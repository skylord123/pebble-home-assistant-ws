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
 * Make one request. A token Home Assistant has refused is not tried again
 * until it changes: every refused attempt counts towards Home Assistant's IP
 * ban, and a plugin polled every thirty seconds would get the phone banned.
 */
function request(conn, method, path, body) {
    var print = fingerprint(conn.token);
    if (store.get('auth_failed') === print) {
        return Promise.reject(new PluginError('AUTH_REQUIRED',
            'Home Assistant refused the access token. Update it in the watch app\'s settings.'));
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
        if (response.status === 401 || response.status === 403) {
            store.set('auth_failed', print);
            throw new PluginError('AUTH_REQUIRED',
                'Home Assistant refused the access token. Update it in the watch app\'s settings.');
        }
        if (response.status === 404) {
            return null;
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

function cachedStates() {
    return store.fresh('states', STATES_TTL_MS) || {};
}

/** Keep states that just came back, whether from a fetch or a service call */
function rememberStates(states) {
    var byId = cachedStates();
    for (var i = 0; i < states.length; i++) {
        if (states[i] && states[i].entity_id) {
            byId[states[i].entity_id] = states[i];
        }
    }
    store.remember('states', byId);
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
            var byId = cachedStates();
            if (!changed || !changed.some(function(s) { return s.entity_id === data.entity_id; })) {
                delete byId[data.entity_id];
                store.remember('states', byId);
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
    getStates: getStates,
    discoverWeather: discoverWeather,
    callService: callService,
    callServiceForResponse: callServiceForResponse,
    fingerprint: fingerprint
};
