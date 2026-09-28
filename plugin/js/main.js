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
    return weatherIds(conn, opts).then(function(weatherList) {
        var ids = options.exposedIds(opts);
        // Weather is shared without being chosen, and belongs in the full list
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

Pebble.registerSourceHandler(function(request, respond) {
    var opts = options.read();
    var conn = options.connection(opts);
    if (!conn) { return notSetUp(respond); }

    var work;
    if (request.category === 'home' && entities.ITEMS.indexOf(request.item) !== -1) {
        work = homeSource(conn, opts, request.item);
    } else if (request.category === 'weather' && request.item === 'location') {
        work = weatherIds(conn, opts).then(function(ids) { return weather.location(conn, ids); });
    } else if (request.category === 'weather' && request.item === 'hour') {
        work = weatherIds(conn, opts).then(function(ids) { return weather.hours(conn, ids); });
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
});

Pebble.registerActionHandler(function(request, respond) {
    var opts = options.read();
    var conn = options.connection(opts);
    if (!conn) { return notSetUp(respond); }

    return actions.run(conn, opts, request.action, request.args || {}).then(function(result) {
        respond.ok(result);
    }, function(err) {
        fail(respond, err);
    });
});

/**
 * The watch app's settings page talks to the plugin while it is open: to
 * check the plugin can reach Home Assistant, and to have whatever reads the
 * shared entities read them again once the list has changed.
 */
Pebble.registerConfigHandler(function(message, respond) {
    var type = message && message.type;
    var opts = options.read();

    if (type === 'refresh') {
        Pebble.refreshSources(['home/entity', 'weather/location', 'weather/hour']
            .concat(entities.ITEMS.map(function(item) { return 'home/' + item; })));
        return respond({ ok: true });
    }

    if (type === 'status') {
        var conn = options.connection(opts);
        if (!conn) {
            return respond({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Home Assistant is not set up yet' } });
        }
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

    respond({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Unknown request: ' + type } });
});
