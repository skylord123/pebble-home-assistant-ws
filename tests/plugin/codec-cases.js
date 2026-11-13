/**
 * Fixed inputs for the speech encoder, and what any implementation of it
 * makes of them. speech-codec.test.js holds these to what Speech.js made
 * before the encoder moved into src/js/app/speech-codec.js
 * (codec-expected.json), so the watch app's speech stays byte for byte the
 * same.
 */
'use strict';

const crypto = require('crypto');

function hash(view) {
    return crypto.createHash('sha256')
        .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength)).digest('hex');
}

//! The same noise on every machine
function noise(seed) {
    let x = seed >>> 0;
    return () => {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        return x / 4294967296 - 0.5;
    };
}

/** A voice-like signal: a chirp with harmonics, noise and gaps, peaking near `peak` */
function signal(count, rate, peak, seed) {
    const rand = noise(seed);
    const out = new Float64Array(count);
    let phase = 0;
    for (let i = 0; i < count; i++) {
        const t = i / rate;
        phase += 2 * Math.PI * (120 + 200 * Math.sin(t * 3)) / rate;
        const envelope = Math.max(0, Math.sin(t * 7));
        out[i] = peak * envelope * (0.6 * Math.sin(phase) + 0.25 * Math.sin(3 * phase) + 0.15 * rand());
    }
    return out;
}

/**
 * A WAV file. `size` is 'exact', 'zero' or 'max' for the data chunk's size,
 * as Home Assistant writes it when it streams. `format` 1 is PCM, 0xFFFE
 * WAVE_FORMAT_EXTENSIBLE, 3 float. `junk` puts an odd-sized chunk before
 * the data.
 */
function wav(opts) {
    const channels = opts.channels || 1;
    const bits = opts.bits || 16;
    const count = opts.count;
    const width = bits / 8;
    const data = Buffer.alloc(count * channels * width);
    const sig = signal(count, opts.rate, opts.peak, opts.seed || 1);
    for (let i = 0; i < count; i++) {
        for (let c = 0; c < channels; c++) {
            const v = Math.round(sig[i] * (c ? 0.5 : 1));
            const at = (i * channels + c) * width;
            if (bits === 16) {
                data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), at);
            } else {
                data.writeUInt8(Math.max(0, Math.min(255, (v >> 8) + 128)), at);
            }
        }
    }
    const parts = [Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')];
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0);
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(opts.format === undefined ? 1 : opts.format, 8);
    fmt.writeUInt16LE(channels, 10);
    fmt.writeUInt32LE(opts.rate, 12);
    fmt.writeUInt32LE(opts.rate * channels * width, 16);
    fmt.writeUInt16LE(channels * width, 20);
    fmt.writeUInt16LE(bits, 22);
    parts.push(fmt);
    if (opts.junk) {
        const junk = Buffer.alloc(8 + 5 + 1);
        junk.write('LIST', 0);
        junk.writeUInt32LE(5, 4);
        parts.push(junk);
    }
    const head = Buffer.alloc(8);
    head.write('data', 0);
    head.writeUInt32LE(opts.size === 'zero' ? 0 : opts.size === 'max' ? 0xFFFFFFFF : data.length, 4);
    parts.push(head, data);
    const file = Buffer.concat(parts);
    file.writeUInt32LE(file.length - 8, 4);
    return file;
}

