/**
 * A watch speaker in JS, keeping the rules ha_speech.c keeps, for testing the
 * phone side against. It checks what the phone sends as the watch would, and
 * records anything the phone does that the real one would end the clip for.
 *
 *     const watch = fakeWatch.create({ capacity: 8192, report: (status) => ... });
 *     watch.receive([1, clip, rate, volume, flags, ...]);   // a message from the phone
 *     watch.tick(1000);                                     // play up to 1000 bytes
 *
 * `report({ clip, state, played, capacity })` is how its status gets back to
 * the phone. `watch.wire(status)` makes the STATUS message of the brief.
 */
'use strict';

const OP_PLAY = 1;
const OP_DATA = 2;
const OP_STOP = 3;
const OP_STATUS = 4;

const FLAG_LAST = 1;
const FLAG_PHRASE = 2;

const STATES = {
    BUFFERING: 0, PLAYING: 1, DONE: 2, STOPPED: 3, MUTED: 4, NO_MEMORY: 5, FAILED: 6, PREEMPTED: 7
};

//! As ha_speech.c: a quarter of a second at 8 kHz before it starts, at the least
const PREBUFFER_MIN = 1000;

function u32(bytes, at) {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function le32(value) {
    return [value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF];
}

/** A message from the phone as its fields, or null */
function parse(bytes) {
    bytes = Array.from(bytes);
    switch (bytes[0]) {
        case OP_PLAY:
            return { op: 'play', clip: bytes[1], rate: bytes[2], volume: bytes[3], flags: bytes[4],
                prebuffer: u32(bytes, 5), total: u32(bytes, 9), length: bytes.length };
        case OP_DATA:
            return { op: 'data', clip: bytes[1], flags: bytes[2], offset: u32(bytes, 3),
                bytes: bytes.slice(7) };
        case OP_STOP:
            return { op: 'stop', clip: bytes[1], length: bytes.length };
        case OP_STATUS:
            return { op: 'status', clip: bytes[1], state: bytes[2], played: u32(bytes, 3),
                capacity: u32(bytes, 7) };
        default:
            return null;
    }
}

/**
 * opts: capacity (the ring), muted, noMemory, report(status) and
 * preempt/fail hooks through watch.end(state)
 */
function create(opts) {
    opts = opts || {};
    const watch = {
        capacity: opts.capacity || 8192,
        muted: !!opts.muted,
        noMemory: !!opts.noMemory,
        report: opts.report || (() => {}),
        //! Every message, parsed, in the order it came
        messages: [],
        //! What the real watch would have ended the clip for
        violations: [],
        //! The most bytes the ring ever held that had not been played
        maxHeld: 0,
        //! Empty pieces that only said the phone was still there
        keepAlives: 0,
        //! Every byte of audio taken, in order
        audio: [],
        clip: null,
        active: false,
        open: false,
        state: null,
        received: 0,
        played: 0,
        reported: 0,
        final: false,
        phraseEnd: 0,
        prebuffer: 0,
        play: null,
        statuses: []
    };

    function send(state) {
        watch.state = state;
        watch.reported = watch.played;
        const status = { clip: watch.clip, state: state, played: watch.played,
            capacity: watch.active ? watch.capacity : 0 };
        watch.statuses.push(status);
        watch.report(status);
    }

    watch.end = function(state) {
        watch.active = false;
        watch.open = false;
        send(state);
    };

    watch.receive = function(bytes) {
        const msg = parse(bytes);
        watch.messages.push(msg);
        if (!msg) { watch.violations.push('unknown message ' + JSON.stringify(Array.from(bytes))); return; }
        if (msg.op === 'play') {
            watch.clip = msg.clip;
            watch.play = msg;
            watch.active = false;
            watch.open = false;
            watch.received = watch.played = watch.reported = watch.phraseEnd = 0;
            watch.final = false;
            watch.audio = [];
            if (watch.muted) { send(STATES.MUTED); return; }
            if (watch.noMemory) { send(STATES.NO_MEMORY); return; }
            watch.active = true;
            watch.prebuffer = Math.min(Math.max(msg.prebuffer, PREBUFFER_MIN), watch.capacity);
            send(STATES.BUFFERING);
        } else if (msg.op === 'data') {
            if (!watch.active || msg.clip !== watch.clip || watch.final) { return; }
            const length = msg.bytes.length;
            if (length === 0 && !(msg.flags & FLAG_LAST)) { watch.keepAlives++; }
            if (msg.offset + length <= watch.received && !(msg.flags & FLAG_LAST)) { return; }
            if (msg.offset !== watch.received) {
                watch.violations.push('gap: offset ' + msg.offset + ', had ' + watch.received);
                watch.end(STATES.FAILED);
                return;
            }
            if (watch.received + length - watch.played > watch.capacity) {
                watch.violations.push('overrun: ' + (watch.received + length - watch.played) + ' > ' + watch.capacity);
                watch.end(STATES.FAILED);
                return;
            }
            watch.audio.push(...msg.bytes);
            watch.received += length;
            watch.maxHeld = Math.max(watch.maxHeld, watch.received - watch.played);
            watch.final = !!(msg.flags & FLAG_LAST);
            if (msg.flags & FLAG_PHRASE) { watch.phraseEnd = watch.received; }
        } else if (msg.op === 'stop') {
            if (!watch.active || msg.clip !== watch.clip) { return; }
            // The phone asked, so it needs no telling
            watch.active = false;
            watch.open = false;
            watch.state = STATES.STOPPED;
        }
    };

    /** Play up to `bytes` of what is held, as the speaker's tick does. True while there is a clip. */
    watch.tick = function(bytes) {
        if (!watch.active) { return false; }
        const buffered = watch.received - watch.played;
        if (!watch.open) {
            if (watch.final || buffered >= watch.prebuffer || watch.phraseEnd > watch.played) {
                watch.open = true;
                send(STATES.PLAYING);
            }
            return true;
        }
        watch.played += Math.min(bytes, buffered);
        if (watch.final && watch.played >= watch.received) {
            watch.end(STATES.DONE);
            return false;
        }
        if (watch.played - watch.reported >= watch.capacity / 4) {
            send(watch.state);
        }
        return true;
    };

    return watch;
}

/** The STATUS message the watch sends */
function wire(status) {
    return [OP_STATUS, status.clip, status.state].concat(le32(status.played), le32(status.capacity));
}

module.exports = {
    create: create,
    parse: parse,
    wire: wire,
    le32: le32,
    STATES: STATES,
    FLAG_LAST: FLAG_LAST,
    FLAG_PHRASE: FLAG_PHRASE
};
