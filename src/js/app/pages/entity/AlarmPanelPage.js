/**
 * AlarmPanelPage - Alarm control panel entity page
 *
 * Features:
 * - Disarm / arm modes filtered by supported_features
 * - Code entry (PinEntryPage) when the panel requires one, mirroring the
 *   HA frontend rules: disarm needs a code whenever code_format is set,
 *   arming only when code_arm_required is also true
 * - Remembered codes and a per-entity "never ask" option (AlarmCodeStore)
 * - Trigger behind a confirmation card
 * - Real-time state subscription
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var Settings = require('settings');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');
var PinEntryPage = require('app/pages/PinEntryPage');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// AlarmControlPanelEntityFeature bitfield values from Home Assistant
var AlarmEntityFeature = {
    ARM_HOME: 1,
    ARM_AWAY: 2,
    ARM_NIGHT: 4,
    TRIGGER: 8,
    ARM_CUSTOM_BYPASS: 16,
    ARM_VACATION: 32
};

// Arm modes in display order (away first: it doubles as the long-press
// fallback order)
var ARM_MODES = [
    { service: 'alarm_arm_away', title: 'Arm Away', feature: AlarmEntityFeature.ARM_AWAY, state: 'armed_away' },
    { service: 'alarm_arm_home', title: 'Arm Home', feature: AlarmEntityFeature.ARM_HOME, state: 'armed_home' },
    { service: 'alarm_arm_night', title: 'Arm Night', feature: AlarmEntityFeature.ARM_NIGHT, state: 'armed_night' },
    { service: 'alarm_arm_vacation', title: 'Arm Vacation', feature: AlarmEntityFeature.ARM_VACATION, state: 'armed_vacation' },
    { service: 'alarm_arm_custom_bypass', title: 'Arm Custom', feature: AlarmEntityFeature.ARM_CUSTOM_BYPASS, state: 'armed_custom_bypass' }
];

var STATE_LABELS = {
    disarmed: 'Disarmed',
    armed_home: 'Armed Home',
    armed_away: 'Armed Away',
    armed_night: 'Armed Night',
    armed_vacation: 'Armed Vacation',
    armed_custom_bypass: 'Armed Custom',
    arming: 'Arming...',
    pending: 'Pending...',
    disarming: 'Disarming...',
    triggered: 'TRIGGERED'
};

var SERVICE_LABELS = {
    alarm_disarm: 'Disarm',
    alarm_trigger: 'Trigger'
};
ARM_MODES.forEach(function(mode) { SERVICE_LABELS[mode.service] = mode.title; });

function stateLabel(state) {
    return STATE_LABELS[state] || state;
}

/**
 * Whether a service call on this entity needs a code, per the same rules
 * the HA frontend keypad uses. Trigger never prompts (the code is
 * optional server-side and blocking a panic action on a PIN would be
 * backwards).
 */
function needsCode(entity, service) {
    if (!entity.attributes.code_format) return false;
    if (service === 'alarm_trigger') return false;
    if (service !== 'alarm_disarm' && entity.attributes.code_arm_required === false) return false;
    return true;
}

function errorMessage(error) {
    if (error && error.error && error.error.message) {
        return error.error.message;
    }
    return 'Action failed';
}

/**
 * Run an alarm service with the full code flow: no prompt when the panel
 * doesn't need a code, remembered/never-ask codes from the store, and a
 * PIN page (with retry on a wrong code) otherwise.
 */
