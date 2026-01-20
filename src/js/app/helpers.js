/**
 * helpers - Utility functions used throughout the app
 */

/**
 * Sort an object by its keys alphabetically
 * @param {Object} object - Object to sort
 * @returns {Object} - New object with sorted keys
 */
function sortObjectByKeys(object) {
    return Object.fromEntries(
        Object.entries(object).sort(function(a, b) {
            return a[0] < b[0] ? -1 : 1;
        })
    );
}

/**
 * Clone an object (shallow clone)
 * @param {Object} obj - Object to clone
 * @returns {Object} - Cloned object
 */
function cloneObject(obj) {
    if (null == obj || "object" != typeof obj) return obj;
    var copy = obj.constructor();
    for (var attr in obj) {
        if (obj.hasOwnProperty(attr)) copy[attr] = obj[attr];
    }
    return copy;
}

/**
 * Capitalize first letter of a string
 * @param {string} str - Input string
 * @returns {string} - String with first letter capitalized
 */
function ucword(str) {
    return str.replace(/^\w/, function(s) { return s.toUpperCase(); });
}

/**
 * Capitalize first letter of each word
 * @param {string} str - Input string
 * @returns {string} - String with each word capitalized
 */
function ucwords(str) {
    return str.replace(/(\b\w)/g, function(s) { return s.toUpperCase(); });
}

/**
 * Calculate human-readable time difference
 * @param {Date} newestDate - The more recent date
 * @param {Date} oldestDate - The older date
 * @returns {string} - Human readable string like "5 m" or "2 h"
 */
function humanDiff(newestDate, oldestDate) {
    // Check if dates are valid Date objects, if not convert them
    newestDate = newestDate instanceof Date ? newestDate : new Date(newestDate);
    oldestDate = oldestDate instanceof Date ? oldestDate : new Date(oldestDate);

    // Reverse the check - if oldestDate is after newestDate, they're in wrong order
    if (oldestDate > newestDate) {
        return 'now';
    }

    var prettyDate = {
        diffDate: newestDate - oldestDate,
        diffUnit: "ms"
    };

    function reduceNumbers(inPrettyDate, interval, unit) {
        // Only convert if the difference is greater than or equal to the interval
        if (inPrettyDate.diffDate >= interval) {
            // Use integer division to prevent accumulating floating point errors
            inPrettyDate.diffDate = Math.floor(inPrettyDate.diffDate / interval);
            inPrettyDate.diffUnit = unit;
            return true;
        }
        return false;
    }

    // Use a chain of if-statements rather than sequential operations to avoid
    // continually dividing small values
    if (reduceNumbers(prettyDate, 1000, 's')) {
        if (reduceNumbers(prettyDate, 60, 'm')) {
            if (reduceNumbers(prettyDate, 60, 'h')) {
                reduceNumbers(prettyDate, 24, 'd');
            }
        }
    }

    // Round properly and return a formatted string
    return prettyDate.diffDate + ' ' + prettyDate.diffUnit;
}

/**
 * Calculate milliseconds until the humanDiff output will change for a given timestamp.
 * This is useful for scheduling updates to relative time displays.
 *
 * @param {Date|string|number} lastChanged - The timestamp to calculate from
 * @returns {number} Milliseconds until the humanDiff output will change
 */
function getNextHumanDiffChangeMs(lastChanged) {
    var now = new Date();
    var lastChangedDate = lastChanged instanceof Date ? lastChanged : new Date(lastChanged);

    // If lastChanged is in the future, return 0 (update immediately when it becomes "now")
    if (lastChangedDate > now) {
        return lastChangedDate - now;
    }

    var diffMs = now - lastChangedDate;

    // Time thresholds in milliseconds (matching humanDiff logic)
    var SECOND = 1000;
    var MINUTE = 60 * SECOND;
    var HOUR = 60 * MINUTE;
    var DAY = 24 * HOUR;

    // Determine current unit and calculate time until next change
    if (diffMs < SECOND) {
        // Currently showing milliseconds, will change to seconds at 1 second
        return SECOND - diffMs;
    } else if (diffMs < MINUTE) {
        // Currently showing seconds (e.g., "5 s")
        // Will change when we hit the next second
        var currentSeconds = Math.floor(diffMs / SECOND);
        var nextSecondMs = (currentSeconds + 1) * SECOND;
        return nextSecondMs - diffMs;
    } else if (diffMs < HOUR) {
        // Currently showing minutes (e.g., "5 m")
        // Will change when we hit the next minute
        var currentMinutes = Math.floor(diffMs / MINUTE);
        var nextMinuteMs = (currentMinutes + 1) * MINUTE;
        return nextMinuteMs - diffMs;
    } else if (diffMs < DAY) {
        // Currently showing hours (e.g., "5 h")
        // Will change when we hit the next hour
        var currentHours = Math.floor(diffMs / HOUR);
        var nextHourMs = (currentHours + 1) * HOUR;
        return nextHourMs - diffMs;
    } else {
        // Currently showing days (e.g., "5 d")
        // Will change when we hit the next day
        var currentDays = Math.floor(diffMs / DAY);
        var nextDayMs = (currentDays + 1) * DAY;
        return nextDayMs - diffMs;
    }
}

/**
 * Helper function to determine if we should show domain menu based on settings
 * @param {Array} entities - Array of entity IDs
 * @param {string} menuSetting - 'yes', 'no', or 'conditional'
 * @param {Object} options - Additional options
 * @param {number} options.minEntities - Minimum entities for conditional
 * @param {number} options.minDomains - Minimum domains for conditional
 * @returns {boolean} - Whether to show domain menu
 */
function shouldShowDomainMenu(entities, menuSetting, options) {
    options = options || {};
    var minEntities = options.minEntities || 10;
    var minDomains = options.minDomains || 2;

    var Platform = require('platform');

    // If setting is explicitly yes or no, respect that
    if (menuSetting === 'yes') return true;
    if (menuSetting === 'no') return false;

    // Get unique domains from entities
    var domains = new Set();
    var isAplite = Platform.version() === 'aplite';

    for (var i = 0; i < entities.length; i++) {
        var entity_id = entities[i];
        domains.add(entity_id.split('.')[0]);

        // OG Pebble (aplite) lacks memory to display more than 3 icons
        // so we force the domain menu if there are multiple domains
        // this way only 2 icons will ever display on the menu
        if (isAplite && domains.size > 1) {
            return true;
        }
    }

    // For conditional, check the conditions
    if (menuSetting === 'conditional') {
        var domainCount = domains.size;

        // Check if we meet the minimum entity count condition
        var meetsEntityCountCondition = entities.length >= minEntities;

        // Check if we meet the minimum domain count condition
        var meetsDomainCountCondition = domainCount >= minDomains;

        // Return true if both conditions are met
        return meetsEntityCountCondition && meetsDomainCountCondition;
    }

    // Default to false for any other value
    return false;
}

/**
 * Log a message if debug mode is enabled
 * @param {string} msg - Message to log
 * @param {*} extra - Optional extra data to log
 */
function log_message(msg, extra) {
    var Constants = require('app/Constants');
    if (!Constants.debugMode) return;

    if (extra) {
        console.log('[App] ' + msg, extra);
        return;
    }

    console.log('[App] ' + msg);
}

module.exports = {
    sortObjectByKeys: sortObjectByKeys,
    cloneObject: cloneObject,
    ucword: ucword,
    ucwords: ucwords,
    humanDiff: humanDiff,
    getNextHumanDiffChangeMs: getNextHumanDiffChangeMs,
    shouldShowDomainMenu: shouldShowDomainMenu,
    log_message: log_message
};
