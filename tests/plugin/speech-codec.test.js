'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const harness = require('./harness');
const cases = require('./codec-cases');

const ROOT = path.join(__dirname, '..', '..');
//! What Speech.js made of codec-cases.js before the encoder moved out of it
const EXPECTED = require('./codec-expected.json');

/** A CommonJS file loaded with `require` answered from `modules` */
function load(file, modules) {
    const module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(path.join(ROOT, file), 'utf8'))(
        (name) => {
            if (!(name in modules)) { throw new Error('unexpected require ' + name); }
            return modules[name];
        }, module, module.exports);
    return module.exports;
}

const codec = load('src/js/app/speech-codec.js', {});

/** The watch's decoder (simply_speaker.c), for checking what the encoder makes */
function decodeAdpcm(bytes, state) {
    let predictor = state ? state.predictor : 0;
    let index = state ? state.index : 0;
    const out = new Int16Array(bytes.length * 2);
    for (let i = 0; i < out.length; i++) {
        const code = (bytes[i >> 1] >> ((i & 1) * 4)) & 0x0F;
        const step = codec.ADPCM_STEP[index];
        let delta = step >> 3;
        if (code & 4) { delta += step; }
        if (code & 2) { delta += step >> 1; }
        if (code & 1) { delta += step >> 2; }
        predictor += (code & 8) ? -delta : delta;
        predictor = Math.max(-32768, Math.min(32767, predictor));
        index = Math.max(0, Math.min(88, index + codec.ADPCM_INDEX[code]));
        out[i] = predictor;
    }
    return out;
}

test('the shared encoder makes exactly what Speech.js made before', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(cases.outputs(codec))), EXPECTED);
});

test('the plugin bundle\'s speech-codec is the same file and makes the same', () => {
    const engine = harness.create().engine();
    const bundled = engine.require('speech-codec');
    engine.end();
    assert.deepEqual(JSON.parse(JSON.stringify(cases.outputs(bundled))), EXPECTED);
});

test('the watch app\'s Speech uses the shared encoder', () => {
    const Speech = load('src/js/app/Speech.js', {
        'settings': { option: () => undefined },
        'ui/speaker': { onIdle() {}, onStatus() {}, RATE_8K: 0, RATE_16K: 1 },
        'app/AppState': { getInstance: () => ({}) },
        'app/helpers': { log_message() {} },
        'app/speech-codec': codec
    });
    assert.equal(Speech.parseWav, codec.parseWav);
    assert.equal(Speech.encodeAdpcm, codec.encodeAdpcm);
    assert.equal(Speech.nextPiece, codec.nextPiece);
    assert.equal(Speech.sentenceEnds, codec.sentenceEnds);
    const markdown = '# Weather\n\nIt is **sunny**. See [the forecast](https://example.com/x).';
    assert.equal(Speech.spokenText(markdown), codec.speakable(markdown).text);
});

test('what the encoder makes decodes back close to the voice, across pieces', () => {
    const wav = codec.parseWav(cases.arrayBuffer(cases.wav({ rate: 8000, count: 8000, peak: 20000, seed: 9 })));
    const state = { predictor: 0, index: 0 };
    const first = codec.encodeAdpcm(wav.samples.subarray(0, 4000), state);
    const second = codec.encodeAdpcm(wav.samples.subarray(4000), state);
    const decoded = decodeAdpcm(Buffer.concat([first, second]));
    let error = 0;
    let level = 0;
    for (let i = 0; i < wav.samples.length; i++) {
        error += Math.abs(decoded[i] - wav.samples[i]);
        level += Math.abs(wav.samples[i]);
    }
    assert.ok(error / level < 0.1, 'decoded audio is off by ' + Math.round(100 * error / level) + '%');
    assert.deepEqual(decodeAdpcm(second, { predictor: 0, index: 0 }).length, second.length * 2);
});

test('the shared decoder is the watch\'s, and carries its state from part to part', () => {
    const wav = codec.parseWav(cases.arrayBuffer(cases.wav({ rate: 16000, count: 16001, peak: 30000, hum: 2000, seed: 4 })));
    const encoder = { predictor: 0, index: 0 };
    const bytes = codec.encodeAdpcm(wav.samples, encoder);
    assert.deepEqual(codec.decodeAdpcm(bytes), decodeAdpcm(bytes));

    // In parts of odd sizes, as an upload arrives
    const state = { predictor: 0, index: 0 };
    const parts = [];
    for (let at = 0; at < bytes.length; at += 777) {
        parts.push(codec.decodeAdpcm(bytes.subarray(at, at + 777), state));
    }
    const joined = new Int16Array(bytes.length * 2);
    let offset = 0;
    parts.forEach((part) => { joined.set(part, offset); offset += part.length; });
    assert.deepEqual(joined, decodeAdpcm(bytes));
    // The decoder ends where the encoder did, so the two never drift apart
    assert.deepEqual(state, encoder);

    // Full scale both ways is held, not wrapped
    const loud = codec.decodeAdpcm(new Uint8Array(200).fill(0x77));
    assert.equal(loud[loud.length - 1], 32767);
    const low = codec.decodeAdpcm(new Uint8Array(200).fill(0xFF));
    assert.equal(low[low.length - 1], -32768);
    assert.deepEqual(codec.decodeAdpcm(new Uint8Array(0)), new Int16Array(0));
});

test('nextPiece takes a smaller piece size when given one', () => {
    const text = 'This is the first sentence here. ' + 'Another sentence of words follows it. '.repeat(10);
    const first = codec.nextPiece(text, true, true, 200);
    assert.equal(text.substring(0, first), 'This is the first sentence here.');
    const rest = text.substring(first);
    const cut = codec.nextPiece(rest, false, true, 200);
    assert.ok(cut <= 200 && cut > 150, String(cut));
    assert.ok(codec.nextPiece(rest, false, true) > 300);
});
