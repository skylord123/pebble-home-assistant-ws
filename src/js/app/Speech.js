/**
 * Speech - Assist answers read out loud through the watch's speaker
 *
 * Home Assistant already knows how to say an answer: every pipeline has a
 * text-to-speech engine and voice. The pipeline's own audio is whatever the
 * engine makes, usually mp3, which neither this JS nor the watch can decode.
 * /api/tts_get_url takes the same engine, language and voice along with a
 * preferred format, and has Home Assistant convert the speech to plain PCM
 * WAV at the rate asked for. That works with any engine and needs nothing
 * outside Home Assistant.
 *
 * Raw PCM is far more than Bluetooth can carry in real time, so it is
 * compressed here to 4-bit IMA ADPCM, a quarter of the size and cheap for the
 * watch to undo, and sent down a piece at a time (ui/speaker.js). The watch
 * says how far it has played, and nothing is ever sent past the room that
 * leaves in its ring. How fast the link has been is remembered, and decides
 * both the sample rate and how much the watch holds before it starts, so that
 * once it starts it does not run dry.
 *
 * Only the Pebble Time 2 and Core 2 Duo have a speaker.
 */
var Settings = require('settings');
var Speaker = require('ui/speaker');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

var Speech = {};

var SPEAKER_PLATFORMS = ['emery', 'flint'];

// Bytes of audio a second at each rate, at two samples a byte
var RATES = [
    { hz: 8000, code: Speaker.RATE_8K, bytesPerSecond: 4000 },
    { hz: 16000, code: Speaker.RATE_16K, bytesPerSecond: 8000 }
];

// 16 kHz is only worth it with this much to spare over what it needs, since a
// link that cannot keep up makes the watch stop and wait part way through
var HIGH_RATE_MARGIN = 1.5;

// What the link is assumed to manage before it has been measured. Low, so the
// first answer starts a little late rather than stalling.
var DEFAULT_LINK_BPS = 3000;
var LINK_KEY = 'assist_speak_link_bps';

// Less than this says more about the moment than about the link
var MIN_MEASURED_BYTES = 4000;

// Every message the watch takes holds about 2K, some of which goes on the
// packet headers and whatever else is on its way down alongside
var CHUNK_BYTES = 1800;

// Half a second in hand on top of whatever the link speed says is needed
var PREBUFFER_SECONDS = 0.5;

// An agent can write an essay. Reading one out on a watch helps nobody, and a
// long synthesis keeps the wearer waiting for the first word, so speech stops
// at the end of the sentence nearest this.
var MAX_SPOKEN_CHARS = 1200;

// Home Assistant generates speech while it is fetched, and an engine that is
// slow to start can take a while. Past this it is not coming.
var FETCH_TIMEOUT_MS = 30000;

// Peaks are brought up to about this, at most four times louder: the speaker
// is small, and most voices are mastered well below full scale
var TARGET_PEAK = 30000;
var MAX_GAIN = 4;

// Clips are numbered so a late report about the last one is never taken for
// the current one
var clipCounter = 0;

// The answer being spoken, from the request to Home Assistant until the watch
// has played the last of it
var current = null;

function watchInfo() {
    try {
        return Pebble.getActiveWatchInfo ? Pebble.getActiveWatchInfo() : null;
    } catch (e) {
        return null;
    }
}

/** Whether this watch has a speaker at all. */
Speech.watchHasSpeaker = function() {
    var info = watchInfo();
    return !!info && SPEAKER_PLATFORMS.indexOf(info.platform) !== -1;
};

/** Off unless the wearer turned it on. */
Speech.enabled = function() {
    return Settings.option('assist_speak') === true;
};

function selectedPipeline() {
    var appState = AppState.getInstance();
    var pipelines = appState.ha_pipelines || [];
    for (var i = 0; i < pipelines.length; i++) {
        if (pipelines[i].id === appState.selected_pipeline) {
            return pipelines[i];
        }
    }
    return null;
}

