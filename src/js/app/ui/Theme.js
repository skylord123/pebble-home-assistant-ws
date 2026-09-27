/**
 * Theme - decides whether the app is drawn light or dark.
 *
 * Menus and the assistant conversation are themed separately, and each can be
 * pinned to black or white or told to follow the sun. Following the sun means
 * white while the sun is up and black once it has set, worked out on the phone
 * from wherever the watch is, and it flips the moment the sun does rather than
 * waiting for the next screen.
 */
var Constants = require('app/Constants');
var AppState = require('app/AppState');
var LocationService = require('app/LocationService');
var Menu = require('ui/menu');
var NumberField = require('ui/numberfield');
var WindowStack = require('ui/windowstack');
var SunCalc = require('vendor/suncalc');
var helpers = require('app/helpers');

var modes = Constants.backgroundModes;

// The angle SunCalc itself calls sunrise and sunset: the sun's upper edge on
// the horizon, refraction included. Asking the same question the schedule was
// built from means the colours change on the minute they were booked for.
var HORIZON = -0.833 * Math.PI / 180;

// Never sleep longer than this between checks, however far off the next
// sunrise is. A long sleep is the one thing a phone is likely to get wrong,
// and a check costs almost nothing.
var MAX_SLEEP_MS = 30 * 60 * 1000;

var DARK_COLORS = {
    backgroundColor: 'black',
    textColor: 'white',
    highlightBackgroundColor: 'white',
    highlightTextColor: 'black'
};

var LIGHT_COLORS = {
    backgroundColor: 'white',
    textColor: 'black',
    highlightBackgroundColor: 'black',
    highlightTextColor: 'white'
};

var listeners = [];
var timer = null;
var menuIsDark = true;
var assistIsDark = true;

function log(message) {
    helpers.log_message('Theme: ' + message);
}

function normalizeMode(mode) {
    if (mode === modes.WHITE || mode === modes.SUN) {
        return mode;
    }
    return modes.BLACK;
}

/**
 * Whether the sun is above the horizon right now, or null when we have no idea
 * where the watch is.
 */
function sunIsUp() {
    var where = LocationService.get();
    if (!where) { return null; }

    try {
        var position = SunCalc.getPosition(new Date(), where.latitude, where.longitude);
        if (!position || typeof position.altitude !== 'number' || isNaN(position.altitude)) {
            return null;
        }
        return position.altitude > HORIZON;
    } catch (e) {
        log('could not work out the sun: ' + e);
        return null;
    }
}

function isValidDate(date) {
    return !!date && typeof date.getTime === 'function' && !isNaN(date.getTime());
}

/**
 * When the sun next crosses the horizon, or null if that cannot be worked out
 * (which is the ordinary state of affairs inside the polar circles, where the
 * sun can stay up or down for months).
 */
function nextSunChange() {
    var where = LocationService.get();
    if (!where) { return null; }

    var now = Date.now();
    var soonest = null;

    for (var day = 0; day < 2; ++day) {
        var times;
        try {
            times = SunCalc.getTimes(new Date(now + day * 24 * 60 * 60 * 1000),
                                     where.latitude, where.longitude);
        } catch (e) {
            return null;
        }
        if (!times) { continue; }

        var candidates = [times.sunrise, times.sunset];
        for (var i = 0; i < candidates.length; ++i) {
            var at = candidates[i];
            if (!isValidDate(at)) { continue; }
            var when = at.getTime();
            if (when <= now) { continue; }
            if (soonest === null || when < soonest) {
                soonest = when;
            }
        }
    }

    return soonest;
}

/**
 * Resolve one setting to dark or light. A mode following the sun falls back to
 * dark while we have no location, which is what the app has always looked
 * like, so nothing changes until we actually know better.
 */
function resolve(mode) {
    mode = normalizeMode(mode);
    if (mode === modes.BLACK) { return true; }
    if (mode === modes.WHITE) { return false; }

    var up = sunIsUp();
    return up === null ? true : !up;
}

function usesSun() {
    var appState = AppState.getInstance();
    return normalizeMode(appState.menu_background_mode) === modes.SUN ||
           normalizeMode(appState.assist_background_mode) === modes.SUN;
}

function notify() {
    for (var i = 0; i < listeners.length; ++i) {
        try {
            listeners[i]();
        } catch (e) {
            log('a listener threw: ' + e);
        }
    }
}

/**
 * Push the current colours out: to menus built from here on, to the one on
 * screen now, and to anyone else who asked to be told.
 */
