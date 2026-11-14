'use strict';

/**
 * The watch half of the speech kit, sdk/speech/ha_speech.c, built for this
 * computer against a stub pebble.h and run inside a fake watch
 * (speech_host.c). Skipped when there is no C compiler.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', '..');

const codec = (() => {
    const module = { exports: {} };
    new Function('module', 'exports', fs.readFileSync(path.join(ROOT, 'src', 'js', 'app', 'speech-codec.js'), 'utf8'))(module, module.exports);
    return module.exports;
})();

// As in ha_speech.h
const BUFFERING = 0;
const PLAYING = 1;
const DONE = 2;
const STOPPED = 3;
const MUTED = 4;
const NO_MEMORY = 5;
const FAILED = 6;
const PREEMPTED = 7;
const LAST = 1;
const PHRASE = 2;
const HEAP_RESERVE = 12288;
const KEY = 42;

/** Builds the fake watch, or says why it cannot */
function build(name, defines) {
    const cc = process.env.CC || 'cc';
    if (childProcess.spawnSync(cc, ['--version']).error) { return { skip: 'no C compiler (' + cc + ')' }; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-speech-'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    const binary = path.join(dir, name);
    const result = childProcess.spawnSync(cc, ['-std=gnu11', '-Wall', '-O1',
        '-I', path.join(__dirname, 'stub')].concat(defines,
        [path.join(__dirname, 'speech_host.c'), path.join(ROOT, 'sdk', 'speech', 'ha_speech.c'),
            '-o', binary]), { encoding: 'utf8' });
    if (result.status !== 0) { throw new Error('could not build ' + name + ':\n' + result.stderr); }
    return { binary: binary };
}

const WATCH = build('speech_host', []);
const PLAIN_WATCH = WATCH.skip ? WATCH : build('speech_host_no_speaker', ['-DSTUB_NO_SPEAKER']);

/** A fake watch to give commands to, each answered with what it did */
function start(watch) {
    const child = childProcess.spawn(watch.binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = readline.createInterface({ input: child.stdout });
    const waiting = [];
    let output = [];
    lines.on('line', (line) => {
        if (line === 'ok') {
            waiting.shift().resolve(output);
            output = [];
        } else {
            output.push(line);
        }
    });
    // A crash fails the test rather than leaving it waiting
    child.on('exit', (code, signal) => {
        waiting.splice(0).forEach((w) => w.reject(new Error('the fake watch stopped: ' + (signal || code))));
    });
    async function run(...commands) {
        let all = [];
        for (const command of commands) {
            all = all.concat(await new Promise((resolve, reject) => {
                waiting.push({ resolve: resolve, reject: reject });
                child.stdin.write(command + '\n');
            }));
        }
        return all;
    }
    return {
        run: run,
        close: () => child.stdin.end(),
        /** Every report in some output, as [clip, state, played, capacity] */
        reports: (out) => out.filter((l) => l.startsWith('report ')).map((l) => l.split(' ').slice(1).map(Number)),
        /** Every message sent, as [key, Buffer] */
        sent: (out) => out.filter((l) => l.startsWith('sent ')).map((l) => {
            const parts = l.split(' ');
            return [Number(parts[1]), Buffer.from(parts[2] || '', 'hex')];
        }),
        /** Everything played since the last time this was asked */
        pcm: async () => {
            const line = (await run('pcm'))[0].split(' ');
            return Int16Array.from(line[2] ? line[2].split(',').map(Number) : []);
        }
    };
}

function speechTest(name, fn) {
    test(name, { skip: WATCH.skip }, async () => {
        const watch = start(WATCH);
        try {
            await fn(watch);
        } finally {
            watch.close();
        }
    });
}

/**
 * `count` samples that keep the decoder busy: a rising tone, bursts loud
 * enough to clip, noise and silence
 */
function samples(count, seed) {
    let random = seed || 7;
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) {
        random = (random * 1103515245 + 12345) & 0x7fffffff;
        const part = Math.floor(i / 1000) % 4;
        let v = 0;
        if (part === 0) { v = 12000 * Math.sin(i * i / 40000); }
        if (part === 1) { v = (i & 32) ? 32767 : -32768; }
        if (part === 2) { v = (random % 20000) - 10000; }
        out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
    return out;
}

function adpcm(count, seed) {
    return Buffer.from(codec.encodeAdpcm(samples(count, seed), { predictor: 0, index: 0 }));
}

/** The speaker was given exactly what the app's own decoder makes of `bytes` */
function assertDecoded(pcm, bytes) {
    const expected = codec.decodeAdpcm(bytes, { predictor: 0, index: 0 });
    assert.equal(pcm.length, expected.length);
    // Compared by hand: a diff of thousands of samples is no help to anyone
    const at = expected.findIndex((sample, i) => pcm[i] !== sample);
    assert.equal(at, -1, 'sample ' + at + ' is ' + pcm[at] + ', not ' + expected[at]);
}

function data(clip, flags, offset, bytes) {
    return 'data ' + clip + ' ' + flags + ' ' + offset + ' ' + Buffer.from(bytes || []).toString('hex');
}

function u32(value) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value);
    return b;
}

