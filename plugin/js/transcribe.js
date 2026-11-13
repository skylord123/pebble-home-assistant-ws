/**
 * What was said in a recording, for watch apps that record the wearer's
 * voice themselves. Home Assistant's speech-to-text, in the pipeline chosen
 * in the watch app, hears the audio and the plugin answers with the words.
 *
 * The audio comes whole, in base64: a plugin's WebSocket closes when the
 * request that opened it ends, so nothing can be heard live across calls. It
 * is sent to Home Assistant the way the watch app sends its own: binary
 * frames that start with the handler id the run announced, once the run has
 * started speech-to-text, then a frame with only that byte to end it. Home
 * Assistant's own end-of-speech detection is off, since the recording is
 * already over and a pause in it is not the end.
 */
var ha = require('ha');
var ws = require('ws');
var options = require('options');
var codec = require('speech-codec');

var PluginError = ha.PluginError;

var FORMATS = ['ima_adpcm', 'pcm16le'];
//! Home Assistant takes 16 kHz, 16-bit mono, and nothing else is converted here
var SAMPLE_RATE = 16000;
var MAX_SECONDS = 30;
//! The most of each format a request takes: 30 seconds at 16 kHz
var MAX_BYTES = {
    ima_adpcm: MAX_SECONDS * SAMPLE_RATE / 2,
    pcm16le: MAX_SECONDS * SAMPLE_RATE * 2
};
//! The most audio sent in one frame, after its handler byte
var FRAME_BYTES = 8192;

var NO_STT = 'The assistant\'s pipeline in Home Assistant has no speech-to-text';

//! What Home Assistant refuses a run with, or ends one with, when its
//! pipeline cannot hear
var CANNOT_HEAR = ['validation-error', 'stt-provider-missing', 'stt-provider-unsupported-metadata'];

function invalid(message) {
    return new PluginError('INVALID_ARGS', message);
}

var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var BASE64_VALUE = (function() {
    var values = [];
    for (var i = 0; i < 128; i++) { values.push(-1); }
    for (var j = 0; j < BASE64.length; j++) { values[BASE64.charCodeAt(j)] = j; }
    return values;
})();

//! The bytes of base64 `text`, or null when it is not base64
function fromBase64(text) {
    var end = text.length;
    while (end > 0 && text.charAt(end - 1) === '=') { end--; }
    if (text.length - end > 2 || end % 4 === 1) { return null; }
    var out = new Uint8Array(Math.floor(end * 3 / 4));
    var value = 0;
    var bits = 0;
    var at = 0;
    for (var i = 0; i < end; i++) {
        var c = text.charCodeAt(i);
        var v = c < 128 ? BASE64_VALUE[c] : -1;
        if (v < 0) { return null; }
        value = ((value << 6) | v) & 0xFFFFFF;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[at++] = (value >> bits) & 0xFF;
        }
    }
    return out;
}

/**
 * The recording as the 16-bit little-endian samples Home Assistant takes,
 * or an INVALID_ARGS error. Its size is checked before anything is decoded.
 */
function audioArg(args) {
    if (FORMATS.indexOf(args.format) === -1) {
        throw invalid('format must be ' + FORMATS.join(' or '));
    }
    if (args.sample_rate !== undefined && args.sample_rate !== null && args.sample_rate !== SAMPLE_RATE) {
        throw invalid('sample_rate must be ' + SAMPLE_RATE);
    }
    if (typeof args.audio !== 'string' || !args.audio) {
        throw invalid('audio is required');
    }
    if (args.audio.length > Math.ceil(MAX_BYTES[args.format] / 3) * 4) {
        throw invalid('audio must be at most ' + MAX_SECONDS + ' seconds');
    }
    var bytes = fromBase64(args.audio);
    if (!bytes || bytes.length === 0) {
        throw invalid('audio must be base64');
    }
    if (args.format === 'pcm16le') {
        if (bytes.length & 1) { throw invalid('pcm16le audio must be whole 16-bit samples'); }
        return bytes;
    }
    // The bytes of the samples as they lie in memory, which is little-endian
    // on every phone
    var samples = codec.decodeAdpcm(bytes, { predictor: 0, index: 0 });
    return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * Each frame is a view of its own bytes, never a bare ArrayBuffer: the
 * emulator sends one of those empty, and Home Assistant drops the whole
 * connection for an empty frame (src/js/vendor/haws.js, sendAudio).
 */
function sendAudio(send, handler, pcm) {
    for (var at = 0; at < pcm.length; at += FRAME_BYTES) {
        var part = pcm.subarray(at, Math.min(pcm.length, at + FRAME_BYTES));
        var frame = new Uint8Array(part.length + 1);
        frame[0] = handler;
        frame.set(part, 1);
        send(frame);
    }
    // Only the handler byte: the end of the audio
    send(new Uint8Array([handler]));
}

function sttError(data) {
    if (CANNOT_HEAR.indexOf(data.code) !== -1) {
        return new PluginError('PLUGIN_UNAVAILABLE', NO_STT);
    }
    return new PluginError('UNKNOWN', data.message || 'Home Assistant could not hear the audio');
}

/**
 * transcribe { audio, format, sample_rate? }: the words Home Assistant heard
 * in `audio`, as plain text. Nothing heard is an empty answer, not an error.
 */
function transcribe(conn, opts, args) {
    var pcm;
    try {
        pcm = audioArg(args);
    } catch (err) {
        return Promise.reject(err);
    }

    var command = {
        type: 'assist_pipeline/run',
        start_stage: 'stt',
        end_stage: 'stt',
        input: { sample_rate: SAMPLE_RATE, no_vad: true }
    };
    var pipeline = options.pipeline(opts);
    if (pipeline) { command.pipeline = pipeline; }

    var handler = null;
    var sent = false;
    // Optional: a proxy that refuses WebSockets only stops this, not every
    // source that REST still reaches
    return ws.run(conn, command, function(msg, settle, send) {
        var event = msg.type === 'event' && msg.event;
        if (!event) { return; }
        var data = event.data || {};
        if (event.type === 'run-start') {
            // Where the audio goes is known now, but Home Assistant only
            // takes it once speech-to-text has started
            handler = data.runner_data ? data.runner_data.stt_binary_handler_id : null;
        } else if (event.type === 'stt-start') {
            if (typeof handler !== 'number') {
                throw new PluginError('UNKNOWN', 'Home Assistant gave nowhere to send the audio');
            }
            if (!sent) {
                sent = true;
                sendAudio(send, handler, pcm);
            }
        } else if (event.type === 'stt-end') {
            var output = data.stt_output || {};
            settle(typeof output.text === 'string' ? output.text.trim() : '');
        } else if (event.type === 'error') {
            if (data.code === 'stt-no-text-recognized') {
                settle('');
                return;
            }
            throw sttError(data);
        } else if (event.type === 'run-end') {
            throw new PluginError('UNKNOWN', 'Home Assistant ended the run without hearing the audio');
        }
    }, true).then(function(heard) {
        return { text: heard };
    }, function(err) {
        if (err && CANNOT_HEAR.indexOf(err.reason) !== -1) {
            throw new PluginError('PLUGIN_UNAVAILABLE', NO_STT);
        }
        throw err;
    });
}

module.exports = {
    transcribe: transcribe,
    MAX_SECONDS: MAX_SECONDS,
    FRAME_BYTES: FRAME_BYTES
};
