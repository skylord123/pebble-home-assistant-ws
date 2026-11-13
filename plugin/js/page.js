/**
 * The settings page, when the watch app's JS is not running to answer it.
 *
 * The Pebble app can open the page from its Plugins tab, or from an Index
 * destination, without starting the watch app. The page then sends the
 * requests it would send the watch app (see src/js/app/ConfigBridge.js) here,
 * and they are answered from the stored settings and Home Assistant's REST
 * API instead. Replies have the same shape: `{ ok: true, ... }` or
 * `{ ok: false, error: { code, message } }`.
 *
 * The phone keeps the plugin running while its page is open, so the states
 * fetched for searching are kept in memory between requests.
 */
var options = require('options');
var ha = require('ha');
var ws = require('ws');
var entities = require('entities');
var values = require('values');
var areas = require('areas');

var SEARCH_LIMIT_DEFAULT = 30;
var SEARCH_LIMIT_MAX = 100;
//! Longer than anyone writes by hand; past it a preview is refused
var TEMPLATE_MAX = 10000;

//! Every area with what is in it, as [entity_id, name, state, unit]. REST has
//! no way to the area registry; a template does, in one request.
var AREAS_TEMPLATE =
    '{%- set ns = namespace(areas=[], entities=[]) -%}' +
    '{%- for area in areas() -%}' +
    '{%- set ns.entities = [] -%}' +
    '{%- for s in states | selectattr(\'entity_id\', \'in\', area_entities(area)) -%}' +
    '{%- set ns.entities = ns.entities + [[s.entity_id, s.name, s.state, ' +
    's.attributes.unit_of_measurement | default(\'\')]] -%}' +
    '{%- endfor -%}' +
    '{%- set ns.areas = ns.areas + [{\'id\': area, \'name\': area_name(area), \'entities\': ns.entities}] -%}' +
    '{%- endfor -%}' +
    '{{ ns.areas | tojson }}';

//! Every entity's state, fetched once while the page is open
var allStates = null;

function failure(err) {
    return {
        ok: false,
        error: { code: (err && err.code) || 'internal', message: (err && err.message) || String(err) }
    };
}

function normalizeUrl(url) {
    if (typeof url !== 'string') { return null; }
    url = url.trim().replace(/\/+$/, '');
    return /^https?:\/\/[^\/\s]+/i.test(url) ? url : null;
}

/** Where the connection stands, in the shape ConfigBridge.status() reports */
function status(conn) {
    var base = {
        phase: 'unconfigured',
        connected: false,
        ha_url: conn ? conn.url : null,
        ha_version: null,
        states_loaded: !!allStates,
        entity_count: allStates ? allStates.length : 0,
        error: null
    };
    if (!conn) { return Promise.resolve(base); }
    return ha.request(conn, 'GET', '/api/config').then(function(config) {
        base.phase = 'connected';
        base.connected = true;
        base.ha_version = (config && config.version) || null;
        return base;
    }, function(err) {
        base.phase = err.code === 'AUTH_REQUIRED' ? 'auth_failed' : 'connecting';
        base.error = { code: err.code, message: err.message };
        return base;
    });
}

/** The pipelines, as the watch app lists them for the page */
function pipelines(conn) {
    return ws.run(conn, { type: 'assist_pipeline/pipeline/list' }, function(msg, settle) {
        if (msg.type === 'result') { settle(msg.result || {}); }
    }).then(function(result) {
        return (result.pipelines || []).map(function(p) {
            return { id: p.id, name: p.name, preferred: p.id === result.preferred_pipeline, stt: !!p.stt_engine };
        });
    });
}

function calendars(states) {
    return states.filter(function(state) {
        return state.entity_id.indexOf('calendar.') === 0;
    }).map(function(state) {
        var named = state.attributes && state.attributes.friendly_name;
        return { entity_id: state.entity_id, name: named ? String(named) : state.entity_id.substring(9) };
    });
}

/**
 * Fetch what the watch app would have filled in from its own connection:
 * every state (for searching), the calendars and the pipelines. The lists
 * are saved, as the watch app saves them, so the page can offer them. Each
 * part settles on its own; one failing leaves the stored list as it was.
 */
