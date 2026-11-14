'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');
const fixtures = require('./fixtures');

const SHARED = ['light.kitchen', 'light.porch', 'switch.coffee', 'fan.bedroom', 'climate.living_room',
    'climate.upstairs', 'cover.office_blind', 'cover.garage_door', 'cover.driveway_gate', 'cover.window', 'lock.front_door',
    'alarm_control_panel.house', 'media_player.living_room', 'media_player.tv', 'scene.movie',
    'select.washer_program', 'script.good_night'];

function setUp(extra) {
    const h = harness.create();
    h.states(fixtures.states(h.now()));
    h.settings(Object.assign({
        plugin_exposed_entities: SHARED,
        plugin_weather_entities: ['weather.home']
    }, extra || {}));
    return h;
}

/** The one service call an action made, as "domain.service" and its data */
function onlyCall(h) {
    const calls = h.ha.serviceCalls();
    assert.equal(calls.length, 1, 'expected one service call, got ' + JSON.stringify(calls));
    return calls[0];
}

function assertRefused(answer, code, pattern) {
    assert.ok(answer.error, 'expected ' + code + ', got ' + JSON.stringify(answer.ok));
    assert.equal(answer.error.code, code, answer.error.message);
    if (pattern) { assert.match(answer.error.message, pattern); }
}

/**
 * What a tap on a Dashboard tile showing `property` of an instance does, by
 * the rule Core's Dashboard and ActionDeclaration.bindable follow: the action
 * may require only instanceId, item, and on when the property it writes is a
 * boolean (sent as the opposite of what it shows). One targeting the property
 * goes first, then one targeting the item, then one writing another property.
 */
async function dashboardTap(h, category, item, instanceId, property) {
    const manifest = harness.manifest();
    const declared = manifest.sources.find((s) => s.category === category && s.items.includes(item)).properties;
    const prefix = category + '/' + item;
    const writes = (action) => {
        const target = action.targets.find((t) => t.indexOf(prefix + '/') === 0);
        return target ? target.slice(prefix.length + 1) : '';
    };
    const usable = manifest.actions.filter((action) => {
        const flipped = writes(action) || property;
        const canFlip = (declared[flipped] || []).includes('boolean');
        return action.parameters.required.every((name) => name === 'instanceId' || name === 'item' ||
            (name === 'on' && canFlip));
    });
    const targeting = (target) => usable.filter((action) => action.targets.includes(target));
    const action = targeting(prefix + '/' + property).concat(targeting(prefix))
        .concat(usable.filter((a) => writes(a) && writes(a) !== property))[0];
    assert.ok(action, 'nothing to tap on ' + prefix + '/' + property);

    const answer = await h.source(category, item);
    const instance = answer.data.instances.find((i) => i.instanceId === instanceId);
    const args = { instanceId: instanceId };
    if (action.parameters.required.includes('item')) { args.item = item; }
    if (action.parameters.required.includes('on')) {
        const shown = instance.properties[writes(action) || property];
        args.on = !(shown && shown.boolean && shown.boolean.value);
    }
    h.ha.requests.length = 0;
    return { action: action.name, args: args, answer: await h.action(action.name, args) };
}

test('toggle toggles a light and says so', async () => {
    const h = setUp();
    const answer = await h.action('toggle', { instanceId: 'light.kitchen' });
    assert.deepEqual(answer.ok, { text: 'Toggled Kitchen.', refreshed: ['home/entity', 'home/light'] });
    assert.deepEqual(onlyCall(h), { service: 'light.toggle', data: { entity_id: 'light.kitchen' }, query: {} });
});

test('the states a service call reports changed are served next', async () => {
    const h = setUp();
    h.ha.on('POST', '/api/services/light/toggle', () => {
        const now = new Date(h.now()).toISOString();
        h.ha.statesById['light.kitchen'] = Object.assign({}, h.ha.statesById['light.kitchen'],
            { state: 'off', last_changed: now });
        return [h.ha.statesById['light.kitchen']];
    });
    await h.source('home', 'light');
    await h.action('toggle', { instanceId: 'light.kitchen' });
    const reads = h.ha.calls('GET /api/states/light.kitchen').length;
    const answer = await h.source('home', 'light');
    const kitchen = answer.data.instances.find((i) => i.instanceId === 'light.kitchen');
    assert.deepEqual(kitchen.properties.on.boolean, { value: false });
    assert.equal(h.ha.calls('GET /api/states/light.kitchen').length, reads, 'read again despite the fresh state');
});