function arrayBuffer(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

const WAVS = {
    mono16k: { rate: 16000, count: 16001, peak: 9000, seed: 1 },
    mono8k: { rate: 8000, count: 7001, peak: 12000, seed: 2 },
    stereo22k: { rate: 22050, channels: 2, count: 11025, peak: 6000, seed: 3, size: 'zero' },
    eightBit44k: { rate: 44100, bits: 8, count: 22050, peak: 20000, seed: 4, size: 'max' },
    loud24k: { rate: 24000, count: 12000, peak: 32000, seed: 5, junk: true },
    extensible: { rate: 16000, count: 4000, peak: 3000, seed: 6, format: 0xFFFE },
    quiet: { rate: 16000, count: 4000, peak: 100, seed: 7 }
};

const REJECTED = {
    float: wav({ rate: 16000, count: 100, peak: 1000, format: 3 }),
    mp3: Buffer.from([0xFF, 0xFB, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    short: Buffer.from('RIFF')
};

const MARKDOWN = [
    'Sure. The kitchen light is on.',
    '# Weather\n\nIt is **sunny** and 21 degrees. See [the forecast](https://example.com/x) for more.\n' +
        '- High of 25\n- Low of 12\n1. Bring water\n```\ncode here\n```\n![chart](https://x/y.png) Done',
    'Mr. Smith arrived at 3 p.m. today, e.g. on time! Is that right? Yes.',
    'One sentence without an end',
    'A' + ' long sentence.'.repeat(120),
    'Word '.repeat(300),
    '"Quoted." (Bracketed!) Next... And done?',
    ''
];

const PARTIAL = [
    'Here is code ```\nunfinished',
    'Look at [the link](http://unfinished',
    'An image ![alt',
    'Plain text. More',
    'Done ```a``` and [x](y)'
];

/**
 * Everything an implementation makes of the inputs, as plain JSON. `impl`
 * has speakable, settled, sentenceEnds, nextPiece, parseWav, resample,
 * gainFor, amplify and encodeAdpcm.
 */
function outputs(impl) {
    const out = { text: {}, audio: {}, rejected: {} };

    out.text.speakable = MARKDOWN.map((m) => impl.speakable(m));
    out.text.settled = PARTIAL.map((m) => impl.settled(m));
    out.text.sentenceEnds = MARKDOWN.map((m) => impl.sentenceEnds(m));
    out.text.nextPiece = [];
    MARKDOWN.forEach((m) => {
        const spoken = impl.speakable(m).text;
        [[true, true], [true, false], [false, true], [false, false]].forEach(([first, complete]) => {
            out.text.nextPiece.push(impl.nextPiece(spoken, first, complete));
        });
        // Split the way Speech.js feeds a finished answer
        const pieces = [];
        let pending = spoken;
        for (let n = 0; n < 50; n++) {
            const cut = impl.nextPiece(pending, n === 0, true);
            if (!cut) { break; }
            pieces.push(pending.substring(0, cut).trim());
            pending = pending.substring(cut);
        }
        out.text.nextPiece.push(pieces);
    });

    Object.keys(WAVS).forEach((name) => {
        const parsed = impl.parseWav(arrayBuffer(wav(WAVS[name])));
        const entry = { rate: parsed.rate, samples: parsed.samples.length, parsed: hash(parsed.samples) };
        [8000, 16000].forEach((to) => {
            const samples = impl.resample(parsed.samples, parsed.rate, to);
            const gain = impl.gainFor(samples);
            const loud = impl.amplify(samples, gain);
            const whole = { predictor: 0, index: 0 };
            const bytes = impl.encodeAdpcm(loud, whole);
            // Two pieces of one answer, the first with an odd number of samples
            const half = (loud.length >> 1) | 1;
            const carried = { predictor: 0, index: 0 };
            const a = impl.encodeAdpcm(loud.subarray(0, half), carried);
            const b = impl.encodeAdpcm(loud.subarray(half), carried);
            entry[to] = {
                resampled: samples.length,
                gain: gain,
                amplified: hash(loud),
                adpcm: hash(bytes),
                adpcmLength: bytes.length,
                state: whole,
                pieces: [hash(a), hash(b)],
                carried: carried
            };
        });
        out.audio[name] = entry;
    });

    Object.keys(REJECTED).forEach((name) => {
        out.rejected[name] = impl.parseWav(arrayBuffer(REJECTED[name]));
    });
    // No state given starts from silence
    out.defaultState = hash(impl.encodeAdpcm(new Int16Array([0, 1000, -2000, 30000, -30000])));
    return out;
}

module.exports = {
    wav: wav,
    arrayBuffer: arrayBuffer,
    signal: signal,
    outputs: outputs,
    hash: hash
};
