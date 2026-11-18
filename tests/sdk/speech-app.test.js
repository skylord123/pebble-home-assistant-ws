/**
 * The watch app's own spoken answers (src/js/app/Speech.js), which fetch the
 * speech from Home Assistant themselves and play it through the speech kit's
 * player over ui/speaker.js. Home Assistant is the plugin harness's fake, and
 * the watch is the fake speaker in fake-watch.js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const harness = require('../plugin/harness');
const fakeWatch = require('./fake-watch');

const ROOT = path.join(__dirname, '..', '..');

const VOICE_PIPELINE = {
    id: 'p2', name: 'Kitchen', language: 'en', stt_engine: 'stt.x',
    tts_engine: 'tts.piper', tts_voice: 'en_GB-alba-medium', tts_language: 'en-GB'
};

/** An XMLHttpRequest over the fake Home Assistant's fetch */
function xhrFor(ha) {
    return function FakeXHR() {
        const xhr = this;
        let method;
        let url;
        const headers = {};
        let aborted = false;
        xhr.readyState = 0;
        xhr.responseType = '';
        xhr.open = (m, u) => { method = m; url = u; xhr.readyState = 1; };
        xhr.setRequestHeader = (k, v) => { headers[k] = v; };
        xhr.abort = () => { aborted = true; };
        xhr.send = (body) => {
            ha.fetch(url, { method: method, headers: headers, body: body || undefined,
                responseType: xhr.responseType }).then((res) => {
                xhr.status = res.status;
                return xhr.responseType === 'arraybuffer' && res.ok ?
                    res.arrayBuffer().then((b) => { xhr.response = b; }) :
                    res.text().then((t) => { xhr.responseText = t; });
            }).then(() => {
                if (aborted) { return; }
                xhr.readyState = 4;
                xhr.onreadystatechange();
            });
        };
    };
}

/**
 * Speech.js loaded with the real ui/speaker.js, speech-codec and ha_speech,
 * and a stand-in for the app's message queue that carries each message to
 * the fake watch one at a time
 */
function setUp(opts) {
    opts = opts || {};
    const h = harness.create();
    const settings = Object.assign({ assist_speak: true }, opts.settings || {});
    const sent = [];
    const queue = [];
    let sending = false;
    let Speaker;

    const watch = fakeWatch.create({
        capacity: opts.capacity || 6000,
        muted: opts.muted,
        report: (status) => setImmediate(() => Speaker.emitStatus(status.clip, status.state, status.played, status.capacity))
    });

    function cycle() {
        if (!queue.length) {
            sending = false;
            Speaker.emitIdle();
            return;
        }
        const bytes = queue.shift();
        sent.push(bytes);
        watch.receive(bytes);
        // A real link takes time; with none, there is no speed to measure
        if (opts.linkMs) { setTimeout(cycle, opts.linkMs); } else { setImmediate(cycle); }
    }

    function queueMessage(bytes) {
        queue.push(bytes);
        if (sending) { return; }
        sending = true;
        setImmediate(cycle);
    }

    const le32 = fakeWatch.le32;
    const simply = {
        impl: {
            speakerPlay: (clip, rate, prebuffer, total, volume) =>
                queueMessage([1, clip, rate, volume, 0].concat(le32(prebuffer), le32(total))),
            speakerData: (clip, offset, bytes, flags) =>
                queueMessage([2, clip, flags].concat(le32(offset), Array.from(bytes))),
            speakerStop: (clip) => queueMessage([3, clip]),
            isIdle: () => !sending
        }
    };

    const cache = {};
    const stubs = {
        'settings': { option: (k, v) => { if (arguments.length > 1 || v !== undefined) { settings[k] = v; } return settings[k]; } },
        'ui/simply': simply,
        'app/AppState': { getInstance: () => ({
            ha_url: h.ha.url, ha_password: h.ha.token, ha_pipelines: [VOICE_PIPELINE], selected_pipeline: 'p2'
        }) },
        'app/helpers': { log_message: () => {} }
    };
    const files = {
        'ui/speaker': 'src/js/ui/speaker.js',
        'app/speech-codec': 'src/js/app/speech-codec.js',
        'ha_speech': 'sdk/speech/ha_speech.js',
        'app/Speech': 'src/js/app/Speech.js'
    };
    const Pebble = { getActiveWatchInfo: () => ({ platform: 'emery' }) };
    function load(name) {
        if (stubs[name]) { return stubs[name]; }
        if (cache[name]) { return cache[name].exports; }
        if (!files[name]) { throw new Error('unexpected require ' + name); }
        const module = cache[name] = { exports: {} };
        new Function('require', 'module', 'exports', 'XMLHttpRequest', 'Pebble',
            fs.readFileSync(path.join(ROOT, files[name]), 'utf8'))(load, module, module.exports, xhrFor(h.ha), Pebble);
        return module.exports;
    }
    Speaker = load('ui/speaker');
    const Speech = load('app/Speech');
    return { h, Speech, watch, sent, settings };
}

