/**
 * TimerPage - timer entity page
 *
 * Home Assistant only writes the remaining attribute when the timer's
 * state changes, so a running timer's countdown has to be worked out on
 * this side from finishes_at (which is only present while active) and
 * ticked locally once a second. Paused timers report an accurate frozen
 * remaining, and idle ones fall back to their configured duration.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var NumberField = require('ui/numberfield');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// Longest duration the picker offers, one second short of 24 hours
var MAX_SECONDS = 86399;

/**
 * Parse a Home Assistant duration ("0:05:00") into seconds
 * @param {string} value
 * @returns {number} seconds, or 0 if unparseable
 */
function parseDuration(value) {
    if (typeof value === 'number') return Math.max(0, Math.round(value));
    if (!value) return 0;
    var parts = String(value).split(':');
    var seconds = 0;
    for (var i = 0; i < parts.length; i++) {
        seconds = seconds * 60 + (parseInt(parts[i], 10) || 0);
    }
    return Math.max(0, seconds);
}

/**
 * Format seconds as M:SS, or H:MM:SS once past an hour
 * @param {number} seconds
 */
function formatRemaining(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var pad = function(n) { return (n < 10 ? '0' : '') + n; };
    if (h > 0) {
        return h + ':' + pad(m) + ':' + pad(s);
    }
    return m + ':' + pad(s);
}

/**
 * Format seconds as the HH:MM:SS string the timer services expect
 * @param {number} seconds
 */
function serviceDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    var pad = function(n) { return (n < 10 ? '0' : '') + n; };
    return pad(Math.floor(seconds / 3600)) + ':' +
        pad(Math.floor((seconds % 3600) / 60)) + ':' +
        pad(seconds % 60);
}

/**
 * Seconds left on a timer right now. Active timers count down from
 * finishes_at; paused timers hold their remaining; idle timers show what
 * they would run for.
 * @param {Object} entity
 * @returns {number}
 */
function remainingSeconds(entity) {
    if (!entity) return 0;
    var attrs = entity.attributes || {};
    if (entity.state === 'active' && attrs.finishes_at) {
        var endMs = new Date(attrs.finishes_at).getTime();
        if (!isNaN(endMs)) {
            return Math.max(0, (endMs - Date.now()) / 1000);
        }
    }
    if (entity.state === 'idle') {
        return parseDuration(attrs.duration);
    }
    return parseDuration(attrs.remaining);
}

/**
 * State plus countdown for menu subtitles, e.g. "Running 4:32"
 * @param {Object} entity
 */
function statusText(entity) {
    var labels = { active: 'Running', paused: 'Paused', idle: 'Idle' };
    var label = labels[entity.state] || entity.state;
    if (entity.state === 'unavailable' || entity.state === 'unknown') {
        return entity.state;
    }
    return label + ' ' + formatRemaining(remainingSeconds(entity));
}

function callTimerService(entity_id, service, data) {
    var appState = AppState.getInstance();
    appState.haws.callService(
        'timer',
        service,
        data || {},
        { entity_id: entity_id },
        function(result) {
            Vibe.vibrate('short');
            helpers.log_message('timer.' + service + ' called for ' + entity_id);
        },
        function(error) {
            Vibe.vibrate('double');
            helpers.log_message('Error calling timer.' + service + ': ' + JSON.stringify(error));
        }
    );
}

/**
 * Long press quick action: start an idle timer, pause a running one, and
 * resume a paused one.
 */
function quickAction(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('quickAction: entity ' + entity_id + ' not found in state dict');
        return;
    }
    if (entity.state === 'active') {
        callTimerService(entity_id, 'pause');
    } else if (entity.state === 'paused' || entity.state === 'idle') {
        callTimerService(entity_id, 'start');
    } else {
        helpers.log_message('Timer ' + entity_id + ' in state ' + entity.state + ' - no action taken');
    }
}

/**
 * Pick a duration as HH:MM:SS and start the timer with it. Always allowed,
 * unlike timer.change which cannot extend past the running duration.
 */
