/**
 * ValvePage - valve entity control page
 *
 * Shaped like the cover page, but every action is gated on its own feature
 * bit the way Home Assistant registers them, and toggle is only offered to
 * valves that can both open and close. Valves that do not report a
 * position simply have no position row.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var NumberField = require('ui/numberfield');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// ValveEntityFeature bitfield values from Home Assistant
var ValveEntityFeature = {
    OPEN: 1,
    CLOSE: 2,
    SET_POSITION: 4,
    STOP: 8
};

function getValveData(entity) {
    var attrs = entity.attributes || {};
    var features = attrs.supported_features || 0;
    var position = null;
    if (attrs.current_position !== undefined && attrs.current_position !== null) {
        position = Math.round(attrs.current_position);
    }
    return {
        friendly_name: attrs.friendly_name || entity.entity_id,
        state: entity.state,
        is_closed: entity.state === 'closed',
        unavailable: entity.state === 'unavailable' || entity.state === 'unknown',
        position: position,
        can_open: !!(features & ValveEntityFeature.OPEN),
        can_close: !!(features & ValveEntityFeature.CLOSE),
        can_stop: !!(features & ValveEntityFeature.STOP),
        can_set_position: !!(features & ValveEntityFeature.SET_POSITION)
    };
}

/**
 * State plus how far open it is, for subtitles: "open 60%". Valves that do
 * not report a position just show their state.
 */
function statusText(entity) {
    var data = getValveData(entity);
    if (data.unavailable) return entity.state;
    if (data.position !== null && data.position > 0 && data.position < 100) {
        return entity.state + ' ' + data.position + '%';
    }
    return entity.state;
}

function callValveService(entity_id, service, data) {
    var appState = AppState.getInstance();
    appState.haws.callService(
        'valve',
        service,
        data || {},
        { entity_id: entity_id },
        function(result) {
            Vibe.vibrate('short');
            helpers.log_message('valve.' + service + ' called for ' + entity_id);
        },
        function(error) {
            Vibe.vibrate('double');
            helpers.log_message('Error calling valve.' + service + ': ' + JSON.stringify(error));
        }
    );
}

/**
 * Long press: toggle when the valve can do both, otherwise whichever single
 * direction it supports, so a valve that only opens still has its action
 */
function quickAction(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('quickAction: entity ' + entity_id + ' not found in state dict');
        return;
    }
    var data = getValveData(entity);
    if (data.unavailable) {
        helpers.log_message('Valve ' + entity_id + ' in state ' + entity.state + ' - no action taken');
        return;
    }

    if (data.can_open && data.can_close) {
        callValveService(entity_id, 'toggle');
    } else if (data.can_open) {
        callValveService(entity_id, 'open_valve');
    } else if (data.can_close) {
        callValveService(entity_id, 'close_valve');
    } else {
        helpers.log_message('Valve ' + entity_id + ' supports no open or close - no action taken');
    }
}

function showPositionPicker(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) return;
    var data = getValveData(entity);

    NumberField.show({
        title: 'Position',
        unit: '%',
        value: data.position !== null ? data.position : 0,
        min: 0,
        max: 100,
        step: 1,
        decimals: 0,
        showBar: true,
        onSet: function(value) {
            appState.haws.callService(
                'valve',
                'set_valve_position',
                { position: value },
                { entity_id: entity_id },
                function(result) {
                    Vibe.vibrate('short');
                    helpers.log_message('Set valve position to ' + value + '% for ' + entity_id);
                    NumberField.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message('Error setting valve position: ' + JSON.stringify(error));
                }
            );
        }
    });
}

function showValveEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Valve entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing valve entity ${entity_id}`, JSON.stringify(entity, null, 4));

    let valveMenu = new UI.Menu({
        status: false,
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    function buildStatusItem(updatedEntity) {
        let data = getValveData(updatedEntity);
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

    function updateValveMenuItems(updatedEntity) {
        let data = getValveData(updatedEntity);
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!data.unavailable) {
            if (data.can_open) {
                menuItems.push({
                    title: 'Open',
                    on_click: function() { callValveService(entity_id, 'open_valve'); }
                });
            }
            if (data.can_close) {
                menuItems.push({
                    title: 'Close',
                    on_click: function() { callValveService(entity_id, 'close_valve'); }
                });
            }
            if (data.can_stop) {
                menuItems.push({
                    title: 'Stop',
                    on_click: function() { callValveService(entity_id, 'stop_valve'); }
                });
            }
            if (data.can_set_position) {
                menuItems.push({
                    title: 'Position',
                    subtitle: data.position !== null ? data.position + '%' : 'NA',
                    on_click: function() { showPositionPicker(entity_id); }
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

        valveMenu.items(0, menuItems);

        // The action rows only come and go with availability, so the
        // highlight is left where it is otherwise
        if (renderedUnavailable !== null && renderedUnavailable !== data.unavailable) {
            selectedIndex = 0;
            valveMenu.selection(0, 0);
        }
        renderedUnavailable = data.unavailable;
    }

    let selectedIndex = 0;

    valveMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Valve menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    valveMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateValveMenuItems(entity);

        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.ha_state_dict[entity_id];
            if (current) {
                valveMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Valve entity update for ${entity_id}: ${updatedEntity.state}`);
                updateValveMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < valveMenu.items(0).length) {
                valveMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    valveMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    valveMenu.show();
}

module.exports.showValveEntity = showValveEntity;
module.exports.quickAction = quickAction;
module.exports.statusText = statusText;