function playMessage(clip, rate, volume, prebuffer, total) {
    return Buffer.concat([Buffer.from([1, clip, rate, volume, 0]), u32(prebuffer), u32(total)]);
}

function dataMessage(clip, flags, offset, bytes) {
    return Buffer.concat([Buffer.from([2, clip, flags]), u32(offset), Buffer.from(bytes || [])]);
}

function status(clip, state, played, capacity) {
    return Buffer.concat([Buffer.from([4, clip, state]), u32(played), u32(capacity)]);
}

function message(key, bytes, type) {
    return 'message ' + key + ' ' + (type || 0) + ' ' + Buffer.from(bytes).toString('hex');
}

speechTest('a whole clip plays as the reference decoder decodes it', async (w) => {
    const bytes = adpcm(24000);
    let out = await w.run('reporter', 'play 3 1 80 0 0 ' + bytes.length);
    assert.deepEqual(w.reports(out), [[3, BUFFERING, 0, bytes.length]]);
    const commands = [];
    for (let at = 0; at < bytes.length; at += 1800) {
        const end = Math.min(at + 1800, bytes.length);
        commands.push(data(3, end === bytes.length ? LAST : 0, at, bytes.subarray(at, end)));
    }
    out = await w.run(...commands, 'advance 100 50');
    assert.ok(out.includes('open 3 80'), '16 kHz at the volume asked for');
    assert.ok(out.includes('close'));
    assert.deepEqual(w.reports(out), [
        [3, PLAYING, 0, bytes.length],
        [3, PLAYING, bytes.length, bytes.length],
        [3, DONE, bytes.length, 0]
    ]);
    assertDecoded(await w.pcm(), bytes);
    assert.deepEqual(await w.run('playing'), ['playing 0']);
});

speechTest('a long clip goes through a small ring as the watch makes room', async (w) => {
    const bytes = adpcm(64000, 3);
    const capacity = 8192;
    // Room for 8K but not 16K: the ring halves until it fits
    let out = await w.run('reporter', 'heap ' + (HEAP_RESERVE + capacity + 100), 'room_per_ms 16',
        'play 1 0 100 0 2048 0');
    assert.deepEqual(w.reports(out), [[1, BUFFERING, 0, capacity]]);
    let sent = 0;
    let played = 0;
    let state = BUFFERING;
    const reports = [];
    for (let ticks = 0; state !== DONE; ticks++) {
        assert.ok(ticks < 1000, 'never finished');
        const commands = [];
        // The phone never has more out than the watch said it has room for
        while (sent < bytes.length && sent - played < capacity) {
            const length = Math.min(1800, capacity - (sent - played), bytes.length - sent);
            commands.push(data(1, sent + length === bytes.length ? LAST : 0, sent, bytes.subarray(sent, sent + length)));
            sent += length;
        }
        out = await w.run(...commands, 'advance 50');
        for (const report of w.reports(out)) {
            assert.notEqual(report[1], FAILED);
            reports.push(report);
            played = report[2];
            state = report[1];
        }
    }
    // Room is reported a quarter of the ring at a time, not for every byte
    const playing = reports.filter((r) => r[1] === PLAYING);
    assert.ok(playing.length > 4);
    for (let i = 1; i < playing.length; i++) {
        assert.ok(playing[i][2] - playing[i - 1][2] >= capacity / 4, 'report ' + i + ' came too soon');
        assert.equal(playing[i][3], capacity);
    }
    assert.deepEqual(reports[reports.length - 1], [1, DONE, bytes.length, 0]);
    assertDecoded(await w.pcm(), bytes);
});

