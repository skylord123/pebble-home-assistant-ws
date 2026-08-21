/**
 * RemotePage - remote entity control page
 *
 * On, off and toggle are always available. Activities come from the
 * ACTIVITY feature, which is also the only condition under which Home
 * Assistant publishes activity_list and current_activity at all.
 *
 * Sending and deleting commands are deliberately not here. Both need a
 * command name that already exists, and Home Assistant offers no way to
 * enumerate them: Harmony keeps them in a file on disk, Broadlink in its
 * own storage. Dictating an exact string like VolumeUp or KEY_POWER does
 * not work, and integrations expose the actions worth having as button
 * entities anyway, which this app already presses. Wrapping a command in a
 * script works for the rest.
 *
 * Learning is different, because the name is one the user is inventing
 * rather than matching, so dictation suits it. It does need a device on
 * Broadlink, which refuses without one, and a command type, since Broadlink
 * branches on it and cannot learn a radio remote told to expect infrared.
 * Harmony publishes its devices in devices_list so they can be picked from
 * a menu; anything else has to be spoken.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var Voice = require('ui/voice');
var Feature = require('platform/feature');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// RemoteEntityFeature bitfield values from Home Assistant
var RemoteEntityFeature = {
    LEARN_COMMAND: 1,
    // DELETE_COMMAND is 2, unused here: deleting needs an existing command
    // name that cannot be enumerated or reliably spoken
    ACTIVITY: 4
};

function getRemoteData(entity) {
    var attrs = entity.attributes || {};
    var features = attrs.supported_features || 0;
    return {
        friendly_name: attrs.friendly_name || entity.entity_id,
        state: entity.state,
        is_on: entity.state === 'on',
        unavailable: entity.state === 'unavailable' || entity.state === 'unknown',
        // Home Assistant only publishes these when ACTIVITY is supported
        activity_list: Array.isArray(attrs.activity_list) ? attrs.activity_list : [],
        current_activity: attrs.current_activity || null,
        // Not part of the remote entity, but Harmony publishes the devices
        // its hub knows about, which saves dictating one
        devices_list: Array.isArray(attrs.devices_list) ? attrs.devices_list : [],
        has_activity: !!(features & RemoteEntityFeature.ACTIVITY),
        can_learn: !!(features & RemoteEntityFeature.LEARN_COMMAND)
    };
}

/**
 * State plus whatever it is currently doing, e.g. "on Watch TV"
 */
function statusText(entity) {
    var data = getRemoteData(entity);
    if (data.unavailable) return entity.state;
    // Only meaningful while on: Harmony names its off state PowerOff, which
    // would otherwise read as "off PowerOff" in every list
    if (data.is_on && data.current_activity) {
        return entity.state + ' ' + data.current_activity;
    }
    return entity.state;
}

function callRemoteService(entity_id, service, data, onDone) {
    var appState = AppState.getInstance();
    appState.haws.callService(
        'remote',
        service,
        data || {},
        { entity_id: entity_id },
        function(result) {
            Vibe.vibrate('short');
            helpers.log_message('remote.' + service + ' called for ' + entity_id +
                ' with ' + JSON.stringify(data || {}));
            if (onDone) onDone(true);
        },
        function(error) {
            Vibe.vibrate('double');
            helpers.log_message('Error calling remote.' + service + ': ' + JSON.stringify(error));
            if (onDone) onDone(false);
        }
    );
}

function quickAction(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('quickAction: entity ' + entity_id + ' not found in state dict');
        return;
    }
    if (getRemoteData(entity).unavailable) {
        helpers.log_message('Remote ' + entity_id + ' in state ' + entity.state + ' - no action taken');
        return;
    }
    callRemoteService(entity_id, 'toggle');
}

/**
 * Dictate a command name and hand it back. Commands are not discoverable
 * from Home Assistant, so speaking one is the only way to name it here.
 */
function dictateCommand(onCommand) {
    var appState = AppState.getInstance();
    Voice.dictate('start', appState.voice_confirm, function(e) {
        if (e.err) {
            if (e.err !== 'systemAborted') {
                helpers.log_message('Dictation error: ' + e.err);
                Vibe.vibrate('double');
            }
            return;
        }
        var command = (e.transcription || '').trim();
        if (!command.length) {
            Vibe.vibrate('double');
            return;
        }
        onCommand(command);
    });
}

function showRemoteEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Remote entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing remote entity ${entity_id}`, JSON.stringify(entity, null, 4));

    let hasMicrophone = Feature.microphone(true, false);

    // Applied to sending, learning and deleting. device is required by
    // Harmony, Broadlink and Kira and ignored by Xiaomi, so it is chosen
    // once here rather than asked for three times. command_type only
    // matters to Learn, where Broadlink needs rf to learn a radio remote.
    let pending = { device: null, command_type: 'ir' };

    let remoteMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    // Activities are switched by turning the remote on with one named,
    // which is what the activity field on turn_on is for
    function showActivityMenu() {
        let activityMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Select Activity'
            }]
        });
        let activity_subscription_msg_id = null;

        function buildItems(current) {
            if (!current) { return; }
            let data = getRemoteData(current);
            let items = [];
            data.activity_list.forEach(function(activity) {
                items.push({
                    title: activity,
                    subtitle: activity === data.current_activity ? 'Current' : '',
                    on_click: function() {
                        callRemoteService(entity_id, 'turn_on', { activity: activity });
                    }
                });
            });
            activityMenu.items(0, items);
        }

        activityMenu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        activityMenu.on('show', function() {
            buildItems(appState.ha_state_dict[entity_id]);
            activity_subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(eventData) {
                let updated = EntityService.applyCompressedEvent(entity_id, eventData);
                if (updated) { buildItems(updated); }
            }, function(error) {
                helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
            });
        });

        activityMenu.on('hide', function() {
            if (activity_subscription_msg_id) {
                appState.haws.unsubscribe(activity_subscription_msg_id);
            }
        });

        activityMenu.show();
    }

    // Harmony hands us the device names; everything else has to be spoken
    function showDeviceMenu() {
        let data = getRemoteData(appState.ha_state_dict[entity_id] || entity);
        let deviceMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Select Device'
            }]
        });

        let items = [{
            title: 'Default',
            subtitle: pending.device === null ? 'Current' : '',
            on_click: function() {
                pending.device = null;
                Vibe.vibrate('short');
                deviceMenu.hide();
            }
        }];

        data.devices_list.forEach(function(device) {
            items.push({
                title: device,
                subtitle: device === pending.device ? 'Current' : '',
                on_click: function() {
                    pending.device = device;
                    Vibe.vibrate('short');
                    deviceMenu.hide();
                }
            });
        });

        if (hasMicrophone) {
            items.push({
                title: 'Speak a Name',
                on_click: function() {
                    dictateCommand(function(device) {
                        pending.device = device;
                        deviceMenu.hide();
                    });
                }
            });
        }

        deviceMenu.items(0, items);
        deviceMenu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });
        deviceMenu.on('hide', function() {
            updateRemoteMenuItems(appState.ha_state_dict[entity_id] || entity);
        });
        deviceMenu.show();
    }

    // Only the chosen device is sent, so a remote that ignores it is
    // unaffected and one that needs it finally gets it
    function withDevice(data) {
        return pending.device ? { device: pending.device } : {};
    }

    function learnCommand() {
        dictateCommand(function(command) {
            // alternative and timeout keep the integration's defaults, but
            // command_type is sent because Broadlink branches on it and
            // cannot learn a radio remote without being told rf
            let payload = withDevice();
            payload.command = [command];
            payload.command_type = pending.command_type;
            callRemoteService(entity_id, 'learn_command', payload);
        });
    }

    function buildStatusItem(updatedEntity) {
        let data = getRemoteData(updatedEntity);
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedEntity.last_changed));
        return {
            title: data.friendly_name,
            subtitle: `${statusText(updatedEntity)} > ${timeStr}`,
            icon: EntityService.getIcon(updatedEntity),
            on_click: function() {
                callRemoteService(entity_id, 'toggle');
            }
        };
    }

    let renderedSignature = null;

    function updateRemoteMenuItems(updatedEntity) {
        let data = getRemoteData(updatedEntity);
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!data.unavailable) {
            menuItems.push({
                title: data.is_on ? 'Turn Off' : 'Turn On',
                on_click: function() {
                    callRemoteService(entity_id, data.is_on ? 'turn_off' : 'turn_on');
                }
            });

            if (data.has_activity && data.activity_list.length) {
                menuItems.push({
                    title: 'Activity',
                    subtitle: data.current_activity || 'None',
                    on_click: showActivityMenu
                });
            }

            // Every command row needs a name, and dictation is the only way
            // to produce one on a watch
            // Learning is the only command flow here, and it needs a name
            // spoken, a device on some integrations, and a type
            if (hasMicrophone && data.can_learn) {
                menuItems.push({
                    title: 'Learn Command',
                    subtitle: 'Name it, then press the remote',
                    on_click: learnCommand
                });
                menuItems.push({
                    title: 'Device',
                    subtitle: pending.device || 'Default',
                    on_click: showDeviceMenu
                });
                menuItems.push({
                    title: 'Learn Type',
                    subtitle: pending.command_type === 'rf' ? 'Radio (RF)' : 'Infrared (IR)',
                    on_click: function() {
                        pending.command_type = pending.command_type === 'rf' ? 'ir' : 'rf';
                        Vibe.vibrate('short');
                        updateRemoteMenuItems(appState.ha_state_dict[entity_id] || entity);
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

        remoteMenu.items(0, menuItems);

        // The row set also changes when the activity row appears, which a
        // Harmony can do a beat after startup, so the highlight follows the
        // whole shape rather than availability alone
        let signature = data.unavailable + ':' + (data.has_activity && data.activity_list.length > 0);
        if (renderedSignature !== null && renderedSignature !== signature) {
            selectedIndex = 0;
            remoteMenu.selection(0, 0);
        }
        renderedSignature = signature;
    }

    let selectedIndex = 0;

    remoteMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Remote menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    remoteMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateRemoteMenuItems(entity);

        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.ha_state_dict[entity_id];
            if (current) {
                remoteMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Remote entity update for ${entity_id}: ${updatedEntity.state}`);
                updateRemoteMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < remoteMenu.items(0).length) {
                remoteMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    remoteMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    remoteMenu.show();
}

module.exports.showRemoteEntity = showRemoteEntity;
module.exports.quickAction = quickAction;
module.exports.statusText = statusText;
module.exports.getRemoteData = getRemoteData;
