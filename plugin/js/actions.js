/**
 * What other apps can do to shared entities, and the assistant.
 *
 * Every entity action names its entity by `instanceId` (the entity_id), and
 * is refused unless that entity is shared. Nothing here reaches beyond the
 * one entity named: `call_service` only calls the services listed below for
 * the entity's own domain, on that entity.
 *
 * Unlocking, disarming and opening a garage door, gate or door ask the
 * wearer first (the manifest marks those actions), and no other action does
 * the same thing without asking.
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

var ON_OFF = ['turn_on', 'turn_off', 'toggle'];
var SELECT = ['select_option', 'select_next', 'select_previous', 'select_first', 'select_last'];

/**
 * What call_service may call, by domain. Only services that act on the
 * entity they are given: a script, for one, is also a service of its own
 * (script.<name>), so an open list would run any script in the house.
 */
var CALLABLE = {
    light: ON_OFF,
    switch: ON_OFF,
    input_boolean: ON_OFF,
    siren: ON_OFF,
    remote: ON_OFF,
    script: ON_OFF,
    fan: ON_OFF.concat(['set_percentage', 'increase_speed', 'decrease_speed', 'set_preset_mode',
        'oscillate', 'set_direction']),
    automation: ON_OFF.concat(['trigger']),
    humidifier: ON_OFF.concat(['set_humidity', 'set_mode']),
    scene: ['turn_on'],
    button: ['press'],
    input_button: ['press'],
    number: ['set_value'],
    input_number: ['set_value', 'increment', 'decrement'],
    counter: ['increment', 'decrement', 'reset', 'set_value'],
    select: SELECT,
    input_select: SELECT,
    text: ['set_value'],
    input_text: ['set_value'],
    input_datetime: ['set_datetime'],
    climate: ON_OFF.concat(['set_temperature', 'set_hvac_mode', 'set_preset_mode', 'set_fan_mode',
        'set_humidity', 'set_swing_mode']),
    water_heater: ['turn_on', 'turn_off', 'set_temperature', 'set_operation_mode', 'set_away_mode'],
    cover: ['open_cover', 'close_cover', 'stop_cover', 'toggle', 'set_cover_position', 'open_cover_tilt',
        'close_cover_tilt', 'stop_cover_tilt', 'set_cover_tilt_position', 'toggle_cover_tilt'],
    valve: ['open_valve', 'close_valve', 'stop_valve', 'toggle', 'set_valve_position'],
    lock: ['lock'],
    alarm_control_panel: ['alarm_arm_home', 'alarm_arm_away', 'alarm_arm_night', 'alarm_arm_vacation',
        'alarm_arm_custom_bypass'],
    media_player: ON_OFF.concat(['media_play', 'media_pause', 'media_play_pause', 'media_stop',
        'media_next_track', 'media_previous_track', 'media_seek', 'volume_set', 'volume_up',
        'volume_down', 'volume_mute', 'select_source', 'select_sound_mode', 'shuffle_set', 'repeat_set']),
    vacuum: ['start', 'pause', 'stop', 'return_to_base', 'locate', 'clean_spot', 'set_fan_speed'],
    lawn_mower: ['start_mowing', 'pause', 'dock']
};

//! Cover services that can open one
var COVER_OPENING = ['open_cover', 'toggle', 'set_cover_position'];

//! Covers that let people in. Opening one goes through `open`, which asks.
var GUARDED_COVERS = { garage: true, gate: true, door: true };

function isGuarded(entity) {
    return entities.domainOf(entity.entity_id) === 'cover' &&
        GUARDED_COVERS[(entity.attributes || {}).device_class] === true;
}

/**
 * The phone does not yet ask the wearer before an action marked
 * requiresConfirmation, so the actions that let people in stay off until
 * the wearer turns on "Apps Can Unlock" in the watch app.
 */
function needsUnlockPermission(name, entity) {
    if (name === 'unlock' || name === 'alarm_disarm') { return true; }
    return name === 'open' && (entities.domainOf(entity.entity_id) === 'lock' || isGuarded(entity));
}

