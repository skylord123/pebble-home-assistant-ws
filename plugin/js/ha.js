/**
 * Home Assistant over its REST API. A plugin cannot keep anything running
 * between requests, and a WebSocket closes with the request that opened it,
 * so each request asks for what it needs and gets out. REST reuses the
 * phone's open connection where a WebSocket would log in again every time,
 * so only the assistant, which REST cannot reach, goes over ws.js.
 *
 * Nothing here logs the address or the token: plugin logs go to the phone's
 * own log, which ends up in bug reports.
 */
var store = require('store');

//! How long fetched states are reused. A dashboard reading lights, switches
//! and sensors polls each of them in turn, and they should share one fetch.
var STATES_TTL_MS = 10000;
//! Past this many entities one full /api/states beats fetching them one by one
var BULK_THRESHOLD = 15;
//! How long a refused token is left alone before it is tried again
var AUTH_RETRY_MS = 30 * 60 * 1000;
//! How long an unreachable Home Assistant is not tried again. Every source
//! is polled in turn, one at a time, and a host that never answers holds
//! each of them for the phone's full 20 seconds.
var UNREACHABLE_RETRY_MS = 30 * 1000;

var REFUSED = 'Home Assistant refused the access token. Update it in the watch app\'s settings.';
//! Before Pebble app 1.17 a host that is down and one the Pebble app has not
//! allowed fail the same way, with nothing to tell them apart, so the
//! message names both
var UNREACHABLE = 'Could not reach Home Assistant. Check that it is up, and that the Pebble app ' +
    'allows Home Assistant WS the internet and local network.';
var NOT_ALLOWED = 'The Pebble app does not allow Home Assistant WS to connect to Home Assistant. ' +
    'Allow it the internet and local network in the Pebble app.';

function PluginError(code, message) {
    this.code = code;
    this.message = message;
}

//! A short fingerprint of the token, so a refused one can be recognised
//! without keeping a second copy of it anywhere
function fingerprint(token) {
    var hash = 5381;
    for (var i = 0; i < token.length; i++) {
        hash = ((hash << 5) + hash + token.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16);
}

/**
 * Whether this token was refused recently. A refused token is left alone for
 * a while: every refused attempt counts towards Home Assistant's IP ban, and
 * a plugin polled every thirty seconds would get the phone banned.
 */
function tokenRefused(conn) {
    var failed = store.get('auth_failed');
    return !!(failed && failed.print === fingerprint(conn.token) &&
        Date.now() - failed.at < AUTH_RETRY_MS);
}

/**
 * Leave this token alone for a while. The marker is also kept in secure
 * storage: on Android the Pebble app rewrites localStorage from the watch
 * app's copy whenever the watch app's JS stops, which would wipe it and let
 * the next poll try the bad token again.
 */
function markRefused(conn) {
    var failed = { print: fingerprint(conn.token), at: Date.now() };
    store.set('auth_failed', failed);
    if (Pebble.secureStorage) {
        Pebble.secureStorage.setItem('auth_failed', JSON.stringify(failed)).catch(function() {});
    }
}

/** Put back a refusal marker the Android rewrite wiped. Settles either way. */
function loadRefusal() {
    if (store.get('auth_failed') || !Pebble.secureStorage) { return Promise.resolve(); }
    return Pebble.secureStorage.getItem('auth_failed').then(function(saved) {
        var failed = saved ? JSON.parse(saved) : null;
        if (failed && typeof failed.at === 'number') { store.set('auth_failed', failed); }
    }).catch(function() {});
}

/** Try the token again on the next request, e.g. when the settings page asks */
function forgetRefusal() {
    store.set('auth_failed', null);
    store.set('unreachable', null);
    if (Pebble.secureStorage) {
        Pebble.secureStorage.removeItem('auth_failed').catch(function() {});
    }
}

function recentlyUnreachable() {
    var at = store.get('unreachable');
    return typeof at === 'number' && Date.now() - at < UNREACHABLE_RETRY_MS;
}

function markUnreachable() {
    store.set('unreachable', Date.now());
}

//! The one check of the token for this request, however many of its calls
//! were refused at once
var checkingToken = null;

/**
 * Home Assistant also answers 401 when the token is fine but its user may
 * not do something (reloads and other admin-only services). Only a 401 from
 * the API root means the token itself is bad.
 */
function refused(conn, path) {
    if (tokenRefused(conn)) {
        return Promise.reject(new PluginError('AUTH_REQUIRED', REFUSED));
    }
    if (path !== '/api/' && checkingToken) {
        return checkingToken;
    }
    var verdict = path === '/api/' ? Promise.resolve(true) : fetch(conn.url + '/api/', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + conn.token }
    }).then(function(response) {
        return response.status === 401;
    }, function() {
        return false;
    });
    var outcome = verdict.then(function(tokenBad) {
        if (tokenBad) {
            markRefused(conn);
            throw new PluginError('AUTH_REQUIRED', REFUSED);
        }
        throw new PluginError('PERMISSION_DENIED',
            'Home Assistant does not let this token\'s user do that');
    });
    if (path !== '/api/') { checkingToken = outcome; }
    return outcome;
}

