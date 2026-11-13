'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');

//! As the watch app saves them, in Home Assistant's order
const SAVED = [
    { id: 'p1', name: 'Home', preferred: true, stt: true, tts: true },
    { id: 'p2', name: 'Kitchen', preferred: false, stt: false, tts: true },
    { id: 'p3', name: 'Typing', preferred: false, stt: false, tts: false }
];

function setUp(extra) {
    const h = harness.create();
    h.states([{ entity_id: 'light.kitchen', state: 'off', attributes: { friendly_name: 'Kitchen' } }]);
    h.ha.pipelines = {
        pipelines: [
            { id: 'p1', name: 'Home', language: 'en', stt_engine: 'stt.cloud', tts_engine: 'tts.piper', tts_voice: 'en_US-amy' },
            { id: 'p2', name: 'Kitchen', language: 'en', tts_engine: 'tts.piper', tts_voice: 'en_GB-alba' },
            { id: 'p3', name: 'Typing', language: 'en' }
        ],
        preferred_pipeline: 'p1'
    };
    h.settings(Object.assign({
        available_pipelines: SAVED,
        plugin_share_assistant: true,
        plugin_exposed_entities: ['light.kitchen']
    }, extra || {}));
    return h;
}

function summary(answer) {
    assert.ok(answer.data, JSON.stringify(answer.error));
    return answer.data.instances.map((i) => {
        const p = i.properties;
        const flag = (name) => (p[name] ? p[name].boolean.value : undefined);
        return [i.instanceId, p.name.shortText.text, flag('listens'), flag('speaks'), flag('preferred'), flag('selected')];
    });
}

test('agent/pipeline lists the pipelines from the settings, and asks Home Assistant nothing', async () => {
    const h = setUp({ selected_pipeline: 'p2' });
    const answer = await h.source('agent', 'pipeline');
    assert.deepEqual(summary(answer), [
        ['p1', 'Home', true, true, true, false],
        ['p2', 'Kitchen', false, true, false, true],
        ['p3', 'Typing', false, false, false, false]
    ]);
    assert.equal(answer.data.validUntilMs - h.now(), 300000);
    assert.equal(h.ha.requests.length, 0);
    assert.equal(h.ha.sockets.length, 0);
});

test('with none chosen, or the chosen one deleted, the preferred one is selected', async () => {
    const h = setUp();
    assert.deepEqual(summary(await h.source('agent', 'pipeline')).map((p) => p[5]), [true, false, false]);
    h.settings({ available_pipelines: SAVED, selected_pipeline: 'gone' });
    assert.deepEqual(summary(await h.source('agent', 'pipeline')).map((p) => p[5]), [true, false, false]);
});

test('a pipeline saved without its flags comes without them, and one without a name is named by its id', async () => {
    const h = setUp({ available_pipelines: [{ id: 'p1', preferred: true, stt: true }, { id: 'p2' }, null, { name: 'no id' }, { id: 'p1' }] });
    assert.deepEqual(summary(await h.source('agent', 'pipeline')), [
        ['p1', 'p1', true, undefined, true, true],
        ['p2', 'p2', undefined, undefined, false, false]
    ]);
    const none = setUp({ available_pipelines: undefined });
    assert.deepEqual((await none.source('agent', 'pipeline')).data.instances, []);
});

test('agent/pipeline needs Home Assistant set up', async () => {
    const h = harness.create();
    assert.equal((await h.source('agent', 'pipeline')).error.code, 'AUTH_REQUIRED');
});

test('ask_assistant and transcribe run the pipeline the call names', async () => {
    const h = setUp({ selected_pipeline: 'p2' });
    await h.action('ask_assistant', { text: 'hi', pipeline: 'p3' });
    await h.action('ask_assistant', { text: 'hi' });
    await h.action('transcribe', { audio: Buffer.alloc(800).toString('base64'), format: 'ima_adpcm', pipeline: 'p1' });
    const runs = h.ha.commands().filter((c) => c.type === 'assist_pipeline/run');
    assert.deepEqual(runs.map((c) => c.pipeline), ['p3', 'p2', 'p1']);
});

test('a pipeline the settings do not list is INVALID_ARGS, and nothing is asked', async () => {
    const h = setUp();
    const calls = [
        ['ask_assistant', { text: 'hi', pipeline: 'p9' }],
        ['ask_assistant', { text: 'hi', pipeline: 7 }],
        ['ask_assistant', { text: 'hi', json: true, speak: true, pipeline: 'p9' }],
        ['transcribe', { audio: 'AAAA', format: 'ima_adpcm', pipeline: 'p9' }],
        ['speak', { text: 'Hello there.', format: 'ima_adpcm', pipeline: 'p9' }],
        ['speak_next', { text: 'Hello there.', format: 'ima_adpcm', next: '1.8000.0.0.0.0.0.0.a.b', pipeline: 'p9' }]
    ];
    for (const [name, args] of calls) {
        assert.deepEqual((await h.action(name, args)).error,
            { code: 'INVALID_ARGS', message: 'pipeline must be the instanceId of one from agent/pipeline' }, name);
    }
    assert.equal(h.ha.requests.length, 0);
    assert.equal(h.ha.sockets.length, 0);
    // Nor with no list saved to check it against
    const unlisted = setUp({ available_pipelines: [] });
    assert.equal((await unlisted.action('ask_assistant', { text: 'hi', pipeline: 'p1' })).error.code, 'INVALID_ARGS');
});

