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

const VOICE_PIPELINE = {
    id: 'p2', name: 'Kitchen', language: 'en', stt_engine: 'stt.x',
    tts_engine: 'tts.piper', tts_voice: 'en_GB-alba-medium', tts_language: 'en-GB'
};

//! Four pieces: a short first sentence, two of about 200 characters (each too
//! long for one result at 8 kHz), and a short last one
const TEXT = 'The front door is locked and the garage is closed. ' +
    'The kitchen light has been on since this morning, and the living room is at twenty one degrees. ' +
    'Nobody has opened the back door today, and the porch camera saw a parcel arrive at noon. ' +
    'The washing machine finished its cycle twenty minutes ago and is waiting to be emptied now. ' +
    'Rain is expected tonight, so the patio umbrella should come in before dark, and the windows upstairs are open. ' +
    'That is all.';

function setUp(extra) {
    const h = harness.create();
    h.ha.pipelines = {
        pipelines: [{ id: 'p1', name: 'Home', language: 'en', stt_engine: 'stt.x' }, VOICE_PIPELINE],
        preferred_pipeline: 'p1'
    };
    h.settings(Object.assign({
        selected_pipeline: 'p2',
        available_pipelines: [{ id: 'p1' }, { id: 'p2' }]
    }, extra || {}));
    return h;
}

function parse(answer) {
    assert.ok(answer.ok, 'expected a result, got ' + JSON.stringify(answer.error));
    assert.deepEqual(Object.keys(answer.ok).sort(), ['refreshed', 'text']);
    const result = JSON.parse(answer.ok.text);
    result.bytes = Buffer.from(result.audio, 'base64');
    return result;
}

/** speak and then speak_next until the last slice */
async function speakAll(h, text, rate) {
    const results = [];
    let result = parse(await h.action('speak', { text: text, format: 'ima_adpcm', rate: rate }));
    results.push(result);
    while (!result.last) {
        assert.ok(results.length < 50, 'never got to the last slice');
        result = parse(await h.action('speak_next', { text: text, next: result.next, format: 'ima_adpcm' }));
        results.push(result);
    }
    return results;
}

/** What one pass of the encoder over every piece makes, as the watch app would */
function reference(h, pieces, rate) {
    let gain = 0;
    const state = { predictor: 0, index: 0 };
    const out = pieces.map((words) => {
        const wav = codec.parseWav(cases.arrayBuffer(h.ha.speechFor(words, { preferred_sample_rate: rate })));
        const samples = codec.resample(wav.samples, wav.rate, rate);
        if (!gain) { gain = Math.round(codec.gainFor(samples) * 100); }
        return Buffer.from(codec.encodeAdpcm(codec.amplify(samples, gain / 100), state));
    });
    return { pieces: out, all: Buffer.concat(out) };
}

function piecesOf(h, text) {
    const engine = h.engine();
    const pieces = engine.require('speech').piecesOf(text);
    engine.end();
    return pieces;
}

function ttsPosts(h) {
    return h.ha.calls('POST /api/tts_get_url').map((r) => r.body.message);
}

