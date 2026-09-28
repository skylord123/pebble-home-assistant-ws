/**
 * What other apps can do to shared entities, and the assistant.
 *
 * Every entity action names its entity by `instanceId` (the entity_id), and
 * is refused unless that entity is shared. Nothing here reaches beyond the
 * one entity named: `call_service` only calls services of the entity's own
 * domain, on that entity.
 *
 * Codes for locks and alarm panels come from the caller when needed. The
 * codes the watch app remembers are never used here, or any installed app
 * could disarm an alarm without knowing its code.
 */
var ha = require('ha');
var store = require('store');
var options = require('options');
var entities = require('entities');

var PluginError = ha.PluginError;

//! How long a conversation with the assistant carries on between asks
var CONVERSATION_IDLE_MS = 5 * 60 * 1000;

var TOGGLE_DOMAINS = {
    light: true, switch: true, input_boolean: true, fan: true, automation: true,
    siren: true, humidifier: true, remote: true
};

//! Services with an action of their own that asks the wearer first, so
//! call_service cannot be used to skip the asking
var CONFIRMED_SERVICES = {
    'lock.unlock': 'unlock',
    'lock.open': 'open',
    'alarm_control_panel.alarm_disarm': 'alarm_disarm'
};

function invalid(message) {
    return new PluginError('INVALID_ARGS', message);
}

function requireDomain(entity, allowed, what) {
    var domain = entities.domainOf(entity.entity_id);
    if (allowed.indexOf(domain) === -1) {
        throw invalid(entity.entity_id + ' cannot ' + what);
    }
    return domain;
}

function withCode(data, args) {
    if (args.code !== undefined && args.code !== null && args.code !== '') {
        data.code = String(args.code);
    }
    return data;
}

function percentArg(args, key) {
    var value = Number(args[key]);
    if (!isFinite(value) || value < 0 || value > 100) {
        throw invalid(key + ' must be a number from 0 to 100');
    }
    return Math.round(value);
}

/**
 * Each action turns its arguments and the entity's current state into the
 * service call that does it, and a line saying what happened.
 */
