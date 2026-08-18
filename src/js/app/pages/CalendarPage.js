/**
 * CalendarPage - Home Assistant calendar browsing
 *
 * Features:
 * - Calendar list built from calendar.* entities, with an "All" option that
 *   aggregates every calendar when more than one exists
 * - Event list grouped into one section per day, from today into the future
 * - Event detail card
 * - Timeline pin launch: a pin's launchCode is matched against upcoming
 *   events so the app can jump straight to the event's detail page
 *
 * Events are fetched with the calendar.get_events service over the websocket
 * (call_service with return_response), which returns events keyed by calendar
 * entity so a single round trip covers the aggregated view.
 */
var UI = require('ui');
var AppState = require('app/AppState');
var TimelineLaunch = require('app/TimelineLaunch');
var helpers = require('app/helpers');

// How far into the future events are listed
var EVENT_WINDOW_DAYS = 30;

// Event descriptions are cut to this many characters in list subtitles
var DESCRIPTION_PREVIEW_LENGTH = 100;

var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Get calendar entities as [{entity_id, name}]. The default order matches
 * Home Assistant (the order calendars appear in get_states); when the user
 * saved a custom order on the config page that order is used instead.
 * Calendars hidden on the config page are excluded unless includeHidden is
 * set (used for timeline pin matching, which must see every calendar).
 */
function getCalendars(includeHidden) {
    var appState = AppState.getInstance();
    var calendars = [];
    var seen = {};

    function addCalendar(entity) {
        if (seen[entity.entity_id]) { return; }
        seen[entity.entity_id] = true;
        calendars.push({
            entity_id: entity.entity_id,
            name: entity.attributes && entity.attributes.friendly_name
                ? entity.attributes.friendly_name
                : entity.entity_id.substring(9)
        });
    }

    // ha_state_cache is the raw get_states array, which preserves Home
    // Assistant's order; the dict is only a fallback when it is unavailable
    var stateList = appState.ha_state_cache || [];
    for (var i = 0; i < stateList.length; i++) {
        if (stateList[i].entity_id.indexOf('calendar.') === 0) {
            addCalendar(stateList[i]);
        }
    }
    for (var entity_id in appState.ha_state_dict) {
        if (entity_id.indexOf('calendar.') === 0) {
            addCalendar(appState.ha_state_dict[entity_id]);
        }
    }

    // Apply the user's custom order from the config page when set; calendars
    // added since the order was saved keep their default position at the end
    var order = appState.calendar_order;
    if (order && order.length) {
        var position = {};
        for (var j = 0; j < calendars.length; j++) {
            var savedIndex = order.indexOf(calendars[j].entity_id);
            position[calendars[j].entity_id] = savedIndex === -1 ? order.length + j : savedIndex;
        }
        calendars.sort(function(a, b) {
            return position[a.entity_id] - position[b.entity_id];
        });
    }

    if (!includeHidden && appState.hidden_calendars && appState.hidden_calendars.length) {
        calendars = calendars.filter(function(calendar) {
            return appState.hidden_calendars.indexOf(calendar.entity_id) === -1;
        });
    }

    return calendars;
}

/**
 * Format a Date as an ISO 8601 string with the local UTC offset, which
 * Home Assistant parses unambiguously for start_date_time/end_date_time
 */
function toLocalISO(date) {
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var offsetMin = -date.getTimezoneOffset();
    var sign = offsetMin >= 0 ? '+' : '-';
    var absMin = Math.abs(offsetMin);
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
        sign + pad(Math.floor(absMin / 60)) + ':' + pad(absMin % 60);
}

/**
 * Whether an event start/end value is a date-only string (all-day event)
 */
function isDateOnly(value) {
    return typeof value === 'string' && value.indexOf('T') === -1;
}

/**
 * Parse an event start/end value into a local Date. Date-only strings are
 * parsed manually because `new Date('YYYY-MM-DD')` would treat them as UTC
 * midnight and could land on the wrong local day.
 */