function apply(announce) {
    var appState = AppState.getInstance();
    var wasMenuDark = menuIsDark;
    var wasAssistDark = assistIsDark;

    menuIsDark = resolve(appState.menu_background_mode);
    assistIsDark = resolve(appState.assist_background_mode);

    var colors = Theme.menuColors();
    Menu.setColorDefaults(colors);
    // The number selector is reached from a menu and takes its colours, so a
    // dark list does not open onto a white window
    NumberField.setColors(colors);

    if (menuIsDark !== wasMenuDark || announce) {
        WindowStack.each(function(window) {
            if (window && typeof window.setColors === 'function') {
                window.setColors(colors);
            }
        });
    }

    if (menuIsDark !== wasMenuDark || assistIsDark !== wasAssistDark || announce) {
        log('menus ' + (menuIsDark ? 'dark' : 'light') +
            ', assistant ' + (assistIsDark ? 'dark' : 'light'));
        notify();
    }
}

/**
 * Ask Home Assistant where home is. Only worth doing when the background
 * follows the sun and the phone has never told us anything, since a real fix
 * always wins and this cannot displace one.
 */
function askHomeAssistant() {
    if (!usesSun() || LocationService.get()) { return; }

    var haws = AppState.getInstance().haws;
    if (!haws || typeof haws.isConnected !== 'function' || !haws.isConnected()) { return; }

    haws.getConfig(function(data) {
        var config = data && data.result;
        if (!config) { return; }
        if (LocationService.seed(config.latitude, config.longitude)) {
            apply();
            schedule();
        }
    }, function(error) {
        log('Home Assistant would not say where home is: ' + JSON.stringify(error));
    });
}

function findLocation() {
    LocationService.refresh(function() {
        apply();
        schedule();
        // The phone had nothing to offer, so fall back on the house
        askHomeAssistant();
    });
}

function schedule() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    if (!usesSun()) { return; }

    var sleep = MAX_SLEEP_MS;
    var next = nextSunChange();
    if (next !== null) {
        // A second past the crossing, so the answer has definitely changed by
        // the time we ask again
        sleep = Math.min(sleep, Math.max(1000, next - Date.now() + 1000));
    }

    // Refreshing on the way is also the only way a first fix arrives when the
    // phone had no answer at startup, and how a watch that has travelled
    // catches up with where it now is
    timer = setTimeout(findLocation, sleep);
}

var Theme = {
    /**
     * The four colours every menu is built with.
     */
    menuColors: function() {
        return menuIsDark ? DARK_COLORS : LIGHT_COLORS;
    },

    /**
     * Whether menus are currently drawn dark.
     */
    menuIsDark: function() {
        return menuIsDark;
    },

    /**
     * Whether the assistant conversation is currently drawn dark.
     */
    assistIsDark: function() {
        return assistIsDark;
    },

    /**
     * The name of a mode, for a menu row.
     */
    label: function(mode) {
        switch (normalizeMode(mode)) {
            case modes.WHITE: return 'White';
            case modes.SUN: return 'Follow Sun';
            default: return 'Black';
        }
    },

    /**
     * The name of a mode with what it currently works out to, so a menu row can
     * say that the sun is up, or that we have nowhere to work it out from.
     */
    describe: function(mode) {
        mode = normalizeMode(mode);
        if (mode !== modes.SUN) {
            return Theme.label(mode);
        }

        var up = sunIsUp();
        if (up === null) {
            return 'Follow Sun - no location';
        }
        return up ? 'Follow Sun - day' : 'Follow Sun - night';
    },

    /**
     * The three modes in the order they are offered.
     */
    all: function() {
        return [modes.BLACK, modes.WHITE, modes.SUN];
    },

    /**
     * Read the settings again and apply them. Called at startup and whenever
     * the settings change, from the config page or from the watch.
     */
    configure: function() {
        apply(true);
        schedule();

        if (usesSun() && !LocationService.get()) {
            // Nothing to go on yet, so start looking straight away rather than
            // waiting out the first sleep
            findLocation();
        }
    },

    /**
     * Ask Home Assistant where home is, if a sun-following background still
     * has nowhere to work from. Does nothing otherwise.
     */
    requestHomeLocation: askHomeAssistant,

    /**
     * Called whenever the colours change, including on the first apply.
     */
    onChange: function(listener) {
        if (typeof listener === 'function' && listeners.indexOf(listener) === -1) {
            listeners.push(listener);
        }
    },

    offChange: function(listener) {
        var index = listeners.indexOf(listener);
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    }
};

module.exports = Theme;
