'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');

const VALUES = [
    { id: 'v1', name: 'Doors open', template: '{{ doors }}' },
    { id: 'v2', name: 'Battery', template: '{{ battery }}', unit: '%' },
    { id: 'v3', name: 'Power', template: '{{ power }}', unit: 'W' },
    { id: 'v4', name: 'Who is home', template: '{{ people }}' }
];

const RENDERED = {
    '{{ doors }}': '2',
    '{{ battery }}': '\n 17 ',
    '{{ power }}': '1234.5',
    '{{ people }}': 'Alex and Jo'
};

function setUp(values, templates) {
    const h = harness.create();
    h.settings({ plugin_values: values === undefined ? VALUES : values });
    h.ha.templates = Object.assign({}, RENDERED, templates || {});
    return h;
}

function renders(h) {
    return h.ha.calls('POST /api/template');
}

function byId(answer) {
    assert.ok(answer.data, 'expected data, got ' + JSON.stringify(answer.error));
    const out = {};
    answer.data.instances.forEach((i) => { out[i.instanceId] = i.properties; });
    return out;
}

test('home/value renders every value in one request, in the wearer\'s order', async () => {
    const h = setUp();
    const answer = await h.source('home', 'value');
    assert.deepEqual(answer.data.instances.map((i) => i.instanceId), ['v1', 'v2', 'v3', 'v4']);
    assert.equal(renders(h).length, 1);
    assert.equal(h.ha.calls().length, 1);
    // The templates go to Home Assistant, never anything a caller sent
    const sent = renders(h)[0].body.template;
    VALUES.forEach((v) => assert.ok(sent.includes(v.template)));
    assert.ok(answer.data.validUntilMs > h.now());
});

test('a value is typed: a number with its unit, a percentage with a range, text as text', async () => {
    const h = setUp();
    const props = byId(await h.source('home', 'value'));

    assert.deepEqual(props.v1.name, { shortText: { text: 'Doors open' }, longText: { text: 'Doors open' } });
    assert.deepEqual(props.v1.state, { shortText: { text: '2' }, longText: { text: '2' }, numericValue: { value: 2 } });
    assert.equal(props.v1.unit, undefined);

    assert.deepEqual(props.v2.state, {
        shortText: { text: '17%' }, longText: { text: '17%' }, numericValue: { value: 17, unit: '%', min: 0, max: 100 }
    });
    assert.deepEqual(props.v2.unit, { shortText: { text: '%' } });

    assert.deepEqual(props.v3.state, {
        shortText: { text: '1234.5 W' }, longText: { text: '1234.5 W' }, numericValue: { value: 1234.5, unit: 'W' }
    });

    assert.deepEqual(props.v4.state, { shortText: { text: 'Alex and Jo' }, longText: { text: 'Alex and Jo' } });
});

test('text with a unit does not get the unit, and a long result is shortened only in shortText', async () => {
    const long = 'Alex, Jo, Sam, Robin and the neighbour\'s cat';
    const h = setUp([{ id: 'v', name: 'Home', template: '{{ people }}', unit: 'people' }], { '{{ people }}': long });
    const props = byId(await h.source('home', 'value'));
    assert.equal(props.v.state.longText.text, long);
    assert.equal(props.v.state.shortText.text.length, 24);
    assert.ok(props.v.state.shortText.text.endsWith('…'));
    assert.equal(props.v.state.numericValue, undefined);
});

test('one template that fails only fails its own value', async () => {
    const h = setUp(undefined, { '{{ power }}': { error: 'UndefinedError: \'None\' has no attribute \'state\'' } });
    const props = byId(await h.source('home', 'value'));
    assert.deepEqual(props.v3.state, { shortText: { text: 'Error' }, longText: { text: 'Error' } });
    assert.deepEqual(props.v3.error, { longText: { text: 'UndefinedError: \'None\' has no attribute \'state\'' } });
    assert.equal(props.v1.state.numericValue.value, 2);
    assert.equal(props.v4.state.shortText.text, 'Alex and Jo');
    assert.equal(props.v1.error, undefined);
    // All together, then each on its own to find which
    assert.equal(renders(h).length, 1 + VALUES.length);

    // From then on the failing one is rendered on its own, beside the rest
    h.advance(16000);
    const again = byId(await h.source('home', 'value'));
    assert.equal(again.v3.state.shortText.text, 'Error');
    assert.equal(again.v2.state.numericValue.value, 17);
    assert.equal(renders(h).length, 1 + VALUES.length + 2);

    // Once it renders again it rejoins the others
    h.ha.templates['{{ power }}'] = '80';
    h.advance(16000);
    assert.equal(byId(await h.source('home', 'value')).v3.state.numericValue.value, 80);
    h.advance(16000);
    const before = renders(h).length;
    await h.source('home', 'value');
    assert.equal(renders(h).length, before + 1);
});

test('a single value that fails costs one request', async () => {
    const h = setUp([{ id: 'v', name: 'Broken', template: '{{ broken }}' }], { '{{ broken }}': { error: 'nope' } });
    const props = byId(await h.source('home', 'value'));
    assert.deepEqual(props.v.error, { longText: { text: 'nope' } });
    assert.equal(renders(h).length, 1);
});

test('values are rendered once for polls a few seconds apart, and again after', async () => {
    const h = setUp();
    await h.source('home', 'value');
    h.advance(10000);
    await h.source('home', 'value');
    assert.equal(renders(h).length, 1);
    h.advance(6000);
    await h.source('home', 'value');
    assert.equal(renders(h).length, 2);
});

