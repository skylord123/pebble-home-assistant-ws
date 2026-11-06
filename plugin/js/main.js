/**
 * Home Assistant WS as a plugin: the entities the user shares, and weather,
 * for any watchface or app on the phone to read and control.
 *
 * The phone starts a fresh engine for every request and tears it down after,
 * so this registers its handlers and waits to be asked. See plugin/README.md
 * for what it serves.
 */
var options = require('options');
var ha = require('ha');
var entities = require('entities');
var weather = require('weather');
var actions = require('actions');
var page = require('page');

function fail(respond, err) {
    if (err instanceof ha.PluginError) {
        respond.error(err.code, err.message);
    } else {
        respond.error('UNKNOWN', String((err && err.message) || err));
    }
}

function notSetUp(respond) {
    respond.error('AUTH_REQUIRED', 'Home Assistant is not set up in the watch app yet');
}

//! How long a consumer may treat an answer as current
var VALID_MS = { entity: 30000, light: 30000, switch: 30000, media_player: 30000 };

function weatherIds(conn, opts) {
    var known = options.weatherIds(opts);
    return known !== null ? Promise.resolve(known) : ha.discoverWeather(conn);
}

function homeSource(conn, opts, item) {
    // Weather is shared without being chosen, and only belongs in the full list
    var listed = item === 'entity' ? weatherIds(conn, opts) : Promise.resolve([]);
    return listed.then(function(weatherList) {
        var ids = options.exposedIds(opts);
        if (item === 'entity') {
            weatherList.forEach(function(id) {
                if (ids.indexOf(id) === -1) { ids.push(id); }
            });
        } else {
            ids = ids.filter(function(id) { return entities.itemFor(id) === item; });
        }
        if (ids.length === 0) { return []; }
        return ha.getStates(conn, ids).then(function(states) {
            var instances = [];
            ids.forEach(function(id) {
                var instance = states[id] && entities.toInstance(item, states[id]);
                if (instance) { instances.push(instance); }
            });
            return instances;
        });
    });
}

/**
 * Whether send_to_agent would work: Index only offers the assistant as a
 * destination while this says so. It needs nothing from Home Assistant, so
 * it answers even before the plugin is set up.
 */
function agentConfigured(conn, opts) {
    return {
        validUntilMs: Date.now() + 300000,
        instances: [{
            instanceId: 'assistant',
            properties: {
                configured: { boolean: { value: !!conn && opts.plugin_share_assistant === true } },
                name: { shortText: { text: 'Assist' } }
            }
        }]
    };
}

Pebble.registerSourceHandler(function(request, respond) {
    return ha.loadRefusal().then(function() { return source(request, respond); })
        .catch(function(err) { fail(respond, err); });
});

function source(request, respond) {
    var opts = options.read();
    var conn = options.connection(opts);
    if (request.category === 'agent' && request.item === 'configured') {
        return respond.data(agentConfigured(conn, opts));
    }
    if (!conn) { return notSetUp(respond); }

    var work;
    if (request.category === 'home' && entities.ITEMS.indexOf(request.item) !== -1) {
        work = homeSource(conn, opts, request.item);
    } else if (request.category === 'weather' && request.item === 'location') {
        work = weatherIds(conn, opts).then(function(ids) { return weather.location(conn, ids, request); });
    } else {
        return respond.error('INVALID_REQUEST', 'unknown item ' + request.category + '/' + request.item);
    }

    return work.then(function(instances) {
        respond.data({
            validUntilMs: Date.now() + (VALID_MS[request.item] || 60000),
            instances: instances
        });
    }, function(err) {
        fail(respond, err);
    });
}

Pebble.registerActionHandler(function(request, respond) {
    return ha.loadRefusal().then(function() { return action(request, respond); })
        .catch(function(err) { fail(respond, err); });
});

function action(request, respond) {
    var opts = options.read();
    var conn = options.connection(opts);
    if (!conn) { return notSetUp(respond); }

    return actions.run(conn, opts, request.action, request.args || {}).then(function(result) {
        respond.ok(result);
    }, function(err) {
        fail(respond, err);
    });
}

/**
 * The settings page talks to the plugin while it is open: to check the
 * plugin can reach Home Assistant, and to have whatever reads the shared
 * entities read them again once the list has changed. When the watch app's
 * JS is not running, the page also loads and saves the settings here; see
 * page.js.
 */
Pebble.registerConfigHandler(function(message, respond) {
    var type = message && message.type;
    var opts = options.read();

    if (type === 'refresh') {
        // Asked for because something changed; a cached answer would hide it
        page.refreshSources();
        return respond({ ok: true });
    }

    if (type === 'status') {
        var conn = options.connection(opts);
        if (!conn) {
            return respond({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Home Assistant is not set up yet' } });
        }
        // Someone is looking at the settings, so a refused token gets another try
        ha.forgetRefusal();
        return ha.request(conn, 'GET', '/api/').then(function() {
            respond({
                ok: true,
                shared: options.exposedIds(opts).length,
                weather: (options.weatherIds(opts) || []).length,
                assistant: opts.plugin_share_assistant === true
            });
        }, function(err) {
            respond({ ok: false, error: { code: err.code || 'UNKNOWN', message: err.message || String(err) } });
        });
    }

    var handler = page.handlerFor(type);
    if (handler) {
        return Promise.resolve(handler(message, respond)).catch(function(err) {
            respond(page.failure(err));
        });
    }

    respond({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Unknown request: ' + type } });
});
