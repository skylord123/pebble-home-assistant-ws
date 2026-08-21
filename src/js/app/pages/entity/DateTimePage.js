/**
 * DateTimePage - input_datetime / datetime / date / time entity page
 *
 * All four are the same idea with different halves enabled, so one page
 * covers them: whether a date and a time are in play decides both which
 * editor opens and which fields the service call carries. Each domain
 * names its service field after itself (date, time, datetime) rather than
 * using "value" the way text and number do.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var NumberField = require('ui/numberfield');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');
var DateTimeEditorPage = require('app/pages/DateTimeEditorPage');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n) {
    return (n < 10 ? '0' : '') + n;
}

/**
 * Which halves of a date and time this entity holds, and the current
 * value as a local Date.
 */
function getDateTimeData(entity) {
    var domain = entity.entity_id.split('.')[0];
    var attrs = entity.attributes || {};
    var hasDate = true;
    var hasTime = true;

    if (domain === 'input_datetime') {
        hasDate = attrs.has_date !== false;
        hasTime = attrs.has_time === true;
    } else if (domain === 'date') {
        hasTime = false;
    } else if (domain === 'time') {
        hasDate = false;
    }

    return {
        domain: domain,
        friendly_name: attrs.friendly_name || entity.entity_id,
        unavailable: entity.state === 'unavailable' || entity.state === 'unknown',
        hasDate: hasDate,
        hasTime: hasTime,
        value: parseValue(entity, domain, hasDate, hasTime)
    };
}

/**
 * input_datetime publishes the parts as attributes, which beats picking
 * apart the state string. Everything else is parsed from the state: a
 * datetime entity is UTC ISO and converts to local on its own, while date
 * and time entities are plain local values that must not be run through
 * ISO parsing or they would shift by the timezone offset.
 */
function parseValue(entity, domain, hasDate, hasTime) {
    var attrs = entity.attributes || {};
    var now = new Date();

    if (domain === 'input_datetime') {
        if (attrs.year !== undefined || attrs.hour !== undefined) {
            return new Date(
                attrs.year !== undefined ? attrs.year : now.getFullYear(),
                attrs.month !== undefined ? attrs.month - 1 : now.getMonth(),
                attrs.day !== undefined ? attrs.day : now.getDate(),
                attrs.hour !== undefined ? attrs.hour : 0,
                attrs.minute !== undefined ? attrs.minute : 0,
                attrs.second !== undefined ? attrs.second : 0
            );
        }
    }

    var state = typeof entity.state === 'string' ? entity.state : '';

    if (domain === 'datetime') {
        var parsed = new Date(state);
        return isNaN(parsed.getTime()) ? now : parsed;
    }

    var dateMatch = state.match(/^(\d{4})-(\d{2})-(\d{2})/);
    var timeMatch = state.match(/(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!dateMatch && !timeMatch) {
        return now;
    }
    return new Date(
        dateMatch ? parseInt(dateMatch[1], 10) : now.getFullYear(),
        dateMatch ? parseInt(dateMatch[2], 10) - 1 : now.getMonth(),
        dateMatch ? parseInt(dateMatch[3], 10) : now.getDate(),
        timeMatch ? parseInt(timeMatch[1], 10) : 0,
        timeMatch ? parseInt(timeMatch[2], 10) : 0,
        timeMatch && timeMatch[3] ? parseInt(timeMatch[3], 10) : 0
    );
}

function formatDate(d) {
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

function formatTime(d, withSeconds) {
    return helpers.formatTimeOfDay(d, { seconds: withSeconds });
}

/**
 * Human readable current value for subtitles
 */
function displayValue(entity) {
    var data = getDateTimeData(entity);
    if (data.unavailable) return entity.state;
    var parts = [];
    if (data.hasDate) parts.push(formatDate(data.value));
    // Seconds are shown for a time only entity, where they are part of the
    // value and the picker can actually set them. Alongside a date they
    // would only lengthen the row: that editor cannot change them.
    if (data.hasTime) parts.push(formatTime(data.value, !data.hasDate));
    return parts.join(' ');
}

/**
 * Send a new value. Each domain takes its own field name, and
 * input_datetime refuses date and datetime together, so only the fields
 * this entity actually holds are sent.
 */
function sendValue(entity_id, date, onDone) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) return;
    var data = getDateTimeData(entity);
    var service = data.domain === 'input_datetime' ? 'set_datetime' : 'set_value';
    var payload = {};

    var dateStr = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    var timeStr = pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());

    if (data.domain === 'datetime') {
        // Wants a timezone aware value, and an ISO string in UTC is one
        payload.datetime = date.toISOString();
    } else if (data.hasDate && data.hasTime) {
        payload.datetime = dateStr + ' ' + timeStr;
    } else if (data.hasDate) {
        payload.date = dateStr;
    } else {
        payload.time = timeStr;
    }

    appState.haws.callService(
        data.domain,
        service,
        payload,
        { entity_id: entity_id },
        function(result) {
            Vibe.vibrate('short');
            helpers.log_message(data.domain + '.' + service + ' called for ' + entity_id +
                ' with ' + JSON.stringify(payload));
            if (onDone) onDone(true);
        },
        function(error) {
            Vibe.vibrate('double');
            helpers.log_message('Error calling ' + data.domain + '.' + service + ': ' +
                JSON.stringify(error));
            if (onDone) onDone(false);
        }
    );
}

