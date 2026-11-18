'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const harness = require('./harness');
const cases = require('./codec-cases');

const codec = (() => {
    const module = { exports: {} };
    new Function('module', 'exports', fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'js', 'app', 'speech-codec.js'), 'utf8'))(module, module.exports);
    return module.exports;
})();

function setUp(extra) {
    const h = harness.create();
    h.ha.pipelines = {
        pipelines: [
            { id: 'p1', name: 'Home', language: 'en', stt_engine: 'stt.cloud', tts_engine: 'tts.piper' },
            { id: 'p2', name: 'Typing', language: 'en', tts_engine: 'tts.piper' }
        ],
        preferred_pipeline: 'p1'
    };
    h.settings(Object.assign({ available_pipelines: [{ id: 'p1' }, { id: 'p2' }] }, extra || {}));
    return h;
}

//! `seconds` of a voice-like signal at 16 kHz, as 16-bit samples
function voice(seconds, seed) {
    const wav = cases.wav({ rate: 16000, count: Math.round(16000 * seconds), peak: 12000, hum: 1500, seed: seed || 3 });
    return codec.parseWav(cases.arrayBuffer(wav)).samples;
}

//! The samples as a watch app records them: ADPCM from silence, in base64
function adpcm(samples) {
    return Buffer.from(codec.encodeAdpcm(samples, { predictor: 0, index: 0 })).toString('base64');
}

