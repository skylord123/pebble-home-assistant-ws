/**
 * HumidifierPage - humidifier entity control page
 *
 * Features (each shown only when the entity supports it):
 * - Turn on / off
 * - Target humidity through the native number selector
 * - Mode selection when the entity advertises MODES
 * - Real-time state subscription
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var NumberField = require('ui/numberfield');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// HumidifierEntityFeature bitfield values from Home Assistant
var HumidifierEntityFeature = {
    MODES: 1
};

function getHumidifierData(entity) {
    var attrs = entity.attributes || {};
    return {
        entity_id: entity.entity_id,
        friendly_name: attrs.friendly_name || entity.entity_id,
        state: entity.state,
        is_on: entity.state === 'on',
        unavailable: entity.state === 'unavailable' || entity.state === 'unknown',
        target: attrs.humidity !== undefined && attrs.humidity !== null ? Math.round(attrs.humidity) : null,
        current: attrs.current_humidity !== undefined && attrs.current_humidity !== null
            ? Math.round(attrs.current_humidity) : null,
        min: attrs.min_humidity !== undefined && attrs.min_humidity !== null ? Math.round(attrs.min_humidity) : 0,
        max: attrs.max_humidity !== undefined && attrs.max_humidity !== null ? Math.round(attrs.max_humidity) : 100,
        action: attrs.action || null,
        mode: attrs.mode || null,
        available_modes: Array.isArray(attrs.available_modes) ? attrs.available_modes : [],
        modes_supported: !!((attrs.supported_features || 0) & HumidifierEntityFeature.MODES)
    };
}

/**
 * Short status for subtitles: what it is doing plus the humidity readings,
 * e.g. "humidifying 41% > 55%"
 */
function statusText(entity) {
    var data = getHumidifierData(entity);
    if (data.unavailable) return entity.state;

    // Avoid ">" here: list subtitles already use it before the relative
    // time, and "41% > 55% > 2m ago" reads as one run of comparisons
    var text = data.action ? data.action : entity.state;
    if (data.current !== null) {
        text += ' ' + data.current + '%';
    }
    if (data.target !== null) {
        text += ', set ' + data.target + '%';
    }
    return text;
}

function callHumidifierService(entity_id, service, data) {
    var appState = AppState.getInstance();
    appState.haws.callService(
        'humidifier',
        service,
        data || {},
        { entity_id: entity_id },
        function(result) {
            Vibe.vibrate('short');
            helpers.log_message('humidifier.' + service + ' called for ' + entity_id);
        },
        function(error) {
            Vibe.vibrate('double');
            helpers.log_message('Error calling humidifier.' + service + ': ' + JSON.stringify(error));
        }
    );
}

/**
 * Pick a target humidity with the native selector
 */
function showHumidityPicker(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) return;
    var data = getHumidifierData(entity);

    NumberField.show({
        title: 'Humidity',
        unit: '%',
        value: data.target !== null ? data.target : data.min,
        min: data.min,
        max: data.max,
        step: 1,
        decimals: 0,
        showBar: true,
        onSet: function(value) {
            appState.haws.callService(
                'humidifier',
                'set_humidity',
                { humidity: value },
                { entity_id: entity_id },
                function(result) {
                    Vibe.vibrate('short');
                    helpers.log_message('Set humidity to ' + value + '% for ' + entity_id);
                    NumberField.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message('Error setting humidity: ' + JSON.stringify(error));
                }
            );
        }
    });
}

function showHumidifierEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Humidifier entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing humidifier entity ${entity_id}`, JSON.stringify(entity, null, 4));

    let humidifierMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    // Mode picker, offered only when the entity advertises MODES
    function showModeMenu() {
        let modeMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Select Mode'
            }]
        });
        let mode_subscription_msg_id = null;

        function buildModeItems(updatedData) {
            if (!updatedData) { return; }
            let items = [];
            updatedData.available_modes.forEach(function(mode) {
                items.push({
                    title: helpers.ucwords(mode.replace(/_/g, ' ')),
                    subtitle: mode === updatedData.mode ? 'Current' : '',
                    on_click: function() {
                        callHumidifierService(entity_id, 'set_mode', { mode: mode });
                    }
                });
            });
            modeMenu.items(0, items);
        }

        modeMenu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('show', function() {
            let current = appState.ha_state_dict[entity_id];
            buildModeItems(current ? getHumidifierData(current) : null);
            mode_subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(eventData) {
                let updated = EntityService.applyCompressedEvent(entity_id, eventData);
                if (updated) {
                    buildModeItems(getHumidifierData(updated));
                }
            }, function(error) {
                helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
            });
        });

        modeMenu.on('hide', function() {
            if (mode_subscription_msg_id) {
                appState.haws.unsubscribe(mode_subscription_msg_id);
            }
        });

        modeMenu.show();
    }

    function buildStatusItem(updatedEntity) {
        let data = getHumidifierData(updatedEntity);
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedEntity.last_changed));
        return {
            title: data.friendly_name,
            subtitle: `${statusText(updatedEntity)} > ${timeStr}`,
            icon: data.is_on ? 'images/icon_switch_on.png' : 'images/icon_switch_off.png',
            on_click: function() {
                callHumidifierService(entity_id, 'toggle');
            }
        };
    }

    // Turning on and off keeps every row in place, so the highlight can
    // stay put, but going unavailable removes the action rows and shifts
    // the rest up; reset the highlight in that case so a press cannot land
    // on a different row than the one aimed at
    let renderedUnavailable = null;

    function updateHumidifierMenuItems(updatedEntity) {
        let data = getHumidifierData(updatedEntity);
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!data.unavailable) {
            menuItems.push({
                title: data.is_on ? 'Turn Off' : 'Turn On',
                on_click: function() {
                    callHumidifierService(entity_id, data.is_on ? 'turn_off' : 'turn_on');
                }
            });

            menuItems.push({
                title: 'Humidity',
                subtitle: data.target !== null ? data.target + '%' : 'NA',
                on_click: function() {
                    showHumidityPicker(entity_id);
                }
            });

            if (data.modes_supported && data.available_modes.length) {
                menuItems.push({
                    title: 'Mode',
                    subtitle: data.mode ? helpers.ucwords(data.mode.replace(/_/g, ' ')) : 'NA',
                    on_click: showModeMenu
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

        humidifierMenu.items(0, menuItems);

        if (renderedUnavailable !== null && renderedUnavailable !== data.unavailable) {
            selectedIndex = 0;
            humidifierMenu.selection(0, 0);
        }
        renderedUnavailable = data.unavailable;
    }

    let selectedIndex = 0;

    humidifierMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Humidifier menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    humidifierMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateHumidifierMenuItems(entity);

        // Only the status row carries the relative time
        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.ha_state_dict[entity_id];
            if (current) {
                humidifierMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Humidifier entity update for ${entity_id}: ${updatedEntity.state}`);
                updateHumidifierMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < humidifierMenu.items(0).length) {
                humidifierMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    humidifierMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    humidifierMenu.show();
}

module.exports.showHumidifierEntity = showHumidifierEntity;
module.exports.statusText = statusText;