var ENTITY_ACTIONS = {
    set_on: function(entity, args) {
        if (typeof args.on !== 'boolean') { throw invalid('on must be true or false'); }
        var domain = entities.domainOf(entity.entity_id);
        var name = entities.nameOf(entity);
        if (TOGGLE_DOMAINS[domain] || domain === 'media_player' || domain === 'climate' ||
            domain === 'water_heater') {
            return { domain: domain, service: args.on ? 'turn_on' : 'turn_off',
                text: (args.on ? 'Turned on ' : 'Turned off ') + name + '.' };
        }
        if (domain === 'cover' || domain === 'valve') {
            return { domain: domain, service: (args.on ? 'open_' : 'close_') + domain,
                text: (args.on ? 'Opening ' : 'Closing ') + name + '.' };
        }
        if (domain === 'scene' || domain === 'script') {
            if (!args.on) { return { domain: domain, service: 'turn_off', text: 'Stopped ' + name + '.' }; }
            return { domain: domain, service: 'turn_on', text: 'Ran ' + name + '.' };
        }
        throw invalid(entity.entity_id + ' has no on or off');
    },

    toggle: function(entity) {
        var domain = entities.domainOf(entity.entity_id);
        var name = entities.nameOf(entity);
        if (TOGGLE_DOMAINS[domain]) {
            return { domain: domain, service: 'toggle', text: 'Toggled ' + name + '.' };
        }
        switch (domain) {
            case 'cover':
            case 'valve':
                return { domain: domain, service: 'toggle', text: 'Toggled ' + name + '.' };
            case 'lock':
                // Unlocking asks the wearer first, which a toggle would skip
                if (entity.state === 'locked') {
                    throw invalid(name + ' is locked; use unlock');
                }
                return { domain: domain, service: 'lock', text: 'Locked ' + name + '.' };
            case 'media_player':
                return { domain: domain, service: 'media_play_pause', text: 'Play/paused ' + name + '.' };
            case 'climate':
            case 'water_heater':
                return entity.state === 'off'
                    ? { domain: domain, service: 'turn_on', text: 'Turned on ' + name + '.' }
                    : { domain: domain, service: 'turn_off', text: 'Turned off ' + name + '.' };
            case 'scene':
            case 'script':
            case 'button':
            case 'input_button':
            case 'automation':
                return ENTITY_ACTIONS.activate(entity);
        }
        throw invalid(entity.entity_id + ' cannot be toggled');
    },

    activate: function(entity) {
        var domain = entities.domainOf(entity.entity_id);
        var name = entities.nameOf(entity);
        switch (domain) {
            case 'scene':
            case 'script':
                return { domain: domain, service: 'turn_on', text: 'Ran ' + name + '.' };
            case 'button':
            case 'input_button':
                return { domain: domain, service: 'press', text: 'Pressed ' + name + '.' };
            case 'automation':
                return { domain: domain, service: 'trigger', text: 'Triggered ' + name + '.' };
        }
        throw invalid(entity.entity_id + ' cannot be activated');
    },

    set_brightness: function(entity, args) {
        requireDomain(entity, ['light'], 'set a brightness');
        var percent = percentArg(args, 'percent');
        if (percent === 0) {
            return { domain: 'light', service: 'turn_off', text: 'Turned off ' + entities.nameOf(entity) + '.' };
        }
        return { domain: 'light', service: 'turn_on', data: { brightness_pct: percent },
            text: 'Set ' + entities.nameOf(entity) + ' to ' + percent + '%.' };
    },

    set_temperature: function(entity, args) {
        var domain = requireDomain(entity, ['climate', 'water_heater'], 'set a temperature');
        var value = Number(args.temperature);
        if (!isFinite(value)) { throw invalid('temperature must be a number'); }
        return { domain: domain, service: 'set_temperature', data: { temperature: value },
            text: 'Set ' + entities.nameOf(entity) + ' to ' + value + '°.' };
    },

    set_hvac_mode: function(entity, args) {
        requireDomain(entity, ['climate'], 'change its mode');
        if (typeof args.hvac_mode !== 'string' || !args.hvac_mode) { throw invalid('hvac_mode is required'); }
        return { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: args.hvac_mode },
            text: 'Set ' + entities.nameOf(entity) + ' to ' + args.hvac_mode + '.' };
    },

    set_position: function(entity, args) {
        var domain = requireDomain(entity, ['cover', 'valve'], 'set a position');
        var position = percentArg(args, 'position');
        return { domain: domain, service: domain === 'cover' ? 'set_cover_position' : 'set_valve_position',
            data: { position: position }, text: 'Moving ' + entities.nameOf(entity) + ' to ' + position + '%.' };
    },

    open: function(entity, args) {
        var domain = requireDomain(entity, ['cover', 'valve', 'lock'], 'open');
        var service = domain === 'lock' ? 'open' : 'open_' + domain;
        return { domain: domain, service: service, data: withCode({}, args),
            text: 'Opening ' + entities.nameOf(entity) + '.' };
    },

    close: function(entity) {
        var domain = requireDomain(entity, ['cover', 'valve'], 'close');
        return { domain: domain, service: 'close_' + domain,
            text: 'Closing ' + entities.nameOf(entity) + '.' };
    },

    stop: function(entity) {
        var domain = requireDomain(entity, ['cover', 'valve'], 'stop');
        return { domain: domain, service: 'stop_' + domain,
            text: 'Stopped ' + entities.nameOf(entity) + '.' };
    },

    lock: function(entity, args) {
        requireDomain(entity, ['lock'], 'lock');
        return { domain: 'lock', service: 'lock', data: withCode({}, args),
            text: 'Locked ' + entities.nameOf(entity) + '.' };
    },

    unlock: function(entity, args) {
        requireDomain(entity, ['lock'], 'unlock');
        return { domain: 'lock', service: 'unlock', data: withCode({}, args),
            text: 'Unlocked ' + entities.nameOf(entity) + '.' };
    },

    alarm_arm: function(entity, args) {
        requireDomain(entity, ['alarm_control_panel'], 'arm');
        var modes = ['home', 'away', 'night', 'vacation', 'custom_bypass'];
        var mode = args.mode || 'away';
        if (modes.indexOf(mode) === -1) { throw invalid('mode must be one of ' + modes.join(', ')); }
        return { domain: 'alarm_control_panel', service: 'alarm_arm_' + mode, data: withCode({}, args),
            text: 'Arming ' + entities.nameOf(entity) + ' (' + mode.replace('_', ' ') + ').' };
    },

    alarm_disarm: function(entity, args) {
        requireDomain(entity, ['alarm_control_panel'], 'disarm');
        return { domain: 'alarm_control_panel', service: 'alarm_disarm', data: withCode({}, args),
            text: 'Disarmed ' + entities.nameOf(entity) + '.' };
    },

    set_playing: function(entity, args) {
        requireDomain(entity, ['media_player'], 'play');
        if (typeof args.playing !== 'boolean') { throw invalid('playing must be true or false'); }
        return { domain: 'media_player', service: args.playing ? 'media_play' : 'media_pause',
            text: (args.playing ? 'Playing ' : 'Paused ') + entities.nameOf(entity) + '.' };
    },

    next_track: function(entity) {
        requireDomain(entity, ['media_player'], 'skip');
        return { domain: 'media_player', service: 'media_next_track', text: 'Next track.' };
    },

    previous_track: function(entity) {
        requireDomain(entity, ['media_player'], 'skip back');
        return { domain: 'media_player', service: 'media_previous_track', text: 'Previous track.' };
    },

    set_volume: function(entity, args) {
        requireDomain(entity, ['media_player'], 'change volume');
        var percent = percentArg(args, 'percent');
        return { domain: 'media_player', service: 'volume_set', data: { volume_level: percent / 100 },
            text: 'Volume ' + percent + '%.' };
    },

    /**
     * Anything else the entity's own domain offers: numbers, selects,
     * vacuums, and whatever has no action of its own here. Always on the
     * named entity, never another.
     */
    call_service: function(entity, args) {
        var domain = entities.domainOf(entity.entity_id);
        if (typeof args.service !== 'string' || !/^[a-z0-9_]+$/.test(args.service)) {
            throw invalid('service must be a service name of the ' + domain + ' domain');
        }
        var confirmed = CONFIRMED_SERVICES[domain + '.' + args.service];
        if (confirmed) {
            throw new PluginError('PERMISSION_DENIED', 'Use the ' + confirmed + ' action for that');
        }
        var data = {};
        if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
            Object.keys(args.data).forEach(function(key) {
                // The target is the named entity and nothing else
                if (key !== 'entity_id' && key !== 'device_id' && key !== 'area_id' &&
                    key !== 'floor_id' && key !== 'label_id') {
                    data[key] = args.data[key];
                }
            });
        }
        return { domain: domain, service: args.service, data: data,
            text: 'Called ' + domain + '.' + args.service + ' on ' + entities.nameOf(entity) + '.' };
    }
};

