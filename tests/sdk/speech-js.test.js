/**
 * The speech kit's phone side (sdk/speech/ha_speech.js), as another app uses
 * it: loaded with require(), talking to a fake watch speaker (fake-watch.js)
 * over a fake Pebble.sendAppMessage, and to the real plugin through a fake
 * Pebble.invokeAction answered by the plugin harness and its fake Home
 * Assistant.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const harness = require('../plugin/harness');
const fakeWatch = require('./fake-watch');
const HaSpeech = require('../../sdk/speech/ha_speech');

const ROOT = path.join(__dirname, '..', '..');
const KIT = path.join(ROOT, 'sdk', 'speech', 'ha_speech.js');
const KEY = 'HA_SPEECH';
const { STATES, FLAG_LAST, FLAG_PHRASE } = fakeWatch;

const VOICE_PIPELINE = {
    id: 'p2', name: 'Kitchen', language: 'en', stt_engine: 'stt.x',
    tts_engine: 'tts.piper', tts_voice: 'en_GB-alba-medium', tts_language: 'en-GB'
};

//! Several pieces, two of them too long for one slice at 8 kHz
const TEXT = 'The front door is locked and the garage is closed. ' +
    'The kitchen light has been on since this morning, and the living room is at twenty one degrees. ' +
    'Nobody has opened the back door today, and the porch camera saw a parcel arrive at noon. ' +
    'The washing machine finished its cycle twenty minutes ago and is waiting to be emptied now. ' +
    'That is all.';

function memoryStorage(values) {
    const items = Object.assign({}, values || {});
    return {
        items: items,
        getItem: (k) => (k in items ? items[k] : null),
        setItem: (k, v) => { items[k] = String(v); }
    };
}

function tick() {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A Pebble for the kit: sendAppMessage carries each message to `watch` after
 * `latency` ms, unless `nack(bytes, attempt)` says to refuse it, and the
 * watch's status comes back through `deliver`. invokeAction is answered by
 * the plugin in `h`.
 */
function fakePebble(opts) {
    const attempts = new Map();
    const pebble = {
        platform: opts.platform || 'emery',
        latency: opts.latency || 0,
        nack: opts.nack || null,
        //! Every message as it was sent, resends included
        sent: [],
        inFlight: 0,
        maxInFlight: 0,
        //! Every invokeAction request
        invoked: [],
        getActiveWatchInfo: () => ({ platform: pebble.platform }),
        sendAppMessage(dict, ok, fail) {
            const keys = Object.keys(dict);
            assert.deepEqual(keys, [KEY], 'one key a message');
            const bytes = dict[KEY];
            assert.ok(Array.isArray(bytes), 'a byte array');
            bytes.forEach((b) => assert.ok(Number.isInteger(b) && b >= 0 && b <= 255, 'byte ' + b));
            pebble.sent.push(bytes.slice());
            pebble.inFlight++;
            pebble.maxInFlight = Math.max(pebble.maxInFlight, pebble.inFlight);
            const attempt = (attempts.get(bytes) || 0) + 1;
            attempts.set(bytes, attempt);
            setTimeout(() => {
                pebble.inFlight--;
                if (pebble.nack && pebble.nack(bytes, attempt)) {
                    fail({ data: dict });
                    return;
                }
                if (opts.watch) { opts.watch.receive(bytes); }
                ok({ data: dict });
            }, pebble.latency);
        }
    };
    if (opts.h) {
        pebble.invokeAction = (req) => {
            pebble.invoked.push(JSON.parse(JSON.stringify(req)));
            if (req.plugin !== HaSpeech.PLUGIN_UUID) {
                return Promise.resolve({ ok: false, code: 'PLUGIN_UNAVAILABLE', message: 'No such plugin' });
            }
            // As the Pebble app hands a result to the caller
            return opts.h.action(req.action, req.args).then((answer) => (answer.ok ?
                { ok: true, text: answer.ok.text, refreshed: answer.ok.refreshed } :
                { ok: false, code: answer.error.code, message: answer.error.message }));
        };
    }
    return pebble;
}

/**
 * The plugin with a voice to speak in, a fake watch, a Pebble joining them,
 * and the kit made the way an app makes it
 */