function performAction(entity_id, service) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('performAction: entity ' + entity_id + ' not found in state dict');
        return;
    }
    var store = appState.alarmCodeStore;

    function send(code, successCallback, errorCallback) {
        var service_data = (code !== null && code !== undefined) ? { code: String(code) } : {};
        var sent = appState.haws.callService(
            'alarm_control_panel',
            service,
            service_data,
            { entity_id: entity_id },
            function(data) {
                helpers.log_message('alarm_control_panel.' + service + ' called for ' + entity_id);
                successCallback(data);
            },
            function(error) {
                helpers.log_message('Error calling alarm_control_panel.' + service + ': ' + JSON.stringify(error));
                errorCallback(error);
            }
        );
        if (sent === false) {
            errorCallback({ error: { message: 'Not connected' }, not_connected: true });
        }
    }

    function promptForCode(initialError) {
        PinEntryPage.show({
            title: SERVICE_LABELS[service] || service,
            subtitle: entity.attributes.friendly_name || entity_id,
            error: initialError,
            onSubmit: function(code, done) {
                send(code, function() {
                    Vibe.vibrate('short');
                    if (store && appState.alarm_code_remember !== false) {
                        store.setCode(entity_id, code);
                    }
                    done(null);
                }, function(error) {
                    Vibe.vibrate('double');
                    done(errorMessage(error));
                });
            }
        });
    }

    if (!needsCode(entity, service)) {
        send(null,
            function() { Vibe.vibrate('short'); },
            function() { Vibe.vibrate('double'); });
        return;
    }

    var saved = store ? store.get(entity_id) : undefined;
    if (saved) {
        send(saved.code, function() {
            Vibe.vibrate('short');
        }, function(error) {
            Vibe.vibrate('double');
            // A connection failure says nothing about the code, but a
            // server rejection gets a prompt showing why (both for a
            // stale remembered code and a "never ask" panel that turned
            // out to need one). The stored entry is left alone: transient
            // server errors shouldn't wipe a good code, and a successful
            // retry overwrites a stale one anyway.
            if (!error.not_connected) {
                promptForCode(errorMessage(error));
            }
        });
        return;
    }

    promptForCode(null);
}

/**
 * Long-press quick action: disarm when armed (or pending/triggered), arm
 * when disarmed using the first supported mode (away preferred).
 */
function quickAction(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('quickAction: entity ' + entity_id + ' not found in state dict');
        return;
    }

    var state = entity.state;
    if (state === 'unavailable' || state === 'unknown') {
        helpers.log_message('Alarm ' + entity_id + ' in state ' + state + ' - no action taken');
        return;
    }

    if (state === 'disarmed') {
        var supported = entity.attributes.supported_features || 0;
        for (var i = 0; i < ARM_MODES.length; i++) {
            if (supported & ARM_MODES[i].feature) {
                performAction(entity_id, ARM_MODES[i].service);
                return;
            }
        }
        helpers.log_message('Alarm ' + entity_id + ' supports no arm modes - no action taken');
        return;
    }

    performAction(entity_id, 'alarm_disarm');
}

