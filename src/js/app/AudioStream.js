/**
 * AudioStream - the watch microphone, arriving here as audio for Home Assistant
 *
 * Firmware 4.43 can stream the microphone to this JS instead of sending it to
 * the phone's dictation service, and the phone hands it over as 16 kHz, 16-bit
 * mono PCM in audiostream events, 100 ms at a time. That is exactly what an
 * Assist pipeline's speech-to-text takes, so a turn can be heard by Home
 * Assistant itself.
 *
 * Whether it works depends on three things, and only the watch can find out
 * the last of them:
 *
 *  - the watch: a Pebble Time 2, Core 2 Duo or Core Time Round on 4.43 or later
 *  - the setting, which is on unless the wearer turned it off
 *  - the phone app, which either takes the stream, refuses it, or (if it has
 *    never heard of streams) says nothing at all
 *
 * The watch asks, and falls back to dictation by itself whenever the answer
 * is anything but yes. What it learned is kept here, so a phone that cannot
 * stream is not asked every time.
 */
var Settings = require('settings');
var helpers = require('app/helpers');

var AudioStream = {};

// Platforms Core still builds firmware for. Everything older is frozen at an
// SDK revision without the microphone stream.
var STREAM_PLATFORMS = ['emery', 'flint', 'gabbro'];
var STREAM_FIRMWARE = [4, 43];

// The rate Home Assistant is told the audio arrives at. The firmware always
// encodes at 16 kHz and the phone decodes back to it; audiostreamstart says
// so, and a different figure there is logged rather than trusted, since the
// pipeline has been started long before it arrives.
AudioStream.SAMPLE_RATE = 16000;

// A phone app that never answered does not know about streams. It may be
// updated one day, so it is asked again after this long rather than never.
var NO_ANSWER_RETRY_MS = 14 * 24 * 60 * 60 * 1000;

// What the phone did the last time it was asked, kept across launches:
// { result: 'works' | 'refused' | 'noanswer', at: ms }
var STATUS_KEY = 'assist_stream_status';

// A refusal from the Core app means its Plugins preview is off or the
// microphone has not been allowed yet. Either can change at any time, but
// asking again before the next launch would only put the same refusal, and
// the moment it costs, in front of every turn.
var refusedThisLaunch = false;

// Whoever is listening to the audio just now: one turn at a time
var sink = null;

function watchInfo() {
    try {
        return Pebble.getActiveWatchInfo ? Pebble.getActiveWatchInfo() : null;
    } catch (e) {
        return null;
    }
}

/**
 * Whether this watch can stream at all. A phone app that does not report the
 * watch's firmware leaves it to the watch, which checks for itself and simply
 * dictates if it cannot.
 */
AudioStream.watchCanStream = function() {
    var info = watchInfo();
    if (!info || STREAM_PLATFORMS.indexOf(info.platform) === -1) {
        return false;
    }
    var fw = info.firmware;
    if (!fw || typeof fw.major !== 'number') {
        return true;
    }
    return fw.major > STREAM_FIRMWARE[0] ||
        (fw.major === STREAM_FIRMWARE[0] && fw.minor >= STREAM_FIRMWARE[1]);
};

/** Whether this watch is one that could stream, whatever its firmware. */
AudioStream.watchHasStreamPlatform = function() {
    var info = watchInfo();
    return !!info && STREAM_PLATFORMS.indexOf(info.platform) !== -1;
};

/** On unless the wearer turned it off. Nothing here ever turns it back on. */
AudioStream.enabled = function() {
    return Settings.option('assist_stream_audio') !== false;
};

function status() {
    var value = Settings.option(STATUS_KEY);
    return (value && typeof value === 'object') ? value : null;
}

/**
 * Why a turn would be dictated rather than streamed, or null when it would
 * be streamed. One of 'off', 'watch', 'firmware', 'refused', 'noanswer'.
 */
