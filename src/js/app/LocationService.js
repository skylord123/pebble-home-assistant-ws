/**
 * LocationService - roughly where the watch is, for anything that needs to know
 * where the sun is.
 *
 * A fix is asked of the phone when it is wanted and then kept, because the
 * phone is often unwilling to give one: the GPS may be off, the permission may
 * not have been granted yet, or the phone may simply be indoors. Sunrise and
 * sunset barely move over a few miles, so yesterday's fix answers today's
 * question perfectly well, and a stored one is used until a real one arrives.
 *
 * Home Assistant knows the home's latitude and longitude too. That is only ever
 * a starting point, used when the phone has given us nothing at all, and any
 * real fix takes its place.
 */
var helpers = require('app/helpers');

var CACHE_KEY = 'ha_location_cache';

// A fix from the last half hour is worth reusing rather than waking the GPS
var GPS_MAX_AGE_MS = 30 * 60 * 1000;
var GPS_TIMEOUT_MS = 30 * 1000;

var current = null;
var loaded = false;
var asking = false;

function log(message) {
    helpers.log_message('Location: ' + message);
}

function isUsable(location) {
    return !!location &&
        typeof location.latitude === 'number' && !isNaN(location.latitude) &&
        typeof location.longitude === 'number' && !isNaN(location.longitude);
}

function load() {
    if (loaded) { return; }
    loaded = true;
    try {
        var stored = localStorage.getItem(CACHE_KEY);
        if (!stored) { return; }
        var parsed = JSON.parse(stored);
        if (isUsable(parsed)) {
            current = parsed;
            log('restored ' + parsed.source + ' fix from ' + new Date(parsed.time));
        }
    } catch (e) {
        log('could not read the stored fix: ' + e);
    }
}

function store(location) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(location));
    } catch (e) {
        log('could not store the fix: ' + e);
    }
}

var LocationService = {
    /**
     * The best location we have, or null if we have never had one.
     * @returns {{latitude: number, longitude: number, source: string, time: number}|null}
     */
    get: function() {
        load();
        return current;
    },

    /**
     * Ask the phone where it is. The callback is handed the location we ended
     * up with, which on a refusal is whatever we already had, or null.
     * @param {Function} [callback]
     */
    refresh: function(callback) {
        load();

        function done() {
            if (typeof callback === 'function') {
                callback(current);
            }
        }

        // A fix this recent tells us nothing new
        if (current && current.source === 'gps' &&
            Date.now() - current.time < GPS_MAX_AGE_MS) {
            return done();
        }

        if (asking || !navigator.geolocation) {
            return done();
        }

        asking = true;
        navigator.geolocation.getCurrentPosition(function(position) {
            asking = false;
            var coords = position && position.coords;
            if (!coords) { return done(); }

            var fix = {
                latitude: coords.latitude,
                longitude: coords.longitude,
                source: 'gps',
                time: Date.now()
            };
            if (!isUsable(fix)) { return done(); }

            current = fix;
            store(fix);
            log('fixed at ' + fix.latitude.toFixed(3) + ', ' + fix.longitude.toFixed(3));
            done();
        }, function(error) {
            asking = false;
            log('no fix from the phone: ' + (error && error.message ? error.message : error));
            done();
        }, {
            enableHighAccuracy: false,
            maximumAge: GPS_MAX_AGE_MS,
            timeout: GPS_TIMEOUT_MS
        });
    },

    /**
     * Offer Home Assistant's own idea of home. It is only taken when we have
     * nothing at all, so it can never displace a real fix.
     * @param {number} latitude
     * @param {number} longitude
     * @returns {boolean} whether it was taken
     */
    seed: function(latitude, longitude) {
        load();

        var home = {
            latitude: latitude,
            longitude: longitude,
            source: 'home',
            time: Date.now()
        };
        if (!isUsable(home) || current) { return false; }

        current = home;
        store(home);
        log('using Home Assistant\'s location until the phone offers one');
        return true;
    }
};

module.exports = LocationService;