/** Whether the pipeline in use has a voice to speak with. */
Speech.pipelineSpeaks = function() {
    var pipeline = selectedPipeline();
    return !!(pipeline && pipeline.tts_engine);
};

/** Whether answers should be spoken at all just now. */
Speech.wanted = function() {
    return Speech.enabled() && Speech.watchHasSpeaker();
};

function linkSpeed() {
    var bps = Number(Settings.option(LINK_KEY));
    return bps > 0 ? bps : DEFAULT_LINK_BPS;
}

//! Remember how fast the watch took audio, leaning on what was known before
//! so that one slow moment does not decide every answer after it
function recordLinkSpeed(bps) {
    if (!(bps > 0)) { return; }
    var known = Number(Settings.option(LINK_KEY));
    var next = known > 0 ? Math.round(known * 0.6 + bps * 0.4) : Math.round(bps);
    Settings.option(LINK_KEY, next);
}

function chooseRate() {
    return linkSpeed() >= RATES[1].bytesPerSecond * HIGH_RATE_MARGIN ? RATES[1] : RATES[0];
}

/**
 * The words of an answer, without the markdown. A conversation agent writes
 * for a screen: what is only there for the eye (emphasis, code, links, list
 * markers) is either read out as punctuation or spelled out by the engine.
 */
function spokenText(markdown) {
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
    if (text.length > MAX_SPOKEN_CHARS) {
        var cut = text.substring(0, MAX_SPOKEN_CHARS);
        var end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
        text = end > MAX_SPOKEN_CHARS / 2 ? cut.substring(0, end + 1) : cut;
    }
    return text.trim();
}

Speech.spokenText = spokenText;

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