speechTest('playing waits for the prebuffer or a whole sentence', async (w) => {
    const bytes = adpcm(20000);
    let out = await w.run('reporter', 'play 1 0 100 0 4000 0', data(1, 0, 0, bytes.subarray(0, 3000)), 'advance 500 50');
    assert.ok(!out.some((l) => l.startsWith('open')));
    out = await w.run(data(1, 0, 3000, bytes.subarray(3000, 4000)), 'advance 50');
    assert.ok(out.includes('open 2 100'), '8 kHz');
    assert.deepEqual(w.reports(out)[0], [1, PLAYING, 0, 32768]);

    out = await w.run('play 2 0 100 0 4000 0', data(2, PHRASE, 0, bytes.subarray(0, 500)), 'advance 50');
    assert.ok(out.includes('open 2 100'), 'a whole sentence is enough');

    // Never less than a quarter of a second, whatever the phone asks
    out = await w.run('play 3 0 100 0 10 0', data(3, 0, 0, bytes.subarray(0, 1000)), 'advance 200 50');
    assert.ok(!out.some((l) => l.startsWith('open')));
    out = await w.run(data(3, 0, 1000, bytes.subarray(1000, 1024)), 'advance 50');
    assert.ok(out.includes('open 2 100'));
});

speechTest('running dry waits for a decent run before playing on', async (w) => {
    const bytes = adpcm(20000);
    await w.run('reporter', 'play 1 0 100 0 1024 0', data(1, 0, 0, bytes.subarray(0, 1024)), 'advance 100 50');
    assert.equal((await w.pcm()).length, 2048);
    await w.run(data(1, 0, 1024, bytes.subarray(1024, 1124)), 'advance 100 50');
    assert.equal((await w.pcm()).length, 0, 'a scrap is not played');
    await w.run(data(1, PHRASE, 1124, bytes.subarray(1124, 1200)), 'advance 50');
    assert.equal((await w.pcm()).length, 2 * 176, 'the end of a sentence is');
});

speechTest('a phone that goes quiet fails the clip, and empty pieces keep it going', async (w) => {
    const bytes = adpcm(2000);
    let out = await w.run('reporter', 'play 1 0 100 0 4000 0', data(1, 0, 0, bytes.subarray(0, 100)),
        'advance 9000 50', data(1, 0, 100), 'advance 9000 50');
    assert.deepEqual(w.reports(out), [[1, BUFFERING, 0, 32768]]);
    out = await w.run('advance 1100 50');
    assert.deepEqual(w.reports(out), [[1, FAILED, 0, 0]]);
    assert.deepEqual(await w.run('playing'), ['playing 0']);
});

speechTest('a piece sent again is ignored, and a gap or an overrun fails the clip', async (w) => {
    const bytes = adpcm(8000);
    let out = await w.run('reporter', 'play 1 0 100 0 4000 1000', data(1, 0, 0, bytes.subarray(0, 100)),
        data(1, 0, 0, bytes.subarray(0, 100)), data(1, 0, 100, bytes.subarray(100, 200)));
    assert.deepEqual(w.reports(out), [[1, BUFFERING, 0, 2048]], 'a small clip gets the smallest ring');
    out = await w.run(data(1, 0, 300, bytes.subarray(300, 400)));
    assert.deepEqual(w.reports(out), [[1, FAILED, 0, 0]]);

    out = await w.run('play 2 0 100 0 4000 1000', data(2, 0, 0, bytes.subarray(0, 2048)),
        data(2, 0, 2048, bytes.subarray(2048, 2049)));
    assert.deepEqual(w.reports(out), [[2, BUFFERING, 0, 2048], [2, FAILED, 0, 0]]);

    // Pieces for another clip are not this one's
    out = await w.run('play 3 0 100 0 4000 1000', data(4, 0, 50, bytes.subarray(0, 10)), 'advance 50');
    assert.deepEqual(w.reports(out), [[3, BUFFERING, 0, 2048]]);
});

speechTest('the ring takes what the heap can spare', async (w) => {
    let out = await w.run('reporter', 'play 1 0 100 0 0 5000');
    assert.deepEqual(w.reports(out), [[1, BUFFERING, 0, 5000]]);
    out = await w.run('heap ' + (HEAP_RESERVE + 20000), 'play 2 0 100 0 0 0');
    assert.deepEqual(w.reports(out), [[2, BUFFERING, 0, 16384]]);
    out = await w.run('heap ' + (HEAP_RESERVE + 1000), 'play 3 0 100 0 0 0');
    assert.deepEqual(w.reports(out), [[3, NO_MEMORY, 0, 0]]);
    assert.deepEqual(await w.run('playing'), ['playing 0']);
});