test('toggle never unlocks a lock', async () => {
    const h = setUp({ plugin_allow_unlock: true });
    assertRefused(await h.action('toggle', { instanceId: 'lock.front_door' }), 'INVALID_ARGS', /use unlock/);
    assert.equal(h.ha.serviceCalls().length, 0);
});

test('set_on runs the Hue-style action on lights and switches', async () => {
    const h = setUp();
    await h.action('set_on', { item: 'light', instanceId: 'light.kitchen', on: false });
    assert.equal(onlyCall(h).service, 'light.turn_off');
    assertRefused(await h.action('set_on', { instanceId: 'light.kitchen', on: 'yes' }), 'INVALID_ARGS');
    assertRefused(await h.action('set_on', { instanceId: 'scene.movie', on: false }), 'INVALID_ARGS', /cannot be turned off/);
});

test('set_on plays and pauses a media player, as its on reads', async () => {
    const h = setUp();
    const answer = await h.action('set_on', { instanceId: 'media_player.living_room', on: false });
    assert.equal(answer.ok.text, 'Paused Living room speaker.');
    assert.equal(onlyCall(h).service, 'media_player.media_pause');

    h.ha.requests.length = 0;
    await h.action('set_on', { instanceId: 'media_player.living_room', on: true });
    assert.equal(onlyCall(h).service, 'media_player.media_play');

    // The TV can pause but not play
    h.ha.requests.length = 0;
    assertRefused(await h.action('set_on', { instanceId: 'media_player.tv', on: true }), 'INVALID_ARGS', /cannot play/);
    assert.equal(h.ha.serviceCalls().length, 0);
});

test('a Dashboard tap on a media player plays and pauses it', async () => {
    const h = setUp();
    for (const item of ['media_player', 'entity']) {
        const tap = await dashboardTap(h, 'home', item, 'media_player.living_room', 'on');
        assert.equal(tap.action, 'set_on', item);
        assert.equal(onlyCall(h).service, 'media_player.media_pause', item);
    }
});

test('set_on locks and arms, but never unlocks or disarms, even with Apps Can Unlock', async () => {
    const h = setUp({ plugin_allow_unlock: true,
        plugin_exposed_entities: SHARED.concat(['lock.shed', 'alarm_control_panel.shed']) });
    // A Dashboard tile on home/entity flips `on`: an unlocked lock locks
    let tap = await dashboardTap(h, 'home', 'entity', 'lock.shed', 'on');
    assert.deepEqual([tap.action, tap.args.on], ['set_on', true]);
    assert.equal(tap.answer.ok.text, 'Locked Shed.');
    assert.equal(onlyCall(h).service, 'lock.lock');

    tap = await dashboardTap(h, 'home', 'entity', 'alarm_control_panel.shed', 'on');
    assert.equal(onlyCall(h).service, 'alarm_control_panel.alarm_arm_away');

    // and a locked one, or an armed panel, is refused with what to use instead
    tap = await dashboardTap(h, 'home', 'entity', 'lock.front_door', 'on');
    assertRefused(tap.answer, 'INVALID_ARGS', /unlock action/);
    tap = await dashboardTap(h, 'home', 'entity', 'alarm_control_panel.house', 'on');
    assertRefused(tap.answer, 'INVALID_ARGS', /alarm_disarm action/);
    assert.equal(h.ha.serviceCalls().length, 0);
});

test('a Dashboard tap on a script runs or stops it, and set_on runs scenes and presses buttons', async () => {
    const h = setUp({ plugin_exposed_entities: SHARED.concat(['button.restart_router']) });
    const tap = await dashboardTap(h, 'home', 'scene', 'script.good_night', 'running');
    assert.deepEqual([tap.action, tap.args.on], ['set_on', true]);
    assert.equal(onlyCall(h).service, 'script.turn_on');

    h.ha.requests.length = 0;
    await h.action('set_on', { instanceId: 'button.restart_router', on: true });
    assert.equal(onlyCall(h).service, 'button.press');
    assertRefused(await h.action('set_on', { instanceId: 'button.restart_router', on: false }),
        'INVALID_ARGS', /cannot be turned off/);
});

