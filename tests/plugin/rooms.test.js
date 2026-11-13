'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');

const LIGHT = { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen' } };
const SWITCH = { entity_id: 'switch.coffee', state: 'off', attributes: { friendly_name: 'Coffee maker' } };
const PORCH = { entity_id: 'light.porch', state: 'off', attributes: { friendly_name: 'Porch' } };
const SHARED = ['light.kitchen', 'switch.coffee', 'light.porch'];

function setUp() {
    const h = harness.create();
    h.states([LIGHT, SWITCH, PORCH]);
    h.ha.areas = { 'light.kitchen': 'Kitchen', 'switch.coffee': 'Kitchen' };
    h.settings({ plugin_exposed_entities: SHARED, plugin_weather_entities: [] });
    return h;
}

function rooms(answer) {
    assert.ok(answer.data, 'expected data, got ' + JSON.stringify(answer.error));
    const out = {};
    answer.data.instances.forEach((i) => { out[i.instanceId] = i.properties.room ? i.properties.room.shortText.text : null; });
    return out;
}

test('every home instance has its room, and one without an area goes without', async () => {
    const h = setUp();
    assert.deepEqual(rooms(await h.source('home', 'entity')),
        { 'light.kitchen': 'Kitchen', 'switch.coffee': 'Kitchen', 'light.porch': null });
    assert.deepEqual(rooms(await h.source('home', 'light')), { 'light.kitchen': 'Kitchen', 'light.porch': null });
});

test('the areas of every served entity come from one template, kept an hour', async () => {
    const h = setUp();
    await h.source('home', 'entity');
    const calls = h.ha.calls('POST /api/template');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.variables.ids, SHARED);
    // The ids go in as a variable, never into the template itself
    assert.ok(!calls[0].body.template.includes('light.kitchen'));

    await h.source('home', 'light');
    await h.source('home', 'switch');
    h.advance(59 * 60000);
    await h.source('home', 'entity');
    assert.equal(h.ha.calls('POST /api/template').length, 1);

    h.advance(2 * 60000);
    await h.source('home', 'entity');
    assert.equal(h.ha.calls('POST /api/template').length, 2);
});

test('a newly shared entity has its area fetched', async () => {
    const h = setUp();
    h.settings({ plugin_exposed_entities: ['light.kitchen'], plugin_weather_entities: [] });
    await h.source('home', 'light');
    h.settings({ plugin_exposed_entities: SHARED, plugin_weather_entities: [] });
    assert.equal(rooms(await h.source('home', 'switch'))['switch.coffee'], 'Kitchen');
    assert.equal(h.ha.calls('POST /api/template').length, 2);
});

test('rooms are only fetched for a caller that wants them', async () => {
    const h = setUp();
    let answer = await h.source('home', 'light', { properties: ['on'] });
    assert.equal(answer.data.instances[0].properties.room, undefined);
    // What the Pebble app sends when none of the properties asked for is declared
    answer = await h.source('home', 'light', { properties: [] });
    assert.equal(answer.data.instances.length, 2);
    assert.equal(h.ha.calls('POST /api/template').length, 0);

    assert.deepEqual(rooms(await h.source('home', 'light', { properties: ['room'] })),
        { 'light.kitchen': 'Kitchen', 'light.porch': null });
});

test('a template Home Assistant refuses leaves the rooms out, and is not asked again for a while', async () => {
    const h = setUp();
    h.ha.admin = false;
    assert.deepEqual(rooms(await h.source('home', 'entity')),
        { 'light.kitchen': null, 'switch.coffee': null, 'light.porch': null });
    // Not a refused token: the API itself still answers
    assert.equal(h.stored('auth_failed'), null);
    await h.source('home', 'entity');
    assert.equal(h.ha.calls('POST /api/template').length, 1);

    h.ha.admin = true;
    h.advance(11 * 60000);
    assert.equal(rooms(await h.source('home', 'entity'))['light.kitchen'], 'Kitchen');
});

test('a template that fails to render leaves the rooms out', async () => {
    const h = setUp();
    h.ha.on('POST', '/api/template', () => ({ status: 400, body: { message: 'Error rendering template' } }));
    assert.deepEqual(rooms(await h.source('home', 'light')), { 'light.kitchen': null, 'light.porch': null });
});
