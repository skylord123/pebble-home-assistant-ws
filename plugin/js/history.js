/**
 * The last day of a number, for a graph: `history` on numeric instances, a
 * series of one value an hour in the same shape as the weather's hourly
 * series. Each value is the hour's average, weighted by how long each state
 * held, so a sensor that sat still all hour still has its value there.
 * States that are not numbers (unavailable, unknown) count for nothing, and
 * an hour with only those is null.
 *
 * A sensor with a `state_class` has long-term statistics, which already hold
 * each hour's average: a few numbers an hour, however often it changes. They
 * only come over the WebSocket, in one command for all of them. Any other
 * sensor's day of state changes comes over REST, which for one that changes
 * every second is tens of thousands of them, so only a few are asked for at
 * a time.
 *
 * Only built for a caller that names `history` in its properties: a caller
 * that names none (Index reads everything) would otherwise pay for a history
 * call on every read.
 */
var ha = require('ha');
var ws = require('ws');
var store = require('store');
var entities = require('entities');

var HOUR_S = 3600;
var HOUR_MS = HOUR_S * 1000;
//! One a hour for a day, the last one the hour under way
var POINTS = 24;
var HISTORY_TTL_MS = 5 * 60 * 1000;
//! Not asked again for a while after a failure, which every poll would repeat
var FAILED_TTL_MS = 5 * 60 * 1000;
//! Sensors without statistics whose state changes are fetched in one poll;
//! the rest wait for the next
var RAW_MAX_IDS = 5;

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

/**
 * The time-weighted average of each hour from startS up to now, in one pass
 * over the changes
 */
function buckets(points, startS, now) {
    var first = startS * 1000;
    var last = first + (POINTS - 1) * HOUR_MS;
    var sums = [];
    var held = [];
    for (var i = 0; i < POINTS; i++) {
        sums.push(0);
        held.push(0);
    }
    //! The state as the hour under way began
    var current = null;
    for (var k = 0; k < points.length; k++) {
        var value = points[k].value;
        if (points[k].at <= last) { current = value; }
        if (value === null) { continue; }
        var begins = Math.max(points[k].at, first);
        var ends = Math.min(k + 1 < points.length ? points[k + 1].at : now, now);
        while (begins < ends) {
            var hour = Math.floor((begins - first) / HOUR_MS);
            var part = Math.min(ends, first + (hour + 1) * HOUR_MS) - begins;
            sums[hour] += value * part;
            held[hour] += part;
            begins += part;
        }
    }
    var values = [];
    for (var h = 0; h < POINTS; h++) {
        if (held[h] > 0) {
            values.push(entities.roundValue(sums[h] / held[h]));
        } else if (h === POINTS - 1 && now <= last) {
            // The hour has only just begun: what it is now
            values.push(current !== null ? entities.roundValue(current) : null);
        } else {
            values.push(null);
        }
    }
    return values;
}

/**
 * Hourly means from the recorder's statistics into `fetched`, for those of
 * `ids` that have them. Statistics only cover finished hours, so the hour
 * under way is the value now.
 */
function fromStatistics(conn, ids, current, startS, now, fetched) {
    if (ids.length === 0) { return Promise.resolve(); }
    // Counted as failed until it answers, so a request the phone ends at
    // 20 seconds is not tried again on the next poll either
    store.remember('statistics_failed', true);
    return ws.run(conn, {
        type: 'recorder/statistics_during_period',
        start_time: new Date(startS * 1000).toISOString(),
        end_time: new Date(now).toISOString(),
        statistic_ids: ids,
        period: 'hour',
        types: ['mean']
    }, function(msg, settle) {
        if (msg.type === 'result') { settle(msg.result || {}); }
    }, true).then(function(result) {
        store.set('statistics_failed', null);
        ids.forEach(function(id) {
            var rows = result[id];
            if (!Array.isArray(rows) || rows.length === 0) { return; }
            var values = [];
            for (var i = 0; i < POINTS; i++) { values.push(null); }
            rows.forEach(function(row) {
                // Milliseconds since 2023.3, text before
                var at = typeof row.start === 'number' ? row.start : Date.parse(row.start);
                var hour = Math.round((at / 1000 - startS) / HOUR_S);
                if (hour >= 0 && hour < POINTS - 1 && typeof row.mean === 'number') {
                    values[hour] = entities.roundValue(row.mean);
                }
            });
            values[POINTS - 1] = entities.roundValue(current[id]);
            fetched[id] = values;
        });
    }, function() {});
}

