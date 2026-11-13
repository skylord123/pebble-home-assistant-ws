'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');

const LIGHT = { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen', brightness: 255 } };
const SWITCH = { entity_id: 'switch.coffee', state: 'off', attributes: { friendly_name: 'Coffee maker' } };
const SECRET = { entity_id: 'light.bedroom', state: 'on', attributes: { friendly_name: 'Bedroom' } };
const WEATHER = { entity_id: 'weather.home', state: 'sunny', attributes: {
    friendly_name: 'Home', temperature: 20, temperature_unit: '°C', supported_features: 0 } };

function setUp(extra) {
    const h = harness.create();
    h.states([LIGHT, SWITCH, SECRET, WEATHER]);
    h.settings(Object.assign({
        plugin_exposed_entities: ['light.kitchen', 'switch.coffee'],
        plugin_weather_entities: ['weather.home']
    }, extra || {}));
    return h;
}

function ids(answer) {
    assert.ok(answer.data, 'expected data, got ' + JSON.stringify(answer.error));
    return answer.data.instances.map((i) => i.instanceId);
}

test('home/entity serves the shared entities and weather, nothing else', async () => {
    const h = setUp();
    assert.deepEqual(ids(await h.source('home', 'entity')), ['light.kitchen', 'switch.coffee', 'weather.home']);
});

test('each item serves only its own kind of shared entity', async () => {
    const h = setUp();
    assert.deepEqual(ids(await h.source('home', 'light')), ['light.kitchen']);
    assert.deepEqual(ids(await h.source('home', 'switch')), ['switch.coffee']);
    assert.deepEqual(ids(await h.source('home', 'lock')), []);
    // Nothing unshared was even asked for
    assert.equal(h.ha.calls('GET /api/states/light.bedroom').length, 0);
    assert.equal(h.ha.calls('GET /api/states').length, 0);
});

test('a light instance has the typed properties a face draws', async () => {
    const h = setUp();
    const answer = await h.source('home', 'light');
    const props = answer.data.instances[0].properties;
    assert.deepEqual(props.name.shortText, { text: 'Kitchen' });
    assert.deepEqual(props.on, { boolean: { value: true }, shortText: { text: 'On' } });
    assert.deepEqual(props.brightness.numericValue, { value: 100, unit: '%', min: 0, max: 100 });
    assert.equal(typeof props.last_changed.timestamp.value, 'number');
    assert.ok(answer.data.validUntilMs > h.now());
});

test('instances come in the order the wearer shared them, the same on every read', async () => {
    // Complications and faces pick an instance by its place in the list
    const h = setUp({ plugin_exposed_entities: ['switch.coffee', 'light.bedroom', 'light.kitchen'] });
    const first = ids(await h.source('home', 'entity'));
    assert.deepEqual(first, ['switch.coffee', 'light.bedroom', 'light.kitchen', 'weather.home']);
    assert.deepEqual(ids(await h.source('home', 'light')), ['light.bedroom', 'light.kitchen']);
    // Partly from the cache, partly fetched again
    h.advance(11000);
    await h.source('home', 'light');
    assert.deepEqual(ids(await h.source('home', 'entity')), first);

    // Enough of them to be fetched all at once, which Home Assistant answers in its own order
    const many = [];
    for (let i = 0; i < 20; i++) { many.push('sensor.s' + String(i).padStart(2, '0')); }
    const big = harness.create();
    big.states(many.map((id) => ({ entity_id: id, state: '1', attributes: {} })));
    const shared = many.slice().reverse();
    big.settings({ plugin_exposed_entities: shared, plugin_weather_entities: [] });
    assert.deepEqual(ids(await big.source('home', 'sensor')), shared);
    assert.equal(big.ha.calls('GET /api/states').length, 1);
    big.advance(11000);
    assert.deepEqual(ids(await big.source('home', 'sensor', { properties: ['value', 'room', 'history'] })), shared);
});

test('the shared list also takes entries saved as objects', async () => {
    const h = setUp({ plugin_exposed_entities: [{ entity_id: 'light.kitchen', name: 'Kitchen' }, 'light.kitchen'] });
    assert.deepEqual(ids(await h.source('home', 'light')), ['light.kitchen']);
});

test('weather is found by the plugin itself before the watch app has listed it', async () => {
    const h = setUp({ plugin_weather_entities: undefined });
    assert.deepEqual(ids(await h.source('home', 'entity')), ['light.kitchen', 'switch.coffee', 'weather.home']);
    assert.equal(h.ha.calls('GET /api/states').length, 1);
    // And kept for an hour
    await h.source('home', 'entity');
    assert.equal(h.ha.calls('GET /api/states').length, 1);
});

test('states are fetched once for polls a few seconds apart, and again after', async () => {
    const h = setUp();
    await h.source('home', 'light');
    await h.source('home', 'entity');
    assert.equal(h.ha.calls('GET /api/states/light.kitchen').length, 1);
    h.advance(11000);
    await h.source('home', 'light');
    assert.equal(h.ha.calls('GET /api/states/light.kitchen').length, 2);
});

test('an entity Home Assistant no longer has is left out', async () => {
    const h = setUp({ plugin_exposed_entities: ['light.kitchen', 'light.deleted'] });
    assert.deepEqual(ids(await h.source('home', 'light')), ['light.kitchen']);
});

test('sources answer AUTH_REQUIRED until Home Assistant is set up', async () => {
    const h = harness.create();
    h.states([LIGHT]);
    const answer = await h.source('home', 'light');
    assert.equal(answer.error.code, 'AUTH_REQUIRED');
    const weather = await h.source('weather', 'location');
    assert.equal(weather.error.code, 'AUTH_REQUIRED');
    assert.equal(h.ha.requests.length, 0);
});

test('agent/configured answers before set up, and follows Share with Apps', async () => {
    const h = harness.create();
    let answer = await h.source('agent', 'configured');
    assert.deepEqual(answer.data.instances[0].properties.configured, { boolean: { value: false } });

    h.settings({ plugin_share_assistant: false });
    answer = await h.source('agent', 'configured');
    assert.deepEqual(answer.data.instances[0].properties.configured, { boolean: { value: false } });

    h.settings({ plugin_share_assistant: true });
    answer = await h.source('agent', 'configured');
    assert.equal(answer.data.instances[0].instanceId, 'assistant');
    assert.deepEqual(answer.data.instances[0].properties.configured, { boolean: { value: true } });
    assert.equal(h.ha.requests.length, 0);
});

test('an unknown item is an INVALID_REQUEST', async () => {
    const h = setUp();
    assert.equal((await h.source('home', 'toaster')).error.code, 'INVALID_REQUEST');
    assert.equal((await h.source('nope', 'entity')).error.code, 'INVALID_REQUEST');
});

test('a torn settings write falls back to the backup, with the switches off', async () => {
    const h = setUp({ plugin_share_assistant: true, plugin_allow_unlock: true });
    h.localStorage.setItem('options:' + h.uuid + '.bak', h.localStorage.getItem('options:' + h.uuid));
    h.localStorage.setItem('options:' + h.uuid, '{"ha_url": "http://ha.te');
    assert.deepEqual(ids(await h.source('home', 'light')), ['light.kitchen']);
    const agent = await h.source('agent', 'configured');
    assert.deepEqual(agent.data.instances[0].properties.configured, { boolean: { value: false } });
});

test('a refused token is asked about once, then left alone', async () => {
    const h = setUp({ plugin_exposed_entities: ['light.kitchen', 'switch.coffee', 'light.bedroom'] });
    h.ha.token = 'a-new-token';

    const first = await h.source('home', 'entity');
    assert.equal(first.error.code, 'AUTH_REQUIRED');
    assert.match(first.error.message, /refused the access token/);
    // One entity first, then the check of the token: not one refusal per entity
    assert.deepEqual(h.ha.requests.map((r) => r.method + ' ' + r.path),
        ['GET /api/states/light.kitchen', 'GET /api/']);
    assert.ok(h.stored('auth_failed'));
    assert.ok(h.secureStorage.getItem('auth_failed'), 'kept in secure storage too');

    const before = h.ha.requests.length;
    assert.equal((await h.source('home', 'light')).error.code, 'AUTH_REQUIRED');
    assert.equal((await h.action('toggle', { instanceId: 'light.kitchen' })).error.code, 'AUTH_REQUIRED');
    assert.equal(h.ha.requests.length, before, 'Home Assistant was asked again');
});

test('the refusal marker survives the Android localStorage rewrite', async () => {
    const h = setUp();
    h.ha.token = 'a-new-token';
    await h.source('home', 'light');
    const before = h.ha.requests.length;
    // The Pebble app rewrites localStorage from the watch app's own copy
    h.localStorage.removeItem('plugin:auth_failed');
    assert.equal((await h.source('home', 'light')).error.code, 'AUTH_REQUIRED');
    assert.equal(h.ha.requests.length, before);
});

test('a refused token is tried again after 30 minutes, or once it changes', async () => {
    const h = setUp();
    h.ha.token = 'a-new-token';
    await h.source('home', 'light');
    h.advance(29 * 60000);
    const before = h.ha.requests.length;
    await h.source('home', 'light');
    assert.equal(h.ha.requests.length, before);

    h.advance(2 * 60000);
    await h.source('home', 'light');
    assert.ok(h.ha.requests.length > before, 'tried again after 30 minutes');

    // The wearer puts in the new token
    h.settings({ token: 'a-new-token', plugin_exposed_entities: ['light.kitchen'] });
    assert.deepEqual(ids(await h.source('home', 'light')), ['light.kitchen']);
});

test('the settings page checking the plugin clears the refusal', async () => {
    const h = setUp();
    h.ha.token = 'a-new-token';
    await h.source('home', 'light');
    h.ha.token = harness.TOKEN;
    const status = await h.config({ type: 'status' });
    assert.deepEqual(status, { ok: true, shared: 2, weather: 1, values: 0, assistant: false });
    assert.equal(h.stored('auth_failed'), null);
    assert.equal(h.secureStorage.getItem('auth_failed'), null);
    assert.deepEqual(ids(await h.source('home', 'light')), ['light.kitchen']);
});

test('a 401 on a service the user may not call does not mark the token', async () => {
    const h = setUp();
    h.ha.on('POST', '/api/services/switch/toggle', () => ({ status: 401, body: '401: Unauthorized' }));
    const answer = await h.action('toggle', { instanceId: 'switch.coffee' });
    assert.equal(answer.error.code, 'PERMISSION_DENIED');
    assert.equal(h.stored('auth_failed'), null);
    assert.deepEqual(ids(await h.source('home', 'switch')), ['switch.coffee']);
});

test('an unreachable Home Assistant is left alone for 30 seconds', async () => {
    const h = setUp();
    h.ha.reachable = false;
    const first = await h.source('home', 'light');
    assert.equal(first.error.code, 'PLUGIN_UNAVAILABLE');
    assert.match(first.error.message, /Could not reach Home Assistant/);
    assert.equal(h.ha.requests.length, 1);

    h.ha.reachable = true;
    h.advance(20000);
    assert.equal((await h.source('home', 'light')).error.code, 'PLUGIN_UNAVAILABLE');
    assert.equal((await h.action('toggle', { instanceId: 'light.kitchen' })).error.code, 'PLUGIN_UNAVAILABLE');
    assert.equal(h.ha.requests.length, 1, 'tried while it was marked unreachable');

    h.advance(11000);
    assert.deepEqual(ids(await h.source('home', 'light')), ['light.kitchen']);
    assert.equal(h.stored('unreachable'), null);
});

test('an address the Pebble app has not allowed says so and is not marked unreachable', async () => {
    const h = setUp();
    h.ha.notAllowed = true;
    const answer = await h.source('home', 'light');
    assert.equal(answer.error.code, 'PERMISSION_DENIED');
    assert.match(answer.error.message, /does not allow/);
    assert.equal(h.stored('unreachable'), null);
});

test('a failing Home Assistant answers PLUGIN_UNAVAILABLE with its status', async () => {
    const h = setUp();
    h.ha.on('GET', /^\/api\/states\//, () => ({ status: 502, body: 'Bad gateway' }));
    const answer = await h.source('home', 'light');
    assert.deepEqual(answer.error, { code: 'PLUGIN_UNAVAILABLE', message: 'Home Assistant answered 502' });
});

test('nothing the plugin logs or answers carries the token', async () => {
    const h = setUp();
    h.ha.token = 'a-new-token';
    const answers = [await h.source('home', 'light'), await h.config({ type: 'status' })];
    const text = JSON.stringify(answers) + h.logs.join('\n') + JSON.stringify(h.localStorage.items.get('plugin:auth_failed'));
    assert.ok(!text.includes(harness.TOKEN));
});

test('weather/location serves the weather entities with their forecasts', async () => {
    const h = setUp();
    h.forecasts('weather.home', { daily: [], hourly: [] });
    const answer = await h.source('weather', 'location', { properties: ['temperature', 'condition', 'condition_code'] });
    assert.deepEqual(ids(answer), ['weather.home']);
    const props = answer.data.instances[0].properties;
    assert.deepEqual(props.temperature.numericValue, { value: 20, unit: '°C' });
    assert.deepEqual(props.condition_code.longText, { text: 'sun' });
    // supported_features 0: no forecast types, so none was asked for
    assert.equal(h.ha.serviceCalls().length, 0);
});

test('the wearer\'s weather locations near the home come first, far ones not at all', async () => {
    const h = harness.create({ phone: { locations: [
        { id: 'near', name: 'Boulder', latitude: 40.02, longitude: -105.05 },
        { id: 'far', name: 'Paris', latitude: 48.85, longitude: 2.35 }
    ] } });
    h.states([WEATHER]);
    h.settings({ plugin_weather_entities: ['weather.home'] });
    const answer = await h.source('weather', 'location', { properties: ['name', 'sunrise'] });
    assert.deepEqual(ids(answer), ['near', 'weather.home']);
    assert.deepEqual(answer.data.instances[0].properties.name.shortText, { text: 'Boulder' });
    assert.equal(typeof answer.data.instances[0].properties.sunrise.timestamp.value, 'number');
});

test('locations are not read until the wearer has allowed Location', async () => {
    const h = harness.create({ phone: { location: 'denied', locations: [
        { id: 'near', name: 'Boulder', latitude: 40.02, longitude: -105.05 }
    ] } });
    h.states([WEATHER]);
    h.settings({ plugin_weather_entities: ['weather.home'] });
    assert.deepEqual(ids(await h.source('weather', 'location', { properties: ['name'] })), ['weather.home']);
});
