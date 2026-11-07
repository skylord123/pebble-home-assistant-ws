var simply = require('ui/simply');

/**
 * Speaker - the watch's own speaker, fed from here
 *
 * The watch keeps a ring of compressed audio and plays it as it decodes it
 * (simply_speaker.c). This side only carries messages: what to get ready for,
 * the audio a piece at a time, and the watch's answers about how far it has
 * got. Deciding what to say and when is app/Speech.js's job.
 *
 * Speaker.onStatus(fn)  - fn(clip, state, played, capacity) for every report
 * Speaker.onIdle(fn)    - fn() whenever nothing is waiting to go to the watch
 */
var Speaker = {};

// Must match SpeakerRate in simply_speaker.c
Speaker.RATE_8K = 0;
Speaker.RATE_16K = 1;

// Must match SpeakerState in simply_speaker.c
Speaker.BUFFERING = 0;
Speaker.PLAYING = 1;
Speaker.DONE = 2;
Speaker.STOPPED = 3;
Speaker.MUTED = 4;
Speaker.NO_MEMORY = 5;
Speaker.FAILED = 6;
Speaker.PREEMPTED = 7;

var statusHandler = null;
var idleHandler = null;

Speaker.onStatus = function(fn) { statusHandler = fn; };
Speaker.onIdle = function(fn) { idleHandler = fn; };

Speaker.play = function(clip, rate, prebuffer, total) {
  simply.impl.speakerPlay(clip, rate, prebuffer, total);
};

Speaker.data = function(clip, offset, bytes, last) {
  simply.impl.speakerData(clip, offset, bytes, last);
};

Speaker.stop = function(clip) {
  simply.impl.speakerStop(clip);
};

/** Whether a piece of audio can go now without holding anything else up. */
Speaker.isIdle = function() {
  return simply.impl.isIdle();
};

Speaker.emitStatus = function(clip, state, played, capacity) {
  if (statusHandler) {
    statusHandler(clip, state, played, capacity);
  }
};

Speaker.emitIdle = function() {
  if (idleHandler) {
    idleHandler();
  }
};

module.exports = Speaker;