test('a changed template is rendered at once, cache or not', async () => {
    const h = setUp();
    await h.source('home', 'value');
    h.settings({ plugin_values: [{ id: 'v1', name: 'Doors open', template: '{{ power }}' }] });
    const props = byId(await h.source('home', 'value'));
    assert.equal(props.v1.state.numericValue.value, 1234.5);
    assert.equal(renders(h).length, 2);
});

test('no values asks Home Assistant nothing, and entries without an id or template are left out', async () => {
    let h = setUp([]);
    assert.deepEqual((await h.source('home', 'value')).data.instances, []);
    h = setUp(null);
    assert.deepEqual((await h.source('home', 'value')).data.instances, []);
    assert.equal(h.ha.calls().length, 0);

    h = setUp([
        { name: 'No id', template: '{{ doors }}' },
        { id: 'blank', name: 'No template', template: '  ' },
        { id: 'v1', template: '{{ doors }}' },
        { id: 'v1', name: 'Same id twice', template: '{{ power }}' }
    ]);
    const answer = await h.source('home', 'value');
    assert.deepEqual(answer.data.instances.map((i) => i.instanceId), ['v1']);
    // A value with no name goes by its id
    assert.equal(answer.data.instances[0].properties.name.shortText.text, 'v1');
});

test('home/value answers AUTH_REQUIRED until Home Assistant is set up', async () => {
    const h = harness.create();
    h.localStorage.setItem('options:' + h.uuid, JSON.stringify({ plugin_values: VALUES }));
    assert.equal((await h.source('home', 'value')).error.code, 'AUTH_REQUIRED');
    assert.equal(h.ha.requests.length, 0);
});

test('a refused token fails the source, not each value, and is asked about once', async () => {
    const h = setUp();
    h.ha.token = 'a-new-token';
    const answer = await h.source('home', 'value');
    assert.equal(answer.error.code, 'AUTH_REQUIRED');
    assert.deepEqual(h.ha.requests.map((r) => r.method + ' ' + r.path), ['POST /api/template', 'GET /api/']);
    const before = h.ha.requests.length;
    assert.equal((await h.source('home', 'value')).error.code, 'AUTH_REQUIRED');
    assert.equal(h.ha.requests.length, before);
});

test('a token whose user may not render templates is PERMISSION_DENIED, not a bad token', async () => {
    const h = setUp();
    h.ha.admin = false;
    assert.equal((await h.source('home', 'value')).error.code, 'PERMISSION_DENIED');
    assert.equal(h.stored('auth_failed'), null);
});

test('an unreachable Home Assistant fails the source', async () => {
    const h = setUp();
    h.ha.reachable = false;
    assert.equal((await h.source('home', 'value')).error.code, 'PLUGIN_UNAVAILABLE');
    assert.equal(h.ha.requests.length, 1);
});

test('the settings page previews a template as home/value serves it', async () => {
    const h = setUp([]);
    assert.deepEqual(await h.config({ type: 'preview_template', template: '{{ battery }}', unit: '%' }),
        { ok: true, result: '17', text: '17%' });
    assert.deepEqual(await h.config({ type: 'preview_template', template: '{{ people }}' }),
        { ok: true, result: 'Alex and Jo', text: 'Alex and Jo' });

    h.ha.templates['{{ broken }}'] = { error: 'TemplateSyntaxError: unexpected \'}\'' };
    assert.deepEqual(await h.config({ type: 'preview_template', template: '{{ broken }}' }),
        { ok: false, error: { code: 'template_error', message: 'TemplateSyntaxError: unexpected \'}\'' } });

    assert.equal((await h.config({ type: 'preview_template', template: ' ' })).error.code, 'bad_request');
    assert.equal((await h.config({ type: 'preview_template' })).error.code, 'bad_request');
    assert.equal((await h.config({ type: 'preview_template', template: 'x'.repeat(10001) })).error.code, 'bad_request');
});

test('a preview needs Home Assistant set up, and says when it cannot reach it', async () => {
    let h = harness.create();
    assert.equal((await h.config({ type: 'preview_template', template: '{{ doors }}' })).error.code, 'not_loaded');

    h = setUp([]);
    h.ha.reachable = false;
    const reply = await h.config({ type: 'preview_template', template: '{{ doors }}' });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'PLUGIN_UNAVAILABLE');
});

test('saving values through the plugin refreshes home/value at once', async () => {
    const h = setUp();
    await h.source('home', 'value');
    const settings = h.readSettings();
    settings.plugin_values = VALUES.slice(0, 1);
    assert.deepEqual(await h.config({ type: 'save_settings', settings: settings }), { ok: true, from_plugin: true });
    assert.ok(h.refreshed[h.refreshed.length - 1].includes('home/value'));
    assert.equal(h.stored('values'), null);
    assert.deepEqual((await h.source('home', 'value')).data.instances.map((i) => i.instanceId), ['v1']);

    // A save through the watch app is followed by the page's refresh
    await h.source('home', 'value');
    await h.config({ type: 'refresh' });
    await h.source('home', 'value');
    assert.equal(renders(h).length, 3);
});

test('the status counts the values', async () => {
    const h = setUp();
    assert.equal((await h.config({ type: 'status' })).values, VALUES.length);
});

test('each value is captured in a block of its own', () => {
    const engine = harness.create().engine();
    assert.equal(engine.require('values').wrap(['{{ a }}', 'b']),
        '{% set pebble_value_0 %}{{ a }}{% endset %}{% set pebble_value_1 %}b{% endset %}' +
        '{{ {"0": pebble_value_0, "1": pebble_value_1} | tojson }}');
});