function mustAsk(entity) {
    return new PluginError('PERMISSION_DENIED',
        entities.nameOf(entity) + ' only opens with the open action, which asks first');
}

/**
 * The supported_features bits the actions below depend on. Home Assistant
 * answers 500 when an entity is asked for something it cannot do, which
 * would look like an outage, so they are checked first.
 */
var FEATURE = {
    cover: { open: 1, close: 2, set_position: 4, stop: 8 },
    valve: { open: 1, close: 2, set_position: 4, stop: 8 },
    lock: { open: 1 },
    climate: { target_temperature: 1, target_temperature_range: 2 },
    water_heater: { target_temperature: 1 },
    media_player: { pause: 1, volume_set: 4, previous_track: 16, next_track: 32, play: 16384 }
};

//! Whether the entity can do `feature`. One that does not say is given the benefit of the doubt.
function supports(entity, feature) {
    var bits = (FEATURE[entities.domainOf(entity.entity_id)] || {})[feature];
    var features = (entity.attributes || {}).supported_features;
    if (bits === undefined || typeof features !== 'number') { return true; }
    return (features & bits) !== 0;
}

function requireFeature(entity, feature, what) {
    if (!supports(entity, feature)) {
        throw invalid(entities.nameOf(entity) + ' cannot ' + what);
    }
}

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
            if (args.on && isGuarded(entity)) { throw mustAsk(entity); }
            return { domain: domain, service: (args.on ? 'open_' : 'close_') + domain,
                text: (args.on ? 'Opening ' : 'Closing ') + name + '.' };
        }
        if (domain === 'scene' || domain === 'script') {
            if (!args.on) {
                // A scene has nothing to stop
                if (domain === 'scene') { throw invalid(name + ' cannot be turned off'); }
                return { domain: domain, service: 'turn_off', text: 'Stopped ' + name + '.' };
            }
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
                if (isGuarded(entity)) {
                    if (entity.state !== 'open' && entity.state !== 'opening') { throw mustAsk(entity); }
                    return { domain: domain, service: 'close_cover', text: 'Closing ' + name + '.' };
                }
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
        var modes = (entity.attributes || {}).supported_color_modes;
        if (Array.isArray(modes) && modes.length === 1 && modes[0] === 'onoff') {
            throw invalid(entities.nameOf(entity) + ' cannot be dimmed');
        }
        var percent = percentArg(args, 'percent');
        if (percent === 0) {
            return { domain: 'light', service: 'turn_off', text: 'Turned off ' + entities.nameOf(entity) + '.' };
        }
        return { domain: 'light', service: 'turn_on', data: { brightness_pct: percent },
            text: 'Set ' + entities.nameOf(entity) + ' to ' + percent + '%.' };
    },

    set_temperature: function(entity, args) {
        var domain = requireDomain(entity, ['climate', 'water_heater'], 'set a temperature');
        var name = entities.nameOf(entity);
        var low = Number(args.target_temp_low);
        var high = Number(args.target_temp_high);
        var hasRange = args.target_temp_low !== undefined && args.target_temp_high !== undefined;
        // A thermostat keeping a range (heat_cool) takes a low and a high instead
        if (hasRange || !supports(entity, 'target_temperature')) {
            if (!supports(entity, 'target_temperature_range')) {
                throw invalid(name + ' cannot ' + (hasRange ? 'keep a range' : 'take a target temperature'));
            }
            if (!hasRange || !isFinite(low) || !isFinite(high) || low > high) {
                throw invalid(name + ' keeps a range: give target_temp_low and target_temp_high');
            }
            return { domain: domain, service: 'set_temperature',
                data: { target_temp_low: low, target_temp_high: high },
                text: 'Set ' + name + ' to ' + low + '-' + high + '°.' };
        }
        var value = Number(args.temperature);
        if (args.temperature === undefined || args.temperature === null || !isFinite(value)) {
            throw invalid('temperature must be a number');
        }
        return { domain: domain, service: 'set_temperature', data: { temperature: value },
            text: 'Set ' + name + ' to ' + value + '°.' };
    },

    set_hvac_mode: function(entity, args) {
        requireDomain(entity, ['climate'], 'change its mode');
        if (typeof args.hvac_mode !== 'string' || !args.hvac_mode) { throw invalid('hvac_mode is required'); }
        return { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: args.hvac_mode },
            text: 'Set ' + entities.nameOf(entity) + ' to ' + args.hvac_mode + '.' };
    },

    set_position: function(entity, args) {
        var domain = requireDomain(entity, ['cover', 'valve'], 'set a position');
        requireFeature(entity, 'set_position', 'move to a position');
        var position = percentArg(args, 'position');
        if (position > 0 && isGuarded(entity)) { throw mustAsk(entity); }
        return { domain: domain, service: domain === 'cover' ? 'set_cover_position' : 'set_valve_position',
            data: { position: position }, text: 'Moving ' + entities.nameOf(entity) + ' to ' + position + '%.' };
    },

    open: function(entity, args) {
        var domain = requireDomain(entity, ['cover', 'valve', 'lock'], 'open');
        requireFeature(entity, 'open', 'open');
        // Only locks take a code; covers and valves refuse one
        var service = domain === 'lock' ? 'open' : 'open_' + domain;
        return { domain: domain, service: service, data: domain === 'lock' ? withCode({}, args) : {},
            text: 'Opening ' + entities.nameOf(entity) + '.' };
    },

    close: function(entity) {
        var domain = requireDomain(entity, ['cover', 'valve'], 'close');
        requireFeature(entity, 'close', 'close');
        return { domain: domain, service: 'close_' + domain,
            text: 'Closing ' + entities.nameOf(entity) + '.' };
    },

    stop: function(entity) {
        var domain = requireDomain(entity, ['cover', 'valve'], 'stop');
        requireFeature(entity, 'stop', 'stop');
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
        requireFeature(entity, args.playing ? 'play' : 'pause', args.playing ? 'play' : 'pause');
        return { domain: 'media_player', service: args.playing ? 'media_play' : 'media_pause',
            text: (args.playing ? 'Playing ' : 'Paused ') + entities.nameOf(entity) + '.' };
    },

    next_track: function(entity) {
        requireDomain(entity, ['media_player'], 'skip');
        requireFeature(entity, 'next_track', 'skip to the next track');
        return { domain: 'media_player', service: 'media_next_track', text: 'Next track.' };
    },

    previous_track: function(entity) {
        requireDomain(entity, ['media_player'], 'skip back');
        requireFeature(entity, 'previous_track', 'go back a track');
        return { domain: 'media_player', service: 'media_previous_track', text: 'Previous track.' };
    },

    set_volume: function(entity, args) {
        requireDomain(entity, ['media_player'], 'change volume');
        requireFeature(entity, 'volume_set', 'set its volume');
        var percent = percentArg(args, 'percent');
        return { domain: 'media_player', service: 'volume_set', data: { volume_level: percent / 100 },
            text: 'Volume ' + percent + '%.' };
    },

    /**
     * The rest of what the entity's own domain offers: numbers, selects,
     * vacuums, and whatever has no action of its own here (see CALLABLE).
     * Always on the named entity, never another.
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
        if ((CALLABLE[domain] || []).indexOf(args.service) === -1) {
            throw new PluginError('PERMISSION_DENIED', domain + '.' + args.service + ' cannot be called by other apps');
        }
        if (COVER_OPENING.indexOf(args.service) !== -1 && isGuarded(entity)) {
            throw mustAsk(entity);
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
    // Home Assistant reads "a.b,c.d" as two entities, so only one well-formed id gets through
    if (typeof id !== 'string' || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(id)) {
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
        if (needsUnlockPermission(name, entity) && opts.plugin_allow_unlock !== true) {
            throw new PluginError('PERMISSION_DENIED',
                'Unlocking and opening from other apps is turned off in the watch app\'s settings');
        }
        var call = ENTITY_ACTIONS[name](entity, args);
        var data = call.data || {};
        data.entity_id = entity.entity_id;
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
            refreshed: entities.ITEMS.map(function(item) { return 'home/' + item; })
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