speechTest('a muted watch says so and plays nothing', async (w) => {
    const out = await w.run('reporter', 'muted 1', 'play 1 0 100 0 0 0', 'playing');
    assert.deepEqual(w.reports(out), [[1, MUTED, 0, 0]]);
    assert.ok(out.includes('playing 0'));
});

speechTest('stopping', async (w) => {
    const bytes = adpcm(4000);
    const setUp = ['play 1 0 100 0 0 0', data(1, 0, 0, bytes.subarray(0, 1024)), 'advance 50'];
    let out = await w.run('reporter', 'room_per_ms 0', ...setUp, 'stop_clip 2', 'playing');
    assert.ok(out.includes('playing 1'), 'another clip is not stopped');
    // The phone asked, so it needs no telling
    out = await w.run('stop_clip 1', 'playing', 'stop');
    assert.deepEqual(out, ['halt', 'playing 0']);
    // The wearer stopped it, which the phone does need to hear
    out = await w.run(...setUp, 'stop');
    assert.ok(out.includes('halt'));
    // Played counts what has been decoded for the speaker
    assert.deepEqual(w.reports(out).pop(), [1, STOPPED, 128, 0]);
});

speechTest('the speaker finishing early or being taken away', async (w) => {
    const bytes = adpcm(4000);
    const setUp = ['play 1 0 100 0 0 0', data(1, 0, 0, bytes.subarray(0, 1024)), 'advance 50'];
    let out = await w.run('reporter', 'room_per_ms 0', ...setUp, 'finish 2');
    assert.deepEqual(w.reports(out).pop(), [1, PREEMPTED, 128, 0]);
    assert.ok(!out.includes('halt'));
    out = await w.run(...setUp, 'finish 0');
    assert.deepEqual(w.reports(out).pop(), [1, FAILED, 128, 0], 'done before the end');
});

speechTest('after the last sample the speaker is left to drain', async (w) => {
    const bytes = adpcm(2000);
    const clip = ['play 1 0 100 0 0 0', data(1, LAST, 0, bytes)];
    let out = await w.run('reporter', 'status 1', ...clip, 'advance 500 50');
    assert.ok(out.includes('close'));
    assert.deepEqual(w.reports(out).map((r) => r[1]), [BUFFERING, PLAYING]);
    out = await w.run('finish 0');
    assert.deepEqual(w.reports(out), [[1, DONE, 1000, 0]]);
    // Should the speaker never say, it is done anyway
    out = await w.run(...clip, 'advance 3000 50');
    assert.ok(!w.reports(out).some((r) => r[1] === DONE));
    out = await w.run('advance 200 50');
    assert.deepEqual(w.reports(out), [[1, DONE, 1000, 0]]);
    // Nor does the speaker saying so late end the clip after it
    out = await w.run('play 2 0 100 0 0 0', 'finish 0', 'advance 200 50');
    assert.deepEqual(w.reports(out), [[2, BUFFERING, 0, 32768]]);
});

speechTest('a speaker still letting go is asked again, for a while', async (w) => {
    const bytes = adpcm(2000);
    let out = await w.run('reporter', 'open_failures 3', 'play 1 0 100 0 0 0', data(1, LAST, 0, bytes), 'advance 150 50');
    assert.ok(!out.some((l) => l.startsWith('open')));
    out = await w.run('advance 50');
    assert.ok(out.includes('open 2 100'));
    out = await w.run('open_failures 100', 'play 2 0 100 0 0 0', data(2, LAST, 0, bytes), 'advance 1000 50');
    assert.deepEqual(w.reports(out), [[2, BUFFERING, 0, 32768]]);
    out = await w.run('advance 50');
    assert.deepEqual(w.reports(out), [[2, FAILED, 0, 0]]);
});

