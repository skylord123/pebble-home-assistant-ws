/**
 * ha_speech.js - Home Assistant speech on the watch's speaker, phone side
 *
 * Part of Home Assistant WS (github.com/skylord123/pebble-home-assistant-ws),
 * MIT licence. Copy it into your app unchanged.
 *
 * The watch keeps a ring of 4-bit IMA ADPCM audio and plays it as it decodes
 * it (ha_speech.c). This side sends the audio down a piece at a time. The
 * watch says how far it has played and how big its ring is, and nothing is
 * ever sent past the room that leaves. How fast the link has been is
 * remembered, and decides both the sample rate and how much the watch holds
 * before it starts, so that once it starts it does not run dry.
 *
 * The audio comes from Home Assistant WS, through its plugin: `speak` and
 * `speak_next` make any text into speech in the voice of the wearer's
 * assistant, a slice at a time, and `ask_assistant` with `speak: true`
 * answers a question with a reply that can be read out the same way.
 *
 * Only the Pebble Time 2 and Core 2 Duo have a speaker.
 *
 * Plain ES5 with no dependencies. In your app's src/pkjs:
 *
 *     var HaSpeech = require('./ha_speech');
 *     var speech = HaSpeech.create({ key: 'HA_SPEECH' });
 *
 *     Pebble.addEventListener('appmessage', function(e) {
 *         if (speech.handleMessage(e.payload)) { return; }
 *         // your own messages
 *     });
 *
 *     speech.say('The garage door is closed.').then(function(how) {
 *         // 'done', 'muted', 'stopped' or 'preempted'
 *     }, function(error) {
 *         console.log(error.code + ': ' + error.message);
 *     });
 *
 * `key` is the message key the watch side was given (MESSAGE_KEY_HA_SPEECH),
 * declared in your package.json's messageKeys. Every message to and from the
 * watch is one byte array under that key: an op byte, then its fields, all
 * numbers little-endian.
 *
 *     1 PLAY    phone to watch  clip u8, rate u8 (0 8 kHz, 1 16 kHz), volume u8,
 *                               flags u8 (0), prebuffer u32, total u32 (0 unknown)
 *     2 DATA    phone to watch  clip u8, flags u8 (1 LAST, 2 PHRASE), offset u32, audio
 *     3 STOP    phone to watch  clip u8
 *     4 STATUS  watch to phone  clip u8, state u8, played u32, capacity u32
 */

// MARK: - What the watch understands

// Must match ha_speech.c
var OP_PLAY = 1;
var OP_DATA = 2;
var OP_STOP = 3;
var OP_STATUS = 4;

var RATE_8K = 0;
var RATE_16K = 1;

var FLAG_LAST = 1;
var FLAG_PHRASE = 2;

// What a STATUS says. BUFFERING and PLAYING come while a clip goes on, with
// how far it has played and how big the ring is; the rest end it.
var BUFFERING = 0;
var PLAYING = 1;
var DONE = 2;
var STOPPED = 3;
var MUTED = 4;
var NO_MEMORY = 5;
var FAILED = 6;
var PREEMPTED = 7;

// MARK: - The player

// While the watch waits on the next piece it is told now and then that the
// phone is still there, well inside the ten seconds it waits before deciding
// the phone has gone (STALL_MS in ha_speech.c)
var KEEPALIVE_MS = 4000;

// Bytes of audio a second at each rate, at two samples a byte
var RATES = [
    { hz: 8000, code: RATE_8K, bytesPerSecond: 4000 },
    { hz: 16000, code: RATE_16K, bytesPerSecond: 8000 }
];

// 16 kHz is only worth it with this much to spare over what it needs, since a
// link that cannot keep up makes the watch stop and wait part way through
var HIGH_RATE_MARGIN = 1.5;

// What the link is assumed to manage before it has been measured. Low, so the
// first answer starts a little late rather than stalling.
var DEFAULT_LINK_BPS = 3000;
var LINK_KEY = 'ha_speech_link_bps';

// Less than this says more about the moment than about the link
var MIN_MEASURED_BYTES = 4000;