test('set_on and set_brightness take a Hue-style item and go by the entity\'s own kind', async () => {
    const h = setUp();
    await h.action('set_on', { item: 'switch', instanceId: 'light.kitchen', on: true });
    assert.equal(onlyCall(h).service, 'light.turn_on');
    h.ha.requests.length = 0;
    await h.action('set_brightness', { item: 'entity', instanceId: 'light.kitchen', percent: 10 });
    assert.equal(onlyCall(h).service, 'light.turn_on');
});

test('set_brightness sets a percentage, turns off at 0, and refuses lights that cannot dim', async () => {
    const h = setUp();
    let answer = await h.action('set_brightness', { instanceId: 'light.kitchen', percent: 42.4 });
    assert.equal(answer.ok.text, 'Set Kitchen to 42%.');
    assert.deepEqual(onlyCall(h).data, { brightness_pct: 42, entity_id: 'light.kitchen' });

    h.ha.requests.length = 0;
    await h.action('set_brightness', { instanceId: 'light.kitchen', percent: 0 });
    assert.equal(onlyCall(h).service, 'light.turn_off');

    assertRefused(await h.action('set_brightness', { instanceId: 'light.kitchen', percent: 101 }), 'INVALID_ARGS');
    assertRefused(await h.action('set_brightness', { instanceId: 'light.porch', percent: 50 }), 'INVALID_ARGS', /cannot be dimmed/);
    assertRefused(await h.action('set_brightness', { instanceId: 'switch.coffee', percent: 50 }), 'INVALID_ARGS');
});

test('set_temperature sets one target, or a range on a heat_cool thermostat', async () => {
    const h = setUp();
    await h.action('set_temperature', { instanceId: 'climate.living_room', temperature: 22.5 });
    assert.deepEqual(onlyCall(h), { service: 'climate.set_temperature',
        data: { temperature: 22.5, entity_id: 'climate.living_room' }, query: {} });

    h.ha.requests.length = 0;
    const answer = await h.action('set_temperature', { instanceId: 'climate.upstairs', target_temp_low: 18, target_temp_high: 25 });
    assert.equal(answer.ok.text, 'Set Upstairs to 18-25°.');
    assert.deepEqual(onlyCall(h).data, { target_temp_low: 18, target_temp_high: 25, entity_id: 'climate.upstairs' });

    // The range thermostat has no single target, and the single one no range
    assertRefused(await h.action('set_temperature', { instanceId: 'climate.upstairs', temperature: 21 }),
        'INVALID_ARGS', /keeps a range/);
    assertRefused(await h.action('set_temperature', { instanceId: 'climate.living_room', target_temp_low: 18, target_temp_high: 25 }),
        'INVALID_ARGS', /cannot keep a range/);
    assertRefused(await h.action('set_temperature', { instanceId: 'climate.upstairs', target_temp_low: 26, target_temp_high: 25 }),
        'INVALID_ARGS');
    assertRefused(await h.action('set_temperature', { instanceId: 'climate.living_room' }), 'INVALID_ARGS');
});

test('a garage door or gate opens only through open, and only with Apps Can Unlock', async () => {
    const h = setUp();
    for (const [name, args] of [
        ['set_on', { on: true }],
        ['toggle', {}],
        ['call_service', { service: 'open_cover' }],
        ['call_service', { service: 'toggle' }],
        ['open', {}]
    ]) {
        const answer = await h.action(name, Object.assign({ instanceId: 'cover.garage_door' }, args));
        assertRefused(answer, 'PERMISSION_DENIED');
    }
    for (const args of [{ service: 'set_cover_position', data: { position: 100 } }, { position: 50 }]) {
        const name = args.service ? 'call_service' : 'set_position';
        assertRefused(await h.action(name, Object.assign({ instanceId: 'cover.driveway_gate' }, args)), 'PERMISSION_DENIED');
    }
    assert.equal(h.ha.serviceCalls().length, 0);

    // Closing needs no permission
    await h.action('set_position', { instanceId: 'cover.driveway_gate', position: 0 });
    assert.equal(onlyCall(h).service, 'cover.set_cover_position');

    h.settings({ plugin_exposed_entities: SHARED, plugin_allow_unlock: true });
    h.ha.requests.length = 0;
    const opened = await h.action('open', { instanceId: 'cover.garage_door' });
    assert.equal(opened.ok.text, 'Opening Garage door.');
    assert.deepEqual(onlyCall(h), { service: 'cover.open_cover', data: { entity_id: 'cover.garage_door' }, query: {} });
});

