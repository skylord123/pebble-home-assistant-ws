/**
 * The plugin's own corner of the shared localStorage. Every request runs in a
 * fresh engine, so anything worth keeping from one to the next lives here.
 * Keys are prefixed so they never collide with the watch app's.
 */
var PREFIX = 'plugin:';

function get(key) {
    try {
        var value = localStorage.getItem(PREFIX + key);
        return value ? JSON.parse(value) : null;
    } catch (e) {
        return null;
    }
}

function set(key, value) {
    try {
        if (value === null || value === undefined) {
            localStorage.removeItem(PREFIX + key);
        } else {
            localStorage.setItem(PREFIX + key, JSON.stringify(value));
        }
    } catch (e) {
        // Out of room: the plugin works without its cache, only slower
    }
}

/** A stored value if it was written less than `maxAgeMs` ago */
function fresh(key, maxAgeMs) {
    var entry = get(key);
    if (entry && typeof entry.at === 'number' && Date.now() - entry.at < maxAgeMs) {
        return entry.value;
    }
    return null;
}

function remember(key, value) {
    set(key, { at: Date.now(), value: value });
}

module.exports = {
    get: get,
    set: set,
    fresh: fresh,
    remember: remember
};
