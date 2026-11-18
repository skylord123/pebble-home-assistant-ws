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

test('one statistics command and one history call cover every numeric sensor, and only them', async () => {
    const h = setUp();
    await h.source('home', 'sensor', { properties: ['value', 'history'] });
    // The sensor with a state_class has hourly statistics
    const commands = h.ha.commands();
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, 'recorder/statistics_during_period');
    assert.deepEqual(commands[0].statistic_ids, ['sensor.outside_temperature']);
    assert.equal(commands[0].period, 'hour');
    assert.deepEqual(commands[0].types, ['mean']);
    assert.equal(Date.parse(commands[0].start_time), h.now() - 23 * HOUR);
    // The others' state changes
    const calls = h.ha.calls(/^GET \/api\/history\/period\//);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].query.filter_entity_id.split(','),
        ['sensor.phone_battery', 'number.volume_limit', 'counter.coffees']);
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

/** A power sensor that changes every second, a day up to the next hour, between 100 and 200 W */
function chatty(h, id, stateClass) {
    const attributes = { friendly_name: 'Power', unit_of_measurement: 'W' };
    if (stateClass) { attributes.state_class = 'measurement'; }
    h.states([{ entity_id: id, state: '150', attributes: attributes }]);
    const list = [];
    for (let t = h.now() - 24 * HOUR; t < h.now() + HOUR; t += 1000) {
        list.push({ state: (t / 1000) % 2 === 0 ? '100' : '200', last_changed: new Date(t).toISOString() });
    }
    h.ha.history = { [id]: list };
    h.settings({ plugin_exposed_entities: [id], plugin_weather_entities: [] });
}

test('a sensor with a state_class gets its hours from the statistics, the hour under way its value now', async () => {
    const h = harness.create();
    chatty(h, 'sensor.power', true);
    const props = byId(await h.source('home', 'sensor', { properties: ['history'] }));
    assert.deepEqual(props['sensor.power'].history.series.numericValue,
        { values: Array(24).fill(150), unit: 'W' });
    assert.equal(h.ha.commands().length, 1);
    assert.equal(h.ha.calls(/^GET \/api\/history\//).length, 0);
});

test('a day of changes every second is still averaged quickly', async () => {
    const h = harness.create();
    chatty(h, 'sensor.power', false);
    h.advance(30 * 60000);
    const began = Date.now();
    const props = byId(await h.source('home', 'sensor', { properties: ['history'] }));
    assert.ok(Date.now() - began < 3000, 'took ' + (Date.now() - began) + ' ms');
    assert.deepEqual(props['sensor.power'].history.series.numericValue.values, Array(24).fill(150));
});

test('statistics Home Assistant cannot give fall back to the state changes, and are not asked again for a while', async () => {
    const h = setUp();
    h.ha.statistics = () => ({ error: { code: 'unknown_error', message: 'Recorder is busy' } });
    const props = byId(await h.source('home', 'sensor', { properties: ['history'] }));
    assert.equal(props['sensor.outside_temperature'].history.series.numericValue.values.length, 24);
    assert.ok(h.ha.calls(/^GET \/api\/history\//)[0].query.filter_entity_id.includes('sensor.outside_temperature'));
    // A refused command is not a refused token
    assert.equal(h.stored('auth_failed'), null);

    h.advance(4 * 60000);
    h.ha.history = {};
    await h.source('home', 'sensor', { properties: ['history'] });
    h.advance(50000);
    await h.source('home', 'sensor', { properties: ['history'] });
    assert.equal(h.ha.commands().length, 1);
    h.advance(2 * 60000);
    await h.source('home', 'sensor', { properties: ['history'] });
    assert.equal(h.ha.commands().length, 2);
});

test('a WebSocket that cannot connect does not stop the other sources', async () => {
    const h = setUp();
    const RealSocket = h.ha.WebSocket;
    h.ha.WebSocket = function(url) { return new RealSocket(url + '/refused'); };
    const props = byId(await h.source('home', 'sensor', { properties: ['value', 'history'] }));
    assert.equal(props['sensor.outside_temperature'].history.series.numericValue.values.length, 24);
    assert.ok(byId(await h.source('home', 'light')));
});

test('a history call that fails is not tried again for a few minutes', async () => {
    const h = setUp();
    h.ha.on('GET', /^\/api\/history\//, () => ({ status: 500, body: 'Internal Server Error' }));
    await h.source('home', 'sensor', { properties: ['history'] });
    h.advance(4 * 60000);
    const props = byId(await h.source('home', 'sensor', { properties: ['history'] }));
    assert.equal(h.ha.calls(/^GET \/api\/history\//).length, 1);
    // The statistics are still served
    assert.ok(props['sensor.outside_temperature'].history);
    h.advance(2 * 60000);
    await h.source('home', 'sensor', { properties: ['history'] });
    assert.equal(h.ha.calls(/^GET \/api\/history\//).length, 2);
});

test('state changes are fetched for a few sensors a poll', async () => {
    const h = harness.create();
    const ids = [];
    const states = [];
    for (let i = 0; i < 7; i++) {
        ids.push('sensor.s' + i);
        states.push({ entity_id: 'sensor.s' + i, state: String(i), attributes: {} });
    }
    h.states(states);
    h.ha.history = {};
    ids.forEach((id, i) => {
        h.ha.history[id] = [{ state: String(i), last_changed: new Date(h.now() - 30 * HOUR).toISOString() }];
    });
    h.settings({ plugin_exposed_entities: ids, plugin_weather_entities: [] });

    let props = byId(await h.source('home', 'sensor', { properties: ['history'] }));
    assert.equal(ids.filter((id) => props[id].history).length, 5);
    h.advance(30000);
    props = byId(await h.source('home', 'sensor', { properties: ['history'] }));
    assert.equal(ids.filter((id) => props[id].history).length, 7);
    const calls = h.ha.calls(/^GET \/api\/history\//);
    assert.deepEqual(calls[1].query.filter_entity_id.split(','), ['sensor.s5', 'sensor.s6']);
});
