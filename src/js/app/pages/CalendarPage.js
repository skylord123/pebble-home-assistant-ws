/**
 * CalendarPage - Home Assistant calendar browsing
 *
 * Features:
 * - Calendar list built from calendar.* entities, with an "All" option that
 *   aggregates every calendar when more than one exists
 * - Event list grouped into one section per day, from today into the future
 * - Event detail page styled like a PebbleOS timeline pin, with edit and
 *   delete actions on an action bar when the calendar supports them
 * - Event editing: dictated title/description (on watches with a mic), an
 *   all-day toggle, and alarm-style start/end date pickers
 * - Timeline pin launch: a pin's launchCode is matched against upcoming
 *   events so the app can jump straight to the event's detail page
 *
 * Events are fetched with the calendar/event/subscribe websocket API (one
 * short-lived subscription per calendar), which unlike calendar.get_events
 * includes each event's uid and recurrence data needed for editing.
 */
var UI = require('ui');
var Vector = require('vector2');
var Feature = require('platform/feature');
var Vibe = require('ui/vibe');
var Voice = require('ui/voice');
var simply = require('ui/simply');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var TimelineLaunch = require('app/TimelineLaunch');
var DateTimeEditorPage = require('app/pages/DateTimeEditorPage');
var helpers = require('app/helpers');

// Width reserved by the action bar on the event detail page
var ACTION_BAR_WIDTH = 30;

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
 * Format a Date's time like "2:00PM", or "14:00" when the user asked for
 * 24 hour time
 */
