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
 * An answer is normally asked for a sentence or a few at a time, as the agent
 * writes it, and each is played while the next is made. The wearer hears the
 * start of a long answer while the rest is still being written, rather than
 * waiting for all of it and then for all of its speech. The watch hears
 * where each sentence ends, so when the next is late it pauses between the
 * two rather than in the middle of a word.
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

// How an answer is turned into speech. Sentence by sentence starts speaking
// while the agent is still writing. Whole waits for the complete answer and
// asks for it in one go, which keeps the voice flowing from one sentence into
// the next at the cost of the wait. An assist_speak_mode setting picks one
// when it has been set.
Speech.MODE_SENTENCES = 'sentences';
Speech.MODE_WHOLE = 'whole';
var DEFAULT_MODE = Speech.MODE_SENTENCES;

// The first piece goes as soon as it holds a sentence this long, so that a
// lone "Sure." waits for the one after it rather than costing a request of
// its own
var FIRST_PIECE_CHARS = 20;

// Every piece after the first takes whatever was written while the one before
// it was being made, as many whole sentences as fit in this
var MAX_PIECE_CHARS = 400;

// While the watch waits on the next sentence it is told now and then that the
// phone is still there, well inside the ten seconds it waits before deciding
// the phone has gone (STALL_MS in simply_speaker.c)
var KEEPALIVE_MS = 4000;

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
// is small, and most voices are mastered well below full scale. The first
// piece of an answer decides by how much, and the rest follow it, so that the
// voice does not change level from one sentence to the next.
var TARGET_PEAK = 30000;
var MAX_GAIN = 4;

// Clips are numbered so a late report about the last one is never taken for
// the current one
var clipCounter = 0;

// The answer being written, from when the run starts until it has been said
// or given up on
var activeReply = null;

// The audio of that answer, from the first request to Home Assistant until the
// watch has played the last of it
var current = null;

var EMPTY = new Uint8Array(0);

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

