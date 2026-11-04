/**
 * Home Assistant weather under the same names and shapes as the phone's own
 * weather source (`weather/location`, with its hours and days as series), so
 * a watchface built for that shows Home Assistant's weather when it asks for
 * this plugin.
 *
 * The phone's own weather is asked first, so a face that asks for
 * `weather/location` without naming a plugin gets the phone's unless the
 * wearer picked this app under Preferred sources. Asking with
 * `plugin: <this app's uuid>` gets this one.
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
//! As far ahead as the phone's own source goes: two days of hours, a week of days
var MAX_HOURS = 48;
var MAX_DAYS = 7;
var HOUR_S = 3600;
var DAY_S = 86400;

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

/**
 * Whether the caller wants any property starting with one of `prefixes`. A
 * caller that names no properties wants them all.
 */
function wants(request, prefixes) {
    var names = request && request.properties;
    if (!Array.isArray(names)) { return true; }
    return names.some(function(name) {
        return prefixes.some(function(prefix) { return String(name).indexOf(prefix) === 0; });
    });
}

function localMidnight(ms) {
    var day = new Date(ms);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
}

/**
 * Forecast entries laid out on a grid of `count` slots `stepS` apart from
 * `startS`: a slot nothing falls in stays null, as the phone's series expect.
 * `slotOf` says which slot an entry's time belongs in.
 */
function slots(list, count, slotOf) {
    var out = [];
    for (var i = 0; i < count; i++) { out.push(null); }
    list.forEach(function(entry) {
        var at = Date.parse(entry.datetime);
        if (isNaN(at)) { return; }
        var slot = slotOf(at, entry.datetime);
        if (slot >= 0 && slot < count && out[slot] === null) { out[slot] = entry; }
    });
    return out;
}

function lastFilled(list) {
    for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] !== null) { return list.slice(0, i + 1); }
    }
    return [];
}

function series(startS, stepS, shapes) {
    shapes.start = startS;
    shapes.stepSec = stepS;
    return { series: shapes };
}

function pluck(list, key) {
    return list.map(function(entry) {
        return entry && typeof entry[key] === 'number' ? entry[key] : null;
    });
}

function temperatureSeries(startS, stepS, values, unit) {
    return series(startS, stepS, {
        numericValue: { values: values, unit: unit },
        shortText: { values: values.map(function(v) { return v === null ? null : Math.round(v) + unit; }) }
    });
}

function conditionSeries(startS, stepS, list) {
    var conditions = list.map(function(entry) { return entry && entry.condition ? entry.condition : null; });
    return {
        text: series(startS, stepS, {
            shortText: { values: conditions.map(function(c) { return c === null ? null : conditionLabel(c); }) },
            longText: { values: conditions.map(function(c) { return c === null ? null : conditionLabel(c); }) }
        }),
        code: series(startS, stepS, {
            longText: { values: conditions.map(function(c) { return c === null ? null : conditionCode(c); }) }
        })
    };
}

/**
 * `hourly_*`: today's and tomorrow's hours from local midnight, as the
 * phone's own source gives them. Home Assistant only forecasts from now on,
 * so the hours already gone are null.
 */
function hourlySeries(hourly, unit) {
    var startS = Math.floor(localMidnight(Date.now()) / 1000);
    var hours = lastFilled(slots(hourly, MAX_HOURS, function(at) {
        return Math.round((at / 1000 - startS) / HOUR_S);
    }));
    if (hours.length === 0) { return {}; }
    var condition = conditionSeries(startS, HOUR_S, hours);
    return {
        hourly_temperature: temperatureSeries(startS, HOUR_S, pluck(hours, 'temperature'), unit),
        hourly_condition: condition.text,
        hourly_condition_code: condition.code
    };
}

/**
 * `daily_*`: from today's local midnight, one value a day.
 */
function dailySeries(days, unit, midnight) {
    if (days.length === 0) { return {}; }
    var startS = Math.floor(midnight / 1000);
    var condition = conditionSeries(startS, DAY_S, days);
    var chances = pluck(days, 'precipitation_probability');
    return {
        daily_high: temperatureSeries(startS, DAY_S, pluck(days, 'temperature'), unit),
        daily_low: temperatureSeries(startS, DAY_S, pluck(days, 'templow'), unit),
        daily_condition: condition.text,
        daily_condition_code: condition.code,
        daily_precipitation: series(startS, DAY_S, {
            numericValue: { values: chances, unit: '%', min: 0, max: 100 },
            shortText: { values: chances.map(function(v) { return v === null ? null : Math.round(v) + '%'; }) }
        })
    };
}

/**
 * Each daily forecast in the day it is for. That is the date written in its
 * timestamp, not the day the instant falls on here: Open-Meteo stamps a day
 * at midnight UTC, which in the Americas is the evening before.
 */
function daySlots(daily) {
    var now = new Date();
    var today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return lastFilled(slots(daily, MAX_DAYS, function(at, iso) {
        var date = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
        if (!date) { return -1; }
        var day = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
        return Math.round((day - today) / (DAY_S * 1000));
    }));
}

function locationInstance(entity, days, hourly, request) {
    var attrs = entity.attributes || {};
    var unit = unitOf(entity);
    var today = days ? days[0] : null;
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

    // Series are only built for a caller that asked for them, as the
    // phone's own source does
    var extra = {};
    if (days && wants(request, ['daily_'])) {
        extra = dailySeries(days, unit, localMidnight(Date.now()));
    }
    if (hourly && wants(request, ['hourly_'])) {
        var hours = hourlySeries(hourly, unit);
        Object.keys(hours).forEach(function(name) { extra[name] = hours[name]; });
    }
    Object.keys(extra).forEach(function(name) {
        if (wants(request, [name])) { props[name] = extra[name]; }
    });

    return { instanceId: entity.entity_id, properties: props };
}

/**
 * `weather/location`: one instance per weather entity. Forecasts cost a
 * service call per entity, so each kind is only fetched when something the
 * caller asked for comes from it.
 */
function location(conn, ids, request) {
    var needDaily = wants(request, ['high', 'low', 'uv_index', 'precipitation', 'daily_']);
    var needHourly = wants(request, ['hourly_']);
    return ha.getStates(conn, ids).then(function(states) {
        var present = ids.filter(function(id) { return states[id]; });
        return Promise.all([
            needDaily ? forecasts(conn, states, present, 'daily') : Promise.resolve({}),
            needHourly ? forecasts(conn, states, present, 'hourly') : Promise.resolve({})
        ]).then(function(results) {
            return present.map(function(id) {
                var days = needDaily ? daySlots(results[0][id] || []) : null;
                var hourly = needHourly ? (results[1][id] || []) : null;
                return locationInstance(states[id], days, hourly, request);
            });
        });
    });
}

module.exports = {
    location: location,
    conditionCode: conditionCode
};
