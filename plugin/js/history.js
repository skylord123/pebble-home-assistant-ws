/**
 * The last day of a number, for a graph: `history` on numeric instances, a
 * series of one value an hour in the same shape as the weather's hourly
 * series. Each value is the hour's average, weighted by how long each state
 * held, so a sensor that sat still all hour still has its value there.
 * States that are not numbers (unavailable, unknown) count for nothing, and
 * an hour with only those is null.
 *
 * Only built for a caller that names `history` in its properties: a caller
 * that names none (Index reads everything) would otherwise pay for a history
 * call on every read.
 */
var ha = require('ha');
var store = require('store');
var entities = require('entities');

var HOUR_S = 3600;
//! One a hour for a day, the last one the hour under way
var POINTS = 24;
var HISTORY_TTL_MS = 5 * 60 * 1000;

function wanted(request) {
    var names = request && request.properties;
    return Array.isArray(names) && names.indexOf('history') !== -1;
}

//! Where the series starts: the hour POINTS - 1 hours before this one
function startOf(now) {
    return Math.floor(now / 1000 / HOUR_S) * HOUR_S - (POINTS - 1) * HOUR_S;
}

/** Home Assistant's state changes as [{ at: ms, value: number or null }], oldest first */
function changes(id, list) {
    var out = [];
    list.forEach(function(entry) {
        var at = Date.parse(entry.last_changed || entry.last_updated);
        if (isNaN(at)) { return; }
        out.push({ at: at, value: entities.numericState({ entity_id: id, state: entry.state }) });
    });
    out.sort(function(a, b) { return a.at - b.at; });
    return out;
}

/** The time-weighted average of each hour from startS up to now */
function buckets(points, startS, now) {
    var values = [];
    for (var i = 0; i < POINTS; i++) {
        var from = (startS + i * HOUR_S) * 1000;
        var to = Math.min(from + HOUR_S * 1000, now);
        var sum = 0;
        var held = 0;
        for (var k = 0; k < points.length; k++) {
            if (points[k].value === null) { continue; }
            var begins = Math.max(points[k].at, from);
            var ends = Math.min(k + 1 < points.length ? points[k + 1].at : now, to);
            if (ends > begins) {
                sum += points[k].value * (ends - begins);
                held += ends - begins;
            }
        }
        if (held === 0 && to <= from) {
            // The hour has only just begun: what it is now
            var current = points.filter(function(p) { return p.at <= from; }).pop();
            values.push(current && current.value !== null ? entities.roundValue(current.value) : null);
            continue;
        }
        values.push(held > 0 ? entities.roundValue(sum / held) : null);
    }
    return values;
}

/**
 * The hourly values of each of `ids` over the last day, from one history
 * call for all of them, kept a few minutes. A history Home Assistant cannot
 * give leaves them all out rather than failing the source.
 * @returns {Promise<Object>} { start, values: entity_id -> numbers or nulls }
 */
function hourly(conn, ids) {
    var now = Date.now();
    var startS = startOf(now);
    var cached = store.get('history');
    var reuse = !!(cached && cached.start === startS && now - cached.at < HISTORY_TTL_MS && cached.values);
    var byId = reuse ? cached.values : {};
    var missing = ids.filter(function(id) { return !byId[id]; });
    if (missing.length === 0) { return Promise.resolve({ start: startS, values: byId }); }

    var path = '/api/history/period/' + encodeURIComponent(new Date(startS * 1000).toISOString()) +
        '?filter_entity_id=' + missing.map(encodeURIComponent).join(',') +
        '&end_time=' + encodeURIComponent(new Date(now).toISOString()) +
        '&minimal_response&no_attributes';
    return ha.request(conn, 'GET', path).then(function(lists) {
        var fetched = {};
        (Array.isArray(lists) ? lists : []).forEach(function(list) {
            var id = Array.isArray(list) && list[0] && list[0].entity_id;
            if (id && missing.indexOf(id) !== -1) {
                fetched[id] = buckets(changes(id, list), startS, now);
            }
        });
        // An entity with no history in the window has none to show
        missing.forEach(function(id) {
            if (!fetched[id]) { fetched[id] = buckets([], startS, now); }
            byId[id] = fetched[id];
        });
        // Added to what was kept, which goes stale as it would have anyway
        store.set('history', { at: reuse ? cached.at : now, start: startS, values: byId });
        return { start: startS, values: byId };
    }, function() {
        return { start: startS, values: {} };
    });
}

/**
 * Add `history` to the instances whose value is a number, as a series with
 * that value's unit and range.
 * @param {string} property the instance's numeric property: `value` or `state`
 */
function attach(conn, instances, property) {
    var numeric = instances.filter(function(instance) {
        var prop = instance.properties[property];
        return prop && prop.numericValue;
    });
    if (numeric.length === 0) { return Promise.resolve(instances); }
    return hourly(conn, numeric.map(function(i) { return i.instanceId; })).then(function(found) {
        numeric.forEach(function(instance) {
            var values = found.values[instance.instanceId];
            if (!values || values.every(function(v) { return v === null; })) { return; }
            var current = instance.properties[property].numericValue;
            var shape = { values: values };
            if (current.unit) { shape.unit = current.unit; }
            if ('min' in current) {
                shape.min = current.min;
                shape.max = current.max;
            }
            instance.properties.history = { series: { start: found.start, stepSec: HOUR_S, numericValue: shape } };
        });
        return instances;
    });
}

module.exports = {
    wanted: wanted,
    attach: attach,
    POINTS: POINTS
};
