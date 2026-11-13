'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');
const fixtures = require('./fixtures');

const manifest = harness.manifest();

function sourceKey(source) {
    return source.category + '/' + source.items[0];
}

function declaredFor(key) {
    const source = manifest.sources.find((s) => sourceKey(s) === key);
    return source ? source.properties : null;
}

/** "name" -> ["shortText", ...] for what an instance's properties carry, series as "series.<shape>" */
function shapesOf(instance) {
    const out = {};
    Object.keys(instance.properties).forEach((name) => {
        const prop = instance.properties[name];
        out[name] = [];
        Object.keys(prop).forEach((shape) => {
            if (shape === 'series') {
                Object.keys(prop.series).forEach((inner) => {
                    if (inner !== 'start' && inner !== 'stepSec') { out[name].push('series.' + inner); }
                });
            } else {
                out[name].push(shape);
            }
        });
    });
    return out;
}

/** A bench with every fixture shared, so every source has instances */
function everythingShared() {
    const h = harness.create({ phone: { locations: [
        { id: 'loc-home', name: 'Boulder', latitude: 40.02, longitude: -105.05 },
        { id: 'loc-far', name: 'Paris', latitude: 48.85, longitude: 2.35 }
    ] } });
    const all = fixtures.states(h.now());
    h.states(all);
    const forecasts = fixtures.forecasts(h.now());
    Object.keys(forecasts).forEach((id) => h.forecasts(id, forecasts[id]));
    const todoItems = fixtures.todoItems();
    Object.keys(todoItems).forEach((id) => h.todoItems(id, todoItems[id]));
    h.ha.areas = fixtures.areas();
    h.ha.calendars = fixtures.calendars(h.now());
    h.ha.history = fixtures.history(h.now());
    h.settings({
        plugin_exposed_entities: all.map((s) => s.entity_id).filter((id) => id.indexOf('weather.') !== 0),
        plugin_weather_entities: ['weather.home', 'weather.nws'],
        plugin_share_assistant: true,
        plugin_values: fixtures.values(),
        available_pipelines: [{ id: 'p1', name: 'Home', preferred: true, stt: true, tts: true }]
    });
    h.ha.templates = fixtures.templates();
    return h;
}

/** Every shape each source emits for the fixtures, all of them shared */
async function everythingEmitted() {
    const h = everythingShared();
    const emitted = {};
    function note(key, instance) {
        const shapes = shapesOf(instance);
        emitted[key] = emitted[key] || {};
        Object.keys(shapes).forEach((name) => {
            emitted[key][name] = emitted[key][name] || new Set();
            shapes[name].forEach((shape) => emitted[key][name].add(shape));
        });
    }

    for (const source of manifest.sources) {
        const key = sourceKey(source);
        // Some properties are only built when asked for by name
        const requests = key === 'weather/location'
            ? [{}, { iconPixelSize: { w: 25, h: 25 } }]
            : [{}, { properties: Object.keys(source.properties) }];
        for (const extra of requests) {
            const answer = await h.source(source.category, source.items[0], extra);
            assert.ok(answer.data, key + ' answered ' + JSON.stringify(answer.error));
            assert.ok(answer.data.instances.length > 0, key + ' had no instances');
            answer.data.instances.forEach((instance) => note(key, instance));
        }
    }
    return emitted;
}

test('manifest.json parses and has sources and actions', () => {
    assert.doesNotThrow(() => JSON.parse(harness.manifestText));
    assert.ok(manifest.sources.length > 0);
    assert.ok(manifest.actions.length > 0);
    assert.equal(manifest.script, 'plugin.js');
});

test('every source and action requires Location of its callers', () => {
    manifest.sources.forEach((source) => {
        assert.ok((source.callerPermissions || []).includes('Location'), sourceKey(source) + ' lacks Location');
    });
    manifest.actions.forEach((action) => {
        assert.ok((action.callerPermissions || []).includes('Location'), action.name + ' lacks Location');
    });
});

test('Unlock and Assistant guard exactly the actions they are for', () => {
    const defined = manifest.definesPermissions.map((p) => p.name).sort();
    assert.deepEqual(defined, ['Assistant', 'Unlock']);
    manifest.definesPermissions.forEach((p) => assert.equal(p.kind, 'dangerous'));

    const withPermission = (name) => manifest.actions.filter((a) => (a.callerPermissions || []).includes(name))
        .map((a) => a.name).sort();
    assert.deepEqual(withPermission('Unlock'), ['alarm_disarm', 'open', 'unlock']);
    assert.deepEqual(withPermission('Assistant'), ['ask_assistant', 'send_to_agent']);

    ['alarm_disarm', 'open', 'unlock'].forEach((name) => {
        const action = manifest.actions.find((a) => a.name === name);
        assert.equal(action.requiresConfirmation, true, name);
        assert.equal(action.destructive, true, name);
    });
});

test('the manifest lists the sources and actions the code serves', () => {
    const h = harness.create();
    const engine = h.engine();
    const items = engine.require('entities').ITEMS;
    const served = items.map((item) => 'home/' + item).concat(['home/value', 'calendar/event', 'weather/location', 'agent/configured',
        'agent/pipeline', 'reminders/configured', 'reminders/list']).sort();
    assert.deepEqual(manifest.sources.map(sourceKey).sort(), served);
    manifest.sources.forEach((source) => assert.equal(source.items.length, 1, sourceKey(source)));

    const names = engine.require('actions').names.slice().sort();
    assert.deepEqual(manifest.actions.map((a) => a.name).sort(), names);
});

test('every source\'s answer stays valid until the Pebble app polls it again', async () => {
    const h = everythingShared();
    for (const source of manifest.sources) {
        const key = sourceKey(source);
        const answer = await h.source(source.category, source.items[0]);
        assert.ok(answer.data, key + ' answered ' + JSON.stringify(answer.error));
        assert.equal(answer.data.validUntilMs - h.now(), source.suggestedRefreshIntervalSec * 1000, key);
    }
});

test('every action target names a declared source or property', () => {
    manifest.actions.forEach((action) => {
        action.targets.forEach((target) => {
            const parts = target.split('/');
            const props = declaredOrFail(parts[0] + '/' + parts[1], action.name);
            if (parts[2]) {
                assert.ok(props[parts[2]], action.name + ' targets ' + target + ', which is not declared');
            }
        });
    });
    function declaredOrFail(key, name) {
        const props = declaredFor(key);
        assert.ok(props, name + ' targets ' + key + ', which is not a source');
        return props;
    }
});

test('every property shape the plugin emits is declared, and every declared one is emitted', async () => {
    const emitted = await everythingEmitted();
    const undeclared = [];
    const unseen = [];
    manifest.sources.forEach((source) => {
        const key = sourceKey(source);
        const declared = source.properties;
        const got = emitted[key] || {};
        Object.keys(got).forEach((name) => {
            got[name].forEach((shape) => {
                if (!declared[name] || !declared[name].includes(shape)) { undeclared.push(key + ' ' + name + ' ' + shape); }
            });
        });
        Object.keys(declared).forEach((name) => {
            declared[name].forEach((shape) => {
                if (!got[name] || !got[name].has(shape)) { unseen.push(key + ' ' + name + ' ' + shape); }
            });
        });
    });
    assert.deepEqual(undeclared, [], 'emitted but not declared in manifest.json');
    assert.deepEqual(unseen, [], 'declared in manifest.json but never emitted for the fixtures');
});