test('speak takes the voice of the pipeline named, and keeps each pipeline\'s voice apart', async () => {
    const h = setUp({ selected_pipeline: 'p1' });
    const lists = () => h.ha.commands().filter((c) => c.type === 'assist_pipeline/pipeline/list').length;
    const voices = () => h.ha.calls('POST /api/tts_get_url').map((r) => r.body.options.voice);
    const text = 'Short and sweet, that is it.';
    assert.ok((await h.action('speak', { text: text, format: 'ima_adpcm' })).ok);
    assert.ok((await h.action('speak', { text: text, format: 'ima_adpcm', pipeline: 'p2' })).ok);
    assert.ok((await h.action('speak', { text: text, format: 'ima_adpcm' })).ok);
    assert.ok((await h.action('speak', { text: text, format: 'ima_adpcm', pipeline: 'p2' })).ok);
    assert.deepEqual(voices(), ['en_US-amy', 'en_GB-alba', 'en_US-amy', 'en_GB-alba']);
    assert.equal(lists(), 2, 'looked a voice up again that was already known');

    assert.deepEqual((await h.action('speak', { text: text, format: 'ima_adpcm', pipeline: 'p3' })).error,
        { code: 'PLUGIN_UNAVAILABLE', message: 'The assistant\'s pipeline in Home Assistant has no text-to-speech' });
});

test('a cursor made for a pipeline only carries on in that pipeline', async () => {
    const h = setUp();
    const text = 'The front door is locked and the garage is closed. That is all for now, nothing else.';
    const first = JSON.parse((await h.action('speak', { text: text, format: 'ima_adpcm', pipeline: 'p2' })).ok.text);
    assert.ok(first.next);
    h.ha.requests.length = 0;
    for (const pipeline of [undefined, 'p1']) {
        assert.deepEqual((await h.action('speak_next', { text: text, next: first.next, format: 'ima_adpcm', pipeline: pipeline })).error,
            { code: 'INVALID_ARGS', message: pipeline ? 'next does not belong to this text and pipeline' : 'next does not belong to this text' });
    }
    assert.equal(h.ha.requests.length, 0);
    const next = await h.action('speak_next', { text: text, next: first.next, format: 'ima_adpcm', pipeline: 'p2' });
    assert.ok(next.ok, JSON.stringify(next.error));
    assert.equal(h.ha.calls('POST /api/tts_get_url')[0].body.options.voice, 'en_GB-alba');

    // A cursor made without one does not carry on in a named one either
    const plain = JSON.parse((await h.action('speak', { text: text, format: 'ima_adpcm' })).ok.text);
    assert.equal((await h.action('speak_next', { text: text, next: plain.next, format: 'ima_adpcm', pipeline: 'p1' })).error.code,
        'INVALID_ARGS');
});

test('ask_assistant with speak and a pipeline hands out a cursor for that pipeline', async () => {
    const h = setUp({ selected_pipeline: 'p1' });
    const result = JSON.parse((await h.action('ask_assistant', { text: 'hi', json: true, speak: true, pipeline: 'p2' })).ok.text);
    const runs = h.ha.commands().filter((c) => c.type === 'assist_pipeline/run');
    assert.equal(runs[0].pipeline, 'p2');
    const slice = await h.action('speak_next', { text: result.reply, next: result.next, format: 'ima_adpcm', pipeline: 'p2' });
    assert.ok(slice.ok, JSON.stringify(slice.error));
    assert.equal(h.ha.calls('POST /api/tts_get_url')[0].body.options.voice, 'en_GB-alba');
});

test('the manifest declares agent/pipeline, and pipeline on the assistant and speech actions', () => {
    const manifest = harness.manifest();
    const source = manifest.sources.find((s) => s.category === 'agent' && s.items[0] === 'pipeline');
    assert.deepEqual(source.callerPermissions, ['Location']);
    assert.equal(source.supportsMultiple, true);
    ['ask_assistant', 'transcribe', 'speak', 'speak_next'].forEach((name) => {
        const action = manifest.actions.find((a) => a.name === name);
        assert.equal(action.parameters.properties.pipeline.type, 'string', name);
        assert.ok(!action.parameters.required.includes('pipeline'), name);
    });
});