/** Make one request */
function request(conn, method, path, body) {
    if (tokenRefused(conn)) {
        return Promise.reject(new PluginError('AUTH_REQUIRED', REFUSED));
    }
    if (recentlyUnreachable()) {
        return Promise.reject(new PluginError('PLUGIN_UNAVAILABLE', UNREACHABLE));
    }

    var init = {
        method: method,
        headers: {
            'Authorization': 'Bearer ' + conn.token,
            'Content-Type': 'application/json'
        }
    };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
    }

    return fetch(conn.url + path, init).then(function(response) {
        if (store.get('unreachable')) { store.set('unreachable', null); }
        if (response.status === 401) {
            return refused(conn, path);
        }
        if (response.status === 403) {
            // A ban, or a proxy in front of Home Assistant: nothing to do with the token
            throw new PluginError('PERMISSION_DENIED', 'Home Assistant answered 403');
        }
        if (response.status === 404) {
            return null;
        }
        if (response.status === 400) {
            throw new PluginError('INVALID_ARGS', 'Home Assistant did not accept that');
        }
        // A service that fails answers 500; the server itself is fine
        if (response.status === 500 && method === 'POST') {
            throw new PluginError('UNKNOWN', 'Home Assistant could not do that');
        }
        if (!response.ok) {
            throw new PluginError('PLUGIN_UNAVAILABLE', 'Home Assistant answered ' + response.status);
        }
        return response.text().then(function(text) {
            return text ? JSON.parse(text) : null;
        });
    }, function(err) {
        if (err instanceof PluginError) { throw err; }
        // Newer Pebble apps say when the address was not allowed. That is
        // answered at once, so there is nothing to wait out.
        if (err && err.name === 'NotAllowedError') {
            throw new PluginError('PERMISSION_DENIED', NOT_ALLOWED);
        }
        markUnreachable();
        throw new PluginError('PLUGIN_UNAVAILABLE', UNREACHABLE);
    });
}

/**
 * Cached states, each stamped with when it was fetched, so one entity read
 * now does not make another read a minute ago look fresh.
 * @returns {Object} entity_id -> { at, state }, only the fresh ones
 */
function stateEntries() {
    var entries = store.get('states') || {};
    var now = Date.now();
    var fresh = {};
    Object.keys(entries).forEach(function(id) {
        var entry = entries[id];
        if (entry && typeof entry.at === 'number' && entry.state && now - entry.at < STATES_TTL_MS) {
            fresh[id] = entry;
        }
    });
    return fresh;
}

function cachedStates() {
    var entries = stateEntries();
    var byId = {};
    Object.keys(entries).forEach(function(id) { byId[id] = entries[id].state; });
    return byId;
}

/** Keep states that just came back, whether from a fetch or a service call */
function rememberStates(states) {
    var entries = stateEntries();
    var now = Date.now();
    for (var i = 0; i < states.length; i++) {
        if (states[i] && states[i].entity_id) {
            entries[states[i].entity_id] = { at: now, state: states[i] };
        }
    }
    store.set('states', entries);
}

