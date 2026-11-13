/**
 * Text read out in the voice of the wearer's assistant, for watch apps with a
 * speaker. Home Assistant makes the speech with the engine, voice and
 * language of the pipeline chosen in the watch app, as WAV at the rate asked
 * for, and it is handed back as the 4-bit IMA ADPCM the watch decodes, the
 * same as the watch app's own spoken answers (speech-codec).
 *
 * An action can only answer with text, so a result is JSON in `text`, its
 * audio in base64. The text is split into pieces of a sentence or a few, and
 * each call answers one piece, or a slice of one that is too long to send at
 * once, along with a cursor (`next`) for the rest. Nothing is kept between
 * calls: the cursor says where the next slice starts and how the encoder
 * stood there, the caller sends the text again with it, and the same cursor
 * always gives the same bytes, so a call that was lost can just be made
 * again.
 *
 * Home Assistant starts making the speech for a piece as soon as it is asked
 * for its address, and keeps it a few minutes, so each call asks for the
 * address of the piece after its own: it is being made while this one is
 * sent and played. Asking again for one already made costs next to nothing.
 *
 * Nothing here returns or logs the address of the audio: Home Assistant
 * serves it to anyone who has it.
 */
var ha = require('ha');
var ws = require('ws');
var store = require('store');
var options = require('options');
var codec = require('speech-codec');

var PluginError = ha.PluginError;

var FORMAT = 'ima_adpcm';
var RATES = [8000, 16000];
var DEFAULT_RATE = 8000;
//! The longest text taken. Only the first 1200 or so characters are spoken
//! (speakable), so this only bounds what each call has to read through, and
//! is long enough for any reply ask_assistant hands on to speak_next.
var MAX_TEXT_CHARS = 20000;

//! Each call asks Home Assistant for one piece. Shorter than the watch app's
//! own pieces, so the piece being made ahead is ready sooner.
var MAX_PIECE_CHARS = 200;

//! The most audio one result carries: 8 seconds at 8 kHz, 4 at 16 kHz, and
//! about 43 KB once in base64
var MAX_SLICE_BYTES = 32768;

//! A cursor never points further into a clip than this
var MAX_CLIP_BYTES = 16 * 1024 * 1024;

//! How long the pipeline's voice is reused before it is looked up again
var VOICE_TTL_MS = 60 * 60 * 1000;

var CURSOR_VERSION = 1;

var SPEECH_CHANGED = 'The speech changed in Home Assistant; start again with speak';

var NO_TTS = 'The assistant\'s pipeline in Home Assistant has no text-to-speech';

function invalid(message) {
    return new PluginError('INVALID_ARGS', message);
}

/** The words of `text` to ask for one at a time, as the watch app splits an answer */
function piecesOf(text) {
    var pending = codec.speakable(text).text;
    var pieces = [];
    while (true) {
        var cut = codec.nextPiece(pending, pieces.length === 0, true, MAX_PIECE_CHARS);
        if (!cut) { break; }
        var words = pending.substring(0, cut).trim();
        pending = pending.substring(cut);
        if (words) { pieces.push(words); }
    }
    return pieces;
}

function textArg(args) {
    if (typeof args.text !== 'string' || !args.text.trim()) {
        throw invalid('text is required');
    }
    if (args.text.length > MAX_TEXT_CHARS) {
        throw invalid('text must be at most ' + MAX_TEXT_CHARS + ' characters');
    }
    var pieces = piecesOf(args.text);
    if (pieces.length === 0) {
        throw invalid('text has nothing in it to say');
    }
    return pieces;
}

function formatArg(args) {
    if (args.format !== FORMAT) {
        throw invalid('format must be ' + FORMAT);
    }
}

function rateArg(args) {
    if (args.rate === undefined || args.rate === null) { return DEFAULT_RATE; }
    if (RATES.indexOf(args.rate) === -1) {
        throw invalid('rate must be ' + RATES.join(' or '));
    }
    return args.rate;
}

