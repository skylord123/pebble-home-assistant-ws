/**
 * CounterPage - counter entity control page
 *
 * Increment, decrement and reset take no arguments and move the counter by
 * its own configured step, clamping at whichever bounds are set. Setting a
 * value outright is offered too, though a counter may have no minimum or
 * maximum at all, in which case the picker needs bounds of its own.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var NumberField = require('ui/numberfield');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// Where the picker stops for a counter that names no maximum of its own.
// Holding a button accelerates, so this stays reachable.
var UNBOUNDED_MAX = 9999;

function getCounterData(entity) {
    var attrs = entity.attributes || {};
    var num = function(v) {
        return (v !== undefined && v !== null) ? parseInt(v, 10) : null;
    };
    var value = parseInt(entity.state, 10);
    return {
        friendly_name: attrs.friendly_name || entity.entity_id,
        unavailable: entity.state === 'unavailable' || entity.state === 'unknown' || isNaN(value),
        value: isNaN(value) ? 0 : value,
        step: num(attrs.step) !== null ? num(attrs.step) : 1,
        initial: num(attrs.initial),
        minimum: num(attrs.minimum),
        maximum: num(attrs.maximum)
    };
}

function callCounterService(entity_id, service, data) {
    var appState = AppState.getInstance();
    appState.haws.callService(
        'counter',
        service,
        data || {},
        { entity_id: entity_id },
        function(result) {
            Vibe.vibrate('short');
            helpers.log_message('counter.' + service + ' called for ' + entity_id);
        },
        function(error) {
            Vibe.vibrate('double');
            helpers.log_message('Error calling counter.' + service + ': ' + JSON.stringify(error));
        }
    );
}

/**
 * Long press counts up, which is what a counter is usually for
 */
function quickAction(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('quickAction: entity ' + entity_id + ' not found in state dict');
        return;
    }
    if (getCounterData(entity).unavailable) {
        helpers.log_message('Counter ' + entity_id + ' in state ' + entity.state + ' - no action taken');
        return;
    }
    callCounterService(entity_id, 'increment');
}

function showValuePicker(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) return;
    var data = getCounterData(entity);

    // Both bounds are optional on a counter, so the picker falls back to
    // something it can actually work between
    var min = data.minimum !== null ? data.minimum : 0;
    var max = data.maximum !== null ? data.maximum : Math.max(UNBOUNDED_MAX, data.value);

    NumberField.show({
        title: 'Set Value',
        unit: '',
        value: data.value,
        min: min,
        max: max,
        step: data.step,
        decimals: 0,
        showBar: true,
        onSet: function(value) {
            appState.haws.callService(
                'counter',
                'set_value',
                { value: value },
                { entity_id: entity_id },
                function(result) {
                    Vibe.vibrate('short');
                    helpers.log_message('Set counter to ' + value + ' for ' + entity_id);
                    NumberField.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message('Error setting counter: ' + JSON.stringify(error));
                }
            );
        }
    });
}

function showCounterEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Counter entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing counter entity ${entity_id}`, JSON.stringify(entity, null, 4));

    let counterMenu = new UI.Menu({
        status: false,
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    function buildStatusItem(updatedEntity) {
        let data = getCounterData(updatedEntity);
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedEntity.last_changed));
        return {
            title: data.friendly_name,
            subtitle: `${updatedEntity.state} > ${timeStr}`,
            icon: EntityService.getIcon(updatedEntity),
            on_click: function() {
                callCounterService(entity_id, 'increment');
            }
        };
    }

    let renderedUnavailable = null;

    function updateCounterMenuItems(updatedEntity) {
        let data = getCounterData(updatedEntity);
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!data.unavailable) {
            let byStep = data.step !== 1 ? 'by ' + data.step : '';
            menuItems.push({
                title: 'Increment',
                subtitle: byStep,
                on_click: function() { callCounterService(entity_id, 'increment'); }
            });
            menuItems.push({
                title: 'Decrement',
                subtitle: byStep,
                on_click: function() { callCounterService(entity_id, 'decrement'); }
            });
            menuItems.push({
                title: 'Set Value',
                on_click: function() { showValuePicker(entity_id); }
            });
            menuItems.push({
                title: 'Reset',
                subtitle: data.initial !== null ? 'Back to ' + data.initial : '',
                on_click: function() { callCounterService(entity_id, 'reset'); }
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

        counterMenu.items(0, menuItems);

        if (renderedUnavailable !== null && renderedUnavailable !== data.unavailable) {
            selectedIndex = 0;
            counterMenu.selection(0, 0);
        }
        renderedUnavailable = data.unavailable;
    }

    let selectedIndex = 0;

    counterMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Counter menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    counterMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateCounterMenuItems(entity);

        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.ha_state_dict[entity_id];
            if (current) {
                counterMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Counter entity update for ${entity_id}: ${updatedEntity.state}`);
                updateCounterMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < counterMenu.items(0).length) {
                counterMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    counterMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    counterMenu.show();
}

module.exports.showCounterEntity = showCounterEntity;
module.exports.quickAction = quickAction;