/** Sentence by sentence, unless the setting says otherwise. */
Speech.mode = function() {
    var mode = Settings.option('assist_speak_mode');
    return mode === Speech.MODE_WHOLE || mode === Speech.MODE_SENTENCES ? mode : DEFAULT_MODE;
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

function spokenText(markdown) {
    return speakable(markdown).text;
}

Speech.spokenText = spokenText;

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
    var re = /[.!?]+["'\u201d\u2019)\]]*(?=\s)/g;
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
 * every sentence they can. `complete` says no more is coming, which makes
 * the end of the text the end of a sentence too.
 */
function nextPiece(pending, first, complete) {
    var ends = sentenceEnds(pending);
    if (complete && pending.trim()) { ends.push(pending.length); }
    var cut = 0;
    for (var i = 0; i < ends.length; i++) {
        if (first) {
            cut = ends[i];
            if (pending.substring(0, cut).trim().length >= FIRST_PIECE_CHARS) { break; }
            if (!complete) { cut = 0; }
        } else {
            if (cut && ends[i] > MAX_PIECE_CHARS) { break; }
            cut = ends[i];
        }
    }
    return cut;
}

Speech.sentenceEnds = sentenceEnds;
Speech.nextPiece = nextPiece;

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

function stopKeepAlive(clip) {
    if (clip.keepAlive) {
        clearInterval(clip.keepAlive);
        clip.keepAlive = null;
    }
}

function pump() {
    var clip = current;
    if (!clip || !clip.capacity || clip.awaitingIdle || clip.lastSent) { return; }
    if (!Speaker.isIdle()) { return; }
    while (clip.pieces.length && clip.pieces[0].end <= clip.sent) {
        clip.pieces.shift();
    }
    var piece = clip.pieces[0];
    if (!piece) {
        // Everything made so far has gone. Once nothing more is coming, the
        // watch is told so and plays out what it holds.
        if (clip.complete) {
            send(clip, EMPTY, Speaker.FLAG_LAST);
        }
        return;
    }
    var room = clip.capacity - (clip.sent - clip.played);
    var length = Math.min(CHUNK_BYTES, piece.end - clip.sent, room);
    if (length <= 0) {
        // The ring is full. The watch says when it has played some.
        return;
    }
    var end = clip.sent + length;
    var flags = 0;
    if (end === piece.end) { flags |= Speaker.FLAG_PHRASE; }
    if (end === clip.received && clip.complete) { flags |= Speaker.FLAG_LAST; }
    send(clip, piece.bytes.subarray(clip.sent - piece.start, end - piece.start), flags);
    clip.inFlight = { bytes: length, at: Date.now() };
}

function send(clip, bytes, flags) {
    Speaker.data(clip.id, clip.sent, bytes, flags);
    clip.sent += bytes.length;
    clip.lastSent = !!(flags & Speaker.FLAG_LAST);
    clip.awaitingIdle = true;
    clip.lastSentAt = Date.now();
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
                var reply = clip.reply;
                helpers.log_message('Speech: playing ' + (reply.endedAt ?
                    (clip.startedAt - reply.endedAt) + ' ms after the answer was written' :
                    'while the answer was still being written, ' +
                        (clip.startedAt - reply.begunAt) + ' ms in'));
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

//! Tell the conversation why the answer was not heard, once it is on screen
//! to be told under. Until then it waits for the answer to be finished.
function report(reply, problem) {
    if (reply.ended) {
        if (reply.onProblem) { reply.onProblem(problem); }
    } else {
        reply.problem = problem;
    }
}

function abortRequests(clip) {
    clip.requests.slice().forEach(function(req) {
        try { req.abort(); } catch (e) { /* already done */ }
    });
}

function finishClip(problem, how) {
    var clip = current;
    if (!clip) { return; }
    current = null;
    stopKeepAlive(clip);
    abortRequests(clip);
    clip.reply.finished = true;
    if (clip.linkBytes >= MIN_MEASURED_BYTES && clip.linkMs > 0) {
        recordLinkSpeed(clip.linkBytes * 1000 / clip.linkMs);
    }
    helpers.log_message('Speech: ' + (problem || how || 'finished') + ', ' + clip.asked +
        (clip.asked === 1 ? ' piece' : ' pieces') +
        (clip.linkMs ? ', link ' + Math.round(clip.linkBytes * 1000 / clip.linkMs) + ' B/s' : ''));
    if (problem) {
        report(clip.reply, 'Not read aloud: ' + problem);
    }
}

//! Tell the watch to get ready, now that the first of the audio is here
function startPlaying(clip) {
    var rate = clip.rate;
    // Enough in hand that, at the speed the link has managed before, the rest
    // arrives before the watch gets to it. With more still to be made, the
    // first piece is all there is to go on; the watch also starts as soon as
    // it has a whole sentence, so a long one never holds it up.
    var link = linkSpeed();
    var total = clip.complete ? clip.received : 0;
    var known = total || clip.pieces[0].end;
    var shortfall = link >= rate.bytesPerSecond ? 0 : known * (1 - link / rate.bytesPerSecond);
    var prebuffer = Math.round(shortfall + rate.bytesPerSecond * PREBUFFER_SECONDS);
    if (total) { prebuffer = Math.min(prebuffer, total); }

    helpers.log_message('Speech: ' + rate.hz + ' Hz, ' +
        (total ? total + ' bytes' : 'more to come') + ', starting after ' + prebuffer);
    Speaker.play(clip.id, rate.code, prebuffer, total);
    clip.playSent = true;
    clip.keepAlive = setInterval(function() {
        if (clip !== current || clip.lastSent || clip.awaitingIdle || !Speaker.isIdle() ||
                Date.now() - clip.lastSentAt < KEEPALIVE_MS) {
            return;
        }
        send(clip, EMPTY, 0);
    }, KEEPALIVE_MS / 2);
}

//! Compress the speech for one piece and put it in line for the watch
function addAudio(clip, wav) {
    var samples = resample(wav.samples, wav.rate, clip.rate.hz);
    if (clip.gain === null) {
        clip.gain = gainFor(samples);
    }
    var bytes = encodeAdpcm(amplify(samples, clip.gain), clip.adpcm);
    helpers.log_message('Speech: piece ' + clip.asked + ', ' +
        (samples.length / clip.rate.hz).toFixed(1) + ' s, ' + bytes.length + ' bytes');
    if (!bytes.length) { return; }
    clip.pieces.push({ start: clip.received, end: clip.received + bytes.length, bytes: bytes });
    clip.received += bytes.length;
}

//! Ask Home Assistant to say `words`, and line up what it says
function fetchPiece(clip, words) {
    var pipeline = clip.pipeline;
    var appState = AppState.getInstance();
    var options = {
        preferred_format: 'wav',
        preferred_sample_rate: clip.rate.hz,
        preferred_sample_channels: 1,
        preferred_sample_bytes: 2
    };
    if (pipeline.tts_voice) {
        options.voice = pipeline.tts_voice;
    }
    clip.fetching = true;
    clip.asked++;
    request(clip, 'POST', appState.ha_url + '/api/tts_get_url', {
        engine_id: pipeline.tts_engine,
        message: words,
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
            clip.fetching = false;
            addAudio(clip, wav);
            // The next piece is asked for while this one plays, and settles
            // whether this one is the last
            feed(clip.reply);
            if (clip === current && !clip.playSent && clip.received) {
                startPlaying(clip);
            }
            pump();
        });
    });
}

function startClip(reply) {
    var pipeline = selectedPipeline();
    if (!pipeline || !pipeline.tts_engine) {
        reply.finished = true;
        report(reply, 'Not read aloud: this pipeline has no text-to-speech');
        return null;
    }
    clipCounter = (clipCounter + 1) & 0xFF;
    var clip = current = {
        id: clipCounter,
        reply: reply,
        pipeline: pipeline,
        rate: chooseRate(),
        requests: [],
        // Characters of the spoken text asked for so far
        dispatched: 0,
        asked: 0,
        fetching: false,
        // All the audio there will be is here
        complete: false,
        // The compressed audio not yet sent in full, each piece at its offset
        // into the whole
        pieces: [],
        received: 0,
        gain: null,
        adpcm: { predictor: 0, index: 0 },
        playSent: false,
        sent: 0,
        played: 0,
        capacity: 0,
        lastSent: false,
        lastSentAt: 0,
        awaitingIdle: false,
        inFlight: null,
        keepAlive: null,
        linkBytes: 0,
        linkMs: 0,
        startedAt: 0
    };
    reply.clip = clip;
    return clip;
}

/**
 * Ask for the next of the answer, if there is a sentence of it ready and
 * nothing already being made. Called whenever more has been written, and
 * whenever a piece has arrived.
 */
function feed(reply) {
    if (reply !== activeReply || reply.finished) { return; }
    var clip = reply.clip;
    if (clip && (clip.fetching || clip.complete)) { return; }
    var spoken = speakable(reply.ended ? reply.text : settled(reply.text));
    var complete = reply.ended || spoken.capped;
    var pending = spoken.text.substring(clip ? clip.dispatched : 0);
    if (!clip) {
        if (!pending.trim()) { return; }
        clip = startClip(reply);
        if (!clip) { return; }
    }
    while (true) {
        var cut = reply.mode === Speech.MODE_WHOLE ? pending.length :
            nextPiece(pending, clip.asked === 0, complete);
        if (!cut) { break; }
        var words = pending.substring(0, cut).trim();
        clip.dispatched += cut;
        pending = pending.substring(cut);
        if (words) {
            fetchPiece(clip, words);
            return;
        }
    }
    if (complete && !pending.trim()) {
        clip.complete = true;
        if (!clip.received) {
            // Nothing in it to say
            finishClip(null, 'nothing to say');
        }
    }
}

/**
 * An answer is on its way. In sentence mode what has been written of it is
 * spoken as it comes (Speech.write), and Speech.end says it is complete.
 * `onProblem(text)` is told why, should it not be heard for any reason other
 * than the wearer's own: a muted speaker or a press to stop is not a problem.
 * It is only told once the answer has ended, so that the reason goes under
 * the finished answer rather than into the middle of it.
 */
Speech.begin = function(onProblem) {
    Speech.stop();
    activeReply = {
        mode: Speech.mode(),
        onProblem: onProblem,
        text: '',
        ended: false,
        // Its speech has ended, been stopped or failed, and nothing more of
        // it will be said
        finished: false,
        problem: null,
        clip: null,
        begunAt: Date.now(),
        endedAt: 0
    };
};

/** All of the answer written so far, as markdown. */
Speech.write = function(markdown) {
    var reply = activeReply;
    if (!reply || reply.ended || reply.mode !== Speech.MODE_SENTENCES) { return; }
    reply.text = String(markdown || '');
    feed(reply);
};

/**
 * The answer is complete. `markdown` is what to say if nothing was written
 * along the way, and all of it when speaking a whole answer at once. Starts
 * one if Speech.begin was never called.
 */
Speech.end = function(markdown, onProblem) {
    if (!activeReply || activeReply.ended) {
        Speech.begin(onProblem);
    }
    var reply = activeReply;
    reply.ended = true;
    reply.endedAt = Date.now();
    if (onProblem) { reply.onProblem = onProblem; }
    if (!reply.text || reply.mode === Speech.MODE_WHOLE) {
        reply.text = String(markdown || '');
    }
    if (reply.problem) {
        report(reply, reply.problem);
        return;
    }
    // Whatever was waiting on the end of the text to be a sentence goes now,
    // and with nothing more coming the watch can be told so
    feed(reply);
    pump();
};

/** Read `markdown` out on the watch with the selected pipeline's voice. */
Speech.speak = function(markdown, onProblem) {
    Speech.begin(onProblem);
    Speech.end(markdown);
};

/** Stop speaking, wherever it has got to. Safe when nothing is. */
Speech.stop = function() {
    var clip = current;
    current = null;
    activeReply = null;
    if (!clip) { return; }
    stopKeepAlive(clip);
    abortRequests(clip);
    if (clip.playSent) {
        Speaker.stop(clip.id);
    }
};

/** Whether an answer is being spoken, or about to be. */
Speech.isSpeaking = function() {
    return !!current;
};

module.exports = Speech;
