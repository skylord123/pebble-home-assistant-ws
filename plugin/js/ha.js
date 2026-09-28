/**
 * Home Assistant over its REST API. A plugin cannot open a WebSocket or keep
 * anything running between requests, so each request asks for what it needs
 * and gets out.
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

var REFUSED = 'Home Assistant refused the access token. Update it in the watch app\'s settings.';

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

/** Try the token again on the next request, e.g. when the settings page asks */
function forgetRefusal() {
    store.set('auth_failed', null);
}

/**
 * Home Assistant also answers 401 when the token is fine but its user may
 * not do something (reloads and other admin-only services). Only a 401 from
 * the API root means the token itself is bad.
 */
function refused(conn, path) {
    var verdict = path === '/api/' ? Promise.resolve(true) : fetch(conn.url + '/api/', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + conn.token }
    }).then(function(response) {
        return response.status === 401;
    }, function() {
        return false;
    });
    return verdict.then(function(tokenBad) {
        if (tokenBad) {
            store.set('auth_failed', { print: fingerprint(conn.token), at: Date.now() });
            throw new PluginError('AUTH_REQUIRED', REFUSED);
        }
        throw new PluginError('PERMISSION_DENIED',
            'Home Assistant does not let this token\'s user do that');
    });
}

/** Make one request */
function request(conn, method, path, body) {
    if (tokenRefused(conn)) {
        return Promise.reject(new PluginError('AUTH_REQUIRED', REFUSED));
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
        if (!response.ok) {
            throw new PluginError('PLUGIN_UNAVAILABLE', 'Home Assistant answered ' + response.status);
        }
        return response.text().then(function(text) {
            return text ? JSON.parse(text) : null;
        });
    }, function(err) {
        if (err instanceof PluginError) { throw err; }
        throw new PluginError('PLUGIN_UNAVAILABLE', 'Could not reach Home Assistant');
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
        fetched = Promise.all(missing.map(function(id) {
            return request(conn, 'GET', '/api/states/' + encodeURIComponent(id));
        })).then(function(states) {
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
    request: request,
    forgetRefusal: forgetRefusal,
    getStates: getStates,
    discoverWeather: discoverWeather,
    callService: callService,
    callServiceForResponse: callServiceForResponse,
    fingerprint: fingerprint
};
