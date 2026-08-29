/**
 * WaterHeaterPage - water_heater entity control page
 *
 * A stripped down climate page: the entity's state is its operation mode
 * rather than on or off, and there is no toggle service, so turning one
 * off means calling turn_off directly. Every row is gated on its own
 * feature bit the way Home Assistant registers the services.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var NumberField = require('ui/numberfield');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// WaterHeaterEntityFeature bitfield values from Home Assistant
var WaterHeaterEntityFeature = {
    TARGET_TEMPERATURE: 1,
    OPERATION_MODE: 2,
    AWAY_MODE: 4,
    ON_OFF: 8
};

function stepDecimals(step) {
    var s = String(step);
    var i = s.indexOf('.');
    return i === -1 ? 0 : s.length - i - 1;
}

function getWaterHeaterData(entity) {
    var attrs = entity.attributes || {};
    var features = attrs.supported_features || 0;
    var step = parseFloat(attrs.target_temp_step) || 0.5;
    var num = function(v) {
        return (v !== undefined && v !== null) ? parseFloat(v) : null;
    };
    return {
        friendly_name: attrs.friendly_name || entity.entity_id,
        // The state is the operation mode, with "off" when it is off
        state: entity.state,
        is_off: entity.state === 'off',
        unavailable: entity.state === 'unavailable' || entity.state === 'unknown',
        current: num(attrs.current_temperature),
        target: num(attrs.temperature),
        min: num(attrs.min_temp) !== null ? num(attrs.min_temp) : 30,
        max: num(attrs.max_temp) !== null ? num(attrs.max_temp) : 60,
        step: step,
        decimals: stepDecimals(step),
        operation_list: Array.isArray(attrs.operation_list) ? attrs.operation_list : [],
        // The attribute reads "on" or "off" even though the service that
        // sets it takes a boolean
        away: attrs.away_mode === 'on',
        has_away_attr: attrs.away_mode !== undefined,
        can_set_temperature: !!(features & WaterHeaterEntityFeature.TARGET_TEMPERATURE),
        can_set_operation: !!(features & WaterHeaterEntityFeature.OPERATION_MODE),
        can_set_away: !!(features & WaterHeaterEntityFeature.AWAY_MODE),
        can_turn_on_off: !!(features & WaterHeaterEntityFeature.ON_OFF)
    };
}

function modeLabel(mode) {
    return helpers.ucwords(String(mode).replace(/_/g, ' '));
}

function formatTemp(value, decimals) {
    if (value === null) return null;
    return value.toFixed(decimals) + '°';
}

/**
 * Operation mode plus the readings, e.g. "eco 49°, set 60°"
 */
function statusText(entity) {
    var data = getWaterHeaterData(entity);
    if (data.unavailable) return entity.state;

    var text = modeLabel(data.state);
    var current = formatTemp(data.current, data.decimals);
    var target = formatTemp(data.target, data.decimals);
    if (current) { text += ' ' + current; }
    if (target) { text += ', set ' + target; }
    if (data.away) { text += ', away'; }
    return text;
}

function callWaterHeaterService(entity_id, service, data) {
    var appState = AppState.getInstance();
    appState.haws.callService(
        'water_heater',
        service,
        data || {},
        { entity_id: entity_id },
        function(result) {
            Vibe.vibrate('short');
            helpers.log_message('water_heater.' + service + ' called for ' + entity_id);
        },
        function(error) {
            Vibe.vibrate('double');
            helpers.log_message('Error calling water_heater.' + service + ': ' + JSON.stringify(error));
        }
    );
}

/**
 * Long press: there is no toggle service, so pick the direction from the
 * current state. Water heaters without on/off are left alone.
 */
function quickAction(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('quickAction: entity ' + entity_id + ' not found in state dict');
        return;
    }
    var data = getWaterHeaterData(entity);
    if (data.unavailable || !data.can_turn_on_off) {
        helpers.log_message('Water heater ' + entity_id + ' cannot be turned on or off - no action taken');
        return;
    }
    callWaterHeaterService(entity_id, data.is_off ? 'turn_on' : 'turn_off');
}

