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
        // A fresh show is a fresh attempt, so always reset to the pulsing
        // connecting state
        simply.impl.splashShow();
        mode = MODE_CONNECTING;
        simply.impl.splashMode(mode);
        sendStatus();
        return this;
    },
    hide: function() {
        simply.impl.splashHide();
        return this;
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