// Every message the watch takes holds about 2K, some of which goes on the
// packet headers and whatever else is on its way down alongside
var CHUNK_BYTES = 1800;

// Half a second in hand on top of whatever the link speed says is needed
var PREBUFFER_SECONDS = 0.5;

// With the watchdog on: how long past its due a report is given up on, and
// how long past the end of the audio a clip with no word of being done is
// taken as done
var REPORT_GRACE_MS = 4000;
var DONE_GRACE_MS = 5000;

var EMPTY = new Uint8Array(0);

function rateFor(hz) {
    return Number(hz) === RATES[1].hz ? RATES[1] : RATES[0];
}

function speechError(code, message) {
    var error = new Error(message || code);
    error.code = code;
    return error;
}

/**
 * Player - plays audio someone else has made through the watch's speaker
 *
 * One clip at a time: begin() starts one, add() hands it audio as it comes,
 * in order, and the last add() (or end()) says nothing more is coming. A new
 * clip stops the one before.
 *
 *     var player = new Player({ transport: transport, storage: localStorage });
 *     var clip = player.begin({ rate: player.rate(), volume: 50,
 *         onEnd: function(error, how) { ... } });
 *     player.add(clip, bytes, true, false);   // a sentence of it
 *     player.add(clip, more, true, true);     // the last of it
 *
 * options:
 *   transport - carries messages to and from the watch, with
 *               play(clip, rate, prebuffer, total, volume),
 *               data(clip, offset, bytes, flags), stop(clip), isIdle(),
 *               onIdle(fn) and onStatus(fn(clip, state, played, capacity)).
 *               AppMessageTransport below is one.
 *   storage   - where the link speed is remembered, with getItem/setItem
 *   linkKey   - the key it is remembered under
 *   log       - fn(text) for what happened, if wanted
 *   watchdog  - true when a report from the watch can go missing, as over
 *               AppMessage: a clip then ends 'done' once it has had time to
 *               play out, or FAILED when the watch stops saying how far it
 *               has got while there is more to send
 *
 * onEnd(error, how) is called once, when the clip has ended: error is null,
 * or an Error whose code is NO_MEMORY, FAILED or whatever finish() was given;
 * how is 'done', 'muted', 'stopped', 'preempted' or 'nothing' (there was no
 * audio in it), or null with an error.
 */
