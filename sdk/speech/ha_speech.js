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
 * Only the Pebble Time 2 and Core 2 Duo have a speaker.
 *
 * Plain ES5 with no dependencies, loaded with require('./ha_speech').
 */

// MARK: - What the watch understands

// Must match ha_speech.c
var RATE_8K = 0;
var RATE_16K = 1;

var FLAG_LAST = 1;
var FLAG_PHRASE = 2;

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
        clip.keepAlive = setInterval(function() {
            if (clip !== current || clip.lastSent || clip.awaitingIdle || !transport.isIdle() ||
                    Date.now() - clip.lastSentAt < KEEPALIVE_MS) {
                return;
            }
            send(clip, EMPTY, 0);
        }, KEEPALIVE_MS / 2);
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

module.exports = {
    Player: Player
};