function showAlarmEntity(entity_id) {
    var appState = AppState.getInstance();
    let alarm = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!alarm) {
        throw new Error(`Alarm entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing alarm entity ${entity_id}`, JSON.stringify(alarm, null, 4));

    let alarmMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: alarm.attributes.friendly_name || entity_id
        }]
    });

    function showTriggerConfirm() {
        let confirmCard = new UI.Card({
            title: 'Trigger Alarm?',
            body: 'Press SELECT to sound the alarm.'
        });
        confirmCard.on('click', 'select', function() {
            confirmCard.hide();
            performAction(entity_id, 'alarm_trigger');
        });
        confirmCard.show();
    }

    // Small menu for managing the stored code for this panel
    function showCodeOptionsMenu() {
        let store = appState.alarmCodeStore;
        let codeMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Alarm Code'
            }]
        });

        function buildCodeMenuItems() {
            let saved = store ? store.get(entity_id) : undefined;
            let neverAsk = !!(saved && saved.code === null);
            let hasCode = !!(saved && saved.code !== null);
            let items = [];

            if (hasCode) {
                items.push({
                    title: 'Forget Code',
                    subtitle: 'Ask again next time',
                    on_click: function() {
                        store.remove(entity_id);
                        Vibe.vibrate('short');
                        buildCodeMenuItems();
                    }
                });
            }

            // For panels whose code is stored in HA itself (default code
            // entity option): call services with no code at all
            items.push({
                title: 'Never Ask',
                subtitle: neverAsk ? 'On - no code is sent' : 'Off',
                on_click: function() {
                    if (neverAsk) {
                        store.remove(entity_id);
                    } else {
                        store.setCode(entity_id, null);
                    }
                    Vibe.vibrate('short');
                    buildCodeMenuItems();
                }
            });

            // Global setting: remember codes after a successful entry
            items.push({
                title: 'Remember Codes',
                subtitle: appState.alarm_code_remember !== false ? 'On' : 'Off',
                on_click: function() {
                    appState.alarm_code_remember = appState.alarm_code_remember === false;
                    Settings.option('alarm_code_remember', appState.alarm_code_remember);
                    Vibe.vibrate('short');
                    buildCodeMenuItems();
                }
            });

            codeMenu.items(0, items);
        }

        codeMenu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        codeMenu.on('show', function() {
            buildCodeMenuItems();
        });

        codeMenu.show();
    }

    // Track the state the menu was last built for, so a rebuild that
    // reorders the action items can reset the highlight (otherwise a
    // select right after a remote state change would fire whichever
    // action now sits under the old index)
    let renderedState = null;

    function buildStatusItem(updatedAlarm) {
        let subtitle = stateLabel(updatedAlarm.state);
        if (updatedAlarm.attributes.changed_by) {
            subtitle += ' by ' + updatedAlarm.attributes.changed_by;
        }
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedAlarm.last_changed));
        return {
            title: updatedAlarm.attributes.friendly_name || entity_id,
            subtitle: `${subtitle} > ${timeStr}`,
            icon: EntityService.getIcon(updatedAlarm)
        };
    }

    // Function to update menu items based on current alarm state
    function updateAlarmMenuItems(updatedAlarm) {
        let state = updatedAlarm.state;
        let supported = updatedAlarm.attributes.supported_features || 0;
        let unavailable = (state === 'unavailable' || state === 'unknown');
        let menuItems = [];

        menuItems.push(buildStatusItem(updatedAlarm));

        if (!unavailable && state !== 'disarmed') {
            menuItems.push({
                title: 'Disarm',
                on_click: function() {
                    performAction(entity_id, 'alarm_disarm');
                }
            });
        }

        // Arm modes are only offered while disarmed (matching the HA
        // frontend; switching modes means disarming first)
        if (state === 'disarmed') {
            ARM_MODES.forEach(function(mode) {
                if (supported & mode.feature) {
                    menuItems.push({
                        title: mode.title,
                        on_click: function() {
                            performAction(entity_id, mode.service);
                        }
                    });
                }
            });
        }

        if (!unavailable && state !== 'triggered' && (supported & AlarmEntityFeature.TRIGGER)) {
            menuItems.push({
                title: 'Trigger',
                subtitle: 'Sound the alarm',
                on_click: showTriggerConfirm
            });
        }

        if (updatedAlarm.attributes.code_format) {
            let saved = appState.alarmCodeStore ? appState.alarmCodeStore.get(entity_id) : undefined;
            menuItems.push({
                title: 'Code',
                subtitle: saved
                    ? (saved.code === null ? 'Never ask' : 'Remembered')
                    : 'Ask when needed',
                on_click: showCodeOptionsMenu
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

        alarmMenu.items(0, menuItems);

        if (renderedState !== null && renderedState !== state) {
            // The action items just changed under the highlight
            selectedIndex = 0;
            alarmMenu.selection(0, 0);
        }
        renderedState = state;
    }

    // Track the selected index to restore it when returning from submenus
    let selectedIndex = 0;

    alarmMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;

        helpers.log_message(`Alarm menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    alarmMenu.on('show', function() {
        // Get the latest alarm data
        alarm = appState.ha_state_dict[entity_id];
        updateAlarmMenuItems(alarm);

        // Create RelativeTimeUpdater for live time updates. Only the
        // status row's time suffix changes on a tick, so update just that
        // item instead of re-sending the whole section every second
        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let currentAlarm = appState.ha_state_dict[entity_id];
            if (currentAlarm) {
                alarmMenu.item(0, 0, buildStatusItem(currentAlarm));
            }
        });
        relativeTimeUpdater.register(entity_id, alarm.last_changed);

        // Subscribe to entity updates (arming/pending/triggered transitions
        // are exactly when someone is watching this screen). subscribe_entities
        // rather than subscribe_trigger: its initial snapshot event replays the
        // current state on every re-subscribe, so state changes that happened
        // while this menu was hidden (e.g. a disarm confirmed from the PIN
        // page, which sits on top of and hides this window) are picked up when
        // we come back. A trigger subscription only reports future changes.
        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedAlarm = EntityService.applyCompressedEvent(entity_id, data);

            if (updatedAlarm) {
                helpers.log_message(`Alarm entity update for ${entity_id}: ${updatedAlarm.state}`);

                updateAlarmMenuItems(updatedAlarm);

                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedAlarm.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        // Restore the previously selected index when returning from a
        // submenu (updateAlarmMenuItems has already reset it to 0 if the
        // state changed while we were away)
        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < alarmMenu.items(0).length) {
                alarmMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    alarmMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }

        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    alarmMenu.show();
}

module.exports.showAlarmEntity = showAlarmEntity;
module.exports.performAction = performAction;
module.exports.quickAction = quickAction;
module.exports.ARM_MODES = ARM_MODES;
