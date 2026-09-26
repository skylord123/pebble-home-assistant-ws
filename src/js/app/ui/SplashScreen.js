/**
 * SplashScreen - the startup / connection status screen.
 *
 * The screen itself lives on the watch (src/simply/simply_splash.c): it is
 * pushed natively the moment the app launches, draws the Home Assistant logo
 * and pulse animation from vector primitives, and shows a sad face when told
 * an error occurred. This module is a thin proxy that drives the native
 * window's text and state over the CommandSplash* packets.
 *
 * Exposes the same duck-typed interface app.js and ConnectionService used
 * with the old UI.Card loading card: show/hide/title/subtitle/body/on/_id.
 */

var simply = require('ui/simply');
var Light = require('ui/light');
var WindowStack = require('ui/windowstack');

// Whether the splash is currently covering a JS window. The native splash
// never joins the JS window stack, so this side has to remember.
var covering = false;

// Whether the native splash has been asked onto the screen. It can be covering
// without being shown, when a disconnect during dictation defers it.
var shown = false;

function cover() {
    if (covering) { return; }
    covering = true;
    var top = WindowStack.top();
    if (top) {
        WindowStack._emitHide(top);
    }
}

var texts = {
    title: 'Home Assistant',
    status: '',
    body: ''
};

// Mirrors SplashMode in simply_splash.c
var MODE_CONNECTING = 0;
var MODE_ERROR = 1;
var MODE_SETUP = 2;

var mode = MODE_CONNECTING;

function sendStatus() {
    simply.impl.splashStatus(texts.title, texts.status, texts.body);
}

function setMode(newMode) {
    if (mode === newMode) { return; }
    mode = newMode;
    simply.impl.splashMode(newMode);
}

var SplashScreen = {
    show: function() {
        // Covering a window natively bypasses the JS window stack, so nothing
        // would otherwise tell the page underneath that it has gone away.
        // Pages release their subscription on 'hide' and take a new one on
        // 'show', and that pairing is what re-establishes them after a
        // reconnect: Home Assistant drops every subscription with the socket.
        // Staying silent here left pages holding ids for a connection that no
        // longer existed, so their states froze until the user navigated away
        // and back. Emitting only the event, never WindowStack._hide, keeps
        // the window in place on the watch underneath the splash.
        cover();
        shown = true;

        // A fresh show is a fresh attempt, so always reset to the pulsing
        // connecting state
        simply.impl.splashShow();
        mode = MODE_CONNECTING;
        simply.impl.splashMode(mode);
        sendStatus();
        return this;
    },
    /**
     * Release the page underneath as show() would, without putting the
     * splash up. For a disconnect while the wearer is dictating: the page
     * must still drop subscriptions that died with the socket.
     */
    cover: function() {
        cover();
        return this;
    },
    hide: function() {
        var wasCovering = covering;
        covering = false;
        if (!shown) {
            // Never came up, so the watch has nothing to take down and will
            // send no reveal. The page gets its 'show' from here instead.
            var top = wasCovering && WindowStack.top();
            if (top) {
                WindowStack._emitShow(top);
            }
            return this;
        }
        shown = false;
        // Whatever this screen was waiting on can take a while - a slow
        // connection, a Home Assistant still starting up - and the wearer
        // opened the app expecting to read something at the end of it. The
        // backlight they lit by pressing to launch has usually timed out by
        // then, so the app arrives on a dark screen and has to be woken by
        // hand. Count coming out of the splash as an interaction of its own:
        // the system starts its own timer from here, the same as it does for
        // a button press, and turns the light off in its own time. Nothing is
        // held, and a wearer who has turned the backlight off entirely, or is
        // out in daylight, still gets no light: the watch decides.
        Light.trigger();
        // The matching 'show' is emitted when the watch reports the splash has
        // actually come down, in the SplashRevealPacket handler
        simply.impl.splashHide();
        return this;
    },
    // True while the splash stands in front of the JS windows. A 'hide' seen
    // then comes from the cover, not from the wearer leaving the window.
    isCovering: function() {
        return covering;
    },
    title: function(text) {
        if (text === undefined) { return texts.title; }
        texts.title = text;
        sendStatus();
        return this;
    },
    subtitle: function(text) {
        if (text === undefined) { return texts.status; }
        texts.status = text;
        sendStatus();
        return this;
    },
    body: function(text) {
        if (text === undefined) { return texts.body; }
        texts.body = text;
        sendStatus();
        return this;
    },
    // Switch the native splash to its error state: the pulse stops and a sad
    // face takes the logo's place
    error: function() {
        setMode(MODE_ERROR);
        return this;
    },
    // Switch to the setup state: a settings sliders icon prompting the user
    // to configure the app from the phone
    setup: function() {
        setMode(MODE_SETUP);
        return this;
    },
    // The splash is not a JS window: clicks never reach JS (back exits the
    // app while it is up) and it can never appear in the JS WindowStack, so
    // report an id no real window will ever have
    on: function() {
        return this;
    },
    _id: function() {
        return -1;
    }
};

module.exports = SplashScreen;
