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
 * watch to undo. The speech kit's player (sdk/speech/ha_speech.js, the same
 * one other apps copy) sends it down a piece at a time over ui/speaker.js.
 * The watch says how far it has played, and nothing is ever sent past the
 * room that leaves in its ring. How fast the link has been is remembered, and
 * decides both the sample rate and how much the watch holds before it starts,
 * so that once it starts it does not run dry.
 *
 * Only the Pebble Time 2 and Core 2 Duo have a speaker.
 */
var Settings = require('settings');
var Speaker = require('ui/speaker');
var AppState = require('app/AppState');
var helpers = require('app/helpers');
var codec = require('app/speech-codec');
var HaSpeech = require('ha_speech');

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

// How fast the link has been is kept with the settings, under the key it has
// always had
var LINK_KEY = 'assist_speak_link_bps';

// Home Assistant generates speech while it is fetched, and an engine that is
// slow to start can take a while. Past this it is not coming.
var FETCH_TIMEOUT_MS = 30000;

// The answer being written, from when the run starts until it has been said
// or given up on
var activeReply = null;

// The audio of that answer, from the first request to Home Assistant until the
// watch has played the last of it
var current = null;

// Sends the audio to the watch over the app's own messages (ui/speaker.js)
var player = new HaSpeech.Player({
    transport: Speaker,
    storage: {
        getItem: function(key) { return Settings.option(key); },
        setItem: function(key, value) { Settings.option(key, value); }
    },
    linkKey: LINK_KEY,
    log: function(text) { helpers.log_message('Speech: ' + text); }
});

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

// MARK: - Playing it

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

//! The player is done with `clip`'s audio, for `error` or not
function clipEnded(clip, error) {
    if (clip === current) { current = null; }
    abortRequests(clip);
    clip.reply.finished = true;
    if (error) {
        report(clip.reply, 'Not read aloud: ' + error.message);
    }
}

//! Give up on the answer's speech, for `problem`
function finishClip(clip, problem) {
    player.finish(clip.audio, new Error(problem));
}

//! Compress the speech for one piece, ready for the player
function encodePiece(clip, wav) {
    var samples = resample(wav.samples, wav.rate, clip.hz);
    if (clip.gain === null) {
        clip.gain = gainFor(samples);
    }
    var bytes = encodeAdpcm(amplify(samples, clip.gain), clip.adpcm);
    helpers.log_message('Speech: piece ' + clip.asked + ', ' +
        (samples.length / clip.hz).toFixed(1) + ' s, ' + bytes.length + ' bytes');
    clip.received += bytes.length;
    return bytes;
}

//! Tell the player once everything there will be of the answer is with it
function endIfComplete(clip) {
    if (clip && clip === current && clip.complete) {
        player.end(clip.audio);
    }
}

//! Ask Home Assistant to say `words`, and line up what it says
function fetchPiece(clip, words) {
    var pipeline = clip.pipeline;
    var appState = AppState.getInstance();
    var options = {
        preferred_format: 'wav',
        preferred_sample_rate: clip.hz,
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
            finishClip(clip, describeFetchError(error));
            return;
        }
        var path = null;
        try { path = JSON.parse(req.responseText).path; } catch (e) { /* below */ }
        if (!path) {
            finishClip(clip, 'Home Assistant gave no audio');
            return;
        }
        // The path rather than the url: the url is built from whatever
        // address Home Assistant thinks it has, which the phone may not be
        // able to reach
        request(clip, 'GET', appState.ha_url + path, null, true, function(error2, audioReq) {
            if (error2) {
                finishClip(clip, describeFetchError(error2));
                return;
            }
            var wav = parseWav(responseBytes(audioReq));
            if (!wav || !wav.samples.length) {
                finishClip(clip, 'Home Assistant sent audio the watch cannot play');
                return;
            }
            clip.fetching = false;
            var bytes = encodePiece(clip, wav);
            // The next piece is asked for while this one plays, and settles
            // whether this one is the last
            feed(clip.reply);
            if (clip === current) {
                player.add(clip.audio, bytes, true, clip.complete);
            }
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
    var clip = current = {
        reply: reply,
        pipeline: pipeline,
        hz: player.rate(),
        requests: [],
        // Characters of the spoken text asked for so far
        dispatched: 0,
        asked: 0,
        fetching: false,
        // All the audio there will be has been made
        complete: false,
        // Bytes of compressed audio made so far
        received: 0,
        gain: null,
        adpcm: { predictor: 0, index: 0 },
        // The player's clip, which takes the audio to the watch
        audio: null
    };
    clip.audio = player.begin({
        rate: clip.hz,
        volume: Speech.volume(),
        onPlaying: function() {
            var startedAt = Date.now();
            helpers.log_message('Speech: playing ' + (reply.endedAt ?
                (startedAt - reply.endedAt) + ' ms after the answer was written' :
                'while the answer was still being written, ' +
                    (startedAt - reply.begunAt) + ' ms in'));
        },
        onEnd: function(error) {
            clipEnded(clip, error);
        }
    });
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
            player.end(clip.audio);
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
    endIfComplete(reply.clip);
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
    endIfComplete(reply.clip);
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
    abortRequests(clip);
    player.stop();
};

/** Whether an answer is being spoken, or about to be. */
Speech.isSpeaking = function() {
    return !!current;
};

module.exports = Speech;
