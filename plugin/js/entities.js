/**
 * How Home Assistant entities look to other apps.
 *
 * Every shared entity is an instance of `home/entity`, the one place a picker
 * can find everything. Entities also appear under an item for their kind
 * (`home/light`, `home/sensor`, ...) with typed properties, so a gauge gets a
 * number with a range and a toggle gets a boolean. Lights use the Hue demo's
 * property names, so a face written for Hue lights shows these as well.
 *
 * An instance's id is its entity_id and its `name` is the friendly name.
 */

//! Which item each Home Assistant domain is served under
var ITEM_BY_DOMAIN = {
    light: 'light',
    switch: 'switch',
    input_boolean: 'switch',
    fan: 'switch',
    automation: 'switch',
    siren: 'switch',
    humidifier: 'switch',
    remote: 'switch',
    sensor: 'sensor',
    number: 'sensor',
    input_number: 'sensor',
    counter: 'sensor',
    binary_sensor: 'binary_sensor',
    climate: 'climate',
    water_heater: 'climate',
    cover: 'cover',
    valve: 'cover',
    lock: 'lock',
    media_player: 'media_player',
    person: 'person',
    device_tracker: 'person',
    scene: 'scene',
    script: 'scene',
    button: 'scene',
    input_button: 'scene',
    alarm_control_panel: 'alarm'
};

var ITEMS = ['entity', 'light', 'switch', 'sensor', 'binary_sensor', 'climate', 'cover',
    'lock', 'media_player', 'person', 'scene', 'alarm'];

//! What binary sensors of each class read as, on and off
var BINARY_TEXT = {
    door: ['Open', 'Closed'],
    garage_door: ['Open', 'Closed'],
    window: ['Open', 'Closed'],
    opening: ['Open', 'Closed'],
    motion: ['Detected', 'Clear'],
    occupancy: ['Detected', 'Clear'],
    presence: ['Home', 'Away'],
    moisture: ['Wet', 'Dry'],
    smoke: ['Detected', 'Clear'],
    gas: ['Detected', 'Clear'],
    lock: ['Unlocked', 'Locked'],
    battery: ['Low', 'Normal'],
    connectivity: ['Connected', 'Disconnected'],
    plug: ['Plugged in', 'Unplugged'],
    power: ['On', 'Off'],
    problem: ['Problem', 'OK']
};

//! Sensor classes whose values are percentages, which a gauge can fill against
var PERCENT_CLASSES = { battery: true, humidity: true, moisture: true };

// ---- Shapes ------------------------------------------------------------------

function shortText(text) { return { text: String(text) }; }
function longText(text) { return { text: String(text) }; }
function numeric(value, unit, min, max) {
    var shape = { value: value };
    if (unit) { shape.unit = unit; }
    if (typeof min === 'number') { shape.min = min; }
    if (typeof max === 'number') { shape.max = max; }
    return shape;
}
function bool(value) { return { value: !!value }; }
function timestamp(iso) {
    var ms = Date.parse(iso);
    return isNaN(ms) ? null : { value: Math.floor(ms / 1000) };
}

// ---- Reading an entity --------------------------------------------------------

function domainOf(entityId) {
    return entityId.split('.')[0];
}

function itemFor(entityId) {
    return ITEM_BY_DOMAIN[domainOf(entityId)] || null;
}

function nameOf(entity) {
    var attrs = entity.attributes || {};
    return attrs.friendly_name ? String(attrs.friendly_name) : entity.entity_id;
}

function isUnavailable(entity) {
    return entity.state === 'unavailable' || entity.state === 'unknown';
}

function humanize(state) {
    var text = String(state).replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function roundValue(value) {
    return Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
}

function withUnit(value, unit) {
    if (!unit) { return String(value); }
    return value + (/^[°%]/.test(unit) ? '' : ' ') + unit;
}

function numericState(entity) {
    if (isUnavailable(entity)) { return null; }
    // Strictly a number: timestamps and versions start with digits too
    var text = String(entity.state).trim();
    return /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text) ? Number(text) : null;
}

/** Whether the entity is on, in whatever sense its kind has one, or null */
function isOn(entity) {
    if (isUnavailable(entity)) { return null; }
    switch (domainOf(entity.entity_id)) {
        case 'cover':
        case 'valve':
            return entity.state === 'open' || entity.state === 'opening';
        case 'lock':
            return entity.state === 'locked';
        case 'media_player':
            return entity.state === 'playing';
        case 'person':
        case 'device_tracker':
            return entity.state === 'home';
        case 'alarm_control_panel':
            return entity.state !== 'disarmed';
        case 'climate':
        case 'water_heater':
            return entity.state !== 'off';
    }
    if (entity.state === 'on') { return true; }
    if (entity.state === 'off') { return false; }
    return null;
}

