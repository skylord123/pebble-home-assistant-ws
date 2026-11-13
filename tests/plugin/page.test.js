'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');

/** Home Assistant's answer to the areas template: [entity_id, name, state, unit] per entity */
const AREAS = [
    { id: 'living_room', name: 'Living room', entities: [
        ['sensor.living_temp', 'Temperature', '21.5', '°C'],
        ['light.lamp', 'Lamp', 'off', '']
    ] },
    { id: 'attic', name: 'Attic', entities: [] },
    { id: 'kitchen', name: 'Kitchen', entities: [['light.kitchen', 'Kitchen', 'on', '']] }
];

function withAreas(h, areas) {
    h.ha.on('POST', '/api/template', (req) => {
        if (!/areas\(\)/.test(req.body.template)) { return undefined; }
        return { status: 200, body: JSON.stringify(areas), headers: { 'content-type': 'text/plain' } };
    });
    return h;
}

test('list_areas answers every area with something in it, by name, in one request', async () => {
    const h = withAreas(harness.create().settings({}), AREAS);
    const reply = await h.config({ type: 'list_areas' });
    assert.deepEqual(reply, { ok: true, areas: [
        { id: 'kitchen', name: 'Kitchen', entities: [{ entity_id: 'light.kitchen', name: 'Kitchen', state: 'on' }] },
        { id: 'living_room', name: 'Living room', entities: [
            { entity_id: 'light.lamp', name: 'Lamp', state: 'off' },
            { entity_id: 'sensor.living_temp', name: 'Temperature', state: '21.5 °C' }
        ] }
    ] });
    assert.deepEqual(h.ha.requests.map((r) => r.method + ' ' + r.path), ['POST /api/template']);
    // Nothing about the watch app's settings is written for it
    assert.deepEqual(Object.keys(h.readSettings()).sort(), ['ha_url', 'token']);
});

test('list_areas needs Home Assistant set up, and passes on what went wrong', async () => {
    let h = harness.create();
    assert.equal((await h.config({ type: 'list_areas' })).error.code, 'not_loaded');

    h = harness.create().settings({});
    h.ha.admin = false;
    const reply = await h.config({ type: 'list_areas' });
    // The token works for the API, but its user may not render templates
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'PERMISSION_DENIED');
});

test('saving the settings refreshes every source the plugin serves', async () => {
    const h = harness.create().settings({});
    await h.config({ type: 'refresh' });
    const refreshed = h.refreshed[h.refreshed.length - 1];
    harness.manifest().sources.forEach((source) => {
        source.items.forEach((item) => {
            assert.ok(refreshed.includes(source.category + '/' + item), source.category + '/' + item + ' is not refreshed');
        });
    });
});