function loadLive(conn) {
    var lists = {};
    var states = ha.request(conn, 'GET', '/api/states').then(function(all) {
        allStates = (all || []).filter(function(state) { return state && state.entity_id; });
        lists.available_calendars = calendars(allStates);
    }, function() {});
    var assist = pipelines(conn).then(function(found) {
        lists.available_pipelines = found;
    }, function() {});
    return Promise.all([states, assist]).then(function() {
        if (Object.keys(lists).length > 0) { options.save(lists); }
        return lists;
    });
}

function search(query, limit) {
    var terms = String(query || '').toLowerCase().split(/\s+/).filter(function(t) { return t.length > 0; });
    if (terms.length === 0) { return { results: [], total: 0 }; }
    var phrase = terms.join(' ');
    var matches = [];
    allStates.forEach(function(entity) {
        var name = entities.nameOf(entity);
        var lowerName = name.toLowerCase();
        var haystack = lowerName + ' ' + entity.entity_id.toLowerCase();
        for (var t = 0; t < terms.length; t++) {
            if (haystack.indexOf(terms[t]) === -1) { return; }
        }
        // Ranked as the watch app ranks them (EntityService.search)
        var rank = lowerName.indexOf(phrase) === 0 ? 0
            : lowerName.indexOf(phrase) !== -1 ? 1
            : lowerName.indexOf(terms[0]) === 0 ? 2
            : lowerName.indexOf(terms[0]) !== -1 ? 3 : 4;
        matches.push({ entity: entity, name: name, lowerName: lowerName, rank: rank });
    });
    matches.sort(function(a, b) {
        if (a.rank !== b.rank) { return a.rank - b.rank; }
        return a.lowerName < b.lowerName ? -1 : (a.lowerName > b.lowerName ? 1 : 0);
    });
    return {
        results: matches.slice(0, limit).map(function(match) {
            var unit = match.entity.attributes && match.entity.attributes.unit_of_measurement;
            return {
                entity_id: match.entity.entity_id,
                name: match.name,
                state: match.entity.state + (unit ? ' ' + unit : '')
            };
        }),
        total: matches.length
    };
}

function byName(a, b) {
    var x = a.name.toLowerCase();
    var y = b.name.toLowerCase();
    return x < y ? -1 : (x > y ? 1 : 0);
}

/** Have whatever reads the shared entities read them again */
function refreshSources() {
    ha.forgetStates();
    values.forget();
    // A new token may be an administrator's, which can read the rooms
    areas.forgetFailure();
    Pebble.refreshSources(['home/entity', 'home/value', 'weather/location', 'agent/configured']
        .concat(entities.ITEMS.map(function(item) { return 'home/' + item; })));
}