speechTest('over AppMessage, each op is read from the one key and status goes back on it', async (w) => {
    const bytes = adpcm(200);
    let out = await w.run('init ' + KEY, message(KEY, playMessage(5, 0, 100, 0, 0)));
    assert.ok(out.includes('handled 1'));
    assert.deepEqual(w.sent(out), [[KEY, status(5, BUFFERING, 0, 32768)]]);

    out = await w.run(message(KEY, dataMessage(5, LAST, 0, bytes)), 'advance 100 50');
    assert.ok(out.includes('handled 1'));
    assert.ok(out.includes('open 2 100'));
    assert.deepEqual(w.sent(out), [[KEY, status(5, PLAYING, 0, 32768)], [KEY, status(5, DONE, 100, 0)]]);
    assertDecoded(await w.pcm(), bytes);

    out = await w.run(message(KEY, playMessage(6, 1, 50, 0, 0)), message(KEY, dataMessage(6, PHRASE, 0, bytes)),
        'room_per_ms 0', 'advance 50', message(KEY, Buffer.from([3, 6])), 'playing');
    assert.ok(out.includes('open 3 50'));
    assert.ok(out.includes('halt'));
    assert.ok(out.includes('playing 0'));
    assert.deepEqual(w.sent(out).map((s) => s[1][2]), [BUFFERING, PLAYING], 'nothing said about a stop the phone asked for');
});

speechTest('over AppMessage, what is not the kit\'s is left alone and what is broken is dropped', async (w) => {
    let out = await w.run('init ' + KEY, message(7, playMessage(1, 0, 100, 0, 0)));
    assert.deepEqual(out, ['handled 0']);
    out = await w.run(message(KEY, Buffer.from('hello'), 1), message(KEY, Buffer.from([1, 2, 0, 100])),
        message(KEY, Buffer.from([2, 2, 0])), message(KEY, Buffer.from([9, 1])), message(KEY, Buffer.from([1])), 'playing');
    assert.deepEqual(out, ['handled 1', 'handled 1', 'handled 1', 'handled 1', 'handled 1', 'playing 0']);
    out = await w.run('deinit', message(KEY, playMessage(1, 0, 100, 0, 0)));
    assert.deepEqual(out, ['handled 0']);
});

speechTest('over AppMessage, a busy outbox gets only the newest status', async (w) => {
    const bytes = adpcm(4000);
    let out = await w.run('init ' + KEY, 'room_per_ms 0', 'outbox_busy 1', message(KEY, playMessage(1, 0, 100, 0, 0)),
        message(KEY, dataMessage(1, 0, 0, bytes.subarray(0, 1024))), 'advance 50');
    assert.ok(out.includes('open 2 100'));
    assert.deepEqual(w.sent(out), []);
    out = await w.run('outbox_busy 0', 'advance 200 50');
    assert.deepEqual(w.sent(out), [[KEY, status(1, PLAYING, 0, 32768)]]);

    // With the phone gone there is nobody to tell
    out = await w.run('outbox_busy 1', 'connected 0', 'stop', 'outbox_busy 0', 'connected 1', 'advance 500 50');
    assert.deepEqual(w.sent(out), []);
});

speechTest('over AppMessage, an outbox that was never opened is not tried forever', async (w) => {
    const bytes = adpcm(4000);
    let out = await w.run('init ' + KEY, 'room_per_ms 0', 'outbox_closed 1', message(KEY, playMessage(1, 0, 100, 0, 0)),
        message(KEY, dataMessage(1, 0, 0, bytes.subarray(0, 1024))), 'advance 50');
    assert.deepEqual(w.sent(out), []);
    // Given up on, not waiting for the outbox to come right
    out = await w.run('outbox_closed 0', 'advance 200 50');
    assert.deepEqual(w.sent(out), []);
});

speechTest('deinit stops the speaker without a word to the phone', async (w) => {
    const bytes = adpcm(4000);
    const out = await w.run('init ' + KEY, 'room_per_ms 0', message(KEY, playMessage(1, 0, 100, 0, 0)),
        message(KEY, dataMessage(1, 0, 0, bytes.subarray(0, 1024))), 'advance 50', 'deinit', 'playing', 'advance 500 50');
    assert.deepEqual(out.slice(out.indexOf('halt')), ['halt', 'playing 0']);
});

test('without a speaker the kit claims its messages and does nothing', { skip: PLAIN_WATCH.skip }, async () => {
    const w = start(PLAIN_WATCH);
    try {
        const out = await w.run('init ' + KEY, message(KEY, playMessage(1, 0, 100, 0, 0)), message(7, Buffer.from([1])),
            'advance 500 50', 'playing');
        assert.deepEqual(out, ['handled 1', 'handled 0', 'playing 0']);
    } finally {
        w.close();
    }
});
