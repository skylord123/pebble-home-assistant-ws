/**
 * NumberPage - number / input_number entity page
 *
 * A small menu (current value, History, More) whose status row opens the
 * native number selector honoring the entity's min/max/step and showing
 * its unit. Select sets the value via set_value.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var NumberField = require('ui/numberfield');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// Decimal places implied by the step (0.5 -> 1, 0.05 -> 2, 1 -> 0)
function stepDecimals(step) {
    var s = String(step);
    var i = s.indexOf('.');
    return i === -1 ? 0 : s.length - i - 1;
}

function getNumberData(updatedEntity) {
    let attrs = updatedEntity.attributes;
    let step = parseFloat(attrs.step) || 1;
    return {
        friendly_name: attrs.friendly_name || updatedEntity.entity_id,
        value: parseFloat(updatedEntity.state),
        min: attrs.min !== undefined && attrs.min !== null ? parseFloat(attrs.min) : 0,
        max: attrs.max !== undefined && attrs.max !== null ? parseFloat(attrs.max) : 100,
        step: step,
        decimals: stepDecimals(step),
        unit: attrs.unit_of_measurement ? ' ' + attrs.unit_of_measurement : ''
    };
}

function showNumberEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Number entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing number entity ${entity_id}`, JSON.stringify(entity, null, 4));

    let numberMenu = new UI.Menu({
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
        return {
            title: updatedEntity.attributes.friendly_name || entity_id,
            subtitle: EntityService.getSubtitle(updatedEntity),
            on_click: function() {
                showValueEditor(entity_id);
            }
        };
    }

    function updateNumberMenuItems(updatedEntity) {
        let menuItems = [];

        menuItems.push(buildStatusItem(updatedEntity));

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

        numberMenu.items(0, menuItems);
    }

    numberMenu.on('select', function(e) {
        helpers.log_message(`Number menu item ${e.item.title} was selected!`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    numberMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateNumberMenuItems(entity);

        // Only the status row's time suffix changes on a tick
        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let currentEntity = appState.ha_state_dict[entity_id];
            if (currentEntity) {
                numberMenu.item(0, 0, buildStatusItem(currentEntity));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Number entity update for ${entity_id}: ${updatedEntity.state}`);
                updateNumberMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });
    });

    numberMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    numberMenu.show();
}

// Native number selector (simply_number.c): all adjustment runs on the
// watch with hold-to-repeat, only the final value comes back. Also opened
// directly by a long press on a number entity in any list.
function showValueEditor(entity_id) {
    var appState = AppState.getInstance();
    var domain = entity_id.split('.')[0];
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message(`showValueEditor: entity ${entity_id} not found in state dict`);
        return;
    }

    let data = getNumberData(entity);

    // Follow changes made elsewhere while the selector is open; the watch
    // ignores them while the user is actively adjusting
    let subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(eventData) {
        let updatedEntity = EntityService.applyCompressedEvent(entity_id, eventData);
        if (updatedEntity) {
            let value = parseFloat(updatedEntity.state);
            if (!isNaN(value)) {
                NumberField.value(value);
            }
        }
    }, function(error) {
        helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
    });

    function cleanup() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
            subscription_msg_id = null;
        }
    }

    NumberField.show({
        title: data.friendly_name,
        unit: data.unit,
        value: isNaN(data.value) ? data.min : data.value,
        min: data.min,
        max: data.max,
        step: data.step,
        decimals: data.decimals,
        showBar: true,
        onSet: function(value) {
            appState.haws.callService(
                domain,
                'set_value',
                { value: value },
                { entity_id: entity_id },
                function(result) {
                    Vibe.vibrate('short');
                    helpers.log_message(`${domain}.set_value ${value} called for ${entity_id}`);
                    cleanup();
                    NumberField.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message(`Error calling ${domain}.set_value: ${JSON.stringify(error)}`);
                }
            );
        },
        onCancel: cleanup
    });
}

module.exports.showNumberEntity = showNumberEntity;
module.exports.showValueEditor = showValueEditor;
