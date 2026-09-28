/**
 * Home Assistant weather under the same names and shapes as the phone's own
 * weather source (`weather/location`, `weather/hour`), so a watchface built
 * for that shows Home Assistant's weather when it asks for this plugin.
 *
 * The phone's own weather is registered first, so a face that asks for
 * `weather/location` without naming a plugin still gets the phone's. Asking
 * with `plugin: <this app's uuid>` gets this one.
 *
 * Instances are weather entities (id = entity_id). Icons and images are not
 * drawn; `condition_code` names the condition in the phone's own vocabulary,
 * for a face to draw its own art from.
 */
var ha = require('ha');
var store = require('store');
var entities = require('entities');

var S = entities.shapes;

//! Forecasts change slowly and cost a service call each, so they are kept a while
var FORECAST_TTL_MS = 15 * 60 * 1000;
//! As many hours ahead as the phone's own source gives
var MAX_HOURS = 6;

//! Home Assistant's conditions in the phone's icon vocabulary
var CODE_BY_CONDITION = {
    'sunny': 'sun',
    'clear-night': 'sun',
    'partlycloudy': 'partly_cloudy',
    'windy-variant': 'partly_cloudy',
    'cloudy': 'cloudy',
    'fog': 'cloudy',
    'windy': 'cloudy',
    'exceptional': 'unknown',
    'rainy': 'light_rain',
    'pouring': 'heavy_rain',
    'lightning': 'heavy_rain',
    'lightning-rainy': 'heavy_rain',
    'hail': 'heavy_rain',
    'snowy': 'light_snow',
    'snowy-rainy': 'rain_and_snow'
};

var LABEL_BY_CONDITION = {
    'sunny': 'Sunny',
    'clear-night': 'Clear',
    'partlycloudy': 'Partly cloudy',
    'windy-variant': 'Windy',
    'cloudy': 'Cloudy',
    'fog': 'Fog',
    'windy': 'Windy',
    'exceptional': 'Exceptional',
    'rainy': 'Rain',
    'pouring': 'Heavy rain',
    'lightning': 'Thunderstorm',
    'lightning-rainy': 'Thunderstorm',
    'hail': 'Hail',
    'snowy': 'Snow',
    'snowy-rainy': 'Sleet'
};

function conditionCode(condition) {
    return CODE_BY_CONDITION[condition] || 'unknown';
}

function conditionLabel(condition) {
    return LABEL_BY_CONDITION[condition] || entities.humanize(condition || 'unknown');
}

function temperatureShapes(value, unit) {
    var rounded = Math.round(value);
    return {
        shortText: S.shortText(rounded + unit),
        longText: S.longText(rounded + unit),
        numericValue: S.numeric(value, unit)
    };
}

//! weather's supported_features bits for each forecast type
var FORECAST_FEATURE = { daily: 1, hourly: 2, twice_daily: 4 };

/**
 * The forecast type to ask an entity for: `wanted` if it has it, twice-daily
 * in place of daily (the US National Weather Service has no daily one), or
 * null. An entity that does not say what it has is asked for `wanted`.
 */
function forecastTypeFor(entity, wanted) {
    var features = (entity.attributes || {}).supported_features;
    if (typeof features !== 'number') { return wanted; }
    if (features & FORECAST_FEATURE[wanted]) { return wanted; }
    if (wanted === 'daily' && (features & FORECAST_FEATURE.twice_daily)) { return 'twice_daily'; }
    return null;
}

/**
 * Forecasts of one kind ('daily' or 'hourly') for these entities, from
 * weather.get_forecasts, asked one entity at a time: Home Assistant fails the
 * whole call if any one entity lacks the type. An entity without it, or an
 * older Home Assistant, gets an empty list, which is kept like any other
 * answer so it is not asked again every time.
 * @returns {Promise<Object>} entity_id -> forecast list
 */