test('speak asks Home Assistant for the pipeline\'s voice as WAV and answers with ADPCM in text', async () => {
    const h = setUp();
    const result = parse(await h.action('speak', { text: 'Hello there, the garage door is closed.', format: 'ima_adpcm' }));

    const post = h.ha.calls('POST /api/tts_get_url')[0];
    assert.deepEqual(post.body, {
        engine_id: 'tts.piper',
        message: 'Hello there, the garage door is closed.',
        language: 'en-GB',
        options: {
            preferred_format: 'wav', preferred_sample_rate: 8000, preferred_sample_channels: 1,
            preferred_sample_bytes: 2, voice: 'en_GB-alba-medium'
        }
    });
    assert.equal(post.headers['content-type'], 'application/json');

    const get = h.ha.calls(/^GET \/api\/tts_proxy\//);
    assert.equal(get.length, 1);
    assert.equal(get[0].origin, harness.URL, 'used the url Home Assistant made, not the path');
    assert.equal(get[0].responseType, 'arraybuffer');
    assert.equal(get[0].headers['content-type'], undefined);

    const expected = reference(h, ['Hello there, the garage door is closed.'], 8000);
    assert.equal(result.v, 1);
    assert.equal(result.format, 'ima_adpcm');
    assert.equal(result.rate, 8000);
    assert.equal(result.offset, 0);
    assert.equal(result.phrase, true);
    assert.equal(result.last, true);
    assert.equal(result.next, undefined);
    assert.deepEqual(result.bytes, expected.all);
});

test('the language falls back to the pipeline\'s own, and a voice is only sent when there is one', async () => {
    const h = setUp();
    h.ha.pipelines.pipelines[1] = { id: 'p2', name: 'Kitchen', language: 'nl', tts_engine: 'tts.piper' };
    await h.action('speak', { text: 'Hallo daar, alles is in orde.', format: 'ima_adpcm', rate: 16000 });
    const body = h.ha.calls('POST /api/tts_get_url')[0].body;
    assert.equal(body.language, 'nl');
    assert.equal(body.options.voice, undefined);
    assert.equal(body.options.preferred_sample_rate, 16000);
});

test('every slice from speak and speak_next joined is one encode of every piece', async () => {
    const h = setUp();
    const pieces = piecesOf(h, TEXT);
    assert.equal(pieces.length, 4, JSON.stringify(pieces));
    assert.equal(pieces[0], 'The front door is locked and the garage is closed.');
    pieces.forEach((p) => assert.ok(p.length <= 200 || !/[.!?] /.test(p), p));

    const results = await speakAll(h, TEXT, 8000);
    const expected = reference(h, pieces, 8000);
    assert.deepEqual(Buffer.concat(results.map((r) => r.bytes)), expected.all);

    // Each slice sits right after the one before it
    let offset = 0;
    results.forEach((r) => {
        assert.equal(r.offset, offset);
        assert.ok(r.bytes.length <= 32768);
        offset += r.bytes.length;
    });
    // Long pieces are cut at the cap, and only a slice that ends a piece is a phrase
    assert.ok(results.length > pieces.length, 'no piece was long enough to be cut');
    let end = 0;
    const pieceEnds = expected.pieces.map((p) => (end += p.length));
    results.forEach((r) => {
        assert.equal(r.phrase, pieceEnds.indexOf(r.offset + r.bytes.length) !== -1, 'phrase at ' + r.offset);
        if (!r.phrase) { assert.equal(r.bytes.length, 32768); }
    });
    assert.deepEqual(results.map((r) => r.last), results.map((r, i) => i === results.length - 1));
    // The encoder carries on from where each piece left it, not from silence
    assert.ok(results.some((r) => r.next && !/\.0\.0\.\d+$/.test(r.next)), 'no cursor carried the encoder');
});

test('16 kHz is the same, at twice the bytes', async () => {
    const h = setUp();
    const text = 'The front door is locked and the garage is closed. That is all for now.';
    const results = await speakAll(h, text, 16000);
    results.forEach((r) => assert.equal(r.rate, 16000));
    assert.deepEqual(Buffer.concat(results.map((r) => r.bytes)), reference(h, piecesOf(h, text), 16000).all);
});

test('the same cursor gives the same bytes, so a lost call can be made again', async () => {
    const h = setUp();
    const first = parse(await h.action('speak', { text: TEXT, format: 'ima_adpcm' }));
    const a = parse(await h.action('speak_next', { text: TEXT, next: first.next, format: 'ima_adpcm' }));
    const b = parse(await h.action('speak_next', { text: TEXT, next: first.next, format: 'ima_adpcm' }));
    assert.deepEqual(a, b);
    const again = parse(await h.action('speak', { text: TEXT, format: 'ima_adpcm' }));
    assert.deepEqual(again, first);
});

test('each call starts the next piece and no further', async () => {
    const h = setUp();
    const pieces = piecesOf(h, TEXT);
    const first = parse(await h.action('speak', { text: TEXT, format: 'ima_adpcm' }));
    assert.deepEqual(ttsPosts(h), [pieces[0], pieces[1]]);
    // The next piece is only asked for once its own has arrived
    const order = h.ha.calls().filter((r) => r.path !== '/api/websocket').map((r) => r.method);
    assert.deepEqual(order, ['POST', 'GET', 'POST']);

    h.ha.requests.length = 0;
    await h.action('speak_next', { text: TEXT, next: first.next, format: 'ima_adpcm' });
    assert.deepEqual(ttsPosts(h), [pieces[1], pieces[2]]);
});

test('the last piece starts nothing more', async () => {
    const h = setUp();
    await h.action('speak', { text: 'Only one short sentence here.', format: 'ima_adpcm' });
    assert.equal(ttsPosts(h).length, 1);
});

test('the voice is looked up once an hour, and again when the pipeline changes', async () => {
    const h = setUp();
    const lists = () => h.ha.commands().filter((c) => c.type === 'assist_pipeline/pipeline/list').length;
    const first = parse(await h.action('speak', { text: TEXT, format: 'ima_adpcm' }));
    await h.action('speak_next', { text: TEXT, next: first.next, format: 'ima_adpcm' });
    assert.equal(lists(), 1);
    h.advance(61 * 60000);
    await h.action('speak', { text: 'Short and sweet, that is it.', format: 'ima_adpcm' });
    assert.equal(lists(), 2);
    h.settings({ selected_pipeline: 'p1', available_pipelines: [{ id: 'p1' }, { id: 'p2' }] });
    const answer = await h.action('speak', { text: 'Short and sweet, that is it.', format: 'ima_adpcm' });
    assert.equal(lists(), 3);
    assert.equal(answer.error.code, 'PLUGIN_UNAVAILABLE');
});

test('a pipeline deleted since the app looked gives way to the preferred one', async () => {
    const h = setUp({ selected_pipeline: 'gone', available_pipelines: [] });
    h.ha.pipelines.preferred_pipeline = 'p2';
    assert.ok(parse(await h.action('speak', { text: 'Short and sweet, that is it.', format: 'ima_adpcm' })));
});

test('speak needs neither Share with Apps nor anything shared', async () => {
    const h = setUp({ plugin_share_assistant: false, plugin_exposed_entities: [] });
    assert.ok(parse(await h.action('speak', { text: 'Short and sweet, that is it.', format: 'ima_adpcm' })));
});

test('a pipeline without text-to-speech is PLUGIN_UNAVAILABLE', async () => {
    const h = setUp({ selected_pipeline: 'p1' });
    const answer = await h.action('speak', { text: 'Hello there.', format: 'ima_adpcm' });
    assert.deepEqual(answer.error, { code: 'PLUGIN_UNAVAILABLE', message: 'The assistant\'s pipeline in Home Assistant has no text-to-speech' });
    assert.equal(h.ha.calls('POST /api/tts_get_url').length, 0);
});

test('bad arguments are INVALID_ARGS and ask Home Assistant nothing', async () => {
    const h = setUp();
    const bad = [
        ['speak', { text: 'Hello there.' }],
        ['speak', { text: 'Hello there.', format: 'mp3' }],
        ['speak', { text: '   ', format: 'ima_adpcm' }],
        ['speak', { text: 'https://example.com/only-a-link', format: 'ima_adpcm' }],
        ['speak', { text: 'x'.repeat(20001), format: 'ima_adpcm' }],
        ['speak', { text: 'Hello there.', format: 'ima_adpcm', rate: 11025 }],
        ['speak', { text: 'Hello there.', format: 'ima_adpcm', rate: '8000' }],
        ['speak_next', { text: TEXT, format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: 'garbage', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '2.8000.1.0.100.0.0.150', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.11025.1.0.100.0.0.150', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.8000.1.0.100.0.0.50', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.8000.1.0.100.0.0.401', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.8000.1.0.100.0.0.0', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.8000.1.0.100.40000.0.150', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.8000.1.0.100.0.89.150', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.8000.0.0.100.0.0.150', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.8000.0.0.0.5.0.150', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.8000.1.0.99999999.0.0.150', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.8000.9.0.100.0.0.150', format: 'ima_adpcm' }],
        ['speak_next', { text: TEXT, next: '1.8000.1.0.100.0.0.150', format: 'pcm' }]
    ];
    for (const [name, args] of bad) {
        const answer = await h.action(name, args);
        assert.equal(answer.error && answer.error.code, 'INVALID_ARGS', name + ' ' + JSON.stringify(args).slice(0, 80));
    }
    assert.equal(h.ha.requests.length, 0);
});

test('a cursor past the end of its piece, or from other text, is INVALID_ARGS', async () => {
    const h = setUp();
    const first = parse(await h.action('speak', { text: TEXT, format: 'ima_adpcm' }));
    const parts = first.next.split('.');
    parts[3] = '999999';
    assert.equal((await h.action('speak_next', { text: TEXT, next: parts.join('.'), format: 'ima_adpcm' })).error.code, 'INVALID_ARGS');
    assert.equal((await h.action('speak_next', { text: 'One sentence only, nothing more.', next: first.next, format: 'ima_adpcm' }))
        .error.code, 'INVALID_ARGS');
});

test('Home Assistant failing to say it is UNKNOWN', async () => {
    const h = setUp();
    const text = 'Short and sweet, that is it.';

    h.ha.on('GET', /^\/api\/tts_proxy\//, () => ({ status: 500, body: 'Error' }));
    assert.equal((await h.action('speak', { text: text, format: 'ima_adpcm' })).error.code, 'UNKNOWN');

    h.ha.routes = [];
    h.ha.on('GET', /^\/api\/tts_proxy\//, () => ({ status: 200, body: Buffer.from([0xFF, 0xFB, 0x90, 0x64, 1, 2, 3, 4]) }));
    assert.deepEqual((await h.action('speak', { text: text, format: 'ima_adpcm' })).error,
        { code: 'UNKNOWN', message: 'Home Assistant sent audio that is not PCM WAV' });

    h.ha.routes = [];
    // What Home Assistant answers when making the speech failed
    h.ha.on('GET', /^\/api\/tts_proxy\//, () => ({ status: 404, body: '404: Not Found' }));
    assert.deepEqual((await h.action('speak', { text: text, format: 'ima_adpcm' })).error,
        { code: 'UNKNOWN', message: 'Home Assistant could not say that' });

    h.ha.routes = [];
    h.ha.ttsEngines = [];
    assert.deepEqual((await h.action('speak', { text: text, format: 'ima_adpcm' })).error,
        { code: 'UNKNOWN', message: 'Home Assistant did not accept that: Provider tts.piper not found' });

    h.ha.ttsEngines = ['tts.piper'];
    h.ha.on('POST', '/api/tts_get_url', () => ({ status: 500, body: 'Error' }));
    assert.equal((await h.action('speak', { text: text, format: 'ima_adpcm' })).error.code, 'UNKNOWN');
});

test('a lookahead that fails still answers with the slice', async () => {
    const h = setUp();
    let posts = 0;
    h.ha.on('POST', '/api/tts_get_url', (req, next) => (++posts === 2 ? { status: 500, body: 'Error' } : next()));
    assert.ok(parse(await h.action('speak', { text: TEXT, format: 'ima_adpcm' })));
});

test('a refused token is AUTH_REQUIRED, and a Home Assistant that is down PLUGIN_UNAVAILABLE', async () => {
    const h = setUp();
    h.ha.token = 'another-token';
    assert.equal((await h.action('speak', { text: 'Hello there.', format: 'ima_adpcm' })).error.code, 'AUTH_REQUIRED');

    const down = setUp();
    down.ha.reachable = false;
    assert.equal((await down.action('speak', { text: 'Hello there.', format: 'ima_adpcm' })).error.code, 'PLUGIN_UNAVAILABLE');
});

test('no result or log names the address, the token or where the audio is', async () => {
    const h = setUp();
    const texts = (await speakAll(h, TEXT, 8000)).map((r) => JSON.stringify(Object.assign({}, r, { bytes: undefined })));
    h.ha.on('GET', /^\/api\/tts_proxy\//, () => ({ status: 400, body: { message: 'Bad request for ' + harness.URL + '/api/tts_proxy/x' } }));
    const failed = await h.action('speak', { text: 'Short and sweet, that is it.', format: 'ima_adpcm' });
    texts.push(JSON.stringify(failed));
    const tokens = Array.from(h.ha.ttsTokens.keys());
    texts.concat(h.logs).forEach((text) => {
        assert.ok(text.indexOf('ha.test') === -1, 'the address in ' + text.slice(0, 200));
        assert.ok(text.indexOf('homeassistant.local') === -1, 'Home Assistant\'s url in ' + text.slice(0, 200));
        assert.ok(text.indexOf(harness.TOKEN) === -1, 'the token in ' + text.slice(0, 200));
        assert.ok(text.indexOf('tts_proxy') === -1, 'the audio\'s path in ' + text.slice(0, 200));
        tokens.forEach((token) => assert.ok(text.indexOf(token) === -1, 'an audio token in ' + text.slice(0, 200)));
    });
});

test('only an audio slice is a long result', async () => {
    const h = setUp();
    const results = await speakAll(h, TEXT, 8000);
    results.forEach((r) => {
        const rest = JSON.stringify(Object.assign({}, r, { audio: '', bytes: undefined }));
        assert.ok(rest.length < 200, rest);
    });
    const error = await h.action('speak', { text: TEXT, format: 'mp3' });
    assert.ok(JSON.stringify(error).length < 200);
});

test('the manifest declares speak and speak_next for watch apps, with Location and a required format', () => {
    const manifest = harness.manifest();
    ['speak', 'speak_next'].forEach((name) => {
        const action = manifest.actions.find((a) => a.name === name);
        assert.ok(action, name);
        assert.deepEqual(action.callerPermissions, ['Location']);
        assert.ok(action.parameters.required.includes('format'));
        assert.ok(action.parameters.required.includes('text'));
        assert.deepEqual(action.parameters.properties.format.enum, ['ima_adpcm']);
        assert.match(action.description, /^For watch apps using the Home Assistant speech SDK\. Returns encoded audio, not words: never call it to answer or talk to the user; use ask_assistant\./);
    });
});

test('ask_assistant with speak answers with the reply and a cursor, having started its speech', async () => {
    const h = setUp({ plugin_share_assistant: true });
    const said = 'The front door is locked and the garage is closed. Everything else is fine too.';
    h.ha.assist = () => ({ response: { response_type: 'query_answer', speech: { plain: { speech: said } } } });
    const answer = await h.action('ask_assistant', { text: 'is the house locked', speak: true, rate: 16000 });
    assert.ok(answer.ok.refreshed.includes('home/light'));
    const result = JSON.parse(answer.ok.text);
    assert.deepEqual(Object.keys(result).sort(), ['next', 'reply']);
    assert.equal(result.reply, said);
    assert.ok(answer.ok.text.length < 200 + said.length);

    // Home Assistant is already making the first piece, and nothing was waited for
    assert.deepEqual(ttsPosts(h), [piecesOf(h, said)[0]]);
    assert.equal(h.ha.calls('POST /api/tts_get_url')[0].body.options.preferred_sample_rate, 16000);
    assert.equal(h.ha.calls(/^GET \/api\/tts_proxy\//).length, 0);

    // The SDK hands the reply back with the cursor
    const results = [parse(await h.action('speak_next', { text: result.reply, next: result.next, format: 'ima_adpcm' }))];
    while (!results[results.length - 1].last) {
        const next = results[results.length - 1].next;
        results.push(parse(await h.action('speak_next', { text: result.reply, next: next, format: 'ima_adpcm' })));
    }
    results.forEach((r) => assert.equal(r.rate, 16000));
    assert.deepEqual(Buffer.concat(results.map((r) => r.bytes)), reference(h, piecesOf(h, said), 16000).all);
});

test('ask_assistant without speak is plain text and makes no speech', async () => {
    const h = setUp({ plugin_share_assistant: true });
    const answer = await h.action('ask_assistant', { text: 'turn on the kitchen light', rate: 16000 });
    assert.equal(answer.ok.text, 'Turned on the kitchen light.');
    assert.equal(h.ha.calls('POST /api/tts_get_url').length, 0);
    assert.equal(h.ha.commands().filter((c) => c.type === 'assist_pipeline/pipeline/list').length, 0);
});

test('ask_assistant still gets its reply back when the reply cannot be spoken', async () => {
    const h = setUp({ plugin_share_assistant: true, selected_pipeline: 'p1' });
    let result = JSON.parse((await h.action('ask_assistant', { text: 'lights on', speak: true })).ok.text);
    assert.deepEqual(result, {
        reply: 'Turned on the kitchen light.',
        speech_error: 'The assistant\'s pipeline in Home Assistant has no text-to-speech'
    });

    const failing = setUp({ plugin_share_assistant: true });
    failing.ha.on('POST', '/api/tts_get_url', () => ({ status: 500, body: 'Error' }));
    result = JSON.parse((await failing.action('ask_assistant', { text: 'lights on', speak: true })).ok.text);
    assert.equal(result.reply, 'Turned on the kitchen light.');
    assert.equal(result.next, undefined);
    assert.equal(typeof result.speech_error, 'string');

    // Nothing to say is not an error
    const silent = setUp({ plugin_share_assistant: true });
    silent.ha.assist = () => ({ response: { response_type: 'query_answer', speech: { plain: { speech: '![map](http://x/y.png)' } } } });
    result = JSON.parse((await silent.action('ask_assistant', { text: 'map', speak: true })).ok.text);
    assert.deepEqual(result, { reply: '![map](http://x/y.png)' });
    assert.equal(silent.ha.calls('POST /api/tts_get_url').length, 0);
});

test('ask_assistant with speak checks the rate first, and still needs Share with Apps', async () => {
    const h = setUp({ plugin_share_assistant: true });
    assert.equal((await h.action('ask_assistant', { text: 'hi', speak: true, rate: 44100 })).error.code, 'INVALID_ARGS');
    assert.equal(h.ha.sockets.length, 0, 'asked the assistant before refusing');

    const off = setUp({ plugin_share_assistant: false });
    assert.equal((await off.action('ask_assistant', { text: 'hi', speak: true })).error.code, 'PERMISSION_DENIED');
    assert.equal(off.ha.sockets.length, 0);
});

test('the manifest offers speak on ask_assistant, for watch apps only', () => {
    const action = harness.manifest().actions.find((a) => a.name === 'ask_assistant');
    assert.equal(action.parameters.properties.speak.type, 'boolean');
    assert.match(action.parameters.properties.speak.description, /^For watch apps using the Home Assistant speech SDK only/);
    assert.deepEqual(action.parameters.properties.rate.enum, [8000, 16000]);
    assert.deepEqual(action.parameters.required, ['text']);
});

test('every reply ask_assistant hands a cursor out for can be read out with it', async () => {
    const h = setUp({ plugin_share_assistant: true });
    const long = 'The garage is closed and all is well. '.repeat(120);
    h.ha.assist = () => ({ response: { response_type: 'query_answer', speech: { plain: { speech: long } } } });
    const result = JSON.parse((await h.action('ask_assistant', { text: 'x', speak: true })).ok.text);
    assert.ok(result.reply.length > 4000 && result.next);
    assert.ok(parse(await h.action('speak_next', { text: result.reply, next: result.next, format: 'ima_adpcm' })));

    const huge = 'The garage is closed and all is well. '.repeat(600);
    h.ha.assist = () => ({ response: { response_type: 'query_answer', speech: { plain: { speech: huge } } } });
    const refused = JSON.parse((await h.action('ask_assistant', { text: 'x', speak: true })).ok.text);
    assert.deepEqual(refused, { reply: huge, speech_error: 'The reply is too long to read out' });
});