function showDurationPicker(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) return;

    var configured = parseDuration(entity.attributes.duration) || 300;

    NumberField.showDuration({
        title: 'Start For',
        value: Math.min(MAX_SECONDS, configured),
        min: 1,
        max: MAX_SECONDS,
        onSet: function(seconds) {
            // The selector clamps to the min above, so zero never arrives
            appState.haws.callService(
                'timer',
                'start',
                { duration: serviceDuration(seconds) },
                { entity_id: entity_id },
                function(result) {
                    Vibe.vibrate('short');
                    helpers.log_message('timer.start ' + serviceDuration(seconds) + ' for ' + entity_id);
                    NumberField.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message('Error starting timer: ' + JSON.stringify(error));
                }
            );
        }
    });
}

function showTimerEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        tickTimer = null;
    if (!entity) {
        throw new Error(`Timer entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing timer entity ${entity_id}`, JSON.stringify(entity, null, 4));

    let timerMenu = new UI.Menu({
        status: false,
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    // Rebuilding the whole section every second would flood the message
    // queue, so the countdown only rewrites the status row
    function buildStatusItem(updatedEntity) {
        return {
            title: updatedEntity.attributes.friendly_name || entity_id,
            subtitle: statusText(updatedEntity),
            icon: 'images/icon_timer.png',
            on_click: function() {
                quickAction(entity_id);
            }
        };
    }

    function updateStatusRow() {
        let current = appState.ha_state_dict[entity_id];
        if (current) {
            timerMenu.item(0, 0, buildStatusItem(current));
        }
    }

    function stopTick() {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
    }

    // Only a running timer needs a local tick; paused and idle values are
    // static until the next state change
    function syncTick(updatedEntity) {
        stopTick();
        if (updatedEntity.state === 'active') {
            tickTimer = setInterval(updateStatusRow, 1000);
        }
    }

    let renderedState = null;

    function updateTimerMenuItems(updatedEntity) {
        let state = updatedEntity.state;
        let unavailable = (state === 'unavailable' || state === 'unknown');
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!unavailable) {
            if (state === 'active') {
                menuItems.push({
                    title: 'Pause',
                    on_click: function() { callTimerService(entity_id, 'pause'); }
                });
            } else {
                menuItems.push({
                    title: state === 'paused' ? 'Resume' : 'Start',
                    subtitle: state === 'idle'
                        ? formatRemaining(parseDuration(updatedEntity.attributes.duration))
                        : '',
                    on_click: function() { callTimerService(entity_id, 'start'); }
                });
            }

            menuItems.push({
                title: 'Start For...',
                subtitle: 'Pick a duration',
                on_click: function() { showDurationPicker(entity_id); }
            });

            if (state === 'active' || state === 'paused') {
                menuItems.push({
                    title: 'Cancel',
                    on_click: function() { callTimerService(entity_id, 'cancel'); }
                });
                menuItems.push({
                    title: 'Finish',
                    on_click: function() { callTimerService(entity_id, 'finish'); }
                });
            }

            // Home Assistant only allows changing an active timer, and
            // refuses to take it past the duration it was started with
            if (state === 'active') {
                menuItems.push({
                    title: 'Add 1 min',
                    on_click: function() {
                        callTimerService(entity_id, 'change', { duration: '00:01:00' });
                    }
                });
                menuItems.push({
                    title: 'Subtract 1 min',
                    on_click: function() {
                        callTimerService(entity_id, 'change', { duration: '-00:01:00' });
                    }
                });
            }
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

        timerMenu.items(0, menuItems);

        // The action rows change with the state, so a selection held over
        // from the previous state would fire the wrong thing
        if (renderedState !== null && renderedState !== state) {
            selectedIndex = 0;
            timerMenu.selection(0, 0);
        }
        renderedState = state;

        syncTick(updatedEntity);
    }

    let selectedIndex = 0;

    timerMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Timer menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    timerMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateTimerMenuItems(entity);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Timer entity update for ${entity_id}: ${updatedEntity.state}`);
                updateTimerMenuItems(updatedEntity);
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < timerMenu.items(0).length) {
                timerMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    timerMenu.on('hide', function() {
        stopTick();
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
    });

    timerMenu.show();
}

module.exports.showTimerEntity = showTimerEntity;
module.exports.quickAction = quickAction;
module.exports.statusText = statusText;
module.exports.remainingSeconds = remainingSeconds;
module.exports.formatRemaining = formatRemaining;
