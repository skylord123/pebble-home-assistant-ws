/**
 * AudioLevels - how loud each part of the voice is, for the watch to draw
 *
 * The watch never sees the audio it streams: the firmware sends it straight
 * to the phone. So the phone listens for it, splitting each 100 ms chunk into
 * frequency bands and sending one byte per band back, and the watch draws a
 * bar for each and animates between them.
 *
 * Bands are spaced evenly in pitch from the bottom of a man's voice to the
 * top of its sibilants.
 *
 * A bar shows how far its band stands above the room, not how loud it is.
 * Each band keeps track of its own background noise, which drops quickly
 * toward any quieter moment and only creeps back up, so the gaps between
 * words keep it honest while a voice cannot drag it up with it. Silence then
 * shows dots however much a microphone hisses, and a voice shows against it
 * however quiet the microphone.
 */
var AudioLevels = {};

AudioLevels.BANDS = 9;

var SAMPLE_RATE = 16000;
var FFT_SIZE = 512;
var LOW_HZ = 120;
var HIGH_HZ = 7000;
// How far over its noise a band has to be before its bar rises, in dB. The
// noise wanders by a few dB from one chunk to the next on its own, and more
// in the lowest bands, which are measured from only a few FFT bins, so they
// take a higher gate.
var GATE_DB = 6;
var GATE_BINS = 4;
// How much of the way a band's noise drops toward a quieter chunk, and how
// fast it creeps back up, in dB per 100 ms chunk. Dropping all the way would
// chase every chance dip and leave the noise too low.
var NOISE_DROP = 0.3;
var NOISE_RISE_DB = 0.1;
// The loudest the voice has been lately, above its noise, sets the top of the
// bars, so a quiet voice fills them as well as a loud one. It falls back this
// fast, in dB per chunk, but never closer to the gate than MIN_SPAN_DB, so a
// band barely over it never stands as a full bar.
var PEAK_FALL_DB = 0.5;
var MIN_SPAN_DB = 20;
// A chunk is voice when at least this many bands stand this far over their
// gate. One band alone is as likely a clink or a fan as a word.
var VOICE_DB = 4;
var VOICE_BANDS = 2;

var bandNoise = null;
var peakDb = MIN_SPAN_DB;
var lastVoiced = false;

var hann = null;
var cosTable = null;
var sinTable = null;
var bandBins = null;
var bandGate = null;

function setup() {
    var i;
    hann = new Float32Array(FFT_SIZE);
    for (i = 0; i < FFT_SIZE; i++) {
        hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1));
    }
    cosTable = new Float32Array(FFT_SIZE / 2);
    sinTable = new Float32Array(FFT_SIZE / 2);
    for (i = 0; i < FFT_SIZE / 2; i++) {
        cosTable[i] = Math.cos(2 * Math.PI * i / FFT_SIZE);
        sinTable[i] = Math.sin(2 * Math.PI * i / FFT_SIZE);
    }
    bandBins = [];
    bandGate = [];
    var binHz = SAMPLE_RATE / FFT_SIZE;
    var ratio = Math.pow(HIGH_HZ / LOW_HZ, 1 / AudioLevels.BANDS);
    for (i = 0; i < AudioLevels.BANDS; i++) {
        var lo = LOW_HZ * Math.pow(ratio, i);
        var hi = lo * ratio;
        var first = Math.max(1, Math.round(lo / binHz));
        var last = Math.max(first, Math.round(hi / binHz) - 1);
        bandBins.push([first, last]);
        bandGate.push(GATE_DB * Math.max(1, Math.sqrt(GATE_BINS / (last - first + 1))));
    }
}

// In-place radix-2 FFT of FFT_SIZE points
function fft(re, im) {
    var n = FFT_SIZE;
    var i, j, k;
    for (i = 1, j = 0; i < n; i++) {
        var bit = n >> 1;
        for (; j & bit; bit >>= 1) { j ^= bit; }
        j ^= bit;
        if (i < j) {
            var t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (var size = 2; size <= n; size <<= 1) {
        var half = size >> 1;
        var step = n / size;
        for (i = 0; i < n; i += size) {
            for (k = 0; k < half; k++) {
                var c = cosTable[k * step];
                var s = sinTable[k * step];
                var a = i + k;
                var b = a + half;
                var tr = re[b] * c + im[b] * s;
                var ti = im[b] * c - re[b] * s;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
    }
}

/**
 * Start a new turn: the last one's loudness and noise say nothing about this
 * one, which may well be in another room.
 */
AudioLevels.reset = function() {
    bandNoise = null;
    peakDb = MIN_SPAN_DB;
    lastVoiced = false;
};

/**
 * Levels for one chunk of 16 kHz, 16-bit little-endian mono PCM, from 0 (a
 * dot) to 255 (a full bar), lowest band first. Null for a chunk too short
 * to say anything about.
 */
AudioLevels.analyze = function(buffer) {
    if (!hann) { setup(); }
    var samples = new Int16Array(buffer, 0, buffer.byteLength >> 1);
    if (samples.length < FFT_SIZE) { return null; }

    // Average the power of as many windows as fit, half overlapping
    var power = new Float32Array(FFT_SIZE / 2);
    var re = new Float32Array(FFT_SIZE);
    var im = new Float32Array(FFT_SIZE);
    var windows = 0;
    var i;
    for (var start = 0; start + FFT_SIZE <= samples.length; start += FFT_SIZE / 2) {
        for (i = 0; i < FFT_SIZE; i++) {
            re[i] = samples[start + i] / 32768 * hann[i];
            im[i] = 0;
        }
        fft(re, im);
        for (i = 1; i < FFT_SIZE / 2; i++) {
            power[i] += re[i] * re[i] + im[i] * im[i];
        }
        windows++;
    }

    // How far each band stands above its noise
    var above = [];
    var loudest = 0;
    var voicedBands = 0;
    if (!bandNoise) { bandNoise = []; }
    for (var b = 0; b < AudioLevels.BANDS; b++) {
        var sum = 0;
        for (i = bandBins[b][0]; i <= bandBins[b][1]; i++) {
            sum += power[i];
        }
        var db = 10 * Math.log(sum / windows + 1e-12) / Math.LN10;
        var noise = bandNoise[b];
        if (noise === undefined) {
            noise = db;
        } else if (db < noise) {
            noise += (db - noise) * NOISE_DROP;
        } else {
            noise += Math.min(db - noise, NOISE_RISE_DB);
        }
        bandNoise[b] = noise;
        above.push(db - noise - bandGate[b]);
        if (above[b] > loudest) { loudest = above[b]; }
        if (above[b] >= VOICE_DB) { voicedBands++; }
    }
    lastVoiced = voicedBands >= VOICE_BANDS;

    peakDb = Math.max(loudest, peakDb - PEAK_FALL_DB, MIN_SPAN_DB);
    var levels = [];
    for (b = 0; b < AudioLevels.BANDS; b++) {
        var level = Math.max(0, Math.min(1, above[b] / peakDb));
        levels.push(Math.round(level * 255));
    }
    return levels;
};

/**
 * Whether the chunk last analyzed sounded like someone talking rather than
 * the room, for the phone to tell when the wearer has stopped
 */
AudioLevels.voiced = function() {
    return lastVoiced;
};

module.exports = AudioLevels;
