/**
 * Sunrise and sunset, worked out from a place's coordinates with the
 * sunrise equation. Home Assistant's forecasts carry neither, and its
 * sun.sun entity only has the next of each, but the watch's weather needs
 * them for every day it shows. Good to a minute or two, which is all the
 * watch shows.
 */
var DAY_MS = 86400000;
var RAD = Math.PI / 180;
//! Julian days at the Unix epoch, and at J2000
var J1970 = 2440587.5;
var J2000 = 2451545;
//! The sun's centre this far below the horizon at sunrise, for refraction
//! and its own size
var HORIZON = -0.833 * RAD;
var TILT = 23.4397 * RAD;

function toJulian(ms) { return ms / DAY_MS + J1970; }
function fromJulian(j) { return (j - J1970) * DAY_MS; }

/**
 * Sunrise and sunset on the day around `noonMs`, the place's local noon.
 * @returns {Object} { rise, set } in epoch seconds. Through a polar day
 *     the sun is up from midnight to midnight; through a polar night it
 *     rises and sets at noon.
 */
function times(noonMs, latitude, longitude) {
    var cycle = Math.round(toJulian(noonMs) - J2000 + longitude / 360);
    var meanNoon = cycle - longitude / 360;
    var anomaly = ((357.5291 + 0.98560028 * meanNoon) % 360) * RAD;
    var centre = 1.9148 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly) + 0.0003 * Math.sin(3 * anomaly);
    var ecliptic = ((anomaly / RAD + centre + 180 + 102.9372) % 360) * RAD;
    var transit = J2000 + meanNoon + 0.0053 * Math.sin(anomaly) - 0.0069 * Math.sin(2 * ecliptic);
    var declination = Math.asin(Math.sin(ecliptic) * Math.sin(TILT));
    var phi = latitude * RAD;
    var cosHour = (Math.sin(HORIZON) - Math.sin(phi) * Math.sin(declination)) /
        (Math.cos(phi) * Math.cos(declination));

    var noon = Math.round(fromJulian(transit) / 1000);
    if (cosHour < -1) {
        return { rise: noon - 43200, set: noon + 43199 };
    }
    if (cosHour > 1) {
        return { rise: noon, set: noon };
    }
    var half = Math.acos(cosHour) / (2 * Math.PI);
    return {
        rise: Math.round(fromJulian(transit - half) / 1000),
        set: Math.round(fromJulian(transit + half) / 1000)
    };
}

/**
 * Sunrise and sunset for `count` days from the local midnight `startS`.
 * @returns {Object} { rises: [...], sets: [...] } in epoch seconds
 */
function days(startS, count, latitude, longitude) {
    var rises = [], sets = [];
    for (var i = 0; i < count; i++) {
        var day = times((startS + i * 86400 + 43200) * 1000, latitude, longitude);
        rises.push(day.rise);
        sets.push(day.set);
    }
    return { rises: rises, sets: sets };
}

/** Kilometres between two points, along the ground */
function distanceKm(lat1, lon1, lat2, lon2) {
    var dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = {
    times: times,
    days: days,
    distanceKm: distanceKm
};