function formatTime(date) {
    return helpers.formatTimeOfDay(date);
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
 * "<entity_id>|<startKey>|<summary>" as the payload, where startKey is the
 * plain "YYYY-MM-DD" string for all-day events and the epoch seconds of the
 * start time otherwise. Epoch seconds (not the raw string) because HA renders
 * the same instant with different UTC offsets depending on the API surface:
 * calendar.get_events serializes datetimes as-is while the REST API converts
 * them to server-local time first. The companion app must build the same code
 * when creating a pin so the watch app can find the event the pin refers to:
 *
 *   startKey   = allDay ? start : String(floor(Date.parse(start) / 1000))
 *   launchCode = (1 << 24) | (fnv1a32(entity_id + '|' + startKey + '|' + summary) & 0xFFFFFF)
 */
function eventLaunchCode(entity_id, event) {
    var start = event.start || '';
    var startKey = start;
    if (start.indexOf('T') !== -1) {
        var ms = Date.parse(start);
        if (!isNaN(ms)) {
            startKey = String(Math.floor(ms / 1000));
        }
    }
    var str = entity_id + '|' + startKey + '|' + (event.summary || '');
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
 * What event operations a calendar entity supports, from its
 * supported_features bitfield (CalendarEntityFeature: CREATE_EVENT=1,
 * DELETE_EVENT=2, UPDATE_EVENT=4)
 */
function getCalendarFeatures(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    var sf = (entity && entity.attributes && entity.attributes.supported_features) || 0;
    return {
        create: !!(sf & 1),
        remove: !!(sf & 2),
        update: !!(sf & 4)
    };
}

/**
 * Fetch events for the given calendar entity ids between two Dates using the
 * calendar/event/subscribe websocket API. Unlike the get_events service, the
 * subscription payload includes each event's uid (needed to edit or delete
 * it), plus recurrence information. Each subscription is closed again after
 * its initial push, so this behaves like a one-shot fetch.
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

    var pending = entityIds.length;
    var errored = 0;
    var allEvents = [];

    if (!pending) {
        successCallback([]);
        return;
    }

    function finishOne() {
        if (--pending > 0) { return; }
        if (errored === entityIds.length) {
            if (errorCallback) { errorCallback('all calendars failed'); }
            return;
        }
        // ISO strings sort chronologically, and date-only (all day) strings
        // sort before datetimes on the same day
        allEvents.sort(function(a, b) {
            return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
        });
        successCallback(allEvents);
    }

    entityIds.forEach(function(entity_id) {
        var done = false;
        var msg_id = appState.haws.subscribeTrigger({
            type: 'calendar/event/subscribe',
            entity_id: entity_id,
            start: toLocalISO(startDate),
            end: toLocalISO(endDate)
        }, function(data) {
            // The first response is the subscription ack; the initial event
            // push follows with the event list
            if (done || !data.event) { return; }
            done = true;
            appState.haws.unsubscribe(msg_id);
            var events = data.event.events || [];
            for (var j = 0; j < events.length; j++) {
                var event = events[j];
                event.calendar_entity_id = entity_id;
                event.calendar_name = namesById[entity_id] || entity_id;
                allEvents.push(event);
            }
            finishOne();
        }, function(error) {
            if (done) { return; }
            done = true;
            errored++;
            helpers.log_message('fetchEvents error for ' + entity_id + ': ' + JSON.stringify(error));
            appState.haws.unsubscribe(msg_id);
            finishOne();
        });
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
    // Creating an event needs voice dictation for its title, so the option
    // only exists on watches with a microphone, and only for calendars that
    // support event creation
    var createableIds = Feature.microphone(true, false)
        ? entityIds.filter(function(entity_id) {
            return getCalendarFeatures(entity_id).create;
        })
        : [];

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

    // In the aggregated view with several writable calendars, ask which
    // calendar the new event belongs to first
    function startCreateEvent() {
        if (createableIds.length === 1) {
            showCalendarEventCreate(createableIds[0]);
            return;
        }

        var pickerMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Add to calendar'
            }]
        });

        pickerMenu.items(0, getCalendars(true).filter(function(calendar) {
            return createableIds.indexOf(calendar.entity_id) !== -1;
        }).map(function(calendar) {
            return {
                title: calendar.name,
                on_click: function() {
                    showCalendarEventCreate(calendar.entity_id);
                    // Remove the picker from the stack so saving or backing
                    // out of the form returns to the event list
                    pickerMenu.hide();
                }
            };
        }));

        pickerMenu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        pickerMenu.show();
    }

    function renderEvents(events) {
        var firstDaySection = 0;
        if (createableIds.length) {
            eventsMenu.section(0, { title: title });
            eventsMenu.items(0, [{
                title: '+ Add Event',
                on_click: startCreateEvent
            }]);
            firstDaySection = 1;
        }

        if (events.length === 0) {
            eventsMenu.section(firstDaySection, { title: createableIds.length ? '' : title });
            eventsMenu.items(firstDaySection, [{
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
            eventsMenu.section(firstDaySection + i, { title: dayLabel(sections[i].day) });
            eventsMenu.items(firstDaySection + i, sections[i].items);
        }
    }

    // The native menu keeps the previously shown menu's selected index (the
    // row picked in the calendars list), which lands mid-list once the events
    // stream in; snap to the top after the first render. Every later show is a
    // return from an event detail, and the menu gets rebuilt both natively and
    // by the re-fetch below, so restore the row that was clicked once the
    // re-render is done. Relying on the menu's own remembered selection is not
    // enough because the native rebuild clamps it before the rows exist.
    var hasRendered = false;
    var restoreSelection = null;

    eventsMenu.on('show', function() {
        var start = new Date();
        start.setHours(0, 0, 0, 0);
        var end = new Date(start.getTime());
        end.setDate(end.getDate() + EVENT_WINDOW_DAYS);

        fetchEvents(entityIds, start, end, function(events) {
            renderEvents(events);
            if (restoreSelection) {
                eventsMenu.selection(restoreSelection.sectionIndex, restoreSelection.itemIndex);
            } else if (!hasRendered) {
                eventsMenu.selection(0, 0);
            }
            hasRendered = true;
        }, function(error) {
            eventsMenu.section(0, { title: title });
            eventsMenu.items(0, [{
                title: 'Failed to load',
                subtitle: 'Check connection and try again'
            }]);
        });
    });

    eventsMenu.on('select', function(e) {
        restoreSelection = { sectionIndex: e.sectionIndex, itemIndex: e.itemIndex };
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    eventsMenu.show();
}

/**
 * Show the full details of a calendar event on a scrollable window styled
 * like a PebbleOS timeline pin: a colored banner with the time and day, a
 * bold title, then the calendar, location, and description. When the
 * calendar supports it, an action bar offers edit (select) and delete
 * (down), matching the pin action layout.
 */
function showCalendarEventDetail(event) {
    var res = Feature.resolution();
    var features = getCalendarFeatures(event.calendar_entity_id);
    var canEdit = !!(features.update && event.uid);
    var canDelete = !!(features.remove && event.uid);

    // The action bar shows native scroll arrows (managed on the watch from
    // the live scroll position) and, when the calendar supports editing, the
    // pencil on select to open the edit menu. Up/down still scroll.
    var actionDef = {
        backgroundColor: 'black',
        scrollArrows: true
    };
    if (canEdit || canDelete) {
        actionDef.select = 'images/action_edit.png';
    }

    var contentWidth = res.x - (actionDef ? ACTION_BAR_WIDTH : 0);
    var MARGIN = 5;
    var textWidth = contentWidth - MARGIN * 2;

    var start = parseEventDate(event.start);
    var day = dayLabel(new Date(start.getFullYear(), start.getMonth(), start.getDate()));
    var timeLabel = eventTimeLabel(event);
    var title = event.summary || '(No title)';

    var metaParts = [];
    if (event.calendar_name) { metaParts.push(event.calendar_name); }
    if (event.location) { metaParts.push(event.location); }
    var meta = metaParts.join('\n');
    var description = event.description ? String(event.description).trim() : '';

    // Text heights are measured on the watch so the layout fits the content
    // exactly; measurements are sequential because the response slot is shared.
    // The measurement API expects hyphenated font keys (gothic-24-bold) while
    // stage text elements use underscores, hence the translation.
    function measure(text, font, callback) {
        if (!text) { callback(0); return; }
        simply.impl.calculateTextSize(text, font.replace(/_/g, '-'), textWidth, 'wrap', 'left', function(size) {
            callback(size.height);
        });
    }

    measure(title, 'gothic_24_bold', function(titleHeight) {
    measure(meta, 'gothic_14', function(metaHeight) {
    measure(description, 'gothic_18', function(descriptionHeight) {
        var detailWindow = new UI.Window({
            backgroundColor: 'white',
            scrollable: true,
            status: false,
            action: actionDef
        });

        // Banner styled like a timeline pin header
        var BANNER_HEIGHT = 40;
        detailWindow.add(new UI.Rect({
            position: new Vector(0, 0),
            size: new Vector(contentWidth, BANNER_HEIGHT),
            backgroundColor: Constants.colour.highlight
        }));
        detailWindow.add(new UI.Text({
            text: timeLabel,
            color: Constants.colour.highlight_text,
            font: 'gothic_18_bold',
            position: new Vector(MARGIN, 0),
            size: new Vector(textWidth, 20),
            textAlign: 'left',
            textOverflow: 'ellipsis'
        }));
        detailWindow.add(new UI.Text({
            text: day,
            color: Constants.colour.highlight_text,
            font: 'gothic_14',
            position: new Vector(MARGIN, 20),
            size: new Vector(textWidth, 16),
            textAlign: 'left',
            textOverflow: 'ellipsis'
        }));

        var y = BANNER_HEIGHT + 2;
        detailWindow.add(new UI.Text({
            text: title,
            color: 'black',
            font: 'gothic_24_bold',
            position: new Vector(MARGIN, y),
            size: new Vector(textWidth, titleHeight + 4),
            textOverflow: 'wrap',
            textAlign: 'left'
        }));
        y += titleHeight + 8;

        if (meta) {
            detailWindow.add(new UI.Text({
                text: meta,
                color: 'black',
                font: 'gothic_14',
                position: new Vector(MARGIN, y),
                size: new Vector(textWidth, metaHeight + 4),
                textOverflow: 'wrap',
                textAlign: 'left'
            }));
            y += metaHeight + 8;
        }

        if (description) {
            detailWindow.add(new UI.Text({
                text: description,
                color: 'black',
                font: 'gothic_18',
                position: new Vector(MARGIN, y),
                size: new Vector(textWidth, descriptionHeight + 4),
                textOverflow: 'wrap',
                textAlign: 'left'
            }));
            y += descriptionHeight + 8;
        }

        detailWindow.size(new Vector(contentWidth, Math.max(y + 4, res.y)));

        if (canEdit || canDelete) {
            detailWindow.on('click', 'select', function() {
                showCalendarEventEdit(event, detailWindow);
            });
        }

        detailWindow.show();
    });
    });
    });
}

/**
 * Ask for confirmation, then delete the event via calendar/event/delete.
 * Recurring instances pass their recurrence_id so only that occurrence is
 * deleted. On success the confirmation menu closes and onDeleted is called
 * so the caller can close its own windows; the event list underneath
 * refetches when it reappears.
 */
function confirmDeleteEvent(event, onDeleted) {
    var appState = AppState.getInstance();

    var confirmMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Delete event?'
        }]
    });

    confirmMenu.items(0, [
        { title: 'Delete', subtitle: descriptionPreview(event.summary), action: 'delete' },
        { title: 'Cancel', action: 'cancel' }
    ]);

    confirmMenu.on('select', function(e) {
        if (e.item.action !== 'delete') {
            confirmMenu.hide();
            return;
        }

        var msg = {
            type: 'calendar/event/delete',
            entity_id: event.calendar_entity_id,
            uid: event.uid
        };
        if (event.recurrence_id) {
            msg.recurrence_id = event.recurrence_id;
        }

        appState.haws.send(msg, function(data) {
            helpers.log_message('Deleted event ' + event.uid);
            Vibe.vibrate('short');
            confirmMenu.hide();
            if (typeof onDeleted === 'function') { onDeleted(); }
        }, function(error) {
            helpers.log_message('Event delete failed: ' + JSON.stringify(error));
            Vibe.vibrate('double');
            confirmMenu.hide();
        });
    });

    confirmMenu.show();
}