/** The state the way the watch app shows it */
function stateText(entity) {
    var attrs = entity.attributes || {};
    if (entity.state === 'unavailable') { return 'Unavailable'; }
    if (entity.state === 'unknown') { return 'Unknown'; }

    switch (domainOf(entity.entity_id)) {
        case 'binary_sensor': {
            var pair = BINARY_TEXT[attrs.device_class];
            if (pair) { return entity.state === 'on' ? pair[0] : pair[1]; }
            return entity.state === 'on' ? 'On' : 'Off';
        }
        case 'climate':
            return climateSummary(entity);
        case 'person':
        case 'device_tracker':
            return entity.state === 'home' ? 'Home'
                : entity.state === 'not_home' ? 'Away' : humanize(entity.state);
        case 'light':
            if (entity.state === 'on' && typeof attrs.brightness === 'number') {
                return Math.round(attrs.brightness * 100 / 255) + '%';
            }
            break;
        case 'media_player':
            if (entity.state === 'playing' && attrs.media_title) {
                return String(attrs.media_title);
            }
            break;
        // Their state is when they last ran, which reads badly as text; the
        // time itself is in last_changed
        case 'scene':
            return 'Scene';
        case 'button':
        case 'input_button':
            return 'Button';
        case 'event':
            return attrs.event_type ? humanize(String(attrs.event_type)) : 'Event';
    }

    var value = numericState(entity);
    if (value !== null && attrs.device_class !== 'timestamp') {
        return withUnit(roundValue(value), attrs.unit_of_measurement);
    }
    return humanize(entity.state);
}

//! "Heat 21°/19.5°": the mode, then what it is set to and what it reads
function climateSummary(entity) {
    var attrs = entity.attributes || {};
    var text = humanize(entity.state);
    var target = null;
    if (typeof attrs.temperature === 'number') {
        target = attrs.temperature + '°';
    } else if (typeof attrs.target_temp_low === 'number' && typeof attrs.target_temp_high === 'number') {
        target = attrs.target_temp_low + '-' + attrs.target_temp_high + '°';
    }
    var current = typeof attrs.current_temperature === 'number' ? attrs.current_temperature + '°' : null;
    if (target && current) { return text + ' ' + target + '/' + current; }
    if (target || current) { return text + ' ' + (target || current); }
    return text;
}

function valueShapes(entity) {
    var attrs = entity.attributes || {};
    var shapes = {};
    var text = stateText(entity);
    shapes.shortText = shortText(text);
    shapes.longText = longText(text);

    if (attrs.device_class === 'timestamp') {
        var ts = timestamp(entity.state);
        if (ts) { shapes.timestamp = ts; }
        return shapes;
    }

    var value = numericState(entity);
    if (value !== null) {
        var min, max;
        if (PERCENT_CLASSES[attrs.device_class] || attrs.unit_of_measurement === '%') {
            min = 0; max = 100;
        } else if (typeof attrs.min === 'number' && typeof attrs.max === 'number') {
            min = attrs.min; max = attrs.max;
        }
        shapes.numericValue = numeric(value, attrs.unit_of_measurement, min, max);
    }
    return shapes;
}

// ---- Properties per item ---------------------------------------------------------

function common(entity) {
    var props = { name: { shortText: shortText(nameOf(entity)), longText: longText(nameOf(entity)) } };
    var changed = timestamp(entity.last_changed);
    if (changed) { props.last_changed = { timestamp: changed }; }
    var updated = timestamp(entity.last_updated);
    if (updated) { props.last_updated = { timestamp: updated }; }
    return props;
}

function onProperty(entity, onText, offText) {
    var on = isOn(entity);
    if (on === null) {
        return { shortText: shortText(stateText(entity)) };
    }
    return { boolean: bool(on), shortText: shortText(on ? (onText || 'On') : (offText || 'Off')) };
}

function percentProperty(value) {
    var rounded = Math.round(value);
    return {
        numericValue: numeric(rounded, '%', 0, 100),
        shortText: shortText(rounded + '%')
    };
}

function temperatureProperty(value, unit) {
    return {
        numericValue: numeric(value, unit || '°'),
        shortText: shortText(value + '°')
    };
}