function parseEventDate(value) {
    if (isDateOnly(value)) {
        var parts = value.split('-');
        return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
    return new Date(value);
}

/**
 * Format a Date's time like "2:00PM"
 */
function formatTime(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return hours + ':' + (minutes < 10 ? '0' : '') + minutes + ampm;
}

/**
 * Format a Date like "Aug 18"
 */
function formatMonthDay(date) {
    return MONTH_NAMES[date.getMonth()] + ' ' + date.getDate();
}

/**
 * Local day key like "2026-08-18" for grouping events into day sections
 */
function dayKey(date) {
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/**
 * Section title for a day: "Today", "Tomorrow", or "Mon, Aug 24"
 */
function dayLabel(date) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var diffDays = Math.round((date.getTime() - today.getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    return DAY_NAMES[date.getDay()] + ', ' + formatMonthDay(date);
}

/**
 * Time label for an event: "All Day", "2:00PM to 2:30PM", or
 * "2:00PM to Aug 20 1:00PM" when the event ends on a different day
 */
function eventTimeLabel(event) {
    if (isDateOnly(event.start)) {
        return 'All Day';
    }
    var start = parseEventDate(event.start);
    var end = event.end ? parseEventDate(event.end) : null;
    if (!end) {
        return formatTime(start);
    }
    if (dayKey(start) === dayKey(end)) {
        return formatTime(start) + ' to ' + formatTime(end);
    }
    return formatTime(start) + ' to ' + formatMonthDay(end) + ' ' + formatTime(end);
}

/**
 * One-line description preview cut at DESCRIPTION_PREVIEW_LENGTH characters
 */
function descriptionPreview(description) {
    if (!description) {
        return '';
    }
    var text = String(description).replace(/\s+/g, ' ').trim();
    if (text.length > DESCRIPTION_PREVIEW_LENGTH) {
        text = text.substring(0, DESCRIPTION_PREVIEW_LENGTH) + '...';
    }
    return text;
}

/**
 * Timeline pin launch code for a calendar event: the calendar-event action
 * type in the top byte, and the low 24 bits of the FNV-1a hash of
 * "<entity_id>|<start>|<summary>" as the payload. The companion app must
 * build the same code from the same calendar.get_events fields when creating
 * a pin so the watch app can find the event the pin refers to:
 *
 *   launchCode = (1 << 24) | (fnv1a32(entity_id + '|' + start + '|' + summary) & 0xFFFFFF)
 */
function eventLaunchCode(entity_id, event) {
    var str = entity_id + '|' + event.start + '|' + (event.summary || '');
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        // hash *= 16777619 without Math.imul (kept 32-bit via shifts)
        hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) +
                (hash << 8) + (hash << 24)) >>> 0;
    }
    return TimelineLaunch.makeLaunchCode(TimelineLaunch.ACTION_CALENDAR_EVENT, hash);
}

/**
 * Fetch events for the given calendar entity ids between two Dates.
 * Calls back with a merged, sorted array of events, each annotated with
 * calendar_entity_id and calendar_name.
 */
function fetchEvents(entityIds, startDate, endDate, successCallback, errorCallback) {
    var appState = AppState.getInstance();
    var calendars = getCalendars(true);
    var namesById = {};
    for (var i = 0; i < calendars.length; i++) {
        namesById[calendars[i].entity_id] = calendars[i].name;
    }

    appState.haws.send({
        type: 'call_service',
        domain: 'calendar',
        service: 'get_events',
        target: { entity_id: entityIds },
        service_data: {
            start_date_time: toLocalISO(startDate),
            end_date_time: toLocalISO(endDate)
        },
        return_response: true
    }, function(data) {
        var response = (data.result && data.result.response) || {};
        var events = [];
        for (var entity_id in response) {
            var entityEvents = response[entity_id] && response[entity_id].events;
            if (!entityEvents) { continue; }
            for (var j = 0; j < entityEvents.length; j++) {
                var event = entityEvents[j];
                event.calendar_entity_id = entity_id;
                event.calendar_name = namesById[entity_id] || entity_id;
                events.push(event);
            }
        }
        // ISO strings sort chronologically, and date-only (all day) strings
        // sort before datetimes on the same day
        events.sort(function(a, b) {
            return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
        });
        successCallback(events);
    }, function(error) {
        helpers.log_message('fetchEvents error: ' + JSON.stringify(error));
        if (errorCallback) { errorCallback(error); }
    });
}

/**
 * Show the calendar list. With more than one calendar an "All" option is
 * added at the top that aggregates every calendar into one event list.
 */