/** Play out whatever the watch is given, a little at a time, until it has nothing */
async function playOut(watch, bytesPerTick) {
    for (let i = 0; i < 20000; i++) {
        await new Promise((r) => setImmediate(r));
        if (watch.state !== null && !watch.active) {
            // and the phone has heard about it
            for (let j = 0; j < 5; j++) { await new Promise((r) => setImmediate(r)); }
            return;
        }
        watch.tick(bytesPerTick || 400);
    }
    throw new Error('the watch never finished');
}

test('the app\'s spoken answer goes to the watch within its ring, sentence by sentence', async () => {
    const { Speech, watch, sent, h } = setUp({ settings: { assist_speak_volume: 75 } });
    const problems = [];
    Speech.begin((p) => problems.push(p));
    Speech.write('The front door is locked and the garage is closed. ');
    Speech.write('The front door is locked and the garage is closed. The kitchen light is on. ');
    Speech.write('The front door is locked and the garage is closed. The kitchen light is on. That is all.');
    Speech.end('The front door is locked and the garage is closed. The kitchen light is on. That is all.');
    await playOut(watch);

    assert.deepEqual(watch.violations, []);
    assert.equal(watch.statuses[watch.statuses.length - 1].state, fakeWatch.STATES.DONE);
    assert.ok(watch.maxHeld <= watch.capacity);
    const play = watch.messages[0];
    assert.equal(play.op, 'play');
    assert.equal(play.rate, 0);
    assert.equal(play.volume, 75);
    // Every sentence ends a phrase, and the last piece says so
    const data = watch.messages.filter((m) => m.op === 'data' && m.bytes.length);
    assert.equal(data.filter((m) => m.flags & fakeWatch.FLAG_PHRASE).length, 2);
    const last = watch.messages.filter((m) => m.op === 'data' && (m.flags & fakeWatch.FLAG_LAST));
    assert.equal(last.length, 1);
    // Asked for at 8 kHz with the pipeline's voice: the first sentence alone,
    // to start soon, and the short ones after it together
    const asked = h.ha.requests.filter((r) => r.path === '/api/tts_get_url').map((r) => r.body);
    assert.deepEqual(asked.map((b) => b.message), ['The front door is locked and the garage is closed.',
        'The kitchen light is on. That is all.']);
    assert.ok(asked.every((b) => b.options.preferred_sample_rate === 8000 && b.options.voice === 'en_GB-alba-medium'));
    assert.deepEqual(problems, []);
    assert.equal(Speech.isSpeaking(), false);
    assert.ok(sent.length > 3);
});

test('the app keeps the link speed it measures under its own setting', async () => {
    const { Speech, watch, settings } = setUp({ capacity: 4000, linkMs: 2 });
    Speech.speak('The front door is locked and the garage is closed, and the kitchen light has been on since this morning.');
    await playOut(watch);
    assert.deepEqual(watch.violations, []);
    assert.ok(Number(settings.assist_speak_link_bps) > 0, 'measured ' + settings.assist_speak_link_bps);
});

test('a muted watch is not a problem for the app, and nothing more is sent', async () => {
    const { Speech, watch } = setUp({ muted: true });
    const problems = [];
    Speech.speak('The front door is locked.', (p) => problems.push(p));
    await playOut(watch);
    assert.equal(watch.state, fakeWatch.STATES.MUTED);
    assert.deepEqual(problems, []);
    assert.equal(Speech.isSpeaking(), false);
    assert.equal(watch.messages.filter((m) => m.op === 'data').length, 0);
});

test('stopping the app\'s answer tells the watch', async () => {
    const { Speech, watch } = setUp();
    Speech.speak('The front door is locked and the garage is closed. The kitchen light is on.');
    for (let i = 0; i < 2000 && !watch.active; i++) { await new Promise((r) => setImmediate(r)); }
    Speech.stop();
    for (let i = 0; i < 20; i++) { await new Promise((r) => setImmediate(r)); }
    assert.equal(watch.messages[watch.messages.length - 1].op, 'stop');
    assert.equal(Speech.isSpeaking(), false);
});

test('Home Assistant failing to say it is told under the answer', async () => {
    const { Speech, h } = setUp();
    h.ha.ttsEngines = [];
    const problems = [];
    Speech.speak('The front door is locked.', (p) => problems.push(p));
    for (let i = 0; i < 200 && !problems.length; i++) { await new Promise((r) => setImmediate(r)); }
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^Not read aloud: Home Assistant: Provider tts.piper not found/);
});