function showTemperaturePicker(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) return;
    var data = getWaterHeaterData(entity);

    NumberField.show({
        title: 'Temperature',
        unit: '°',
        value: data.target !== null ? data.target : data.min,
        min: data.min,
        max: data.max,
        step: data.step,
        decimals: data.decimals,
        showBar: true,
        onSet: function(value) {
            appState.haws.callService(
                'water_heater',
                'set_temperature',
                { temperature: value },
                { entity_id: entity_id },
                function(result) {
                    Vibe.vibrate('short');
                    helpers.log_message('Set water heater temperature to ' + value + ' for ' + entity_id);
                    NumberField.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message('Error setting water heater temperature: ' + JSON.stringify(error));
                }
            );
        }
    });
}

function showWaterHeaterEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Water heater entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing water heater entity ${entity_id}`, JSON.stringify(entity, null, 4));

    let heaterMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    function showOperationMenu() {
        let opMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Operation Mode'
            }]
        });
        let op_subscription_msg_id = null;

        function buildItems(current) {
            if (!current) { return; }
            let data = getWaterHeaterData(current);
            let items = [];
            data.operation_list.forEach(function(mode) {
                items.push({
                    title: modeLabel(mode),
                    subtitle: mode === data.state ? 'Current' : '',
                    on_click: function() {
                        callWaterHeaterService(entity_id, 'set_operation_mode', { operation_mode: mode });
                    }
                });
            });
            opMenu.items(0, items);
        }

        opMenu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        opMenu.on('show', function() {
            buildItems(appState.ha_state_dict[entity_id]);
            op_subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(eventData) {
                let updated = EntityService.applyCompressedEvent(entity_id, eventData);
                if (updated) { buildItems(updated); }
            }, function(error) {
                helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
            });
        });

        opMenu.on('hide', function() {
            if (op_subscription_msg_id) {
                appState.haws.unsubscribe(op_subscription_msg_id);
            }
        });

        opMenu.show();
    }

    function buildStatusItem(updatedEntity) {
        let data = getWaterHeaterData(updatedEntity);
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedEntity.last_changed));
        return {
            title: data.friendly_name,
            subtitle: `${statusText(updatedEntity)} > ${timeStr}`,
            icon: EntityService.getIcon(updatedEntity),
            on_click: function() {
                quickAction(entity_id);
            }
        };
    }

    let renderedUnavailable = null;

    function updateHeaterMenuItems(updatedEntity) {
        let data = getWaterHeaterData(updatedEntity);
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!data.unavailable) {
            if (data.can_turn_on_off) {
                menuItems.push({
                    title: data.is_off ? 'Turn On' : 'Turn Off',
                    on_click: function() {
                        callWaterHeaterService(entity_id, data.is_off ? 'turn_on' : 'turn_off');
                    }
                });
            }
            if (data.can_set_temperature) {
                menuItems.push({
                    title: 'Temperature',
                    subtitle: formatTemp(data.target, data.decimals) || 'NA',
                    on_click: function() { showTemperaturePicker(entity_id); }
                });
            }
            if (data.can_set_operation && data.operation_list.length) {
                menuItems.push({
                    title: 'Operation Mode',
                    subtitle: modeLabel(data.state),
                    on_click: showOperationMenu
                });
            }
            if (data.can_set_away) {
                menuItems.push({
                    title: 'Away Mode',
                    subtitle: data.away ? 'On' : 'Off',
                    on_click: function() {
                        // The attribute reads on or off, the service wants a
                        // boolean
                        callWaterHeaterService(entity_id, 'set_away_mode', { away_mode: !data.away });
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

        heaterMenu.items(0, menuItems);

        if (renderedUnavailable !== null && renderedUnavailable !== data.unavailable) {
            selectedIndex = 0;
            heaterMenu.selection(0, 0);
        }
        renderedUnavailable = data.unavailable;
    }

    let selectedIndex = 0;

    heaterMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Water heater menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    heaterMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateHeaterMenuItems(entity);

        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.ha_state_dict[entity_id];
            if (current) {
                heaterMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Water heater entity update for ${entity_id}: ${updatedEntity.state}`);
                updateHeaterMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < heaterMenu.items(0).length) {
                heaterMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    heaterMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    heaterMenu.show();
}

module.exports.showWaterHeaterEntity = showWaterHeaterEntity;
module.exports.quickAction = quickAction;
module.exports.statusText = statusText;