/**
 * Open the right editor for what this entity holds: the alarm style
 * date editor when there is a date, and the watch's own HH:MM:SS picker
 * when it is only a time.
 */
function editValue(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('editValue: entity ' + entity_id + ' not found in state dict');
        return;
    }
    var data = getDateTimeData(entity);
    if (data.unavailable) return;

    if (!data.hasDate) {
        var current = data.value.getHours() * 3600 + data.value.getMinutes() * 60 + data.value.getSeconds();
        // A time of day rather than a length of time, so it reads the way the
        // watch is set: 7:30 AM or 07:30
        NumberField.showTimeOfDay({
            title: data.friendly_name,
            value: current,
            min: 0,
            max: 86399,
            onSet: function(seconds) {
                var next = new Date(data.value.getTime());
                next.setHours(Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60, 0);
                sendValue(entity_id, next, function(ok) {
                    if (ok) NumberField.hide();
                });
            }
        });
        return;
    }

    DateTimeEditorPage.show({
        title: data.friendly_name,
        date: data.value,
        includeTime: data.hasTime,
        onSet: function(result) {
            sendValue(entity_id, result);
        }
    });
}

function showDateTimeEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Date/time entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing date/time entity ${entity_id}`);

    let dateTimeMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    function buildStatusItem(updatedEntity) {
        let data = getDateTimeData(updatedEntity);
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedEntity.last_changed));
        return {
            title: data.friendly_name,
            subtitle: `${displayValue(updatedEntity)} > ${timeStr}`,
            icon: EntityService.getIcon(updatedEntity),
            on_click: function() {
                editValue(entity_id);
            }
        };
    }

    let renderedUnavailable = null;

    function updateDateTimeMenuItems(updatedEntity) {
        let data = getDateTimeData(updatedEntity);
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!data.unavailable) {
            menuItems.push({
                title: data.hasDate && data.hasTime ? 'Set Date & Time'
                    : (data.hasDate ? 'Set Date' : 'Set Time'),
                on_click: function() { editValue(entity_id); }
            });
            menuItems.push({
                title: 'Set to Now',
                on_click: function() { sendValue(entity_id, new Date()); }
            });
        }

        if (require('app/pages/HistoryPage').isSupported()) {
            menuItems.push({
                title: 'History',
                on_click: function() {
                    require('app/pages/HistoryPage').show(entity_id);
                }
            });
        }

        menuItems.push({
            title: 'More',
            on_click: function() {
                GenericEntityPage.showEntityMenu(entity_id);
            }
        });

        dateTimeMenu.items(0, menuItems);

        if (renderedUnavailable !== null && renderedUnavailable !== data.unavailable) {
            selectedIndex = 0;
            dateTimeMenu.selection(0, 0);
        }
        renderedUnavailable = data.unavailable;
    }

    let selectedIndex = 0;

    dateTimeMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Date/time menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    dateTimeMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateDateTimeMenuItems(entity);

        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.ha_state_dict[entity_id];
            if (current) {
                dateTimeMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Date/time entity update for ${entity_id}: ${updatedEntity.state}`);
                updateDateTimeMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < dateTimeMenu.items(0).length) {
                dateTimeMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    dateTimeMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    dateTimeMenu.show();
}

module.exports.showDateTimeEntity = showDateTimeEntity;
module.exports.editValue = editValue;
module.exports.displayValue = displayValue;
module.exports.getDateTimeData = getDateTimeData;