test('open on a blind needs no Apps Can Unlock; cover actions check supported_features', async () => {
    const h = setUp();
    await h.action('open', { instanceId: 'cover.office_blind', code: '1234' });
    // Covers refuse a code, so none is passed on
    assert.deepEqual(onlyCall(h).data, { entity_id: 'cover.office_blind' });

    assertRefused(await h.action('set_position', { instanceId: 'cover.window', position: 40 }),
        'INVALID_ARGS', /cannot move to a position/);
    assertRefused(await h.action('stop', { instanceId: 'cover.window' }), 'INVALID_ARGS', /cannot stop/);
});

test('unlock is refused until the wearer turns on Apps Can Unlock', async () => {
    const h = setUp();
    assertRefused(await h.action('unlock', { instanceId: 'lock.front_door', code: '1234' }),
        'PERMISSION_DENIED', /turned off/);
    assertRefused(await h.action('alarm_disarm', { instanceId: 'alarm_control_panel.house' }), 'PERMISSION_DENIED');
    assertRefused(await h.action('open', { instanceId: 'lock.front_door' }), 'PERMISSION_DENIED');
    assert.equal(h.ha.serviceCalls().length, 0);

    h.settings({ plugin_exposed_entities: SHARED, plugin_allow_unlock: true });
    const answer = await h.action('unlock', { instanceId: 'lock.front_door', code: 1234 });
    assert.equal(answer.ok.text, 'Unlocked Front door lock.');
    assert.deepEqual(onlyCall(h).data, { code: '1234', entity_id: 'lock.front_door' });
});

test('locking and arming need no permission, and pass the caller\'s code', async () => {
    const h = setUp();
    await h.action('alarm_arm', { instanceId: 'alarm_control_panel.house', mode: 'night', code: '9' });
    assert.deepEqual(onlyCall(h), { service: 'alarm_control_panel.alarm_arm_night',
        data: { code: '9', entity_id: 'alarm_control_panel.house' }, query: {} });
    assertRefused(await h.action('alarm_arm', { instanceId: 'alarm_control_panel.house', mode: 'party' }), 'INVALID_ARGS');
});

test('call_service calls listed services of the entity\'s own domain, on that entity only', async () => {
    const h = setUp();
    const answer = await h.action('call_service', {
        instanceId: 'select.washer_program',
        service: 'select_option',
        data: { option: 'quick', entity_id: 'select.other', area_id: 'kitchen', device_id: 'x', floor_id: 'f', label_id: 'l' }
    });
    assert.equal(answer.ok.text, 'Called select.select_option on Washer program.');
    assert.deepEqual(onlyCall(h), { service: 'select.select_option',
        data: { option: 'quick', entity_id: 'select.washer_program' }, query: {} });

    // Not on the list: scripts by name, and any other domain's services
    assertRefused(await h.action('call_service', { instanceId: 'script.good_night', service: 'other_script' }),
        'PERMISSION_DENIED', /cannot be called/);
    assertRefused(await h.action('call_service', { instanceId: 'fan.bedroom', service: 'reload' }), 'PERMISSION_DENIED');
    assertRefused(await h.action('call_service', { instanceId: 'fan.bedroom', service: '../light/turn_on' }), 'INVALID_ARGS');
    assert.equal(h.ha.serviceCalls().length, 1);
});

test('call_service never unlocks or disarms, even with Apps Can Unlock', async () => {
    const h = setUp({ plugin_allow_unlock: true });
    assertRefused(await h.action('call_service', { instanceId: 'lock.front_door', service: 'unlock' }),
        'PERMISSION_DENIED', /unlock action/);
    assertRefused(await h.action('call_service', { instanceId: 'lock.front_door', service: 'open' }), 'PERMISSION_DENIED');
    assertRefused(await h.action('call_service', { instanceId: 'alarm_control_panel.house', service: 'alarm_disarm' }),
        'PERMISSION_DENIED');
    assert.equal(h.ha.serviceCalls().length, 0);
});

