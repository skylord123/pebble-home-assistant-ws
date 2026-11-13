'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');
const fixtures = require('./fixtures');

const HOUR = 3600000;
const SENSORS = ['sensor.outside_temperature', 'sensor.phone_battery', 'sensor.washer_status',
    'number.volume_limit', 'counter.coffees'];

function setUp() {
    const h = harness.create();
    h.states(fixtures.states(h.now()));
    h.ha.history = fixtures.history(h.now());
    h.settings({ plugin_exposed_entities: SENSORS.concat(['light.kitchen']), plugin_weather_entities: [] });
    return h;
}

function byId(answer) {
    assert.ok(answer.data, 'expected data, got ' + JSON.stringify(answer.error));
    const out = {};
    answer.data.instances.forEach((i) => { out[i.instanceId] = i.properties; });
    return out;
}

test('history is a day of hourly values for each numeric sensor', async () => {
    const h = setUp();
    const props = byId(await h.source('home', 'sensor', { properties: ['history'] }));

    const battery = props['sensor.phone_battery'].history.series;
    assert.equal(battery.start, (h.now() - 23 * HOUR) / 1000);
    assert.equal(battery.stepSec, 3600);
    // 100% until three hours ago, 87% since, the last value the hour just begun
    assert.deepEqual(battery.numericValue, {
        values: Array(20).fill(100).concat([87, 87, 87, 87]), unit: '%', min: 0, max: 100
    });

    const outside = props['sensor.outside_temperature'].history.series.numericValue;
    assert.equal(outside.unit, '°C');
    assert.equal(outside.values.length, 24);
    // Unavailable from six and a half hours ago to five hours ago: the hour
    // before is half counted, the hour after not at all
    assert.equal(outside.values[17], null);
    assert.notEqual(outside.values[16], null);
    assert.deepEqual(outside.values.filter((v) => v === null).length, 1);
    // Half an hour at each of two values, averaged
    const first = h.ha.history['sensor.outside_temperature'];
    assert.equal(outside.values[0], (Number(first[6].state) + Number(first[7].state)) / 2);

    // A text sensor has nothing to graph, nor one without any history
    assert.equal(props['sensor.washer_status'].history, undefined);
    assert.equal(props['counter.coffees'].history, undefined);
});

test('one history call covers every numeric sensor, and only them', async () => {
    const h = setUp();
    await h.source('home', 'sensor', { properties: ['value', 'history'] });
    const calls = h.ha.calls(/^GET \/api\/history\/period\//);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].query.filter_entity_id.split(','),
        ['sensor.outside_temperature', 'sensor.phone_battery', 'number.volume_limit', 'counter.coffees']);
    assert.ok('minimal_response' in calls[0].query);
    assert.ok('no_attributes' in calls[0].query);
    assert.equal(Date.parse(calls[0].query.end_time), h.now());
    assert.equal(Date.parse(decodeURIComponent(calls[0].path.split('/').pop())), h.now() - 23 * HOUR);
});

test('history is only built for a caller that names it', async () => {
    const h = setUp();
    let props = byId(await h.source('home', 'sensor'));
    assert.equal(props['sensor.phone_battery'].history, undefined);
    props = byId(await h.source('home', 'sensor', { properties: [] }));
    assert.equal(props['sensor.phone_battery'].history, undefined);
    props = byId(await h.source('home', 'sensor', { properties: ['value'] }));
    assert.equal(props['sensor.phone_battery'].history, undefined);
    assert.equal(h.ha.calls(/^GET \/api\/history\//).length, 0);
});

test('home/entity has history for its numeric entities too', async () => {
    const h = setUp();
    const props = byId(await h.source('home', 'entity', { properties: ['state', 'history'] }));
    assert.equal(props['sensor.phone_battery'].history.series.numericValue.values[23], 87);
    assert.equal(props['light.kitchen'].history, undefined);
    assert.ok(!h.ha.calls(/^GET \/api\/history\//)[0].query.filter_entity_id.includes('light.kitchen'));
});

test('history is kept five minutes, and fetched again when the hour turns', async () => {
    const h = setUp();
    h.advance(50 * 60000);
    await h.source('home', 'sensor', { properties: ['history'] });
    h.advance(4 * 60000);
    await h.source('home', 'sensor', { properties: ['history'] });
    await h.source('home', 'entity', { properties: ['history'] });
    assert.equal(h.ha.calls(/^GET \/api\/history\//).length, 1);

    // 10:00: the series has moved on an hour
    h.advance(6 * 60000);
    const props = byId(await h.source('home', 'sensor', { properties: ['history'] }));
    assert.equal(props['sensor.phone_battery'].history.series.start, (h.now() - 23 * HOUR) / 1000);
    assert.equal(h.ha.calls(/^GET \/api\/history\//).length, 2);
});

test('a history Home Assistant cannot give leaves it out and still serves the sensors', async () => {
    const h = setUp();
    h.ha.on('GET', /^\/api\/history\//, () => ({ status: 500, body: 'Internal Server Error' }));
    const props = byId(await h.source('home', 'sensor', { properties: ['value', 'history'] }));
    assert.equal(props['sensor.phone_battery'].history, undefined);
    assert.deepEqual(props['sensor.phone_battery'].value.numericValue, { value: 87, unit: '%', min: 0, max: 100 });
});