/**
 * Edit menu for an existing calendar event
 */
function showCalendarEventEdit(event, detailWindow) {
    showEventForm(event, detailWindow, event.calendar_entity_id);
}

/**
 * Create a new event on the given calendar: the same form as editing, with
 * a blank draft defaulting to the next full hour for one hour
 */
function showCalendarEventCreate(calendarEntityId) {
    showEventForm(null, null, calendarEntityId);
}

/**
 * Form for creating (event == null) or editing a calendar event: title and
 * description are dictated by voice on watches with a microphone, plus an
 * all-day toggle and alarm-style start/end date pickers. Save calls
 * calendar/event/create or calendar/event/update; the list underneath
 * refetches when it reappears.
 */
function showEventForm(event, detailWindow, calendarEntityId) {
    var appState = AppState.getInstance();
    var canDictate = Feature.microphone(true, false);
    var isCreate = !event;
    var features = getCalendarFeatures(calendarEntityId);
    var canEdit = isCreate ? !!features.create : !!(features.update && event.uid);
    var canDelete = !isCreate && !!(features.remove && event.uid);

    var draft;
    if (isCreate) {
        var now = new Date();
        var start = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                             now.getHours() + 1, 0, 0);
        draft = {
            summary: '',
            description: '',
            allDay: false,
            start: start,
            end: new Date(start.getTime() + 3600000)
        };
    } else {
        draft = {
            summary: event.summary || '',
            description: event.description ? String(event.description).trim() : '',
            allDay: isDateOnly(event.start),
            start: parseEventDate(event.start),
            end: event.end ? parseEventDate(event.end) : null
        };
        if (!draft.end) {
            draft.end = new Date(draft.start.getTime() + (draft.allDay ? 86400000 : 1800000));
        }
        // Home Assistant all-day ends are exclusive; show the inclusive date
        // while editing and add the day back on save
        if (draft.allDay) {
            draft.end = new Date(draft.end.getTime() - 86400000);
        }
    }

    var editMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: isCreate ? 'New Event' : 'Edit Event'
        }]
    });

    function dateFieldLabel(date) {
        var label = MONTH_NAMES[date.getMonth()] + ' ' + date.getDate() + ' ' + date.getFullYear();
        if (!draft.allDay) {
            label += ' ' + formatTime(date);
        }
        return label;
    }

    function updateItems() {
        var items = [];
        if (canEdit) {
            items.push({
                title: 'Title',
                subtitle: draft.summary || '(empty)',
                action: 'title'
            });
            items.push({
                title: 'Description',
                subtitle: descriptionPreview(draft.description) || '(empty)',
                action: 'description'
            });
            items.push({
                title: 'All Day',
                subtitle: draft.allDay ? 'On' : 'Off',
                action: 'allday'
            });
            items.push({
                title: 'Starts',
                subtitle: dateFieldLabel(draft.start),
                action: 'start'
            });
            items.push({
                title: 'Ends',
                subtitle: dateFieldLabel(draft.end),
                action: 'end'
            });
            items.push({
                title: 'Save',
                action: 'save'
            });
        }
        if (canDelete) {
            items.push({
                title: 'Delete',
                action: 'delete'
            });
        }
        editMenu.items(0, items);
    }

    function dictate(onText) {
        if (!canDictate) {
            helpers.log_message('Dictation not supported on this watch');
            Vibe.vibrate('double');
            return;
        }
        Voice.dictate('start', appState.voice_confirm, function(e) {
            if (e.err) {
                if (e.err !== 'systemAborted') {
                    helpers.log_message('Dictation error: ' + e.err);
                    Vibe.vibrate('double');
                }
                return;
            }
            onText(e.transcription);
            updateItems();
        });
    }

    function saveEvent() {
        var eventBody = { summary: draft.summary || '(No title)' };
        if (draft.description) { eventBody.description = draft.description; }
        if (event && event.location) { eventBody.location = event.location; }

        if (draft.allDay) {
            var startDay = new Date(draft.start.getFullYear(), draft.start.getMonth(), draft.start.getDate());
            var endDay = new Date(draft.end.getFullYear(), draft.end.getMonth(), draft.end.getDate());
            if (endDay.getTime() < startDay.getTime()) { endDay = startDay; }
            // Convert the inclusive end date back to Home Assistant's
            // exclusive convention
            endDay = new Date(endDay.getTime() + 86400000);
            eventBody.dtstart = dayKey(startDay);
            eventBody.dtend = dayKey(endDay);
        } else {
            var startDate = draft.start;
            var endDate = draft.end;
            if (endDate.getTime() <= startDate.getTime()) {
                endDate = new Date(startDate.getTime() + 1800000);
            }
            eventBody.dtstart = toLocalISO(startDate);
            eventBody.dtend = toLocalISO(endDate);
        }

        var msg;
        if (isCreate) {
            msg = {
                type: 'calendar/event/create',
                entity_id: calendarEntityId,
                event: eventBody
            };
        } else {
            msg = {
                type: 'calendar/event/update',
                entity_id: calendarEntityId,
                uid: event.uid,
                event: eventBody
            };
            if (event.recurrence_id) {
                msg.recurrence_id = event.recurrence_id;
            }
        }

        appState.haws.send(msg, function(data) {
            helpers.log_message((isCreate ? 'Created event ' : 'Updated event ') + eventBody.summary);
            Vibe.vibrate('short');
            editMenu.hide();
            if (detailWindow) { detailWindow.hide(); }
        }, function(error) {
            helpers.log_message('Event save failed: ' + JSON.stringify(error));
            Vibe.vibrate('double');
        });
    }

    editMenu.on('select', function(e) {
        switch (e.item.action) {
            case 'title':
                dictate(function(text) { draft.summary = text; });
                break;
            case 'description':
                dictate(function(text) { draft.description = text; });
                break;
            case 'allday':
                draft.allDay = !draft.allDay;
                updateItems();
                break;
            case 'start':
                DateTimeEditorPage.show({
                    title: 'Starts',
                    date: draft.start,
                    includeTime: !draft.allDay,
                    onSet: function(date) {
                        // Keep the event duration when the start moves
                        var durationMs = draft.end.getTime() - draft.start.getTime();
                        draft.start = date;
                        draft.end = new Date(date.getTime() + Math.max(durationMs, 0));
                        updateItems();
                    }
                });
                break;
            case 'end':
                DateTimeEditorPage.show({
                    title: 'Ends',
                    date: draft.end,
                    includeTime: !draft.allDay,
                    onSet: function(date) {
                        draft.end = date;
                        updateItems();
                    }
                });
                break;
            case 'save':
                saveEvent();
                break;
            case 'delete':
                confirmDeleteEvent(event, function() {
                    editMenu.hide();
                    if (detailWindow) { detailWindow.hide(); }
                });
                break;
        }
    });

    updateItems();
    editMenu.show();
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
