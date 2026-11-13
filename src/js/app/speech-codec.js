/**
 * speech-codec - Answers into pieces to say, and WAV into IMA ADPCM
 *
 * What the watch app (app/Speech.js) and the plugin (plugin/js/speech.js)
 * both need to turn an answer into audio for the watch: the words of a
 * markdown answer, where its sentences end, how to split it into pieces to
 * ask Home Assistant for, and how to turn the WAV Home Assistant sends into
 * the 4-bit IMA ADPCM the watch decodes (simply_speaker.c).
 *
 * This is the one copy: the plugin's bundle takes this file as its module
 * `speech-codec` (plugin/bundle.json). Plain ES5 with no requires, so it
 * loads the same in either bundle and in Node.
 */
var codec = {};

// The first piece goes as soon as it holds a sentence this long, so that a
// lone "Sure." waits for the one after it rather than costing a request of
// its own
var FIRST_PIECE_CHARS = 20;

// Every piece after the first takes whatever was written while the one before
// it was being made, as many whole sentences as fit in this
var MAX_PIECE_CHARS = 400;

// An agent can write an essay. Reading one out on a watch helps nobody, and a
// long synthesis keeps the wearer waiting for the first word, so speech stops
// at the end of the sentence nearest this.
var MAX_SPOKEN_CHARS = 1200;

// Peaks are brought up to about this, at most four times louder: the speaker
// is small, and most voices are mastered well below full scale. The first
// piece of an answer decides by how much, and the rest follow it, so that the
// voice does not change level from one sentence to the next.
var TARGET_PEAK = 30000;
var MAX_GAIN = 4;

codec.FIRST_PIECE_CHARS = FIRST_PIECE_CHARS;
codec.MAX_PIECE_CHARS = MAX_PIECE_CHARS;
codec.MAX_SPOKEN_CHARS = MAX_SPOKEN_CHARS;
codec.MAX_GAIN = MAX_GAIN;

/**
 * The words of an answer, without the markdown. A conversation agent writes
 * for a screen: what is only there for the eye (emphasis, code, links, list
 * markers) is either read out as punctuation or spelled out by the engine.
 */