test('an unshared entity is refused with PERMISSION_DENIED and never read', async () => {
    const h = setUp();
    for (const name of ['toggle', 'set_on', 'set_brightness', 'call_service']) {
        const answer = await h.action(name, { instanceId: 'light.garage', on: true, percent: 10, service: 'turn_on' });
        assertRefused(answer, 'PERMISSION_DENIED', /not shared/);
    }
    assert.equal(h.ha.requests.length, 0);
});

test('an instanceId naming more than one entity is refused', async () => {
    const h = setUp();
    assertRefused(await h.action('toggle', { instanceId: 'light.kitchen,light.garage' }), 'INVALID_ARGS');
    assertRefused(await h.action('toggle', {}), 'INVALID_ARGS');
    assert.equal(h.ha.requests.length, 0);
});

test('weather is always shared, but has nothing to toggle', async () => {
    const h = setUp();
    assertRefused(await h.action('toggle', { instanceId: 'weather.home' }), 'INVALID_ARGS', /cannot be toggled/);
});

test('media actions check what the player supports', async () => {
    const h = setUp();
    await h.action('set_volume', { instanceId: 'media_player.living_room', percent: 50 });
    assert.deepEqual(onlyCall(h).data, { volume_level: 0.5, entity_id: 'media_player.living_room' });
    assertRefused(await h.action('next_track', { instanceId: 'media_player.tv' }), 'INVALID_ARGS', /cannot skip/);
});

test('an unknown action is an INVALID_REQUEST, and actions need Home Assistant set up', async () => {
    const h = setUp();
    assertRefused(await h.action('self_destruct', { instanceId: 'light.kitchen' }), 'INVALID_REQUEST');
    assertRefused(await h.action('hasOwnProperty', { instanceId: 'light.kitchen' }), 'INVALID_REQUEST');

    const fresh = harness.create();
    assertRefused(await fresh.action('toggle', { instanceId: 'light.kitchen' }), 'AUTH_REQUIRED');
});

test('requests carry the token, and Content-Type only with a body', async () => {
    const h = setUp();
    await h.source('home', 'light');
    await h.action('toggle', { instanceId: 'switch.coffee' });
    assert.ok(h.ha.requests.length >= 2);
    h.ha.requests.forEach((r) => {
        assert.equal(r.headers.authorization, 'Bearer ' + harness.TOKEN, r.method + ' ' + r.path);
        if (r.rawBody === undefined) {
            assert.equal(r.headers['content-type'], undefined, r.method + ' ' + r.path + ' has a Content-Type and no body');
        } else {
            assert.equal(r.headers['content-type'], 'application/json');
        }
    });
    assert.ok(h.ha.requests.some((r) => r.method === 'GET'));
    assert.ok(h.ha.requests.some((r) => r.method === 'POST'));
});

test('a 400 from Home Assistant comes back as INVALID_ARGS with its reason', async () => {
    const h = setUp();
    h.ha.on('POST', '/api/services/select/select_option', () => ({ status: 400,
        body: { message: 'Option banana is not valid for entity select.washer_program' } }));
    const answer = await h.action('call_service', { instanceId: 'select.washer_program', service: 'select_option',
        data: { option: 'banana' } });
    assert.deepEqual(answer.error, { code: 'INVALID_ARGS',
        message: 'Home Assistant did not accept that: Option banana is not valid for entity select.washer_program' });
});

test('a 400 page from a proxy is reduced to its text', async () => {
    const h = setUp();
    h.ha.on('POST', '/api/services/switch/toggle', () => ({ status: 400,
        body: '<html><body><h1>400 Bad Request</h1>\n<p>Request Header Or Cookie Too Large</p></body></html>' }));
    const answer = await h.action('toggle', { instanceId: 'switch.coffee' });
    assert.deepEqual(answer.error, { code: 'INVALID_ARGS',
        message: 'Home Assistant did not accept that: 400 Bad Request Request Header Or Cookie Too Large' });
});

test('a service that fails is UNKNOWN, not an outage', async () => {
    const h = setUp();
    h.ha.on('POST', '/api/services/switch/toggle', () => ({ status: 500, body: '500 Internal Server Error' }));
    const answer = await h.action('toggle', { instanceId: 'switch.coffee' });
    assert.equal(answer.error.code, 'UNKNOWN');
    assert.equal(h.stored('unreachable'), null);
});