function Player(options) {
    var transport = options.transport;
    var storage = options.storage || null;
    var linkKey = options.linkKey || LINK_KEY;
    var log = options.log || function() {};
    var watchdog = !!options.watchdog;
    var self = this;

    // Clips are numbered so a late report about the last one is never taken
    // for the current one
    var clipCounter = 0;

    // The clip playing, from its first piece until the watch has played the
    // last of it
    var current = null;

    function linkSpeed() {
        var bps = 0;
        try { bps = storage ? Number(storage.getItem(linkKey)) : 0; } catch (e) { /* none kept */ }
        return bps > 0 ? bps : DEFAULT_LINK_BPS;
    }

    //! Remember how fast the watch took audio, leaning on what was known before
    //! so that one slow moment does not decide every answer after it
    function recordLinkSpeed(bps) {
        if (!(bps > 0) || !storage) { return; }
        try {
            var known = Number(storage.getItem(linkKey));
            var next = known > 0 ? Math.round(known * 0.6 + bps * 0.4) : Math.round(bps);
            storage.setItem(linkKey, next);
        } catch (e) { /* not kept */ }
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
        if (!transport.isIdle()) { return; }
        while (clip.pieces.length && clip.pieces[0].end <= clip.sent) {
            clip.pieces.shift();
        }
        var piece = clip.pieces[0];
        if (!piece) {
            // Everything made so far has gone. Once nothing more is coming, the
            // watch is told so and plays out what it holds.
            if (clip.complete) {
                send(clip, EMPTY, FLAG_LAST);
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
        if (end === piece.end && piece.phrase) { flags |= FLAG_PHRASE; }
        if (end === clip.received && clip.complete) { flags |= FLAG_LAST; }
        send(clip, piece.bytes.subarray(clip.sent - piece.start, end - piece.start), flags);
        clip.inFlight = { bytes: length, at: Date.now() };
    }

    function send(clip, bytes, flags) {
        transport.data(clip.id, clip.sent, bytes, flags);
        clip.sent += bytes.length;
        clip.lastSent = !!(flags & FLAG_LAST);
        clip.awaitingIdle = true;
        clip.lastSentAt = Date.now();
    }

    transport.onIdle(function() {
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

    transport.onStatus(function(id, state, played, capacity) {
        var clip = current;
        if (!clip || id !== clip.id) { return; }
        clip.heardAt = Date.now();
        switch (state) {
            case BUFFERING:
            case PLAYING:
                clip.capacity = capacity;
                if (played > clip.played) { clip.played = played; }
                if (state === PLAYING && !clip.startedAt) {
                    clip.startedAt = Date.now();
                    if (clip.onPlaying) { clip.onPlaying(); }
                }
                pump();
                return;
            case DONE:
                finishClip(null, 'finished', 'done');
                return;
            case MUTED:
                finishClip(null, 'the watch speaker is muted', 'muted');
                return;
            case STOPPED:
                finishClip(null, 'stopped on the watch', 'stopped');
                return;
            case PREEMPTED:
                finishClip(null, 'the watch needed its speaker for something else', 'preempted');
                return;
            case NO_MEMORY:
                finishClip(speechError('NO_MEMORY', 'The watch had no room to play it'));
                return;
            default:
                finishClip(speechError('FAILED', 'The watch could not play it'));
                return;
        }
    });

    function finishClip(error, how, result) {
        var clip = current;
        if (!clip) { return; }
        current = null;
        stopKeepAlive(clip);
        if (clip.linkBytes >= MIN_MEASURED_BYTES && clip.linkMs > 0) {
            recordLinkSpeed(clip.linkBytes * 1000 / clip.linkMs);
        }
        log((error ? error.message : how || 'finished') + ', ' + clip.added +
            (clip.added === 1 ? ' piece' : ' pieces') +
            (clip.linkMs ? ', link ' + Math.round(clip.linkBytes * 1000 / clip.linkMs) + ' B/s' : ''));
        if (clip.onEnd) { clip.onEnd(error || null, error ? null : result || 'done'); }
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

        log(rate.hz + ' Hz, ' + (total ? total + ' bytes' : 'more to come') +
            ', starting after ' + prebuffer);
        transport.play(clip.id, rate.code, prebuffer, total, clip.volume);
        clip.playSent = true;
        clip.heardAt = Date.now();
        clip.keepAlive = setInterval(function() {
            if (clip !== current || (watchdog && reportsLost(clip))) { return; }
            if (clip.lastSent || clip.awaitingIdle || !transport.isIdle() ||
                    Date.now() - clip.lastSentAt < KEEPALIVE_MS) {
                return;
            }
            send(clip, EMPTY, 0);
        }, KEEPALIVE_MS / 2);
    }

    //! With `watchdog`: a report from the watch that never arrived. Over
    //! AppMessage one the phone could not take is gone for good, and the watch
    //! only sends another once it has played more, so the clip would never
    //! end. True when this has ended it.
    function reportsLost(clip) {
        var now = Date.now();
        if (clip.lastSent) {
            // Everything has gone. Once the watch has had more than long
            // enough to play what it holds, it has, whether it said so or not.
            var left = (clip.received - clip.played) * 1000 / clip.rate.bytesPerSecond;
            if (now - clip.lastSentAt > left + DONE_GRACE_MS) {
                finishClip(null, 'finished, as far as can be told', 'done');
                return true;
            }
            return false;
        }
        // Waiting to hear the watch is ready, or for room in its ring. While
        // it plays it reports every quarter of the ring, so a while past that
        // with nothing heard, nothing is coming.
        var waiting = !clip.capacity ||
            (clip.sent < clip.received && clip.sent - clip.played >= clip.capacity);
        var quarter = clip.capacity / 4 * 1000 / clip.rate.bytesPerSecond;
        if (waiting && now - clip.heardAt > quarter + REPORT_GRACE_MS) {
            transport.stop(clip.id);
            finishClip(speechError('FAILED', 'The watch stopped saying how far it has played'));
            return true;
        }
        return false;
    }

    // MARK: - What the caller sees

    /** The sample rate to make audio at, 8000 or 16000, from how fast the link has been. */
    self.rate = function() {
        return linkSpeed() >= RATES[1].bytesPerSecond * HIGH_RATE_MARGIN ? RATES[1].hz : RATES[0].hz;
    };

    /** How fast the link to the watch has been, in bytes a second. */
    self.linkSpeed = linkSpeed;

    /**
     * Start a new clip, stopping any before it. `opts`: rate (8000 or 16000,
     * what the audio is made at), volume (0 to 100, a share of the watch's
     * own speaker volume), onEnd(error, how), and onPlaying() for when the
     * watch starts to play it. Returns the clip, for add() and end().
     */
    self.begin = function(opts) {
        opts = opts || {};
        self.stop();
        clipCounter = (clipCounter + 1) & 0xFF;
        var volume = Number(opts.volume);
        current = {
            id: clipCounter,
            rate: rateFor(opts.rate),
            volume: volume >= 0 && volume <= 100 ? Math.round(volume) : 100,
            onEnd: opts.onEnd || null,
            onPlaying: opts.onPlaying || null,
            // All the audio there will be is here
            complete: false,
            // The audio not yet sent in full, each piece at its offset into
            // the whole
            pieces: [],
            received: 0,
            added: 0,
            playSent: false,
            sent: 0,
            played: 0,
            capacity: 0,
            lastSent: false,
            lastSentAt: 0,
            // When the watch last said anything about it
            heardAt: 0,
            awaitingIdle: false,
            inFlight: null,
            keepAlive: null,
            linkBytes: 0,
            linkMs: 0,
            startedAt: 0
        };
        return current;
    };

    /**
     * The next of `clip`'s audio, a Uint8Array of IMA ADPCM carrying on from
     * the last. `phrase` when it ends a sentence, where a pause sounds
     * natural if the next is late; `last` when nothing more is coming.
     * Audio for a clip that has since ended is dropped.
     */
    self.add = function(clip, bytes, phrase, last) {
        if (!clip || clip !== current) { return; }
        if (bytes && bytes.length) {
            clip.pieces.push({ start: clip.received, end: clip.received + bytes.length, bytes: bytes,
                phrase: !!phrase });
            clip.received += bytes.length;
            clip.added++;
        }
        if (last) {
            clip.complete = true;
            if (!clip.received) {
                // Nothing in it to say
                finishClip(null, 'nothing to say', 'nothing');
                return;
            }
        }
        if (!clip.playSent && clip.received) {
            startPlaying(clip);
        }
        pump();
    };

    /** Nothing more is coming for `clip`: the watch plays out what it has. */
    self.end = function(clip) {
        self.add(clip, null, false, true);
    };

    /**
     * Give up on `clip` for `error`, which goes to its onEnd. The watch is
     * not told: what it holds plays out, and it gives up waiting for more.
     */
    self.finish = function(clip, error) {
        if (!clip || clip !== current) { return; }
        finishClip(error);
    };

    /** Stop speaking, wherever it has got to. Safe when nothing is. */
    self.stop = function() {
        var clip = current;
        current = null;
        if (!clip) { return; }
        stopKeepAlive(clip);
        if (clip.playSent) {
            transport.stop(clip.id);
        }
        if (clip.onEnd) { clip.onEnd(null, 'stopped'); }
    };

    /** Whether `clip` is the one playing, or about to. */
    self.isCurrent = function(clip) {
        return !!clip && clip === current;
    };

    /** Whether a clip is playing, or about to. */
    self.isPlaying = function() {
        return !!current;
    };
}

Player.RATE_8K = RATE_8K;
Player.RATE_16K = RATE_16K;
Player.FLAG_LAST = FLAG_LAST;
Player.FLAG_PHRASE = FLAG_PHRASE;
Player.BUFFERING = BUFFERING;
Player.PLAYING = PLAYING;
Player.DONE = DONE;
Player.STOPPED = STOPPED;
Player.MUTED = MUTED;
Player.NO_MEMORY = NO_MEMORY;
Player.FAILED = FAILED;
Player.PREEMPTED = PREEMPTED;

// MARK: - Messages to and from the watch

// A message the watch refuses (its inbox busy, say) is sent again after this
var RETRY_MS = 100;

// Refused this many times in a row, the watch app has most likely gone
var MAX_RETRIES = 10;

function pushU32(out, value) {
    out.push(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
}

function readU32(bytes, at) {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/**
 * AppMessageTransport - the Player's messages over AppMessage, as one byte
 * array under `key` (see the top of this file)
 *
 * One message is in flight at a time. The watch taking it (an ack) sends the
 * next, and once there is nothing left to send the transport is idle. A
 * message the watch refuses (a nack) is sent again; the watch ignores audio
 * it already has, so sending a piece twice does no harm.
 */
function AppMessageTransport(key) {
    var queue = [];
    var sending = false;
    var retries = 0;
    var statusHandler = null;
    var idleHandler = null;
    var self = this;

    function sendNext() {
        var head = queue[0];
        if (!head) {
            sending = false;
            if (idleHandler) { idleHandler(); }
            return;
        }
        sending = true;
        var message = {};
        message[key] = head;
        Pebble.sendAppMessage(message, function() {
            retries = 0;
            queue.shift();
            sendNext();
        }, function() {
            if (++retries <= MAX_RETRIES) {
                setTimeout(sendNext, RETRY_MS);
                return;
            }
            // The watch is not listening. Every clip with a message still
            // waiting here is over, not only the one at the front.
            var clips = [];
            queue.forEach(function(waiting) {
                if (clips.indexOf(waiting[1]) === -1) { clips.push(waiting[1]); }
            });
            retries = 0;
            queue = [];
            sending = false;
            clips.forEach(function(clip) {
                if (statusHandler) { statusHandler(clip, FAILED, 0, 0); }
            });
        });
    }

    function enqueue(bytes) {
        queue.push(bytes);
        if (!sending) { sendNext(); }
    }

    self.play = function(clip, rate, prebuffer, total, volume) {
        var out = [OP_PLAY, clip, rate, volume, 0];
        pushU32(out, prebuffer);
        pushU32(out, total);
        enqueue(out);
    };

    self.data = function(clip, offset, bytes, flags) {
        var out = [OP_DATA, clip, flags];
        pushU32(out, offset);
        for (var i = 0; i < bytes.length; i++) { out.push(bytes[i]); }
        enqueue(out);
    };

    self.stop = function(clip) {
        enqueue([OP_STOP, clip]);
    };

    /** Whether nothing is waiting to go to the watch. */
    self.isIdle = function() {
        return !sending;
    };

    self.onStatus = function(fn) { statusHandler = fn; };
    self.onIdle = function(fn) { idleHandler = fn; };

    /**
     * An AppMessage's payload from the watch. True if it was under `key`,
     * so the app's own handler can leave it alone.
     */
    self.handleMessage = function(payload) {
        var bytes = payload ? payload[key] : undefined;
        if (bytes === undefined || bytes === null) { return false; }
        if (bytes[0] === OP_STATUS && bytes.length >= 11 && statusHandler) {
            statusHandler(bytes[1], bytes[2], readU32(bytes, 3), readU32(bytes, 7));
        }
        return true;
    };
}

// MARK: - Home Assistant WS's plugin

var PLUGIN_UUID = '61ae3254-ce00-49db-aad8-23143f649b90';

var FORMAT = 'ima_adpcm';

// The most the Pebble app lets a request take, counted from when it is
// asked, so time spent waiting behind other requests counts too
var REQUEST_TIMEOUT_MS = 20000;

// A Pebble app that does not stop requests itself is given a while longer
// before one counts as not coming back
var INVOKE_TIMEOUT_MS = 25000;

/**
 * Call one of the plugin's actions. Resolves the `text` of its result, or
 * rejects with an Error whose code is the plugin's (or the Pebble app's):
 * AUTH_REQUIRED, PERMISSION_DENIED, INVALID_ARGS, PLUGIN_UNAVAILABLE,
 * TIMEOUT or UNKNOWN.
 */
function invoke(action, args) {
    return new Promise(function(resolve, reject) {
        var settled = false;
        function settle(result) {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            if (result && result.ok) {
                resolve(typeof result.text === 'string' ? result.text : '');
            } else {
                reject(speechError((result && result.code) || 'UNKNOWN', result && result.message));
            }
        }
        var timer = setTimeout(function() {
            settle({ ok: false, code: 'TIMEOUT', message: 'Home Assistant WS took too long' });
        }, INVOKE_TIMEOUT_MS);
        if (typeof Pebble === 'undefined' || typeof Pebble.invokeAction !== 'function') {
            settle({ ok: false, code: 'PLUGIN_UNAVAILABLE',
                message: 'This Pebble app cannot run plugins' });
            return;
        }
        try {
            Pebble.invokeAction({ plugin: PLUGIN_UUID, action: action, args: args,
                timeoutMs: REQUEST_TIMEOUT_MS })
                .then(settle, function(e) {
                    settle({ ok: false, code: 'UNKNOWN', message: String(e && e.message || e) });
                });
        } catch (e) {
            settle({ ok: false, code: 'UNKNOWN', message: String(e && e.message || e) });
        }
    });
}

function parseJson(text) {
    try {
        var value = JSON.parse(text);
        return value && typeof value === 'object' ? value : null;
    } catch (e) {
        return null;
    }
}

var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var BASE64_VALUES = null;

/** The bytes of a base64 string, as a Uint8Array */
function decodeBase64(text) {
    if (!BASE64_VALUES) {
        BASE64_VALUES = {};
        for (var k = 0; k < BASE64.length; k++) { BASE64_VALUES[BASE64.charAt(k)] = k; }
    }
    text = String(text || '').replace(/[^A-Za-z0-9+\/]/g, '');
    var out = new Uint8Array(Math.floor(text.length * 3 / 4));
    var at = 0;
    for (var i = 0; i < text.length; i += 4) {
        var a = BASE64_VALUES[text.charAt(i)];
        var b = BASE64_VALUES[text.charAt(i + 1)];
        var c = i + 2 < text.length ? BASE64_VALUES[text.charAt(i + 2)] : 0;
        var d = i + 3 < text.length ? BASE64_VALUES[text.charAt(i + 3)] : 0;
        var n = (a << 18) | (b << 12) | (c << 6) | d;
        if (at < out.length) { out[at++] = (n >> 16) & 0xFF; }
        if (i + 2 < text.length && at < out.length) { out[at++] = (n >> 8) & 0xFF; }
        if (i + 3 < text.length && at < out.length) { out[at++] = n & 0xFF; }
    }
    return out;
}

// MARK: - What your app uses

var SPEAKER_PLATFORMS = ['emery', 'flint'];

function noop() {}

function copy(args) {
    var out = {};
    for (var name in args || {}) {
        if (Object.prototype.hasOwnProperty.call(args, name)) { out[name] = args[name]; }
    }
    return out;
}

function defaultStorage() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (e) {
        return null;
    }
}

/**
 * Speech for your app. options:
 *   key       - the message key the watch side listens on, by name or number
 *   transport - instead of key, for an app that already carries the
 *               speaker's messages its own way: an object as the Player
 *               takes (see Player above). handleMessage is not needed then.
 *   watchdog  - as the Player takes it: on with key, off with a transport
 *               unless set, for a transport that can lose a report too
 *   volume    - 0 to 100, a share of the watch's own speaker volume (100),
 *               or a function giving it, asked each time something starts
 *   storage   - where the link speed is remembered (localStorage)
 *   linkKey   - the key it is remembered under (ha_speech_link_bps)
 *   log       - fn(text) for what happened, or null for nothing (console.log)
 *
 * Returns { say, ask, playReply, stop, hasSpeaker, rate, handleMessage }.
 * One thing is spoken at a time: starting another stops the one before,
 * whose promise resolves 'stopped'.
 */
function create(options) {
    options = options || {};
    if (!options.transport && (options.key === undefined || options.key === null)) {
        throw new Error('HaSpeech.create needs the message key the watch listens on, or a transport');
    }
    var volume = options.volume;
    var log = options.log === undefined ? function(text) { console.log('ha_speech: ' + text); } :
        options.log || noop;
    var transport = options.transport || new AppMessageTransport(options.key);
    var player = new Player({
        transport: transport,
        storage: options.storage === undefined ? defaultStorage() : options.storage,
        linkKey: options.linkKey,
        log: log,
        // Over AppMessage a status the phone could not take is not sent again
        watchdog: options.watchdog === undefined ? !options.transport : !!options.watchdog
    });

    // What is being spoken: from the first call to the plugin until the watch
    // has played the last of it
    var current = null;

    function hasSpeaker() {
        try {
            var info = Pebble.getActiveWatchInfo ? Pebble.getActiveWatchInfo() : null;
            return !!info && SPEAKER_PLATFORMS.indexOf(info.platform) !== -1;
        } catch (e) {
            return false;
        }
    }

    //! How loud, as it is now
    function volumeNow() {
        var value = typeof volume === 'function' ? volume() : volume;
        return value === undefined ? 100 : Number(value);
    }

    function stop() {
        var job = current;
        if (!job) { return; }
        current = null;
        // The watch is told, and the clip ends 'stopped' whatever else went wrong
        job.error = null;
        player.stop();
        job.settle(null, 'stopped');
    }

    /**
     * Play `text`'s slices, the first of which `first()` asks the plugin
     * for. Each answer carries a cursor for the next, asked for as soon as it
     * arrives: the plugin has Home Assistant start on the piece after before
     * it answers, so it is being made while this one goes to the watch.
     */
    function speak(text, first, args) {
        stop();
        return new Promise(function(resolve, reject) {
            var job = current = { clip: null, error: null, settled: false };

            job.settle = function(error, how) {
                if (job.settled) { return; }
                job.settled = true;
                if (current === job) { current = null; }
                if (error) { reject(error); } else { resolve(how); }
            };

            // The watch has finished with it, one way or another
            function ended(error, how) {
                // Stopped, muted or taken over is how it ended, even when the
                // plugin had already failed to give the rest
                var cut = how === 'stopped' || how === 'muted' || how === 'preempted';
                job.settle(error || (cut ? null : job.error), how === 'nothing' ? 'done' : how);
            }

            // The plugin could not give the rest. What has come still plays,
            // and the error says whether any of it was heard.
            function failed(error) {
                if (current !== job) { return; }
                if (!job.clip) {
                    job.settle(error);
                    return;
                }
                if (job.clip.received) { error.partial = true; }
                job.error = error;
                player.end(job.clip);
            }

            function take(answer) {
                if (current !== job) { return; }
                var slice = parseJson(answer);
                if (!slice || typeof slice.audio !== 'string') {
                    failed(speechError('UNKNOWN', 'Home Assistant WS sent audio this app cannot read'));
                    return;
                }
                if (!job.clip) {
                    job.clip = player.begin({ rate: slice.rate, volume: volumeNow(), onEnd: ended });
                }
                player.add(job.clip, decodeBase64(slice.audio), !!slice.phrase, !!slice.last);
                if (slice.last || current !== job) { return; }
                if (typeof slice.next !== 'string' || !slice.next) {
                    failed(speechError('UNKNOWN', 'Home Assistant WS stopped part way'));
                    return;
                }
                // A cursor only goes with the text and pipeline it was made for
                var next = { text: text, next: slice.next, format: FORMAT };
                if (args && args.pipeline) { next.pipeline = args.pipeline; }
                invoke('speak_next', next).then(take, failed);
            }

            first().then(take, failed);
        });
    }

    /**
     * Read `text` out on the watch, in the voice of the wearer's assistant.
     * `args` are more of the plugin's speak arguments, such as { pipeline }.
     * Resolves 'done', 'muted', 'stopped' or 'preempted'; rejects with
     * NO_SPEAKER, NO_MEMORY, FAILED or the plugin's code. When the plugin
     * fails part way, what came first still plays, and the error, with
     * `partial` true, comes once it has.
     */
    function say(text, args) {
        if (!hasSpeaker()) {
            return Promise.reject(speechError('NO_SPEAKER', 'This watch has no speaker'));
        }
        var first = copy(args);
        first.text = text;
        first.format = FORMAT;
        first.rate = player.rate();
        return speak(text, function() { return invoke('speak', first); }, args);
    }

    /**
     * Read out the reply of an `ask_assistant` your app made itself with
     * `speak: true` and `rate: rate()`: its result as the Pebble app gave
     * it, its `text`, or that parsed. Pass the same `args` ({ pipeline }) the
     * ask had. Resolves and rejects as say() does.
     */
    function playReply(result, args) {
        var answer = result;
        if (answer && typeof answer === 'object' && typeof answer.ok === 'boolean') {
            if (!answer.ok) {
                return Promise.reject(speechError(answer.code || 'UNKNOWN', answer.message));
            }
            answer = answer.text;
        }
        if (typeof answer === 'string') { answer = parseJson(answer); }
        if (!answer || typeof answer.reply !== 'string') {
            return Promise.reject(speechError('UNKNOWN', 'Home Assistant WS sent an answer this app cannot read'));
        }
        if (!hasSpeaker()) {
            return Promise.reject(speechError('NO_SPEAKER', 'This watch has no speaker'));
        }
        if (answer.speech_error) {
            return Promise.reject(speechError('UNKNOWN', answer.speech_error));
        }
        // Nothing in the reply to say
        if (typeof answer.next !== 'string' || !answer.next) {
            return Promise.resolve('done');
        }
        var first = { text: answer.reply, next: answer.next, format: FORMAT };
        if (args && args.pipeline) { first.pipeline = args.pipeline; }
        return speak(answer.reply, function() { return invoke('speak_next', first); }, args);
    }

    /**
     * Ask the wearer's assistant `text`, and read its reply out. `args` are
     * more of the plugin's ask_assistant arguments, such as
     * { new_conversation: true }. Resolves { text, spoken, answer } as soon
     * as the reply is in: `text` is the reply, `spoken` a promise as say()
     * gives for reading it out, and `answer` everything the plugin said.
     * Rejects with the plugin's code. Needs the plugin's Assistant permission.
     */
    function ask(text, args) {
        var speaks = hasSpeaker();
        var question = copy(args);
        question.text = text;
        if (speaks) {
            question.speak = true;
            question.rate = player.rate();
        }
        return invoke('ask_assistant', question).then(function(reply) {
            var answer = speaks || question.json ? parseJson(reply) : { reply: reply };
            if (!answer || typeof answer.reply !== 'string') {
                throw speechError('UNKNOWN', 'Home Assistant WS sent an answer this app cannot read');
            }
            var spoken = speaks ? playReply(answer, args) :
                Promise.reject(speechError('NO_SPEAKER', 'This watch has no speaker'));
            // Not hearing the reply is no reason to stop an app that only
            // wanted to show it
            spoken.catch(noop);
            return { text: answer.reply, spoken: spoken, answer: answer };
        });
    }

    return {
        say: say,
        ask: ask,
        playReply: playReply,
        stop: stop,
        hasSpeaker: hasSpeaker,
        // The sample rate to ask for speech at, 8000 or 16000, from how fast
        // the link has been
        rate: player.rate,
        handleMessage: transport.handleMessage || function() { return false; }
    };
}

module.exports = {
    create: create,
    Player: Player,
    AppMessageTransport: AppMessageTransport,
    PLUGIN_UUID: PLUGIN_UUID
};