function forecasts(conn, states, ids, kind) {
    var key = 'forecast_' + kind;
    var entries = store.get(key) || {};
    var now = Date.now();
    var out = {};
    var missing = [];
    ids.forEach(function(id) {
        var entry = entries[id];
        if (entry && typeof entry.at === 'number' && Array.isArray(entry.list) &&
            now - entry.at < FORECAST_TTL_MS) {
            out[id] = entry.list;
        } else {
            missing.push(id);
        }
    });
    if (missing.length === 0) {
        return Promise.resolve(out);
    }

    return Promise.all(missing.map(function(id) {
        var type = forecastTypeFor(states[id], kind);
        if (!type) { return Promise.resolve([]); }
        return ha.callServiceForResponse(conn, 'weather', 'get_forecasts', { entity_id: id, type: type })
            .then(function(response) {
                var entry = response[id];
                var list = (entry && Array.isArray(entry.forecast)) ? entry.forecast : [];
                // Twice-daily alternates day and night; the day halves stand in for days
                return type === 'twice_daily'
                    ? list.filter(function(part) { return part.is_daytime !== false; })
                    : list;
            }, function(err) {
                if (err && err.code === 'AUTH_REQUIRED') { throw err; }
                return [];
            });
    })).then(function(lists) {
        var stamp = Date.now();
        missing.forEach(function(id, index) {
            out[id] = lists[index];
            entries[id] = { at: stamp, list: lists[index] };
        });
        store.set(key, entries);
        return out;
    });
}

function unitOf(entity) {
    var unit = (entity.attributes || {}).temperature_unit;
    return unit ? String(unit) : '°';
}

function locationInstance(entity, today) {
    var attrs = entity.attributes || {};
    var unit = unitOf(entity);
    var props = {
        name: { shortText: S.shortText(entities.nameOf(entity)) }
    };

    if (typeof attrs.temperature === 'number') {
        props.temperature = temperatureShapes(attrs.temperature, unit);
        var feels = typeof attrs.apparent_temperature === 'number'
            ? attrs.apparent_temperature : attrs.temperature;
        props.feels_like = temperatureShapes(feels, unit);
    }
    if (today && typeof today.temperature === 'number') {
        props.high = temperatureShapes(today.temperature, unit);
    }
    if (today && typeof today.templow === 'number') {
        props.low = temperatureShapes(today.templow, unit);
    }

    props.condition = {
        shortText: S.shortText(conditionLabel(entity.state)),
        longText: S.longText(conditionLabel(entity.state))
    };
    props.condition_code = { longText: S.longText(conditionCode(entity.state)) };

    var uv = typeof attrs.uv_index === 'number' ? attrs.uv_index
        : (today && typeof today.uv_index === 'number' ? today.uv_index : null);
    if (uv !== null) {
        props.uv_index = {
            numericValue: S.numeric(uv, null, 0, 11),
            shortText: S.shortText(String(Math.round(uv)))
        };
    }
    if (today && typeof today.precipitation_probability === 'number') {
        var percent = today.precipitation_probability;
        props.precipitation = {
            numericValue: S.numeric(percent, '%', 0, 100),
            shortText: S.shortText(Math.round(percent) + '%')
        };
    }

    var changed = S.timestamp(entity.last_changed);
    if (changed) { props.last_changed = { timestamp: changed }; }
    return { instanceId: entity.entity_id, properties: props };
}

/** `weather/location`: one instance per weather entity */
function location(conn, ids) {
    return ha.getStates(conn, ids).then(function(states) {
        var present = ids.filter(function(id) { return states[id]; });
        return forecasts(conn, states, present, 'daily').then(function(daily) {
            return present.map(function(id) {
                var list = daily[id] || [];
                return locationInstance(states[id], list[0] || null);
            });
        });
    });
}

/**
 * `weather/hour`: the next few hours for the first weather entity, the way
 * the phone's source gives them for its first location. Hours have no id of
 * their own, so an instance is its position.
 */
function hours(conn, ids) {
    var id = ids.indexOf('weather.home') !== -1 ? 'weather.home' : ids[0];
    if (!id) { return Promise.resolve([]); }
    return ha.getStates(conn, [id]).then(function(states) {
        var entity = states[id];
        if (!entity) { return []; }
        var unit = unitOf(entity);
        return forecasts(conn, states, [id], 'hourly').then(function(hourly) {
            var now = Date.now();
            var ahead = (hourly[id] || []).filter(function(hour) {
                return Date.parse(hour.datetime) > now;
            }).slice(0, MAX_HOURS);
            return ahead.map(function(hour, index) {
                var props = {
                    condition: { shortText: S.shortText(conditionLabel(hour.condition)) },
                    condition_code: { longText: S.longText(conditionCode(hour.condition)) }
                };
                if (typeof hour.temperature === 'number') {
                    props.temperature = {
                        numericValue: S.numeric(hour.temperature, unit),
                        shortText: S.shortText(Math.round(hour.temperature) + unit)
                    };
                }
                var time = S.timestamp(hour.datetime);
                if (time) { props.time = { timestamp: time }; }
                return { instanceId: String(index), properties: props };
            });
        });
    });
}

module.exports = {
    location: location,
    hours: hours,
    conditionCode: conditionCode
};