/**
 * Where a slice starts: `rate`, the `piece` it is in, `at` bytes into that
 * piece's audio, which starts `clipAt` bytes into the whole; the encoder's
 * `predictor` and `index` at the start of the piece; and the `gain` the
 * first piece set, in hundredths, or 0 while there has been no first piece;
 * a fingerprint of the `text` it belongs to; and one of the `audio` of the
 * piece before `at`, since the encoder state is from the piece's start and
 * only fits the rest of it if Home Assistant makes the piece the same again.
 */
function firstCursor(rate, pieces) {
    return {
        rate: rate, piece: 0, at: 0, clipAt: 0, predictor: 0, index: 0, gain: 0,
        text: textPrint(pieces), audio: audioPrint(new Uint8Array(0), 0)
    };
}

function encodeCursor(c) {
    return [CURSOR_VERSION, c.rate, c.piece, c.at, c.clipAt, c.predictor, c.index, c.gain, c.text, c.audio].join('.');
}

//! A short fingerprint of `length` numbers, as at(i) gives them
function fingerprint(length, at) {
    var hash = 5381;
    for (var i = 0; i < length; i++) {
        hash = ((hash << 5) + hash + at(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

//! What is said of a text, so a cursor can tell it apart from other text
function textPrint(pieces) {
    var words = pieces.join('\n');
    return fingerprint(words.length, function(i) { return words.charCodeAt(i); });
}

//! The audio of a piece up to `at`
function audioPrint(bytes, at) {
    return fingerprint(at, function(i) { return bytes[i]; });
}

var CURSOR = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\.(\d+)\.(-?\d+)\.(\d+)\.(\d+)\.([0-9a-z]{1,7})\.([0-9a-z]{1,7})$/;

//! A cursor this plugin could have made, or an INVALID_ARGS error
function decodeCursor(text) {
    var m = typeof text === 'string' && text.length <= 64 ? CURSOR.exec(text) : null;
    if (!m || Number(m[1]) !== CURSOR_VERSION) { throw invalid('next is not a cursor from speak'); }
    var c = {
        rate: Number(m[2]), piece: Number(m[3]), at: Number(m[4]), clipAt: Number(m[5]),
        predictor: Number(m[6]), index: Number(m[7]), gain: Number(m[8]), text: m[9],
        audio: m[10]
    };
    var start = c.piece === 0 && c.at === 0;
    var ok = RATES.indexOf(c.rate) !== -1 &&
        c.at < MAX_CLIP_BYTES && c.clipAt < MAX_CLIP_BYTES &&
        c.predictor >= -32768 && c.predictor <= 32767 && c.index <= 88 &&
        (c.gain === 0 ? start && c.clipAt === 0 : c.gain >= 100 && c.gain <= codec.MAX_GAIN * 100) &&
        // The first piece starts the clip, from silence
        (c.piece !== 0 || (c.clipAt === 0 && c.predictor === 0 && c.index === 0));
    if (!ok) { throw invalid('next is not a cursor from speak'); }
    return c;
}

/**
 * The engine, voice and language of the pipeline the watch app uses. The
 * settings only keep its name and id, so Home Assistant is asked, and the
 * answer kept for an hour.
 */
function voiceFor(conn, opts) {
    var chosen = options.pipeline(opts) || '';
    var cached = cachedVoice(opts);
    if (cached) {
        return Promise.resolve(cached);
    }
    return ws.run(conn, { type: 'assist_pipeline/pipeline/list' }, function(msg, settle) {
        if (msg.type === 'result') { settle(msg.result || {}); }
    }).then(function(result) {
        var pipelines = Array.isArray(result.pipelines) ? result.pipelines : [];
        var find = function(id) {
            for (var i = 0; i < pipelines.length; i++) {
                if (pipelines[i] && pipelines[i].id === id) { return pipelines[i]; }
            }
            return null;
        };
        // A pipeline deleted since the app last looked gives way to the preferred one
        var pipeline = (chosen && find(chosen)) || find(result.preferred_pipeline);
        if (!pipeline || !pipeline.tts_engine) {
            throw new PluginError('PLUGIN_UNAVAILABLE', NO_TTS);
        }
        var voice = {
            engine: pipeline.tts_engine,
            voice: pipeline.tts_voice || null,
            language: pipeline.tts_language || pipeline.language || null
        };
        store.remember('voice', { pipeline: chosen, voice: voice });
        return voice;
    });
}

//! The voice looked up within the hour for the pipeline in use, or null
function cachedVoice(opts) {
    var cached = store.fresh('voice', VOICE_TTL_MS);
    return cached && cached.pipeline === (options.pipeline(opts) || '') ? cached.voice : null;
}

/**
 * Have Home Assistant start saying `words`, and resolve the path its audio
 * will be at. The path, not the url: the url is built from whatever address
 * Home Assistant thinks it has, which the phone may not reach.
 */
function startPiece(conn, voice, words, rate) {
    var settings = {
        preferred_format: 'wav',
        preferred_sample_rate: rate,
        preferred_sample_channels: 1,
        preferred_sample_bytes: 2
    };
    if (voice.voice) { settings.voice = voice.voice; }
    var body = { engine_id: voice.engine, message: words, options: settings };
    if (voice.language) { body.language = voice.language; }
    return ha.request(conn, 'POST', '/api/tts_get_url', body).then(function(answer) {
        var path = answer && answer.path;
        if (typeof path !== 'string' || path.charAt(0) !== '/') {
            throw new PluginError('UNKNOWN', 'Home Assistant gave no audio');
        }
        return path;
    }, function(err) {
        // Home Assistant turning down an engine or a language is not the caller's doing
        if (err && err.code === 'INVALID_ARGS') {
            throw new PluginError('UNKNOWN', err.message);
        }
        throw err;
    });
}

/** The samples of the piece at `path`, once Home Assistant has made them */
function fetchPiece(conn, path) {
    return ha.fetchBytes(conn, path).then(function(bytes) {
        // The audio is not there when Home Assistant failed to make it
        if (!bytes) {
            throw new PluginError('UNKNOWN', 'Home Assistant could not say that');
        }
        var wav = codec.parseWav(bytes);
        if (!wav || !wav.samples.length) {
            throw new PluginError('UNKNOWN', 'Home Assistant sent audio that is not PCM WAV');
        }
        return wav;
    }, function(err) {
        // Whatever Home Assistant said about it could name the path
        if (err && err.code === 'INVALID_ARGS') {
            throw new PluginError('UNKNOWN', 'Home Assistant could not say it');
        }
        throw err;
    });
}

var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
        var n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8) |
            (i + 2 < bytes.length ? bytes[i + 2] : 0);
        out += BASE64.charAt(n >> 18) + BASE64.charAt((n >> 12) & 63) +
            (i + 1 < bytes.length ? BASE64.charAt((n >> 6) & 63) : '=') +
            (i + 2 < bytes.length ? BASE64.charAt(n & 63) : '=');
    }
    return out;
}

/**
 * The slice of `pieces` that cursor `c` names. Its piece is made (or found
 * already made), encoded from the state the cursor carries, and cut at the
 * cursor; the next piece is asked for before answering.
 */
function slice(conn, opts, pieces, c) {
    if (c.piece >= pieces.length || c.text !== textPrint(pieces)) {
        return Promise.reject(invalid('next does not belong to this text'));
    }
    var voice;
    return voiceFor(conn, opts).then(function(found) {
        voice = found;
        return startPiece(conn, voice, pieces[c.piece], c.rate);
    }).then(function(path) {
        return fetchPiece(conn, path);
    }).then(function(wav) {
        var samples = codec.resample(wav.samples, wav.rate, c.rate);
        // The first piece sets the level for the rest, so the voice stays even
        var gain = c.gain || Math.round(codec.gainFor(samples) * 100);
        var state = { predictor: c.predictor, index: c.index };
        var bytes = codec.encodeAdpcm(codec.amplify(samples, gain / 100), state);
        // Home Assistant made this piece again, and made it differently: the
        // rest of it would not follow on from what was sent
        if (c.at >= bytes.length || audioPrint(bytes, c.at) !== c.audio) {
            throw new PluginError('UNKNOWN', SPEECH_CHANGED);
        }
        var end = Math.min(bytes.length, c.at + MAX_SLICE_BYTES);
        var endsPiece = end === bytes.length;
        var last = endsPiece && c.piece === pieces.length - 1;
        var result = {
            v: CURSOR_VERSION,
            format: FORMAT,
            rate: c.rate,
            offset: c.clipAt + c.at,
            audio: base64(bytes.subarray(c.at, end)),
            phrase: endsPiece,
            last: last
        };
        if (!last) {
            result.next = encodeCursor(endsPiece ? {
                rate: c.rate, piece: c.piece + 1, at: 0, clipAt: c.clipAt + bytes.length,
                predictor: state.predictor, index: state.index, gain: gain, text: c.text,
                audio: audioPrint(bytes, 0)
            } : {
                rate: c.rate, piece: c.piece, at: end, clipAt: c.clipAt,
                predictor: c.predictor, index: c.index, gain: gain, text: c.text,
                audio: audioPrint(bytes, end)
            });
        }
        var answer = { text: JSON.stringify(result) };
        if (c.piece + 1 >= pieces.length) { return answer; }
        // Made while this one travels and plays. Not being able to start it
        // now only means the next call waits for it.
        return startPiece(conn, voice, pieces[c.piece + 1], c.rate).then(function() {
            return answer;
        }, function() {
            return answer;
        });
    });
}

/**
 * For ask_assistant with `speak`: resolve { next }, the cursor speak_next
 * takes for `reply`, having Home Assistant start on its first piece when the
 * voice is already known. The assistant can take most of the request's
 * time, and running out of it would lose a reply to something already done,
 * so this waits for nothing that could stall: not the audio, and not a
 * WebSocket to look the voice up, which has no timeout (there are no timers)
 * and is left to the first speak_next. Resolves { speech_error } saying why
 * instead, or {} when there is nothing in the reply to say.
 */
function start(conn, opts, reply, rate) {
    // speak_next would refuse it
    if (reply.length > MAX_TEXT_CHARS) {
        return Promise.resolve({ speech_error: 'The reply is too long to read out' });
    }
    var pieces = piecesOf(reply);
    if (pieces.length === 0) { return Promise.resolve({}); }
    var next = encodeCursor(firstCursor(rate, pieces));
    var voice = cachedVoice(opts);
    if (!voice) {
        return Promise.resolve({ next: next });
    }
    return startPiece(conn, voice, pieces[0], rate).then(function() {
        return { next: next };
    }, function(err) {
        return { speech_error: (err && err.message) || 'The reply cannot be read out' };
    });
}

/** speak { text, format, rate? }: the first slice of `text` */
function speak(conn, opts, args) {
    var pieces;
    var rate;
    try {
        formatArg(args);
        pieces = textArg(args);
        rate = rateArg(args);
    } catch (err) {
        return Promise.reject(err);
    }
    return slice(conn, opts, pieces, firstCursor(rate, pieces));
}

/** speak_next { text, next, format }: the slice `next` names */
function speakNext(conn, opts, args) {
    var pieces;
    var cursor;
    try {
        formatArg(args);
        pieces = textArg(args);
        cursor = decodeCursor(args.next);
    } catch (err) {
        return Promise.reject(err);
    }
    return slice(conn, opts, pieces, cursor);
}

module.exports = {
    speak: speak,
    speakNext: speakNext,
    start: start,
    rateArg: rateArg,
    piecesOf: piecesOf,
    MAX_SLICE_BYTES: MAX_SLICE_BYTES,
    MAX_PIECE_CHARS: MAX_PIECE_CHARS
};