/** The hours from the state changes of `ids` into `fetched`, in one REST call */
function fromHistory(conn, ids, startS, now, fetched) {
    if (ids.length === 0) { return Promise.resolve(); }
    store.remember('history_failed', true);
    var path = '/api/history/period/' + encodeURIComponent(new Date(startS * 1000).toISOString()) +
        '?filter_entity_id=' + ids.map(encodeURIComponent).join(',') +
        '&end_time=' + encodeURIComponent(new Date(now).toISOString()) +
        '&minimal_response&no_attributes';
    return ha.request(conn, 'GET', path).then(function(lists) {
        store.set('history_failed', null);
        (Array.isArray(lists) ? lists : []).forEach(function(list) {
            var id = Array.isArray(list) && list[0] && list[0].entity_id;
            if (id && ids.indexOf(id) !== -1) {
                fetched[id] = buckets(changes(id, list), startS, now);
            }
        });
        // An entity with no history in the window has none to show
        ids.forEach(function(id) {
            if (!fetched[id]) { fetched[id] = buckets([], startS, now); }
        });
    }, function() {});
}

/**
 * The hourly values of each of `ids` over the last day, kept a few minutes:
 * from the statistics for those in `current` (entity_id -> the value now,
 * for the sensors that have a state_class), then from the state changes for
 * the rest. A history Home Assistant cannot give leaves those out rather
 * than failing the source.
 * @returns {Promise<Object>} { start, values: entity_id -> numbers or nulls }
 */
function hourly(conn, ids, current) {
    var now = Date.now();
    var startS = startOf(now);
    var cached = store.get('history');
    var reuse = !!(cached && cached.start === startS && now - cached.at < HISTORY_TTL_MS && cached.values);
    var byId = reuse ? cached.values : {};
    var missing = ids.filter(function(id) { return !byId[id]; });
    if (missing.length === 0) { return Promise.resolve({ start: startS, values: byId }); }

    var fetched = {};
    var measured = store.fresh('statistics_failed', FAILED_TTL_MS) ? [] :
        missing.filter(function(id) { return id in current; });
    return fromStatistics(conn, measured, current, startS, now, fetched).then(function() {
        // Those without statistics, a few at a time
        var raw = store.fresh('history_failed', FAILED_TTL_MS) ? [] :
            missing.filter(function(id) { return !fetched[id]; }).slice(0, RAW_MAX_IDS);
        return fromHistory(conn, raw, startS, now, fetched);
    }).then(function() {
        var added = Object.keys(fetched);
        if (added.length === 0) { return { start: startS, values: byId }; }
        added.forEach(function(id) { byId[id] = fetched[id]; });
        // Added to what was kept, which goes stale as it would have anyway
        store.set('history', { at: reuse ? cached.at : now, start: startS, values: byId });
        return { start: startS, values: byId };
    });
}

/**
 * Add `history` to the instances whose value is a number, as a series with
 * that value's unit and range.
 * @param {string} property the instance's numeric property: `value` or `state`
 * @param {Object} states entity_id -> state, for the state_class
 */
function attach(conn, instances, property, states) {
    var numeric = instances.filter(function(instance) {
        var prop = instance.properties[property];
        return prop && prop.numericValue;
    });
    if (numeric.length === 0) { return Promise.resolve(instances); }
    var latest = {};
    numeric.forEach(function(instance) {
        var state = states && states[instance.instanceId];
        if (state && state.attributes && state.attributes.state_class) {
            latest[instance.instanceId] = instance.properties[property].numericValue.value;
        }
    });
    return hourly(conn, numeric.map(function(i) { return i.instanceId; }), latest).then(function(found) {
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
