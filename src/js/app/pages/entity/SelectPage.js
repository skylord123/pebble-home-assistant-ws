/**
 * SelectPage - select / input_select entity page
 *
 * The entity is literally a list of options, so the page is a menu of
 * them with the active one marked. Picking an option calls
 * select_option; the state subscription moves the Current marker (and
 * picks up changes made elsewhere, since subscribe_entities replays the
 * current state every time the page is shown).
 */
var UI = require('ui');
var Vibe = require('ui/vibe');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

function showSelectEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        domain = entity_id.split('.')[0];
    if (!entity) {
        throw new Error(`Select entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing select entity ${entity_id}`, JSON.stringify(entity, null, 4));

    let selectMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    function selectOption(option) {
        appState.haws.callService(
            domain,
            'select_option',
            { option: option },
            { entity_id: entity_id },
            function(result) {
                Vibe.vibrate('short');
                helpers.log_message(`${domain}.select_option '${option}' called for ${entity_id}`);
            },
            function(error) {
                Vibe.vibrate('double');
                helpers.log_message(`Error calling ${domain}.select_option: ${JSON.stringify(error)}`);
            }
        );
    }

    function updateSelectMenuItems(updatedEntity) {
        let options = updatedEntity.attributes.options || [];
        let menuItems = [];

        options.forEach(function(option) {
            menuItems.push({
                title: option,
                subtitle: option === updatedEntity.state ? 'Current' : '',
                on_click: function() {
                    selectOption(option);
                }
            });
        });

        // The option rows all trigger actions, so history gets its own item
        // (not available on aplite)
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

        selectMenu.items(0, menuItems);
    }

    selectMenu.on('select', function(e) {
        helpers.log_message(`Select menu item ${e.item.title} was selected!`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    selectMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateSelectMenuItems(entity);

        // Subscribe to entity updates; the initial snapshot refreshes any
        // state we missed while hidden
        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Select entity update for ${entity_id}: ${updatedEntity.state}`);
                updateSelectMenuItems(updatedEntity);
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });
    });

    selectMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
    });

    selectMenu.show();
}

module.exports.showSelectEntity = showSelectEntity;
