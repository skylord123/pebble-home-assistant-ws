/**
 * HA Speech Example, phone side. When the watch says ASK, Home Assistant's
 * assistant is asked the time through Home Assistant WS's plugin, the answer
 * goes to the watch to be shown, and the speech kit reads it aloud.
 *
 * ha_speech.js next to this file is copied unchanged from Home Assistant WS's
 * sdk/speech.
 */
var HaSpeech = require('./ha_speech');

// The kit sends its audio under the HA_SPEECH message key, which main.c gave
// to ha_speech_init
var speech = HaSpeech.create({ key: 'HA_SPEECH' });

// The watch shows at most this much of the answer
var MAX_REPLY = 500;

Pebble.addEventListener('appmessage', function(e) {
    // The watch's reports on the speech are the kit's, not the app's
    if (speech.handleMessage(e.payload)) { return; }

    if (e.payload.ASK) {
        askTheTime();
    }
});

function show(text) {
    Pebble.sendAppMessage({ REPLY: text.slice(0, MAX_REPLY) });
}

function askTheTime() {
    // ask() resolves as soon as the answer is in. Its `spoken` is a promise
    // for reading it aloud, which carries on while the answer is shown.
    speech.ask('What time is it?').then(function(answer) {
        show(answer.text);
        answer.spoken.then(function(how) {
            // 'done', 'muted', 'stopped' (Back on the watch) or 'preempted'
            console.log('Read aloud: ' + how);
        }, function(error) {
            // NO_SPEAKER on a watch without one, or why it could not be heard
            console.log('Not read aloud: ' + error.code + ' ' + error.message);
        });
    }, function(error) {
        // AUTH_REQUIRED when Home Assistant WS is not set up, PERMISSION_DENIED
        // when the wearer has not let this app use it, and so on
        show('Could not ask: ' + error.message);
    });
}