//! The sources an entity shows up in, so they re-read after it changes
function refreshKeys(entityId) {
    var keys = ['home/entity'];
    var item = entities.itemFor(entityId);
    if (item) { keys.push('home/' + item); }
    if (entityId.indexOf('weather.') === 0) { keys.push('weather/location'); }
    return keys;
}

function sharedIds(opts) {
    return options.exposedIds(opts).concat(options.weatherIds(opts) || []);
}

function runEntityAction(conn, opts, name, args) {
    var id = args.instanceId;
    if (typeof id !== 'string' || id.indexOf('.') === -1) {
        return Promise.reject(invalid('instanceId must be an entity_id'));
    }
    var shared = sharedIds(opts);
    var isWeather = id.indexOf('weather.') === 0;
    if (shared.indexOf(id) === -1 && !isWeather) {
        return Promise.reject(new PluginError('PERMISSION_DENIED', id + ' is not shared with other apps'));
    }
    return ha.getStates(conn, [id]).then(function(states) {
        var entity = states[id];
        if (!entity) {
            throw new PluginError('PLUGIN_UNAVAILABLE', id + ' is not in Home Assistant');
        }
        var call = ENTITY_ACTIONS[name](entity, args);
        var data = call.data || {};
        data.entity_id = id;
        return ha.callService(conn, call.domain, call.service, data).then(function() {
            return { text: call.text, refreshed: refreshKeys(id) };
        });
    });
}

/**
 * The conversation agent the watch app would talk to: the one behind the
 * pipeline chosen there, or behind Home Assistant's preferred pipeline.
 * Pipelines themselves are only reachable over the WebSocket.
 */
function agentFor(opts) {
    var pipelines = Array.isArray(opts.available_pipelines) ? opts.available_pipelines : [];
    var chosen = null;
    for (var i = 0; i < pipelines.length; i++) {
        if (pipelines[i].id === opts.selected_pipeline) { chosen = pipelines[i]; }
    }
    if (!chosen) {
        for (var j = 0; j < pipelines.length; j++) {
            if (pipelines[j].preferred) { chosen = pipelines[j]; }
        }
    }
    return chosen || {};
}

/**
 * Send text to Home Assistant's assistant and answer with what it said. The
 * conversation carries on across asks for a few minutes, since an action's
 * result has nowhere to hand its id back to the caller. Any app asking shares
 * the one conversation.
 */
function askAssistant(conn, opts, args) {
    if (opts.plugin_share_assistant !== true) {
        return Promise.reject(new PluginError('PERMISSION_DENIED',
            'Sharing the assistant with other apps is turned off in the watch app\'s settings'));
    }
    var text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) { return Promise.reject(invalid('text is required')); }

    var body = { text: text };
    var agent = agentFor(opts);
    if (agent.conversation_engine) { body.agent_id = agent.conversation_engine; }
    if (agent.conversation_language) { body.language = agent.conversation_language; }
    var previous = args.new_conversation === true ? null : store.fresh('conversation', CONVERSATION_IDLE_MS);
    if (previous) { body.conversation_id = previous; }

    return ha.request(conn, 'POST', '/api/conversation/process', body).then(function(answer) {
        var response = (answer && answer.response) || {};
        if (answer && answer.conversation_id) {
            store.remember('conversation', answer.conversation_id);
        }
        var speech = response.speech && response.speech.plain && response.speech.plain.speech;
        if (response.response_type === 'error') {
            throw new PluginError('UNKNOWN', speech || 'The assistant could not answer');
        }
        return {
            text: speech || (response.response_type === 'action_done' ? 'Done.' : 'The assistant gave no answer.'),
            // Whatever it did could have changed anything shared
            refreshed: ['home/entity'].concat(entities.ITEMS.map(function(item) { return 'home/' + item; }))
        };
    });
}

function run(conn, opts, name, args) {
    if (name === 'ask_assistant') {
        return askAssistant(conn, opts, args);
    }
    if (!ENTITY_ACTIONS.hasOwnProperty(name)) {
        return Promise.reject(new PluginError('INVALID_REQUEST', 'unknown action ' + name));
    }
    return runEntityAction(conn, opts, name, args);
}

module.exports = {
    run: run,
    names: Object.keys(ENTITY_ACTIONS).concat(['ask_assistant'])
};