var BUILDERS = {
    entity: function(entity, props) {
        props.state = valueShapes(entity);
        var on = isOn(entity);
        if (on !== null) { props.on = { boolean: bool(on) }; }
        props.domain = { shortText: shortText(domainOf(entity.entity_id)) };
    },

    light: function(entity, props) {
        var attrs = entity.attributes || {};
        props.on = onProperty(entity);
        var bri = entity.state === 'on' && typeof attrs.brightness === 'number'
            ? attrs.brightness * 100 / 255 : 0;
        props.brightness = percentProperty(bri);
        if (typeof attrs.color_temp_kelvin === 'number') {
            props.color_temp = {
                numericValue: numeric(attrs.color_temp_kelvin, 'K',
                    attrs.min_color_temp_kelvin, attrs.max_color_temp_kelvin),
                shortText: shortText(attrs.color_temp_kelvin + 'K')
            };
        }
    },

    switch: function(entity, props) {
        var attrs = entity.attributes || {};
        props.on = onProperty(entity);
        if (typeof attrs.percentage === 'number') {
            props.speed = percentProperty(attrs.percentage);
        }
    },

    sensor: function(entity, props) {
        var attrs = entity.attributes || {};
        props.value = valueShapes(entity);
        if (attrs.device_class) {
            props.device_class = { shortText: shortText(attrs.device_class) };
        }
    },

    binary_sensor: function(entity, props) {
        var attrs = entity.attributes || {};
        var pair = BINARY_TEXT[attrs.device_class] || ['On', 'Off'];
        props.on = onProperty(entity, pair[0], pair[1]);
        props.state = { shortText: shortText(stateText(entity)), longText: longText(stateText(entity)) };
        if (attrs.device_class) {
            props.device_class = { shortText: shortText(attrs.device_class) };
        }
    },

    climate: function(entity, props) {
        var attrs = entity.attributes || {};
        var unit = attrs.temperature_unit;
        if (typeof attrs.current_temperature === 'number') {
            props.current_temperature = temperatureProperty(attrs.current_temperature, unit);
        }
        if (typeof attrs.temperature === 'number') {
            var target = temperatureProperty(attrs.temperature, unit);
            if (typeof attrs.min_temp === 'number') { target.numericValue.min = attrs.min_temp; }
            if (typeof attrs.max_temp === 'number') { target.numericValue.max = attrs.max_temp; }
            props.target_temperature = target;
        }
        props.on = onProperty(entity);
        props.hvac_mode = { shortText: shortText(humanize(entity.state)) };
        if (attrs.hvac_action) {
            props.hvac_action = { shortText: shortText(humanize(attrs.hvac_action)) };
        }
        props.summary = { shortText: shortText(climateSummary(entity)), longText: longText(climateSummary(entity)) };
    },

    cover: function(entity, props) {
        var attrs = entity.attributes || {};
        props.open = onProperty(entity, 'Open', 'Closed');
        props.state = { shortText: shortText(humanize(entity.state)) };
        var position = typeof attrs.current_position === 'number' ? attrs.current_position
            : (typeof attrs.current_valve_position === 'number' ? attrs.current_valve_position : null);
        if (position !== null) {
            props.position = percentProperty(position);
        }
    },

    lock: function(entity, props) {
        props.locked = onProperty(entity, 'Locked', 'Unlocked');
        props.state = { shortText: shortText(humanize(entity.state)) };
    },

    media_player: function(entity, props) {
        var attrs = entity.attributes || {};
        props.on = onProperty(entity, 'Playing', 'Paused');
        props.playing = { boolean: bool(entity.state === 'playing') };
        props.state = { shortText: shortText(humanize(entity.state)) };
        if (attrs.media_title) {
            props.title = { shortText: shortText(attrs.media_title), longText: longText(attrs.media_title) };
        }
        if (attrs.media_artist) {
            props.artist = { shortText: shortText(attrs.media_artist), longText: longText(attrs.media_artist) };
        }
        if (typeof attrs.volume_level === 'number') {
            props.volume = percentProperty(attrs.volume_level * 100);
        }
    },

    person: function(entity, props) {
        props.home = onProperty(entity, 'Home', 'Away');
        var zone = stateText(entity);
        props.zone = { shortText: shortText(zone), longText: longText(zone) };
        var since = timestamp(entity.last_changed);
        if (since) { props.since = { timestamp: since }; }
        // Coordinates never leave: a zone says enough, and any app can read this
    },

    scene: function(entity, props) {
        var domain = domainOf(entity.entity_id);
        if (domain === 'script') {
            props.running = { boolean: bool(entity.state === 'on') };
        }
        // Scenes and buttons keep the time they were last used as their state
        var ran = timestamp(domain === 'script'
            ? (entity.attributes || {}).last_triggered : entity.state);
        if (ran) { props.last_run = { timestamp: ran }; }
    },

    alarm: function(entity, props) {
        props.armed = onProperty(entity, 'Armed', 'Disarmed');
        var text = humanize(entity.state);
        props.state = { shortText: shortText(text), longText: longText(text) };
    }
};

/**
 * One instance for the given item. `home/entity` takes every entity; the
 * others only their own kinds.
 */
function toInstance(item, entity) {
    var build = BUILDERS[item];
    if (!build) { return null; }
    if (item !== 'entity' && itemFor(entity.entity_id) !== item) { return null; }
    var props = common(entity);
    build(entity, props);
    return { instanceId: entity.entity_id, properties: props };
}

module.exports = {
    ITEMS: ITEMS,
    domainOf: domainOf,
    itemFor: itemFor,
    nameOf: nameOf,
    isOn: isOn,
    stateText: stateText,
    toInstance: toInstance,
    shapes: {
        shortText: shortText,
        longText: longText,
        numeric: numeric,
        bool: bool,
        timestamp: timestamp
    },
    humanize: humanize
};