//! Louder, up to a point, so a quiet voice carries on a small speaker
function normalize(samples) {
    var peak = 0;
    for (var i = 0; i < samples.length; i++) {
        var v = samples[i] < 0 ? -samples[i] : samples[i];
        if (v > peak) { peak = v; }
    }
    if (peak === 0) { return samples; }
    var gain = Math.min(MAX_GAIN, TARGET_PEAK / peak);
    if (gain <= 1.05) { return samples; }
    for (var j = 0; j < samples.length; j++) {
        samples[j] = samples[j] * gain;
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
 */
function encodeAdpcm(samples) {
    var out = new Uint8Array(Math.ceil(samples.length / 2));
    var predictor = 0;
    var index = 0;
    for (var i = 0; i < samples.length; i++) {
        var step = ADPCM_STEP[index];
        var diff = samples[i] - predictor;
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
    return out;
}

Speech.parseWav = parseWav;
Speech.encodeAdpcm = encodeAdpcm;

// MARK: - Home Assistant

function request(clip, method, url, body, binary, onDone) {
    var appState = AppState.getInstance();
    var req = new XMLHttpRequest();
    var finished = false;
    function finish(error, result) {
        if (finished) { return; }
        finished = true;
        clearTimeout(timer);
        clip.requests.splice(clip.requests.indexOf(req), 1);
        if (clip === current) { onDone(error, result); }
    }
    var timer = setTimeout(function() {
        try { req.abort(); } catch (e) { /* already done */ }
        finish({ timeout: true });
    }, FETCH_TIMEOUT_MS);
    req.open(method, url, true);
    req.setRequestHeader('Authorization', 'Bearer ' + appState.ha_password);
    if (body) {
        req.setRequestHeader('Content-Type', 'application/json');
    }
    if (binary) {
        try { req.responseType = 'arraybuffer'; } catch (e) { /* older engines */ }
        // A phone app whose XHR knows nothing of array buffers still hands
        // back every byte intact as text in this charset
        if (req.responseType !== 'arraybuffer' && req.overrideMimeType) {
            req.overrideMimeType('text/plain; charset=x-user-defined');
        }
    }
    req.onreadystatechange = function() {
        if (req.readyState !== 4) { return; }
        if (req.status < 200 || req.status >= 300) {
            var message = '';
            try { message = JSON.parse(req.responseText).message || ''; } catch (e) { /* not JSON */ }
            finish({ status: req.status, message: message });
            return;
        }
        finish(null, req);
    };
    clip.requests.push(req);
    req.send(body ? JSON.stringify(body) : null);
}

function responseBytes(req) {
    if (req.response instanceof ArrayBuffer) {
        return req.response;
    }
    var text = req.responseText || '';
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) {
        bytes[i] = text.charCodeAt(i) & 0xFF;
    }
    return bytes.buffer;
}

function describeFetchError(error) {
    if (error.timeout) { return 'Home Assistant took too long to say it'; }
    if (error.status === 401) { return 'Home Assistant refused the request'; }
    if (error.message) { return 'Home Assistant: ' + error.message; }
    if (!error.status) { return 'Could not reach Home Assistant'; }
    return 'Home Assistant could not say it (' + error.status + ')';
}

// MARK: - Sending it to the watch

function pump() {
    var clip = current;
    if (!clip || !clip.audio || !clip.capacity || clip.awaitingIdle || clip.lastSent) { return; }
    if (!Speaker.isIdle()) { return; }
    var room = clip.capacity - (clip.sent - clip.played);
    var length = Math.min(CHUNK_BYTES, clip.audio.length - clip.sent, room);
    if (length <= 0 && clip.sent < clip.audio.length) {
        // The ring is full. The watch says when it has played some.
        clip.waitingForRoom = true;
        return;
    }
    clip.waitingForRoom = false;
    var last = clip.sent + length >= clip.audio.length;
    Speaker.data(clip.id, clip.sent, clip.audio.subarray(clip.sent, clip.sent + length), last);
    clip.sent += length;
    clip.lastSent = last;
    clip.awaitingIdle = true;
    clip.inFlight = { bytes: length, at: Date.now() };
}

Speaker.onIdle(function() {
    var clip = current;
    if (!clip) { return; }
    if (clip.inFlight) {
        // Time from handing a piece over to the watch taking it is what the
        // link can do, as long as nothing else was in the way
        clip.linkBytes += clip.inFlight.bytes;
        clip.linkMs += Date.now() - clip.inFlight.at;
        clip.inFlight = null;
    }
    clip.awaitingIdle = false;
    pump();
});

Speaker.onStatus(function(id, state, played, capacity) {
    var clip = current;
    if (!clip || id !== clip.id) { return; }
    switch (state) {
        case Speaker.BUFFERING:
        case Speaker.PLAYING:
            clip.capacity = capacity;
            if (played > clip.played) { clip.played = played; }
            if (state === Speaker.PLAYING && !clip.startedAt) {
                clip.startedAt = Date.now();
                helpers.log_message('Speech: playing after ' + (clip.startedAt - clip.askedAt) + ' ms');
            }
            pump();
            return;
        case Speaker.DONE:
            finishClip(null, 'finished');
            return;
        case Speaker.MUTED:
            finishClip(null, 'the watch speaker is muted');
            return;
        case Speaker.STOPPED:
            finishClip(null, 'stopped on the watch');
            return;
        case Speaker.PREEMPTED:
            finishClip(null, 'the watch needed its speaker for something else');
            return;
        case Speaker.NO_MEMORY:
            finishClip('The watch had no room to play it');
            return;
        default:
            finishClip('The watch could not play it');
            return;
    }
});

function finishClip(problem, how) {
    var clip = current;
    if (!clip) { return; }
    current = null;
    if (clip.linkBytes >= MIN_MEASURED_BYTES && clip.linkMs > 0) {
        recordLinkSpeed(clip.linkBytes * 1000 / clip.linkMs);
    }
    helpers.log_message('Speech: ' + (problem || how || 'finished') +
        (clip.linkMs ? ', link ' + Math.round(clip.linkBytes * 1000 / clip.linkMs) + ' B/s' : ''));
    if (problem && clip.onProblem) {
        clip.onProblem('Not read aloud: ' + problem);
    }
}

function startTransfer(clip, wav) {
    var rate = clip.rate;
    var samples = normalize(resample(wav.samples, wav.rate, rate.hz));
    clip.audio = encodeAdpcm(samples);
    if (clip.audio.length === 0) {
        finishClip(null);
        return;
    }

    // Enough in hand that, at the speed the link has managed before, the rest
    // arrives before the watch gets to it
    var link = linkSpeed();
    var total = clip.audio.length;
    var shortfall = link >= rate.bytesPerSecond ? 0 : total * (1 - link / rate.bytesPerSecond);
    var prebuffer = Math.round(shortfall + rate.bytesPerSecond * PREBUFFER_SECONDS);

    helpers.log_message('Speech: ' + (samples.length / rate.hz).toFixed(1) + ' s at ' +
        rate.hz + ' Hz, ' + total + ' bytes, starting after ' + prebuffer);
    Speaker.play(clip.id, rate.code, Math.min(prebuffer, total), total);
}

/**
 * Read `markdown` out on the watch with the selected pipeline's voice.
 * `onProblem(text)` is told why, should it not be heard for any reason other
 * than the wearer's own: a muted speaker or a press to stop is not a problem.
 */
Speech.speak = function(markdown, onProblem) {
    Speech.stop();
    var text = spokenText(markdown);
    if (!text) { return; }
    var pipeline = selectedPipeline();
    if (!pipeline || !pipeline.tts_engine) {
        if (onProblem) { onProblem('Not read aloud: this pipeline has no text-to-speech'); }
        return;
    }

    clipCounter = (clipCounter + 1) & 0xFF;
    var rate = chooseRate();
    var clip = current = {
        id: clipCounter,
        rate: rate,
        requests: [],
        audio: null,
        sent: 0,
        played: 0,
        capacity: 0,
        lastSent: false,
        awaitingIdle: false,
        inFlight: null,
        linkBytes: 0,
        linkMs: 0,
        askedAt: Date.now(),
        startedAt: 0,
        onProblem: onProblem
    };

    var appState = AppState.getInstance();
    var options = {
        preferred_format: 'wav',
        preferred_sample_rate: rate.hz,
        preferred_sample_channels: 1,
        preferred_sample_bytes: 2
    };
    if (pipeline.tts_voice) {
        options.voice = pipeline.tts_voice;
    }
    request(clip, 'POST', appState.ha_url + '/api/tts_get_url', {
        engine_id: pipeline.tts_engine,
        message: text,
        language: pipeline.tts_language || pipeline.language,
        options: options
    }, false, function(error, req) {
        if (error) {
            finishClip(describeFetchError(error));
            return;
        }
        var path = null;
        try { path = JSON.parse(req.responseText).path; } catch (e) { /* below */ }
        if (!path) {
            finishClip('Home Assistant gave no audio');
            return;
        }
        // The path rather than the url: the url is built from whatever
        // address Home Assistant thinks it has, which the phone may not be
        // able to reach
        request(clip, 'GET', appState.ha_url + path, null, true, function(error2, audioReq) {
            if (error2) {
                finishClip(describeFetchError(error2));
                return;
            }
            var wav = parseWav(responseBytes(audioReq));
            if (!wav || !wav.samples.length) {
                finishClip('Home Assistant sent audio the watch cannot play');
                return;
            }
            startTransfer(clip, wav);
        });
    });
};

/** Stop speaking, wherever it has got to. Safe when nothing is. */
Speech.stop = function() {
    var clip = current;
    if (!clip) { return; }
    current = null;
    clip.requests.slice().forEach(function(req) {
        try { req.abort(); } catch (e) { /* already done */ }
    });
    if (clip.audio) {
        Speaker.stop(clip.id);
    }
};

/** Whether an answer is being spoken, or about to be. */
Speech.isSpeaking = function() {
    return !!current;
};

module.exports = Speech;
