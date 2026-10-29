/**
 * AudioLevels - how loud each part of the voice is, for the watch to draw
 *
 * The watch never sees the audio it streams: the firmware sends it straight
 * to the phone. So the phone listens for it, splitting each 100 ms chunk into
 * frequency bands and sending one byte per band back, and the watch draws a
 * bar for each and animates between them.
 *
 * Bands are spaced evenly in pitch from the bottom of a man's voice to the
 * top of its sibilants. Higher bands carry less energy in speech, so they are
 * lifted a little per octave to keep the outer bars moving too.
 */
var AudioLevels = {};

AudioLevels.BANDS = 9;

var SAMPLE_RATE = 16000;
var FFT_SIZE = 512;
var LOW_HZ = 120;
var HIGH_HZ = 7000;
// Lift per octave above the lowest band, in dB
var TILT_DB = 2.5;
// The loudest the voice has been lately sets the top of the bars, so a quiet
// microphone fills them as well as a loud one. It falls back this fast once
// the voice drops, in dB per chunk, and never below the floor, so silence
// is not blown up into bars.
var PEAK_FALL_DB = 0.6;
var PEAK_FLOOR_DB = -55;
// How far under the peak a band can be and still show above a dot
var RANGE_DB = 33;

var hann = null;
var cosTable = null;
var sinTable = null;
var bandBins = null;
var bandLift = null;
var peakDb = PEAK_FLOOR_DB;

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
    bandLift = [];
    var binHz = SAMPLE_RATE / FFT_SIZE;
    var ratio = Math.pow(HIGH_HZ / LOW_HZ, 1 / AudioLevels.BANDS);
    for (i = 0; i < AudioLevels.BANDS; i++) {
        var lo = LOW_HZ * Math.pow(ratio, i);
        var hi = lo * ratio;
        var first = Math.max(1, Math.round(lo / binHz));
        var last = Math.max(first, Math.round(hi / binHz) - 1);
        bandBins.push([first, last]);
        bandLift.push(TILT_DB * Math.log(lo / LOW_HZ) / Math.LN2);
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

/** Start a new turn: the last one's loudness says nothing about this one. */
AudioLevels.reset = function() {
    peakDb = PEAK_FLOOR_DB;
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

    // A full-scale sine lands near 0 dB in its band
    var norm = 4 / (FFT_SIZE * FFT_SIZE * 0.25 * windows);
    var db = [];
    var loudest = -200;
    for (var b = 0; b < AudioLevels.BANDS; b++) {
        var sum = 0;
        for (i = bandBins[b][0]; i <= bandBins[b][1]; i++) {
            sum += power[i];
        }
        var value = 10 * Math.log(sum * norm + 1e-12) / Math.LN10 + bandLift[b];
        db.push(value);
        if (value > loudest) { loudest = value; }
    }

    peakDb = Math.max(loudest, peakDb - PEAK_FALL_DB, PEAK_FLOOR_DB);
    var levels = [];
    for (b = 0; b < AudioLevels.BANDS; b++) {
        var level = Math.max(0, Math.min(1, (db[b] - (peakDb - RANGE_DB)) / RANGE_DB));
        // Curved so the loudest bands stand clear of the rest rather than all
        // crowding the top together
        levels.push(Math.round(Math.pow(level, 1.4) * 255));
    }
    return levels;
};

module.exports = AudioLevels;