AudioStream.blocker = function() {
    if (!AudioStream.enabled()) { return 'off'; }
    if (!AudioStream.watchHasStreamPlatform()) { return 'watch'; }
    if (!AudioStream.watchCanStream()) { return 'firmware'; }
    if (refusedThisLaunch) { return 'refused'; }
    var last = status();
    if (last && last.result === 'noanswer' && Date.now() - last.at < NO_ANSWER_RETRY_MS) {
        return 'noanswer';
    }
    return null;
};

/**
 * Turn it on or off for the wearer. Turning it on asks the phone afresh, since
 * the wearer may well have just allowed the microphone or updated the app.
 */
AudioStream.setEnabled = function(enabled) {
    Settings.option('assist_stream_audio', !!enabled);
    if (enabled) {
        refusedThisLaunch = false;
        var last = status();
        if (last && last.result !== 'works') {
            Settings.option(STATUS_KEY, null);
        }
    }
};

/**
 * A few words for the settings menu on how the wearer is being heard.
 * `hearsAudio` is whether the pipeline in use has speech-to-text.
 */
AudioStream.describe = function(hearsAudio) {
    switch (AudioStream.blocker()) {
        case 'off': return 'Phone dictation';
        case 'watch': return 'Not on this watch';
        case 'firmware': return 'Dictation (update watch)';
        case 'refused': return 'Dictation (allow mic)';
        case 'noanswer': return 'Dictation (phone app)';
    }
    return hearsAudio ? 'Home Assistant' : 'Dictation (no STT)';
};

/** Whether the next turn should be offered to Home Assistant as audio. */
AudioStream.shouldTry = function() {
    return AudioStream.blocker() === null;
};

/**
 * Remember what the phone did with a stream: 'works', 'refused' or
 * 'noanswer'. A stream that works clears whatever was learned before.
 */
AudioStream.record = function(result) {
    if (result === 'refused') {
        refusedThisLaunch = true;
    }
    var last = status();
    if (last && last.result === result && result === 'works') {
        return;
    }
    Settings.option(STATUS_KEY, { result: result, at: Date.now() });
    helpers.log_message('Microphone stream: ' + result);
};

/**
 * Take the audio of the turn now listening. `handlers.audio(ArrayBuffer)` gets
 * each chunk as it arrives and `handlers.end()` the end of the stream. Only
 * one turn listens at a time; attaching another replaces it.
 */
AudioStream.attach = function(handlers) {
    sink = handlers;
};

AudioStream.detach = function(handlers) {
    if (!handlers || sink === handlers) {
        sink = null;
    }
};

function decodeBase64(text) {
    if (typeof atob !== 'function') { return null; }
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function onStart(e) {
    var rate = e && (e.sampleRate || (e.payload && e.payload.sampleRate));
    if (rate && rate !== AudioStream.SAMPLE_RATE) {
        helpers.log_message('Microphone stream at ' + rate + ' Hz, expected ' +
            AudioStream.SAMPLE_RATE);
    }
}

function onAudio(e) {
    if (!sink) { return; }
    var data = e && (e.data !== undefined ? e.data : (e.payload && e.payload.data));
    // Android and iOS both hand over an ArrayBuffer. A phone that passed the
    // base64 along instead is decoded here rather than sent on as text.
    if (typeof data === 'string') {
        data = decodeBase64(data);
    }
    if (data && data.byteLength > 0) {
        sink.audio(data);
    }
}

function onStop() {
    if (sink) {
        sink.end();
    }
}

// Registered once for the life of the app. A phone app that has never heard
// of these events never fires them, and one that does not take unknown names
// is not allowed to stop the app starting.
try {
    Pebble.addEventListener('audiostreamstart', onStart);
    Pebble.addEventListener('audiostream', onAudio);
    Pebble.addEventListener('audiostreamstop', onStop);
} catch (e) {
    helpers.log_message('Microphone stream events unavailable: ' + e);
}

module.exports = AudioStream;
