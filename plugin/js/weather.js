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

//! The phone's own setting for how temperatures are shown
var UNITS = { category: 'preferences', item: 'units' };

//! '°C' or '°F' as the wearer has chosen, for this request; null if the
//! phone did not say
var wearerUnit = null;
//! The wearer's wind speed unit, for this request
var wearerWind = null;

//! Metres a second in one of each of Home Assistant's wind speed units
var WIND_MS = { 'm/s': 1, 'km/h': 1 / 3.6, 'mph': 0.44704, 'kn': 0.514444, 'knots': 0.514444, 'ft/s': 0.3048 };

/**
 * The wearer's units, from the phone's preferences. Subscribing has the
 * phone run this source again when the wearer changes them.
 */
function readWearerUnits() {
    if (typeof Pebble.readSource !== 'function') { return Promise.resolve({}); }
    if (typeof Pebble.subscribeSource === 'function') { Pebble.subscribeSource(UNITS); }
    return Pebble.readSource(UNITS).then(function(envelope) {
        var props = (envelope && envelope.instances && envelope.instances[0] &&
            envelope.instances[0].properties) || {};
        function text(name) {
            return props[name] && props[name].shortText && props[name].shortText.text;
        }
        var temperature = text('temperature');
        var wind = text('wind_speed');
        return {
            temperature: temperature === '°C' || temperature === '°F' ? temperature : null,
            wind: WIND_MS[wind] ? wind : null
        };
    }).catch(function() { return {}; });
}

/**
 * A temperature as the wearer reads it. The number itself stays in Home
 * Assistant's unit, which `numericValue` names; only the text follows the
 * wearer's choice.
 */
function temperatureText(value, unit) {
    var shown = unit;
    if (wearerUnit && unit !== wearerUnit && (unit === '°C' || unit === '°F')) {
        value = wearerUnit === '°F' ? value * 9 / 5 + 32 : (value - 32) * 5 / 9;
        shown = wearerUnit;
    }
    return Math.round(value) + shown;
}

function temperatureShapes(value, unit) {
    var text = temperatureText(value, unit);
    return {
        shortText: S.shortText(text),
        longText: S.longText(text),
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
 * Twice-daily forecasts (the US National Weather Service) alternate day and
 * night. Each day half stands in for its day, and the night after it gives
 * that day's low, which the day half itself never has.
 */
function daysFromHalves(list) {
    var days = [];
    list.forEach(function(part, index) {
        if (part.is_daytime === false) { return; }
        var day = {};
        Object.keys(part).forEach(function(key) { day[key] = part[key]; });
        var night = list[index + 1];
        if (typeof day.templow !== 'number' && night && night.is_daytime === false &&
            typeof night.temperature === 'number') {
            day.templow = night.temperature;
        }
        days.push(day);
    });
    return days;
}

/**
 * Forecasts of one kind ('daily' or 'hourly') for these entities, from
 * weather.get_forecasts, asked one entity at a time: Home Assistant fails the
 * whole call if any one entity lacks the type. An entity without it, or an
 * older Home Assistant, gets an empty list, which is kept like any other
 * answer so it is not asked again every time. A call that failed for any
 * other reason keeps the last list it had, and is asked again next time.
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
                return type === 'twice_daily' ? daysFromHalves(list) : list;
            }, function(err) {
                if (err && err.code === 'AUTH_REQUIRED') { throw err; }
                // Home Assistant said no to the type itself
                if (err && err.code === 'INVALID_ARGS') { return []; }
                return null;
            });
    })).then(function(lists) {
        var stamp = Date.now();
        missing.forEach(function(id, index) {
            if (lists[index] === null) {
                var stale = entries[id];
                out[id] = (stale && Array.isArray(stale.list)) ? stale.list : [];
                return;
            }
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
        shortText: { values: values.map(function(v) { return v === null ? null : temperatureText(v, unit); }) }
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

/**
 * Wind speed in a unit the phone knows (m/s, km/h, mph or knots), with the
 * text in the wearer's unit, or km/h when the phone did not say
 */
function windShapes(attrs) {
    var speed = attrs.wind_speed;
    var factor = WIND_MS[attrs.wind_speed_unit];
    if (typeof speed !== 'number' || !factor) { return null; }
    var unit = attrs.wind_speed_unit === 'kn' ? 'knots' : attrs.wind_speed_unit;
    var value = speed;
    if (unit === 'ft/s') {
        value = speed * factor;
        unit = 'm/s';
    }
    var shown = wearerWind || 'km/h';
    return {
        numericValue: S.numeric(value, unit),
        shortText: S.shortText(Math.round(speed * factor / WIND_MS[shown]) + ' ' + shown)
    };
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

    if (typeof attrs.humidity === 'number') {
        props.humidity = {
            numericValue: S.numeric(attrs.humidity, '%', 0, 100),
            shortText: S.shortText(Math.round(attrs.humidity) + '%')
        };
    }
    var wind = windShapes(attrs);
    if (wind) { props.wind_speed = wind; }
    if (typeof attrs.wind_bearing === 'number') {
        props.wind_direction = { numericValue: S.numeric(attrs.wind_bearing, '°', 0, 360) };
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
        var names = request && request.properties;
        if (!Array.isArray(names) || names.indexOf(name) !== -1) { props[name] = extra[name]; }
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
    return readWearerUnits().then(function(units) {
        wearerUnit = units.temperature || null;
        wearerWind = units.wind || null;
        return ha.getStates(conn, ids);
    }).then(function(states) {
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