/** Drop every cached state, so the next read asks Home Assistant */
function forgetStates() {
    store.set('states', null);
}

function forgetState(id) {
    var entries = stateEntries();
    delete entries[id];
    store.set('states', entries);
}

/**
 * The current state of each of `ids`, reusing what was fetched in the last
 * few seconds. Entities Home Assistant no longer has are simply left out.
 * @returns {Promise<Object>} entity_id -> state object
 */
function getStates(conn, ids) {
    var cached = cachedStates();
    var missing = ids.filter(function(id) { return !cached[id]; });
    if (missing.length === 0) {
        return Promise.resolve(pick(cached, ids));
    }

    var fetched;
    if (missing.length > BULK_THRESHOLD) {
        fetched = request(conn, 'GET', '/api/states').then(function(all) {
            var wanted = {};
            ids.forEach(function(id) { wanted[id] = true; });
            return (all || []).filter(function(state) { return wanted[state.entity_id]; });
        });
    } else {
        // One first and the rest after: a bad token would otherwise be
        // refused once for every entity, and each refusal counts towards
        // Home Assistant's IP ban
        var one = function(id) { return request(conn, 'GET', '/api/states/' + encodeURIComponent(id)); };
        fetched = one(missing[0]).then(function(first) {
            return Promise.all(missing.slice(1).map(one)).then(function(rest) {
                return [first].concat(rest);
            });
        }).then(function(states) {
            return states.filter(function(state) { return state && state.entity_id; });
        });
    }

    return fetched.then(function(states) {
        rememberStates(states);
        var byId = cachedStates();
        return pick(byId, ids);
    });
}

function pick(byId, ids) {
    var out = {};
    ids.forEach(function(id) {
        if (byId[id]) { out[id] = byId[id]; }
    });
    return out;
}

/**
 * Every weather entity. Normally the watch app has recorded these; before it
 * has, one look at the whole house finds them, and the answer is kept for an
 * hour.
 */
function discoverWeather(conn) {
    var known = store.fresh('weather_ids', 3600000);
    if (known) { return Promise.resolve(known); }
    return request(conn, 'GET', '/api/states').then(function(all) {
        var weather = (all || []).filter(function(state) {
            return state.entity_id.indexOf('weather.') === 0;
        });
        rememberStates(weather);
        var ids = weather.map(function(state) { return state.entity_id; }).sort();
        store.remember('weather_ids', ids);
        return ids;
    });
}

/**
 * Call a service on one entity. The states Home Assistant reports changed
 * replace the cached ones, so the next read already shows the result.
 */
function callService(conn, domain, service, data) {
    return request(conn, 'POST', '/api/services/' + domain + '/' + service, data).then(function(changed) {
        if (Array.isArray(changed)) {
            rememberStates(changed);
        }
        // Whatever did not come back is stale now
        if (data && data.entity_id) {
            if (!changed || !changed.some(function(s) { return s.entity_id === data.entity_id; })) {
                forgetState(data.entity_id);
            }
        }
        return changed;
    });
}

/** A service that answers with data, such as weather.get_forecasts */
function callServiceForResponse(conn, domain, service, data) {
    return request(conn, 'POST', '/api/services/' + domain + '/' + service + '?return_response', data)
        .then(function(answer) {
            return (answer && answer.service_response) || {};
        });
}

module.exports = {
    PluginError: PluginError,
    REFUSED: REFUSED,
    UNREACHABLE: UNREACHABLE,
    NOT_ALLOWED: NOT_ALLOWED,
    request: request,
    tokenRefused: tokenRefused,
    markRefused: markRefused,
    loadRefusal: loadRefusal,
    recentlyUnreachable: recentlyUnreachable,
    markUnreachable: markUnreachable,
    forgetRefusal: forgetRefusal,
    forgetStates: forgetStates,
    getStates: getStates,
    discoverWeather: discoverWeather,
    callService: callService,
    callServiceForResponse: callServiceForResponse,
    fingerprint: fingerprint
};
