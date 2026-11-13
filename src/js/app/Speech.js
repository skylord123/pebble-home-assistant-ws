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
var codec = require('app/speech-codec');

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

// Home Assistant generates speech while it is fetched, and an engine that is
// slow to start can take a while. Past this it is not coming.
var FETCH_TIMEOUT_MS = 30000;

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

// How loud, as a share of the watch's own speaker volume, which is the most
// an app can play at. The voice is already brought up to near full scale, so
// all the way up is loud.
Speech.VOLUMES = [25, 50, 75, 100];
var DEFAULT_VOLUME = 50;

/** The volume the wearer picked, from Speech.VOLUMES. */
Speech.volume = function() {
    var volume = Number(Settings.option('assist_speak_volume'));
    return Speech.VOLUMES.indexOf(volume) !== -1 ? volume : DEFAULT_VOLUME;
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

// Splitting answers into pieces and encoding their audio is shared with the
// plugin, in app/speech-codec.js
var speakable = codec.speakable;
var settled = codec.settled;
var sentenceEnds = codec.sentenceEnds;
var nextPiece = codec.nextPiece;
var parseWav = codec.parseWav;
var resample = codec.resample;
var gainFor = codec.gainFor;
var amplify = codec.amplify;
var encodeAdpcm = codec.encodeAdpcm;

function spokenText(markdown) {
    return speakable(markdown).text;
}

Speech.spokenText = spokenText;
Speech.sentenceEnds = sentenceEnds;
Speech.nextPiece = nextPiece;
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
    Speaker.play(clip.id, rate.code, prebuffer, total, Speech.volume());
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