function setUp(opts) {
    opts = opts || {};
    const h = harness.create();
    h.ha.pipelines = {
        pipelines: [{ id: 'p1', name: 'Home', language: 'en', stt_engine: 'stt.x' }, VOICE_PIPELINE],
        preferred_pipeline: 'p1'
    };
    h.settings(Object.assign({
        selected_pipeline: 'p2',
        available_pipelines: [{ id: 'p1' }, { id: 'p2' }],
        plugin_share_assistant: true
    }, opts.settings || {}));
    let speech = null;
    const watch = fakeWatch.create({
        capacity: opts.capacity || 6000,
        muted: opts.muted,
        noMemory: opts.noMemory,
        // The watch's answer arrives as an AppMessage of its own
        report: (status) => setImmediate(() => {
            const payload = {};
            payload[KEY] = fakeWatch.wire(status);
            payload[10000] = payload[KEY];
            assert.equal(speech.handleMessage(payload), true);
        })
    });
    const pebble = fakePebble({ h: h, watch: watch, platform: opts.platform, latency: opts.latency, nack: opts.nack });
    global.Pebble = pebble;
    speech = HaSpeech.create(Object.assign({ key: KEY, storage: opts.storage || memoryStorage(), log: null },
        opts.volume !== undefined ? { volume: opts.volume } : {}));
    return { h, watch, pebble, speech };
}

/** Let the watch play what it is given, `bytes` a tick, until `promise` settles */
async function playOut(watch, promise, bytes) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    const until = Date.now() + 10000;
    while (!settled && Date.now() < until) {
        await tick();
        watch.tick(bytes || 500);
    }
    assert.ok(settled, 'never finished');
    return promise;
}

/** Every slice of `text` as the plugin gives it, asking for it directly */
async function slicesOf(h, text, rate) {
    const slices = [];
    let answer = await h.action('speak', { text: text, format: 'ima_adpcm', rate: rate });
    for (;;) {
        const slice = JSON.parse(answer.ok.text);
        slices.push(slice);
        if (slice.last) { return slices; }
        answer = await h.action('speak_next', { text: text, next: slice.next, format: 'ima_adpcm' });
    }
}

function dataMessages(watch) {
    return watch.messages.filter((m) => m && m.op === 'data');
}

test.afterEach(() => { delete global.Pebble; });

// MARK: - Loading

test('the kit loads as a plain CommonJS module and defines no globals', () => {
    const context = vm.createContext({});
    const module = { exports: {} };
    const before = Object.keys(context).sort();
    vm.runInContext('(function(module, exports, require) {' + fs.readFileSync(KIT, 'utf8') + '\n})',
        context)(module, module.exports, () => { throw new Error('the kit requires nothing'); });
    assert.deepEqual(Object.keys(context).sort(), before);
    assert.deepEqual(Object.keys(module.exports).sort(), ['AppMessageTransport', 'PLUGIN_UUID', 'Player', 'create']);
    assert.equal(typeof HaSpeech.create, 'function');
});

