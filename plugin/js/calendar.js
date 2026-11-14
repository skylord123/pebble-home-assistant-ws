/**
 * Home Assistant calendars under the same names and shapes as the phone's
 * own calendar source (`calendar/event`), so a face or app built for that
 * shows the shared Home Assistant calendars when it asks for this plugin.
 *
 * As there, every instance is one upcoming event across the shared
 * calendars, soonest first, at most ten of them from the next seven days,
 * and its id is its place in that list: "0" is always the next event. An
 * event that has started but not ended still counts as upcoming.
 *
 * The phone's own calendar is asked first, so this one is only read by a
 * caller that names this plugin or a wearer who picked it under Preferred
 * sources.
 */
var ha = require('ha');
var store = require('store');
var entities = require('entities');

var S = entities.shapes;

//! The same as the phone's own source
var MAX_EVENTS = 10;
var WINDOW_MS = 7 * 24 * 3600 * 1000;
var ALL_DAY = 'All day';
//! Events are kept a few minutes per calendar; the source is polled every five
var EVENTS_TTL_MS = 5 * 60 * 1000;

/** The shared calendar entities, in the wearer's order */
function calendarIds(ids) {
    return ids.filter(function(id) { return entities.domainOf(id) === 'calendar'; });
}

/**
 * When an event starts or ends, in ms. A whole day ("2026-06-15") starts at
 * the phone's local midnight.
 */
function momentOf(when) {
    var text = when && typeof when === 'object' ? (when.dateTime || when.date) : when;
    if (typeof text !== 'string') { return null; }
    var day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (day) {
        return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    }
    var ms = Date.parse(text);
    return isNaN(ms) ? null : ms;
}

function isAllDay(when) {
    var text = when && typeof when === 'object' ? (when.dateTime || when.date) : when;
    return typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text);
}

/** Only what an instance is built from, to keep the cache small */
function compact(event) {
    var start = momentOf(event.start);
    var end = momentOf(event.end);
    if (start === null) { return null; }
    return {
        name: event.summary ? String(event.summary) : '',
        location: event.location ? String(event.location) : '',
        start: start,
        end: end === null ? start : end,
        allDay: isAllDay(event.start)
    };
}

/**
 * One calendar's events over the next week, reusing what was fetched in the
 * last few minutes. A calendar Home Assistant cannot read (its service is
 * down, say) has none, rather than taking the others down with it.
 */
function eventsOf(conn, id) {
    var cached = store.get('calendar_events') || {};
    var entry = cached[id];
    if (entry && typeof entry.at === 'number' && Date.now() - entry.at < EVENTS_TTL_MS) {
        return Promise.resolve(entry.events);
    }
    var now = Date.now();
    var path = '/api/calendars/' + encodeURIComponent(id) +
        '?start=' + encodeURIComponent(new Date(now).toISOString()) +
        '&end=' + encodeURIComponent(new Date(now + WINDOW_MS).toISOString());
    return ha.request(conn, 'GET', path).then(function(list) {
        var events = (Array.isArray(list) ? list : []).map(compact).filter(function(e) { return e; });
        var all = store.get('calendar_events') || {};
        // Calendars no longer shared are dropped along the way
        Object.keys(all).forEach(function(key) {
            if (Date.now() - all[key].at >= EVENTS_TTL_MS) { delete all[key]; }
        });
        all[id] = { at: Date.now(), events: events };
        store.set('calendar_events', all);
        return events;
    }, function(err) {
        if (err && (err.code === 'INVALID_ARGS' || err.code === 'UNKNOWN')) { return []; }
        throw err;
    });
}

function pad(n) {
    return (n < 10 ? '0' : '') + n;
}

//! "09:30" in the phone's own time zone, as the phone's own source writes it
function clockText(ms) {
    var at = new Date(ms);
    return pad(at.getHours()) + ':' + pad(at.getMinutes());
}

function textShapes(text) {
    return { shortText: S.shortText(text), longText: S.longText(text) };
}

function toInstance(index, event) {
    var props = { name: textShapes(event.name) };
    if (event.location.replace(/\s/g, '')) {
        props.location = textShapes(event.location);
    }
    var starts = textShapes(event.allDay ? ALL_DAY : clockText(event.start));
    starts.timestamp = { value: Math.floor(event.start / 1000) };
    props.starts_at = starts;
    props.ends_at = {
        shortText: S.shortText(event.allDay ? ALL_DAY : clockText(event.end)),
        timestamp: { value: Math.floor(event.end / 1000) }
    };
    props.all_day = { boolean: S.bool(event.allDay) };
    props.calendar = { shortText: S.shortText(event.calendar) };
    return { instanceId: String(index), properties: props };
}

/**
 * `calendar/event`: the next events across the shared calendars.
 * @param {string[]} shared the shared entity ids, in the wearer's order
 */
function upcoming(conn, shared) {
    var ids = calendarIds(shared);
    if (ids.length === 0) { return Promise.resolve([]); }
    return ha.getStates(conn, ids).then(function(states) {
        var present = ids.filter(function(id) { return states[id]; });
        return Promise.all(present.map(function(id) { return eventsOf(conn, id); })).then(function(lists) {
            var now = Date.now();
            var all = [];
            lists.forEach(function(events, c) {
                events.forEach(function(event, i) {
                    if (event.end <= now) { return; }
                    all.push({
                        name: event.name,
                        location: event.location,
                        start: event.start,
                        end: event.end,
                        allDay: event.allDay,
                        calendar: entities.nameOf(states[present[c]]),
                        order: c * 100000 + i
                    });
                });
            });
            // Soonest first; events starting together keep the wearer's
            // order of calendars, so the list does not shuffle between polls
            all.sort(function(a, b) { return a.start - b.start || a.order - b.order; });
            return all.slice(0, MAX_EVENTS).map(function(event, index) { return toInstance(index, event); });
        });
    });
}

module.exports = {
    upcoming: upcoming,
    calendarIds: calendarIds
};