function showCalendarList() {
    var calendars = getCalendars();

    if (calendars.length === 0) {
        var noCalendarsCard = new UI.Card({
            title: 'Calendars',
            body: 'No calendars found in Home Assistant.',
            scrollable: false
        });
        noCalendarsCard.show();
        return;
    }

    var calendarMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Calendars'
        }]
    });

    var menuItems = [];

    if (calendars.length > 1) {
        menuItems.push({
            title: 'All',
            subtitle: 'Events from all calendars',
            on_click: function(e) {
                showCalendarEvents('All Calendars', calendars.map(function(c) {
                    return c.entity_id;
                }));
            }
        });
    }

    calendars.forEach(function(calendar) {
        menuItems.push({
            title: calendar.name,
            on_click: function(e) {
                showCalendarEvents(calendar.name, [calendar.entity_id]);
            }
        });
    });

    calendarMenu.items(0, menuItems);

    calendarMenu.on('select', function(e) {
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    calendarMenu.show();
}

/**
 * Show upcoming events for one or more calendars, grouped into one menu
 * section per day starting from today
 */
function showCalendarEvents(title, entityIds) {
    var eventsMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: title + ' - updating ...'
        }]
    });

    function renderEvents(events) {
        if (events.length === 0) {
            eventsMenu.section(0, { title: title });
            eventsMenu.items(0, [{
                title: 'No upcoming events',
                subtitle: 'Next ' + EVENT_WINDOW_DAYS + ' days'
            }]);
            return;
        }

        // Group events into one section per local day. Events already in
        // progress are grouped under today rather than their past start day.
        var today = new Date();
        today.setHours(0, 0, 0, 0);
        var sections = [];
        var sectionsByDay = {};

        events.forEach(function(event) {
            var start = parseEventDate(event.start);
            var day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
            if (day.getTime() < today.getTime()) {
                day = today;
            }
            var key = dayKey(day);
            var section = sectionsByDay[key];
            if (!section) {
                section = { day: day, items: [] };
                sectionsByDay[key] = section;
                sections.push(section);
            }

            var subtitle = eventTimeLabel(event);
            var preview = descriptionPreview(event.description);
            if (preview) {
                subtitle += ' - ' + preview;
            }

            section.items.push({
                title: event.summary || '(No title)',
                subtitle: subtitle,
                on_click: (function(ev) {
                    return function() {
                        showCalendarEventDetail(ev);
                    };
                })(event)
            });
        });

        for (var i = 0; i < sections.length; i++) {
            eventsMenu.section(i, { title: dayLabel(sections[i].day) });
            eventsMenu.items(i, sections[i].items);
        }
    }

    eventsMenu.on('show', function() {
        var start = new Date();
        start.setHours(0, 0, 0, 0);
        var end = new Date(start.getTime());
        end.setDate(end.getDate() + EVENT_WINDOW_DAYS);

        fetchEvents(entityIds, start, end, function(events) {
            renderEvents(events);
        }, function(error) {
            eventsMenu.section(0, { title: title });
            eventsMenu.items(0, [{
                title: 'Failed to load',
                subtitle: 'Check connection and try again'
            }]);
        });
    });

    eventsMenu.on('select', function(e) {
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    eventsMenu.show();
}

/**
 * Show the full details of a calendar event on a scrollable card
 */
function showCalendarEventDetail(event) {
    var start = parseEventDate(event.start);

    var lines = [];
    lines.push(dayLabel(new Date(start.getFullYear(), start.getMonth(), start.getDate())));
    lines.push(eventTimeLabel(event));
    if (event.calendar_name) {
        lines.push('Calendar: ' + event.calendar_name);
    }
    if (event.location) {
        lines.push('Location: ' + event.location);
    }
    if (event.description) {
        lines.push('');
        lines.push(String(event.description).trim());
    }

    var detailCard = new UI.Card({
        title: event.summary || '(No title)',
        body: lines.join('\n'),
        scrollable: true,
        style: 'small'
    });

    detailCard.show();
}

/**
 * Open the event a timeline pin refers to. The pin's launchCode is matched
 * against the launch code hash of every upcoming event across all calendars;
 * on a match the event detail page opens, otherwise the calendar list is
 * shown as a fallback.
 */
function showCalendarEventByLaunchCode(launchCode) {
    // Include hidden calendars: a pin may reference an event on a calendar
    // the user chose not to browse on the watch
    var calendars = getCalendars(true);
    if (calendars.length === 0) {
        helpers.log_message('Timeline launch: no calendars available');
        return;
    }

    // Include yesterday so pins for events already in progress still resolve
    var start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 1);
    var end = new Date(start.getTime());
    end.setDate(end.getDate() + EVENT_WINDOW_DAYS + 1);

    var entityIds = calendars.map(function(c) { return c.entity_id; });

    fetchEvents(entityIds, start, end, function(events) {
        for (var i = 0; i < events.length; i++) {
            if (eventLaunchCode(events[i].calendar_entity_id, events[i]) === launchCode) {
                helpers.log_message('Timeline launch: matched event ' + events[i].summary);
                showCalendarEventDetail(events[i]);
                return;
            }
        }
        helpers.log_message('Timeline launch: no event matched launch code ' + launchCode);
        showCalendarList();
    }, function(error) {
        helpers.log_message('Timeline launch: failed to fetch events');
    });
}

module.exports.showCalendarList = showCalendarList;
module.exports.showCalendarEvents = showCalendarEvents;
module.exports.showCalendarEventDetail = showCalendarEventDetail;
module.exports.showCalendarEventByLaunchCode = showCalendarEventByLaunchCode;
module.exports.eventLaunchCode = eventLaunchCode;