var handlers = {
    get_settings: function(message, respond) {
        var opts = options.read();
        var conn = options.connection(opts);
        // Someone is looking at the settings, so a refused token gets another try
        ha.forgetRefusal();
        return status(conn).then(function(current) {
            respond({ ok: true, from_plugin: true, settings: opts, status: current });
            if (current.phase !== 'connected') { return; }
            // Answered already; the rest arrives as a push, as it would from
            // the watch app's own connection
            return loadLive(conn).then(function(lists) {
                return status(conn).then(function(after) {
                    Pebble.sendConfigMessage({ type: 'status', status: after, settings: lists });
                });
            });
        });
    },

    get_status: function(message, respond) {
        return status(options.connection(options.read())).then(function(current) {
            respond({ ok: true, status: current });
        });
    },

    save_settings: function(message, respond) {
        var settings = message.settings;
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            return respond(failure({ code: 'bad_request', message: 'save_settings needs a settings object' }));
        }
        if (!settings.ha_url || !settings.token) {
            return respond(failure({ code: 'bad_request', message: 'A Home Assistant URL and access token are required' }));
        }
        options.save(settings);
        ha.forgetRefusal();
        refreshSources();
        respond({ ok: true, from_plugin: true });
    },

    /**
     * Try the given URL and token, and keep them only once Home Assistant
     * has accepted them, so a typo never replaces working ones.
     */
    connect: function(message, respond) {
        var url = normalizeUrl(message.ha_url);
        var token = typeof message.token === 'string' ? message.token.trim() : '';
        if (!url) {
            return respond(failure({ code: 'bad_url', message: 'The URL must begin with http:// or https://' }));
        }
        if (!token) {
            return respond(failure({ code: 'missing_token', message: 'An access token is required' }));
        }
        var conn = { url: url, token: token };
        ha.forgetRefusal();
        allStates = null;
        return ha.request(conn, 'GET', '/api/config').then(function(config) {
            options.save({ ha_url: url, token: token });
            refreshSources();
            respond({ ok: true, ha_version: (config && config.version) || null });
            return loadLive(conn).then(function(lists) {
                return status(conn).then(function(after) {
                    Pebble.sendConfigMessage({ type: 'status', status: after, settings: lists });
                });
            });
        }, function(err) {
            respond(failure(err));
        });
    },

    search_entities: function(message, respond) {
        var conn = options.connection(options.read());
        if (!conn) {
            return respond(failure({ code: 'not_loaded', message: 'Home Assistant is not set up yet' }));
        }
        var limit = parseInt(message.limit, 10);
        if (!(limit > 0)) { limit = SEARCH_LIMIT_DEFAULT; }
        if (limit > SEARCH_LIMIT_MAX) { limit = SEARCH_LIMIT_MAX; }
        var loaded = allStates ? Promise.resolve() : loadLive(conn);
        return loaded.then(function() {
            if (!allStates) {
                return respond(failure({ code: 'unreachable', message: 'Could not load entities from Home Assistant' }));
            }
            var found = search(message.query, limit);
            respond({ ok: true, results: found.results, total: found.total });
        });
    },

    /**
     * A custom value's template rendered as `home/value` would serve it, so
     * the wearer sees what other apps get while they write it. The page
     * sends this here even when the watch app is answering everything else.
     */
    preview_template: function(message, respond) {
        var conn = options.connection(options.read());
        if (!conn) {
            return respond(failure({ code: 'not_loaded', message: 'Home Assistant is not set up yet' }));
        }
        var template = message.template;
        if (typeof template !== 'string' || !template.trim()) {
            return respond(failure({ code: 'bad_request', message: 'preview_template needs a template' }));
        }
        if (template.length > TEMPLATE_MAX) {
            return respond(failure({ code: 'bad_request', message: 'That template is too long' }));
        }
        var unit = typeof message.unit === 'string' ? message.unit.trim() : '';
        return values.preview(conn, template, unit).then(function(rendered) {
            if (rendered.error !== undefined) {
                return respond(failure({ code: 'template_error', message: rendered.error }));
            }
            respond({ ok: true, result: rendered.result, text: rendered.text });
        });
    },

    /**
     * The areas and what is in each, for the page to share a whole area at
     * once. Sent here whoever answers the rest: sharing is for the plugin.
     * Entities come as search results do; empty areas are left out.
     */
    list_areas: function(message, respond) {
        var conn = options.connection(options.read());
        if (!conn) {
            return respond(failure({ code: 'not_loaded', message: 'Home Assistant is not set up yet' }));
        }
        return ha.request(conn, 'POST', '/api/template', { template: AREAS_TEMPLATE }).then(function(found) {
            var areas = (Array.isArray(found) ? found : []).map(function(area) {
                var members = (Array.isArray(area.entities) ? area.entities : []).map(function(e) {
                    return { entity_id: e[0], name: String(e[1] || e[0]), state: e[2] + (e[3] ? ' ' + e[3] : '') };
                });
                members.sort(byName);
                return { id: area.id, name: String(area.name || area.id), entities: members };
            }).filter(function(area) { return area.entities.length > 0; });
            areas.sort(byName);
            respond({ ok: true, areas: areas });
        });
    },

    // The log is the watch app's, kept in its own memory
    get_logs: function(message, respond) {
        respond(failure({ code: 'not_running', message: 'The log is kept by the watch app. Open Home Assistant WS on the watch, then open its settings from there.' }));
    },

    clear_logs: function(message, respond) {
        respond(failure({ code: 'not_running', message: 'The log is kept by the watch app, which is not running' }));
    }
};

/** The handler for a request type, or null; own keys only, so "constructor" finds nothing */
function handlerFor(type) {
    return Object.prototype.hasOwnProperty.call(handlers, type) ? handlers[type] : null;
}

module.exports = {
    handlerFor: handlerFor,
    refreshSources: refreshSources,
    failure: failure
};