function speakable(markdown) {
    var text = String(markdown || '');
    text = text.replace(/```[\s\S]*?```/g, ' ');
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    text = text.replace(/https?:\/\/\S+/g, ' ');
    var lines = text.split('\n').map(function(line) {
        var heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
        var item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
        var words = (heading || item) ? (heading || item)[1] : line;
        words = words.replace(/[*_`~]+/g, '').replace(/\s+/g, ' ').trim();
        // A heading or a list item is its own sentence when it is heard
        if ((heading || item) && words && !/[.!?:;,]$/.test(words)) {
            words += '.';
        }
        return words;
    });
    text = lines.filter(function(line) { return line; }).join(' ');
    var capped = text.length > MAX_SPOKEN_CHARS;
    if (capped) {
        var cut = text.substring(0, MAX_SPOKEN_CHARS);
        var end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
        text = end > MAX_SPOKEN_CHARS / 2 ? cut.substring(0, end + 1) : cut;
    }
    return { text: text.trim(), capped: capped };
}

/**
 * As much of an answer still being written as can be read without guessing
 * at the rest: not a code block that has not been closed, nor a link whose
 * address has not arrived, either of which would be read out as written.
 */
function settled(markdown) {
    var text = String(markdown || '');
    if ((text.split('```').length - 1) % 2) {
        text = text.substring(0, text.lastIndexOf('```'));
    }
    var open = text.lastIndexOf('[');
    if (open !== -1 && text.indexOf(')', open) === -1) {
        text = text.substring(0, open > 0 && text.charAt(open - 1) === '!' ? open - 1 : open);
    }
    return text;
}

// A full stop after one of these, or after an initial, is not the end of a
// sentence
var ABBREVIATION = /(?:^|\s)(?:mr|mrs|ms|dr|st|vs|etc|approx|e\.g|i\.e|[a-z])\.$/i;

//! Where each sentence of `text` ends, just after its punctuation
function sentenceEnds(text) {
    var ends = [];
    var re = /[.!?]+["'”’)\]]*(?=\s)/g;
    var match;
    while ((match = re.exec(text))) {
        var end = match.index + match[0].length;
        if (!ABBREVIATION.test(text.substring(Math.max(0, end - 8), end))) {
            ends.push(end);
        }
    }
    return ends;
}

/**
 * How much of `pending` to ask for next, or 0 to wait for more of it. The
 * first piece is kept short so that speech starts soon, and later ones take
 * every sentence they can, up to `maxChars` (MAX_PIECE_CHARS unless given).
 * `complete` says no more is coming, which makes the end of the text the end
 * of a sentence too.
 */
function nextPiece(pending, first, complete, maxChars) {
    var max = maxChars || MAX_PIECE_CHARS;
    var ends = sentenceEnds(pending);
    if (complete && pending.trim()) { ends.push(pending.length); }
    var cut = 0;
    for (var i = 0; i < ends.length; i++) {
        if (first) {
            cut = ends[i];
            if (pending.substring(0, cut).trim().length >= FIRST_PIECE_CHARS) { break; }
            if (!complete) { cut = 0; }
        } else {
            if (cut && ends[i] > max) { break; }
            cut = ends[i];
        }
    }
    return cut;
}

// MARK: - Audio

function ascii(view, offset, length) {
    var s = '';
    for (var i = 0; i < length; i++) {
        s += String.fromCharCode(view.getUint8(offset + i));
    }
    return s;
}

/**
 * The samples of a WAV file as 16-bit mono, and the rate they are at. Home
 * Assistant was asked for exactly that, but an engine it cannot convert, or
 * a version too old to try, sends what it has; anything PCM is taken as it
 * comes. When it streams the file, the sizes in the header are left at zero
 * or at their maximum, so the data runs to the end of what arrived.
 */
function parseWav(buffer) {
    var view = new DataView(buffer);
    if (buffer.byteLength < 12 || ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') {
        return null;
    }
    var format = null;
    var offset = 12;
    while (offset + 8 <= buffer.byteLength) {
        var id = ascii(view, offset, 4);
        var size = view.getUint32(offset + 4, true);
        var body = offset + 8;
        if (id === 'fmt ' && body + 16 <= buffer.byteLength) {
            format = {
                code: view.getUint16(body, true),
                channels: view.getUint16(body + 2, true),
                rate: view.getUint32(body + 4, true),
                bits: view.getUint16(body + 14, true)
            };
        } else if (id === 'data') {
            if (!format || (format.code !== 1 && format.code !== 0xFFFE) || !format.channels ||
                    (format.bits !== 16 && format.bits !== 8)) {
                return null;
            }
            var end = (size === 0 || size === 0xFFFFFFFF || body + size > buffer.byteLength) ?
                buffer.byteLength : body + size;
            return {
                rate: format.rate,
                samples: toMono16(view, body, end, format.channels, format.bits)
            };
        }
        // Chunks are padded to an even length
        offset = body + size + (size & 1);
    }
    return null;
}

function toMono16(view, start, end, channels, bits) {
    var width = bits / 8;
    var frame = width * channels;
    var count = Math.floor((end - start) / frame);
    var out = new Int16Array(count);
    for (var i = 0; i < count; i++) {
        var sum = 0;
        for (var c = 0; c < channels; c++) {
            var at = start + i * frame + c * width;
            sum += width === 2 ? view.getInt16(at, true) : (view.getUint8(at) - 128) << 8;
        }
        out[i] = sum / channels;
    }
    return out;
}

/**
 * Bring the samples to `rate`. Home Assistant normally already has, and this
 * returns them untouched. Going down averages what falls in each output
 * sample, which keeps what the slower rate cannot carry from folding back in
 * as hiss.
 */
function resample(samples, from, to) {
    if (from === to || !from) { return samples; }
    var ratio = from / to;
    var count = Math.floor(samples.length / ratio);
    var out = new Int16Array(count);
    for (var i = 0; i < count; i++) {
        var pos = i * ratio;
        if (ratio > 1) {
            var first = Math.floor(pos);
            var last = Math.min(samples.length, Math.floor(pos + ratio));
            var sum = 0;
            for (var j = first; j < last; j++) { sum += samples[j]; }
            out[i] = last > first ? sum / (last - first) : samples[first];
        } else {
            var k = Math.floor(pos);
            var frac = pos - k;
            var next = k + 1 < samples.length ? samples[k + 1] : samples[k];
            out[i] = samples[k] + (next - samples[k]) * frac;
        }
    }
    return out;
}

//! How much louder a voice needs to be, up to a point, to carry on a small
//! speaker
function gainFor(samples) {
    var peak = 0;
    for (var i = 0; i < samples.length; i++) {
        var v = samples[i] < 0 ? -samples[i] : samples[i];
        if (v > peak) { peak = v; }
    }
    if (peak === 0) { return 1; }
    var gain = Math.min(MAX_GAIN, TARGET_PEAK / peak);
    return gain <= 1.05 ? 1 : gain;
}

//! Held to full scale, since a later sentence can peak above the first
function amplify(samples, gain) {
    if (gain === 1) { return samples; }
    for (var i = 0; i < samples.length; i++) {
        var v = samples[i] * gain;
        samples[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
    }
    return samples;
}

// Standard IMA ADPCM, which the watch decodes with the same tables
var ADPCM_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
var ADPCM_STEP = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767
];

/**
 * Two samples a byte, low nibble first, starting from silence. The watch
 * starts from the same state, so nothing needs to travel with the audio.
 * The pieces of one answer are a single stream to the watch, so `state`
 * carries the encoder from one into the next. A piece with an odd number of
 * samples has its last one repeated, so that every piece is whole bytes.
 */
function encodeAdpcm(samples, state) {
    state = state || { predictor: 0, index: 0 };
    var count = samples.length + (samples.length & 1);
    var out = new Uint8Array(count / 2);
    var predictor = state.predictor;
    var index = state.index;
    for (var i = 0; i < count; i++) {
        var step = ADPCM_STEP[index];
        var diff = samples[i < samples.length ? i : samples.length - 1] - predictor;
        var code = 0;
        if (diff < 0) {
            code = 8;
            diff = -diff;
        }
        // Rebuilt exactly as the decoder will, so the two never drift apart
        var delta = step >> 3;
        if (diff >= step) { code |= 4; diff -= step; delta += step; }
        step >>= 1;
        if (diff >= step) { code |= 2; diff -= step; delta += step; }
        step >>= 1;
        if (diff >= step) { code |= 1; delta += step; }
        predictor += (code & 8) ? -delta : delta;
        if (predictor > 32767) { predictor = 32767; }
        if (predictor < -32768) { predictor = -32768; }
        index += ADPCM_INDEX[code];
        if (index < 0) { index = 0; }
        if (index > 88) { index = 88; }
        if (i & 1) {
            out[i >> 1] |= code << 4;
        } else {
            out[i >> 1] = code;
        }
    }
    state.predictor = predictor;
    state.index = index;
    return out;
}

codec.speakable = speakable;
codec.settled = settled;
codec.sentenceEnds = sentenceEnds;
codec.nextPiece = nextPiece;
codec.parseWav = parseWav;
codec.toMono16 = toMono16;
codec.resample = resample;
codec.gainFor = gainFor;
codec.amplify = amplify;
codec.encodeAdpcm = encodeAdpcm;
codec.ADPCM_INDEX = ADPCM_INDEX;
codec.ADPCM_STEP = ADPCM_STEP;

module.exports = codec;