function pcmBytes(samples) {
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

test('transcribe sends the audio to a speech-to-text run and answers with what was heard', async () => {
    const h = setUp();
    const samples = voice(2);
    const answer = await h.action('transcribe', { audio: adpcm(samples), format: 'ima_adpcm' });
    assert.deepEqual(answer.ok, { text: 'turn on the kitchen light', refreshed: [] });

    const run = h.ha.sttRuns[0];
    assert.deepEqual(run.command, {
        type: 'assist_pipeline/run', start_stage: 'stt', end_stage: 'stt',
        input: { sample_rate: 16000, no_vad: true }, id: 1
    });
    // Nothing before speech-to-text started, every frame after the handler
    // byte, then one with only that byte
    assert.equal(run.early, 0);
    run.frames.forEach((f) => assert.equal(f[0], run.handler));
    assert.equal(run.frames[run.frames.length - 1].length, 1);
    run.frames.slice(0, -1).forEach((f) => assert.ok(f.length > 1 && f.length <= 8193, String(f.length)));
    // What Home Assistant hears is the watch's own decoding of the ADPCM
    const bytes = Buffer.from(adpcm(samples), 'base64');
    assert.deepEqual(run.pcm, pcmBytes(codec.decodeAdpcm(bytes)));
    assert.equal(h.ha.sockets[0].readyState, 3, 'the socket was left open');
});

test('16-bit PCM goes to Home Assistant as it is', async () => {
    const h = setUp();
    const samples = voice(1, 8);
    const answer = await h.action('transcribe', { audio: pcmBytes(samples).toString('base64'), format: 'pcm16le', sample_rate: 16000 });
    assert.equal(answer.ok.text, 'turn on the kitchen light');
    assert.deepEqual(h.ha.sttRuns[0].pcm, pcmBytes(samples));
});

test('the transcript is trimmed, and nothing heard is an empty answer', async () => {
    const h = setUp();
    h.ha.transcribe = () => '  What time is it?  ';
    assert.equal((await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' })).ok.text, 'What time is it?');

    h.ha.transcribe = () => ({ event: { type: 'error', data: { code: 'stt-no-text-recognized', message: 'No text recognized' } } });
    const nothing = await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' });
    assert.ok(nothing.ok, JSON.stringify(nothing.error));
    // The Pebble app hands an empty text on as null
    assert.equal(nothing.ok.text, null);
});

test('30 seconds of ADPCM is taken, and quickly', async () => {
    const h = setUp();
    const samples = voice(30, 5);
    const audio = adpcm(samples);
    assert.equal(audio.length, 320000);
    const started = Date.now();
    const answer = await h.action('transcribe', { audio: audio, format: 'ima_adpcm' });
    const took = Date.now() - started;
    assert.ok(answer.ok, JSON.stringify(answer.error));
    assert.ok(took < 1000, 'took ' + took + ' ms');
    assert.equal(h.ha.sttRuns[0].pcm.length, 30 * 32000);
});

test('more than 30 seconds, or bad arguments, are INVALID_ARGS and reach no Home Assistant', async () => {
    const h = setUp();
    const good = adpcm(voice(0.5));
    const bad = [
        { audio: good },
        { audio: good, format: 'mp3' },
        { audio: good, format: 'ima_adpcm', sample_rate: 8000 },
        { audio: good, format: 'ima_adpcm', sample_rate: '16000' },
        { format: 'ima_adpcm' },
        { audio: '', format: 'ima_adpcm' },
        { audio: '==', format: 'ima_adpcm' },
        { audio: 'not base64!', format: 'ima_adpcm' },
        { audio: 'AAAAA', format: 'ima_adpcm' },
        { audio: Buffer.from([1, 2, 3]).toString('base64'), format: 'pcm16le' },
        { audio: Buffer.alloc(30 * 8000 + 3).toString('base64'), format: 'ima_adpcm' },
        { audio: Buffer.alloc(30 * 32000 + 3).toString('base64'), format: 'pcm16le' }
    ];
    for (const args of bad) {
        const answer = await h.action('transcribe', args);
        assert.equal(answer.error && answer.error.code, 'INVALID_ARGS', JSON.stringify(args).slice(0, 80));
    }
    assert.equal(h.ha.sockets.length, 0);
    assert.ok((await h.action('transcribe', { audio: Buffer.alloc(30 * 8000).toString('base64'), format: 'ima_adpcm' })).ok);
});

test('transcribe needs neither Share with Apps nor anything shared', async () => {
    const h = setUp({ plugin_share_assistant: false, plugin_exposed_entities: [] });
    assert.ok((await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' })).ok);
});

test('it runs the pipeline chosen in the watch app, and a deleted one gives way to the preferred', async () => {
    const h = setUp({ selected_pipeline: 'p1' });
    await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' });
    assert.equal(h.ha.sttRuns[0].command.pipeline, 'p1');

    h.settings({ selected_pipeline: 'gone', available_pipelines: [{ id: 'p1' }] });
    await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' });
    assert.equal(h.ha.sttRuns[1].command.pipeline, undefined);
});

test('a pipeline that cannot hear is PLUGIN_UNAVAILABLE', async () => {
    const NO_STT = { code: 'PLUGIN_UNAVAILABLE', message: 'The assistant\'s pipeline in Home Assistant has no speech-to-text' };
    const h = setUp({ selected_pipeline: 'p2' });
    assert.deepEqual((await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' })).error, NO_STT);

    for (const code of ['stt-provider-missing', 'stt-provider-unsupported-metadata']) {
        h.ha.pipelines.pipelines[0].sttError = { code: code, message: 'No speech-to-text provider for: stt.cloud' };
        h.settings({ selected_pipeline: 'p1', available_pipelines: [{ id: 'p1' }] });
        assert.deepEqual((await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' })).error, NO_STT, code);
    }
});

test('speech-to-text failing is UNKNOWN, and an unknown pipeline INVALID_ARGS', async () => {
    const h = setUp();
    h.ha.transcribe = () => ({ event: { type: 'error', data: { code: 'stt-stream-failed', message: 'speech-to-text failed' } } });
    assert.deepEqual((await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' })).error,
        { code: 'UNKNOWN', message: 'speech-to-text failed' });

    h.ha.transcribe = () => ({ event: { type: 'error', data: { code: 'cloud-auth-failed' } } });
    assert.deepEqual((await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' })).error,
        { code: 'UNKNOWN', message: 'Home Assistant could not hear the audio' });

    h.ha.pipelines.preferred_pipeline = 'p9';
    assert.equal((await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' })).error.code, 'INVALID_ARGS');
});

test('a WebSocket that cannot connect stops transcribe, not the other sources', async () => {
    const h = setUp({ plugin_exposed_entities: ['light.kitchen'] });
    h.states([{ entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen' } }]);
    const RealSocket = h.ha.WebSocket;
    h.ha.WebSocket = function(url) { return new RealSocket(url + '/refused'); };
    const answer = await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' });
    assert.equal(answer.error.code, 'PLUGIN_UNAVAILABLE');
    assert.equal(h.stored('unreachable'), null, 'marked Home Assistant unreachable');
    assert.ok((await h.source('home', 'light')).data);
});

test('a refused token is AUTH_REQUIRED, and so is a plugin not set up', async () => {
    const h = setUp();
    h.ha.token = 'another-token';
    assert.equal((await h.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' })).error.code, 'AUTH_REQUIRED');

    const fresh = harness.create();
    assert.equal((await fresh.action('transcribe', { audio: adpcm(voice(0.5)), format: 'ima_adpcm' })).error.code, 'AUTH_REQUIRED');
});

test('the manifest offers transcribe to watch apps, keeping agents off it', () => {
    const action = harness.manifest().actions.find((a) => a.name === 'transcribe');
    assert.deepEqual(action.callerPermissions, ['Location']);
    assert.deepEqual(action.parameters.required, ['audio', 'format']);
    assert.deepEqual(action.parameters.properties.format.enum, ['ima_adpcm', 'pcm16le']);
    assert.deepEqual(action.parameters.properties.sample_rate.enum, [16000]);
    assert.match(action.description, /^For watch apps that record the microphone\. Takes recorded audio, not words: never call it to answer the user\./);
});