test('the kit is ES5, for every phone\'s JS engine', () => {
    const source = fs.readFileSync(KIT, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(source, /=>|\blet\s|\bconst\s|`|\bclass\s|\.\.\.|\basync\b|\bawait\b/);
});

test('the watch app\'s bundle defines the kit as module ha_speech', () => {
    const wscript = fs.readFileSync(path.join(ROOT, 'wscript'), 'utf8');
    assert.match(wscript, /concat_javascript\(js_path='src\/js',\s*extra=\{'ha_speech': 'sdk\/speech\/ha_speech\.js'\}\)/);
    assert.match(fs.readFileSync(path.join(ROOT, 'src', 'js', 'app', 'Speech.js'), 'utf8'), /require\('ha_speech'\)/);
});

test('the plugin UUID is Home Assistant WS\'s', () => {
    assert.equal(HaSpeech.PLUGIN_UUID, harness.appinfo.uuid);
});

// MARK: - The wire

test('messages go to the watch exactly as the brief lays them out', async () => {
    const pebble = fakePebble({});
    global.Pebble = pebble;
    const transport = new HaSpeech.AppMessageTransport(KEY);
    transport.onIdle(() => {});
    transport.play(3, 1, 4000, 70000, 50);
    transport.data(3, 0x01020304, new Uint8Array([9, 8, 7]), FLAG_LAST | FLAG_PHRASE);
    transport.data(3, 5, new Uint8Array(0), 0);
    transport.stop(3);
    for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 1)); }
    assert.deepEqual(pebble.sent, [
        [1, 3, 1, 50, 0, 0xA0, 0x0F, 0, 0, 0x70, 0x11, 0x01, 0],
        [2, 3, 3, 4, 3, 2, 1, 9, 8, 7],
        [2, 3, 0, 5, 0, 0, 0],
        [3, 3]
    ]);
});

test('a STATUS from the watch is read, and anything else is left to the app', () => {
    const transport = new HaSpeech.AppMessageTransport(KEY);
    const heard = [];
    transport.onStatus((...args) => heard.push(args));
    assert.equal(transport.handleMessage({ OTHER: 1 }), false);
    assert.equal(transport.handleMessage({}), false);
    assert.equal(transport.handleMessage(null), false);
    assert.equal(transport.handleMessage({ HA_SPEECH: [4, 7, 1, 0x10, 0x27, 0, 0, 0, 0x40, 0, 0] }), true);
    assert.deepEqual(heard, [[7, 1, 10000, 16384]]);
    // By number too, as a phone may hand the payload over
    const numbered = new HaSpeech.AppMessageTransport(10001);
    numbered.onStatus((...args) => heard.push(args));
    assert.equal(numbered.handleMessage({ 10001: [4, 2, 2, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0] }), true);
    assert.deepEqual(heard[1], [2, 2, 0xFFFFFFFF, 0]);
});

test('one message is in flight at a time, and a refused one is sent again, in order', async () => {
    const pebble = fakePebble({ latency: 1, nack: (bytes, attempt) => bytes[0] === 2 && bytes[3] === 1 && attempt <= 2 });
    global.Pebble = pebble;
    const transport = new HaSpeech.AppMessageTransport(KEY);
    let idle = 0;
    transport.onIdle(() => { idle++; });
    transport.data(1, 0, [1], 0);
    transport.data(1, 1, [2], 0);
    transport.data(1, 2, [3], 0);
    assert.equal(transport.isIdle(), false);
    for (let i = 0; i < 100 && !idle; i++) { await new Promise((r) => setTimeout(r, 2)); }
    assert.equal(idle, 1);
    assert.equal(transport.isIdle(), true);
    assert.equal(pebble.maxInFlight, 1);
    assert.deepEqual(pebble.sent.map((b) => b[3]), [0, 1, 1, 1, 2]);
});

test('a watch that refuses everything ends the clip as FAILED rather than being asked forever', async () => {
    const pebble = fakePebble({ nack: () => true });
    global.Pebble = pebble;
    const transport = new HaSpeech.AppMessageTransport(KEY);
    const heard = [];
    transport.onStatus((...args) => heard.push(args));
    transport.onIdle(() => {});
    transport.play(9, 0, 1000, 0, 100);
    for (let i = 0; i < 200 && !heard.length; i++) { await new Promise((r) => setTimeout(r, 10)); }
    assert.deepEqual(heard, [[9, STATES.FAILED, 0, 0]]);
    assert.equal(pebble.sent.length, 11);
    assert.equal(transport.isIdle(), true);
});

// MARK: - The player, on its own clock

/** A Player over the AppMessage transport and a fake watch, with mocked timers */
function playerRig(t, opts) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });
    let transport;
    const watch = fakeWatch.create({
        capacity: opts.capacity || 4000,
        report: (status) => setTimeout(() => {
            // A status the phone could not take is gone
            if (opts.drop && opts.drop(status)) { return; }
            const payload = {};
            payload[KEY] = fakeWatch.wire(status);
            transport.handleMessage(payload);
        }, 0)
    });
    const pebble = fakePebble({ watch: watch, latency: opts.latency || 10 });
    global.Pebble = pebble;
    transport = new HaSpeech.AppMessageTransport(KEY);
    const storage = memoryStorage(opts.stored);
    const player = new HaSpeech.Player({ transport: transport, storage: storage, watchdog: opts.watchdog });
    return { watch, pebble, player, storage, advance: (ms) => t.mock.timers.tick(ms) };
}

function audio(length, seed) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) { bytes[i] = (i * 7 + (seed || 0)) & 0xFF; }
    return bytes;
}

test('the player never sends more than the ring holds, in order, with phrases and the end marked', (t) => {
    const { watch, player, advance } = playerRig(t, { capacity: 4000 });
    const ends = [];
    const clip = player.begin({ rate: 8000, volume: 60, onEnd: (e, how) => ends.push([e, how]) });
    const first = audio(5000, 1);
    const second = audio(3000, 2);
    player.add(clip, first, true, false);
    player.add(clip, second, true, true);
    for (let i = 0; i < 400 && !ends.length; i++) {
        advance(20);
        watch.tick(300);
    }
    assert.deepEqual(ends, [[null, 'done']]);
    assert.deepEqual(watch.violations, []);
    assert.ok(watch.maxHeld <= 4000, 'held ' + watch.maxHeld);
    assert.deepEqual(watch.audio, Array.from(first).concat(Array.from(second)));
    const play = watch.messages[0];
    assert.equal(play.op, 'play');
    assert.equal(play.rate, 0);
    assert.equal(play.volume, 60);
    // It starts on the first piece, before the size of the whole is known
    assert.equal(play.total, 0);
    const data = dataMessages(watch);
    let offset = 0;
    data.forEach((m) => {
        assert.equal(m.offset, offset, 'contiguous');
        assert.ok(m.bytes.length <= 1800);
        offset += m.bytes.length;
    });
    assert.deepEqual(data.filter((m) => m.flags & FLAG_PHRASE).map((m) => m.offset + m.bytes.length), [5000, 8000]);
    assert.deepEqual(data.filter((m) => m.flags & FLAG_LAST).map((m) => m.offset + m.bytes.length), [8000]);
});

test('while the next piece is late, the watch is told the phone is still there', (t) => {
    const { watch, player, advance } = playerRig(t, {});
    const ends = [];
    const clip = player.begin({ rate: 8000, onEnd: (e, how) => ends.push(how) });
    player.add(clip, audio(1500), true, false);
    // Sent and played; nothing more for 20 seconds
    for (let i = 0; i < 100; i++) { advance(20); watch.tick(500); }
    const before = watch.keepAlives;
    let lastAt = Date.now();
    let longest = 0;
    for (let i = 0; i < 200; i++) {
        const count = watch.messages.length;
        advance(100);
        watch.tick(500);
        if (watch.messages.length > count) {
            longest = Math.max(longest, Date.now() - lastAt);
            lastAt = Date.now();
        }
    }
    assert.ok(watch.keepAlives - before >= 4, 'kept in touch ' + (watch.keepAlives - before) + ' times');
    assert.ok(longest < 10000, 'the watch waits ten seconds before giving up, and heard nothing for ' + longest);
    // The keep-alive is an empty piece where the audio stands, with no flags
    const alive = dataMessages(watch).filter((m) => !m.bytes.length && !m.flags);
    assert.ok(alive.every((m) => m.offset === 1500));
    assert.equal(watch.active, true);
    player.add(clip, audio(500), true, true);
    for (let i = 0; i < 100 && !ends.length; i++) { advance(20); watch.tick(500); }
    assert.deepEqual(ends, ['done']);
    assert.deepEqual(watch.violations, []);
});

test('16 kHz is chosen only once the link has been fast enough for it', (t) => {
    const slow = playerRig(t, { latency: 1000 });
    assert.equal(slow.player.rate(), 8000);
    let done = false;
    let clip = slow.player.begin({ rate: slow.player.rate(), onEnd: () => { done = true; } });
    slow.player.add(clip, audio(9000), true, true);
    for (let i = 0; i < 2000 && !done; i++) { slow.advance(20); slow.watch.tick(400); }
    assert.ok(done);
    assert.ok(Number(slow.storage.items.ha_speech_link_bps) < 12000, 'slow: ' + slow.storage.items.ha_speech_link_bps);
    assert.equal(slow.player.rate(), 8000);
    t.mock.timers.reset();

    const fast = playerRig(t, { latency: 20 });
    assert.equal(fast.player.rate(), 8000);
    done = false;
    clip = fast.player.begin({ rate: fast.player.rate(), onEnd: () => { done = true; } });
    fast.player.add(clip, audio(9000), true, true);
    for (let i = 0; i < 2000 && !done; i++) { fast.advance(20); fast.watch.tick(400); }
    assert.ok(done);
    assert.ok(Number(fast.storage.items.ha_speech_link_bps) >= 12000, 'fast: ' + fast.storage.items.ha_speech_link_bps);
    assert.equal(fast.player.rate(), 16000);
    // and the next clip goes at 16 kHz
    clip = fast.player.begin({ rate: fast.player.rate() });
    fast.player.add(clip, audio(100), true, true);
    fast.advance(50);
    assert.equal(fast.watch.messages.filter((m) => m.op === 'play').pop().rate, 1);
    fast.player.stop();
});

test('a slow link holds more back before the watch starts', (t) => {
    const slow = playerRig(t, { stored: { ha_speech_link_bps: '2000' } });
    const clip = slow.player.begin({ rate: 8000 });
    slow.player.add(clip, audio(8000), true, false);
    slow.advance(50);
    // Half a second, plus what the link falls short by over what is known
    assert.equal(slow.watch.play.prebuffer, Math.round(8000 * (1 - 2000 / 4000) + 2000));
    assert.equal(slow.watch.play.total, 0);
    slow.player.stop();
});

test('with the watchdog, playing at the speaker\'s own pace never trips it', (t) => {
    const { watch, player, advance } = playerRig(t, { capacity: 4000, watchdog: true });
    const ends = [];
    const clip = player.begin({ rate: 8000, onEnd: (e, how) => ends.push([e && e.code, how]) });
    player.add(clip, audio(12000), true, true);
    // 4000 bytes a second, as at 8 kHz
    for (let i = 0; i < 1000 && !ends.length; i++) { advance(20); watch.tick(80); }
    assert.deepEqual(ends, [[null, 'done']]);
    assert.deepEqual(watch.violations, []);
});

test('a lost room report ends the clip FAILED and stops the watch, rather than waiting forever', (t) => {
    let lost = false;
    const rig = playerRig(t, { capacity: 4000, watchdog: true,
        drop: (status) => lost && status.state === STATES.PLAYING });
    const ends = [];
    const clip = rig.player.begin({ rate: 8000, onEnd: (e, how) => ends.push([e && e.code, how]) });
    rig.player.add(clip, audio(12000), true, false);
    for (let i = 0; i < 10; i++) { rig.advance(20); rig.watch.tick(0); }
    lost = true;
    // The ring is full; the watch plays it out but none of its reports arrive
    for (let i = 0; i < 100; i++) { rig.advance(20); rig.watch.tick(80); }
    assert.deepEqual(ends, []);
    for (let i = 0; i < 300 && !ends.length; i++) { rig.advance(20); rig.watch.tick(80); }
    assert.deepEqual(ends, [['FAILED', null]]);
    rig.advance(50);
    assert.equal(rig.watch.messages[rig.watch.messages.length - 1].op, 'stop');
});

test('without the watchdog (the watch app\'s own messages) the player waits for the watch', (t) => {
    let lost = false;
    const rig = playerRig(t, { capacity: 4000, drop: (status) => lost && status.state === STATES.PLAYING });
    const ends = [];
    const clip = rig.player.begin({ rate: 8000, onEnd: (e, how) => ends.push(how) });
    rig.player.add(clip, audio(12000), true, false);
    for (let i = 0; i < 10; i++) { rig.advance(20); rig.watch.tick(0); }
    lost = true;
    for (let i = 0; i < 1000; i++) { rig.advance(20); rig.watch.tick(80); }
    assert.deepEqual(ends, []);
    rig.player.stop();
    assert.deepEqual(ends, ['stopped']);
});

test('a lost DONE still ends the clip done, once it has had time to play out', (t) => {
    const rig = playerRig(t, { capacity: 8000, watchdog: true, drop: (status) => status.state === STATES.DONE });
    const ends = [];
    const clip = rig.player.begin({ rate: 8000, onEnd: (e, how) => ends.push(how) });
    rig.player.add(clip, audio(4000), true, true);
    rig.advance(100);
    const lastAt = Date.now();
    // A second of audio, and the watch plays it all, but its DONE goes missing
    for (let i = 0; i < 100; i++) { rig.advance(20); rig.watch.tick(80); }
    assert.equal(rig.watch.state, STATES.DONE);
    assert.deepEqual(ends, []);
    for (let i = 0; i < 400 && !ends.length; i++) { rig.advance(20); }
    assert.deepEqual(ends, ['done']);
    const took = Date.now() - lastAt;
    assert.ok(took >= 5000 && took <= 1000 + 5000 + 2500, 'ended ' + took + ' ms after the last');
});

// MARK: - say(), end to end through the plugin

test('say() reads text out through the plugin, every slice in order within the ring', async () => {
    const { h, watch, pebble, speech } = setUp({ capacity: 6000, volume: 80 });
    const how = await playOut(watch, speech.say(TEXT));
    assert.equal(how, 'done');
    assert.deepEqual(watch.violations, []);
    assert.ok(watch.maxHeld <= 6000);
    assert.equal(pebble.maxInFlight, 1);

    // What the watch got is every slice the plugin makes, joined
    const slices = await slicesOf(h, TEXT, 8000);
    assert.ok(slices.length >= 4);
    const expected = Buffer.concat(slices.map((s) => Buffer.from(s.audio, 'base64')));
    assert.deepEqual(Buffer.from(watch.audio), expected);
    const data = dataMessages(watch).filter((m) => m.bytes.length || m.flags);
    let offset = 0;
    data.forEach((m) => { assert.equal(m.offset, offset); offset += m.bytes.length; });
    // A pause can fall where each piece of the plugin's ends, and nowhere else
    let at = 0;
    const phraseEnds = [];
    slices.forEach((s) => { at += Buffer.from(s.audio, 'base64').length; if (s.phrase) { phraseEnds.push(at); } });
    assert.deepEqual(data.filter((m) => m.flags & FLAG_PHRASE).map((m) => m.offset + m.bytes.length), phraseEnds);
    assert.equal(data.filter((m) => m.flags & FLAG_LAST).length, 1);
    assert.equal(watch.messages[0].volume, 80);
    assert.equal(watch.messages[0].rate, 0);

    // speak, then speak_next with the same text until the last
    assert.equal(pebble.invoked[0].plugin, HaSpeech.PLUGIN_UUID);
    assert.deepEqual(pebble.invoked[0].args, { text: TEXT, format: 'ima_adpcm', rate: 8000 });
    assert.ok(pebble.invoked.slice(1).every((r) => r.action === 'speak_next' && r.args.text === TEXT &&
        r.args.format === 'ima_adpcm' && typeof r.args.next === 'string'));
    assert.equal(pebble.invoked.length, slices.length);
});

test('say() asks for 16 kHz after fast links, and passes a pipeline on to every call', async () => {
    const { watch, pebble, speech } = setUp({ storage: memoryStorage({ ha_speech_link_bps: '20000' }) });
    const how = await playOut(watch, speech.say('The front door is locked. The garage is closed.', { pipeline: 'p2' }), 2000);
    assert.equal(how, 'done');
    assert.equal(pebble.invoked[0].args.rate, 16000);
    assert.ok(pebble.invoked.every((r) => r.args.pipeline === 'p2'));
    assert.equal(watch.messages[0].rate, 1);
});

test('a muted watch resolves muted, and nothing more is sent', async () => {
    const { watch, speech } = setUp({ muted: true });
    assert.equal(await playOut(watch, speech.say('The front door is locked.')), 'muted');
    assert.equal(dataMessages(watch).length, 0);
});

test('a watch with no room rejects NO_MEMORY', async () => {
    const { watch, speech } = setUp({ noMemory: true });
    await assert.rejects(playOut(watch, speech.say('The front door is locked.')),
        (e) => e instanceof Error && e.code === 'NO_MEMORY');
});

test('the speaker taken for an alarm resolves preempted; a watch failure rejects FAILED', async () => {
    let env = setUp();
    let promise = env.speech.say(TEXT);
    for (let i = 0; i < 2000 && !env.watch.open; i++) { await tick(); env.watch.tick(300); }
    env.watch.end(STATES.PREEMPTED);
    assert.equal(await promise, 'preempted');

    env = setUp();
    promise = env.speech.say(TEXT);
    for (let i = 0; i < 2000 && !env.watch.open; i++) { await tick(); env.watch.tick(300); }
    env.watch.end(STATES.FAILED);
    await assert.rejects(promise, (e) => e.code === 'FAILED');
});

test('stop() tells the watch, resolves stopped, and sends nothing after', async () => {
    const { watch, pebble, speech } = setUp();
    const promise = speech.say(TEXT);
    for (let i = 0; i < 2000 && !watch.open; i++) { await tick(); watch.tick(300); }
    speech.stop();
    assert.equal(await promise, 'stopped');
    const calls = pebble.invoked.length;
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 2)); }
    const last = watch.messages[watch.messages.length - 1];
    assert.equal(last.op, 'stop');
    assert.equal(last.clip, watch.clip);
    assert.ok(pebble.invoked.length <= calls + 1, 'at most the call already on its way');
    // A second stop, or one with nothing playing, does nothing
    speech.stop();
});

test('stop() before any audio has come resolves stopped and leaves the watch alone', async () => {
    const { watch, speech } = setUp();
    const promise = speech.say(TEXT);
    speech.stop();
    assert.equal(await promise, 'stopped');
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 5)); }
    assert.equal(watch.messages.length, 0);
});

test('saying something new stops what was being said', async () => {
    const { watch, speech } = setUp();
    const first = speech.say(TEXT);
    for (let i = 0; i < 2000 && !watch.open; i++) { await tick(); watch.tick(300); }
    const second = speech.say('That is all.');
    assert.equal(await first, 'stopped');
    assert.equal(await playOut(watch, second), 'done');
    assert.deepEqual(watch.violations, []);
});

test('the plugin\'s errors reject with its code', async () => {
    let env = setUp();
    env.h.ha.ttsEngines = [];
    await assert.rejects(env.speech.say('The front door is locked.'), (e) => e.code === 'UNKNOWN' && /Provider/.test(e.message));

    env = setUp();
    await assert.rejects(env.speech.say('   '), (e) => e.code === 'INVALID_ARGS');

    env = setUp();
    delete env.pebble.invokeAction;
    await assert.rejects(env.speech.say('Hello.'), (e) => e.code === 'PLUGIN_UNAVAILABLE');
});

test('when the rest cannot be had, what came still plays and the error follows', async () => {
    const { h, watch, speech } = setUp();
    let calls = 0;
    h.ha.routes.push({ method: 'POST', pattern: '/api/tts_get_url', handler: () => (++calls > 2 ? { status: 500, body: { message: 'boom' } } : undefined) });
    const promise = speech.say(TEXT);
    await assert.rejects(playOut(watch, promise), (e) => e.code === 'UNKNOWN');
    assert.ok(watch.audio.length > 0);
    assert.equal(watch.state, STATES.DONE);
    assert.deepEqual(watch.violations, []);
});

// MARK: - ask() and playReply()

test('ask() resolves the reply at once and reads it out', async () => {
    const { h, watch, pebble, speech } = setUp();
    const said = 'The front door is locked and the garage is closed. Everything else is fine too.';
    h.ha.assist = () => ({ response: { response_type: 'query_answer', speech: { plain: { speech: said } } } });
    const answer = await speech.ask('is the house locked');
    assert.equal(answer.text, said);
    assert.equal(answer.answer.reply, said);
    assert.equal(pebble.invoked[0].action, 'ask_assistant');
    assert.deepEqual(pebble.invoked[0].args, { text: 'is the house locked', speak: true, rate: 8000 });
    assert.equal(await playOut(watch, answer.spoken), 'done');
    assert.ok(pebble.invoked.slice(1).every((r) => r.action === 'speak_next' && r.args.text === said));

    const slices = [];
    let answerText = (await h.action('ask_assistant', { text: 'again', speak: true })).ok.text;
    let next = JSON.parse(answerText).next;
    for (;;) {
        const slice = JSON.parse((await h.action('speak_next', { text: said, next: next, format: 'ima_adpcm' })).ok.text);
        slices.push(Buffer.from(slice.audio, 'base64'));
        if (slice.last) { break; }
        next = slice.next;
    }
    assert.deepEqual(Buffer.from(watch.audio), Buffer.concat(slices));
});

test('ask() passes its arguments on, and an error from the assistant rejects', async () => {
    const { pebble, speech, watch } = setUp();
    const answer = await speech.ask('turn on the kitchen light', { new_conversation: true, json: true });
    assert.equal(answer.text, 'Turned on the kitchen light.');
    assert.equal(answer.answer.conversation_id, 'conv-1');
    assert.equal(pebble.invoked[0].args.new_conversation, true);
    await playOut(watch, answer.spoken);

    const off = setUp({ settings: { plugin_share_assistant: false } });
    await assert.rejects(off.speech.ask('hi'), (e) => e.code === 'PERMISSION_DENIED');
});

test('playReply() reads out an answer the app asked for itself', async () => {
    const { h, watch, speech } = setUp();
    const result = await Pebble.invokeAction({ plugin: HaSpeech.PLUGIN_UUID, action: 'ask_assistant',
        args: { text: 'lights on', speak: true } });
    assert.equal(await playOut(watch, speech.playReply(result)), 'done');
    assert.ok(watch.audio.length > 0);

    // Its text, or that parsed, does as well
    assert.equal(await playOut(watch, speech.playReply(result.text)), 'done');
    assert.equal(await playOut(watch, speech.playReply(JSON.parse(result.text))), 'done');

    await assert.rejects(speech.playReply({ ok: false, code: 'PERMISSION_DENIED', message: 'no' }),
        (e) => e.code === 'PERMISSION_DENIED' && e.message === 'no');
    await assert.rejects(speech.playReply({ reply: 'Hi.', speech_error: 'The reply cannot be read out' }),
        (e) => e.code === 'UNKNOWN' && e.message === 'The reply cannot be read out');
    await assert.rejects(speech.playReply('not json'), (e) => e.code === 'UNKNOWN');
    // Nothing in it to say
    assert.equal(await speech.playReply({ reply: '' }), 'done');
    assert.ok(h);
});

// MARK: - Watches without a speaker

test('only emery and flint have a speaker; elsewhere say() rejects and ask() still answers', async () => {
    for (const platform of ['aplite', 'basalt', 'chalk', 'diorite']) {
        const { speech, pebble } = setUp({ platform: platform });
        assert.equal(speech.hasSpeaker(), false, platform);
        await assert.rejects(speech.say('Hello.'), (e) => e.code === 'NO_SPEAKER');
        assert.equal(pebble.invoked.length, 0);
        const answer = await speech.ask('lights on');
        assert.equal(answer.text, 'Turned on the kitchen light.');
        assert.equal(pebble.invoked[0].args.speak, undefined);
        await assert.rejects(answer.spoken, (e) => e.code === 'NO_SPEAKER');
        assert.equal(pebble.sent.length, 0);
    }
    for (const platform of ['emery', 'flint']) {
        assert.equal(setUp({ platform: platform }).speech.hasSpeaker(), true, platform);
    }
});

test('create() needs the message key', () => {
    assert.throws(() => HaSpeech.create({}), /message key/);
});

// MARK: - A speaker channel the app already has

/**
 * A transport with exactly ui/speaker.js's shape, carrying each message
 * straight to `watch` a moment later, as Home Assistant WS's runtime does
 * over its own messages
 */
function directTransport(watch) {
    let busy = 0;
    let statusHandler = null;
    let idleHandler = null;
    const transport = {
        calls: [],
        play(clip, rate, prebuffer, total, volume) {
            carry('play', [1, clip, rate, volume, 0].concat(le32(prebuffer), le32(total)));
        },
        data(clip, offset, bytes, flags) {
            carry('data', [2, clip, flags].concat(le32(offset), Array.from(bytes)));
        },
        stop(clip) { carry('stop', [3, clip]); },
        isIdle: () => busy === 0,
        onIdle(fn) { idleHandler = fn; },
        onStatus(fn) { statusHandler = fn; },
        status(s) { statusHandler(s.clip, s.state, s.played, s.capacity); }
    };
    function le32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
    function carry(name, bytes) {
        transport.calls.push(name);
        busy++;
        setImmediate(() => {
            watch.receive(bytes);
            if (--busy === 0 && idleHandler) { idleHandler(); }
        });
    }
    return transport;
}

function setUpWithTransport(opts) {
    opts = opts || {};
    const env = setUp(Object.assign({ platform: 'flint' }, opts));
    let transport = null;
    env.watch.report = (status) => setImmediate(() => transport.status(status));
    transport = directTransport(env.watch);
    env.transport = transport;
    env.speech = HaSpeech.create({ transport: transport, storage: memoryStorage(), log: null, volume: opts.volume });
    return env;
}

test('with a transport of its own, an app gets the same speech, and no AppMessage is sent', async () => {
    const { h, watch, pebble, speech, transport } = setUpWithTransport({ volume: 40 });
    assert.equal(await playOut(watch, speech.say(TEXT)), 'done');
    assert.deepEqual(watch.violations, []);
    assert.equal(pebble.sent.length, 0);
    assert.equal(transport.calls[0], 'play');
    assert.equal(watch.messages[0].volume, 40);
    const slices = await slicesOf(h, TEXT, 8000);
    assert.deepEqual(Buffer.from(watch.audio), Buffer.concat(slices.map((s) => Buffer.from(s.audio, 'base64'))));
    // Nothing comes in by AppMessage for the kit to take
    assert.equal(speech.handleMessage({ HA_SPEECH: [4, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0] }), false);

    const answer = await speech.ask('is the house locked');
    assert.equal(await playOut(watch, answer.spoken), 'done');
    const result = await Pebble.invokeAction({ plugin: HaSpeech.PLUGIN_UUID, action: 'ask_assistant',
        args: { text: 'lights on', speak: true } });
    const spoken = speech.playReply(result);
    for (let i = 0; i < 2000 && !watch.open; i++) { await tick(); watch.tick(300); }
    speech.stop();
    assert.equal(await spoken, 'stopped');
    await tick();
    assert.equal(watch.messages[watch.messages.length - 1].op, 'stop');
    assert.equal(pebble.sent.length, 0);
});

test('with a transport, a report that never comes is waited for unless the watchdog is asked for', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });
    const first = JSON.stringify({ audio: Buffer.from(audio(4000)).toString('base64'), rate: 8000,
        phrase: true, last: false, next: 'more' });
    async function run(watchdog) {
        let statusHandler = null;
        let idleHandler = null;
        const transport = {
            // The watch says once that it has room for half, and never again
            play(clip) { setTimeout(() => statusHandler(clip, STATES.BUFFERING, 0, 2000), 0); },
            data() { setTimeout(() => idleHandler(), 0); },
            stop() {}, isIdle: () => true,
            onIdle(fn) { idleHandler = fn; }, onStatus(fn) { statusHandler = fn; }
        };
        global.Pebble = {
            getActiveWatchInfo: () => ({ platform: 'emery' }),
            invokeAction: (req) => (req.action === 'speak' ? Promise.resolve({ ok: true, text: first }) :
                new Promise(() => {}))
        };
        const options = { transport: transport, storage: memoryStorage(), log: null };
        if (watchdog !== undefined) { options.watchdog = watchdog; }
        const speech = HaSpeech.create(options);
        let how = null;
        speech.say('Hello.').then((h) => { how = h; }, (e) => { how = e.code; });
        for (let i = 0; i < 150; i++) {
            t.mock.timers.tick(100);
            await Promise.resolve();
        }
        speech.stop();
        await Promise.resolve();
        return how;
    }
    // Home Assistant WS's own messages lose nothing, so the kit waits
    assert.equal(await run(undefined), 'stopped');
    assert.equal(await run(true), 'FAILED');
});
