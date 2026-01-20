/**
 * GenericEntityPage - Generic entity detail page
 *
 * Features:
 * - Entity state display
 * - Entity attributes display
 * - Service calls for toggleable entities
 * - Real-time state subscription
 */
var UI = require('ui');
var Vibe = require('ui/vibe');

var BaseEntityPage = require('app/pages/entity/BaseEntityPage');
var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');

// Menu selection tracking
var menuSelections = {
    entityMenu: 0
};

function showEntityMenu(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id];
    if(!entity){
        throw new Error(`Entity ${entity_id} not found in appState.ha_state_dict`);
    }

    // Set Menu colors
    let showEntityMenu = new UI.Menu({
        status: false,
        backgroundColor: 'white',
        textColor: 'black',
        highlightBackgroundColor: 'black',
        highlightTextColor: 'white',
        sections: [
            {
                title: entity.attributes.friendly_name ? entity.attributes.friendly_name : entity.entity_id
            },
            {
                title: 'Services'
            },
            {
                title: 'Extra'
            }
        ]
    });

    let msg_id = null;

    // Store selection when navigating to a submenu
    showEntityMenu.on('select', function(e) {
        // Handle on_click function if it exists
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
            return;
        }
    });

    //Object.getOwnPropertyNames(entity);
    //Object.getOwnPropertyNames(entity.attributes);
    var arr = Object.getOwnPropertyNames(entity.attributes);
    //var arr = Object.getOwnPropertyNames(device_status.attributes);
    var i = 0;
    helpers.log_message(`Showing entity ${entity.entity_id}: ${JSON.stringify(entity, null, 4)}`)

    showEntityMenu.item(0, i++, {
        title: 'Entity ID',
        subtitle: entity.entity_id
    });
    let stateIndex = i;
    showEntityMenu.item(0, i++, {
        title: 'State',
        subtitle: entity.state + (entity.attributes.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : '')
    });
    showEntityMenu.item(0, i++, {
        title: 'Last Changed',
        subtitle: entity.last_changed
    });
    showEntityMenu.item(0, i++, {
        title: 'Last Updated',
        subtitle: entity.last_updated
    });
    showEntityMenu.item(0, i++, {
        title: 'Attributes',
        subtitle: `${arr.length} attributes`,
        on_click: function() {
            showEntityAttributesMenu(entity_id);
        }
    });

    //entity: {"attributes":{"friendly_name":"Family Room","icon":"mdi:lightbulb"},"entity_id":"switch.family_room","last_changed":"2016-10-12T02:03:26.849071+00:00","last_updated":"2016-10-12T02:03:26.849071+00:00","state":"off"}
    helpers.log_message("This Device entity_id: " + entity.entity_id);
    var device = entity.entity_id.split('.'),
        domain = device[0];

    let servicesCount = 0;
    if(
        domain === "button" ||
        domain === "input_button"
    ) {
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Press',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'press',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        // Success!
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
    }

    if (
        domain === "switch" ||
        domain === "input_boolean" ||
        domain === "automation" ||
        domain === "script"
    )
    {
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Toggle',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'toggle',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                        // Success!
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Turn On',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'turn_on',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                        // Success!
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Turn Off',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'turn_off',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
    }

    if(domain === "lock") {
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Lock',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'lock',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                        // Success!
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Unlock',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'unlock',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
    }

    if(domain === "scene") {
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Turn On',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'turn_on',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                        // Success!
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Apply',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'apply',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                        // Success!
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
    }

    if(
        domain === "input_number" ||
        domain === "counter"
    ) {
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Increment',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'increment',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Decrement',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'decrement',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
    }

    if(domain === "counter") {
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Reset',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'reset',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
    }

    if(
        domain === "automation"
    ) {
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Trigger',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'trigger',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                        // Success!
                        Vibe.vibrate('short');
                        helpers.log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
    }

    if(
        domain === "automation" ||
        domain === "script" ||
        domain === "button" ||
        domain === "input_boolean"
    ) {
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Reload',
            on_click: function(){
                appState.haws.callService(
                    domain,
                    'reload',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                        // Success!
                        helpers.log_message(JSON.stringify(data));
                        Vibe.vibrate('short');
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        helpers.log_message('no response');
                    });
            }
        });
    }

    if(domain === "vacuum") {
        showEntityMenu.item(1, servicesCount++, {
            title: 'Start',
            on_click: function(){
                helpers.log_message('Calling vacuum.start for ' + entity.entity_id);
                appState.haws.callService(
                    'vacuum',
                    'start',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        helpers.log_message('vacuum.start success: ' + JSON.stringify(data));
                        Vibe.vibrate('short');
                    },
                    function(error) {
                        helpers.log_message('vacuum.start failed: ' + JSON.stringify(error));
                        Vibe.vibrate('double');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, {
            title: 'Pause',
            on_click: function(){
                helpers.log_message('Calling vacuum.pause for ' + entity.entity_id);
                appState.haws.callService(
                    'vacuum',
                    'pause',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        helpers.log_message('vacuum.pause success: ' + JSON.stringify(data));
                        Vibe.vibrate('short');
                    },
                    function(error) {
                        helpers.log_message('vacuum.pause failed: ' + JSON.stringify(error));
                        Vibe.vibrate('double');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, {
            title: 'Stop',
            on_click: function(){
                helpers.log_message('Calling vacuum.stop for ' + entity.entity_id);
                appState.haws.callService(
                    'vacuum',
                    'stop',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        helpers.log_message('vacuum.stop success: ' + JSON.stringify(data));
                        Vibe.vibrate('short');
                    },
                    function(error) {
                        helpers.log_message('vacuum.stop failed: ' + JSON.stringify(error));
                        Vibe.vibrate('double');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, {
            title: 'Return to Base',
            on_click: function(){
                helpers.log_message('Calling vacuum.return_to_base for ' + entity.entity_id);
                appState.haws.callService(
                    'vacuum',
                    'return_to_base',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        helpers.log_message('vacuum.return_to_base success: ' + JSON.stringify(data));
                        Vibe.vibrate('short');
                    },
                    function(error) {
                        helpers.log_message('vacuum.return_to_base failed: ' + JSON.stringify(error));
                        Vibe.vibrate('double');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, {
            title: 'Locate',
            on_click: function(){
                helpers.log_message('Calling vacuum.locate for ' + entity.entity_id);
                appState.haws.callService(
                    'vacuum',
                    'locate',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        helpers.log_message('vacuum.locate success: ' + JSON.stringify(data));
                        Vibe.vibrate('short');
                    },
                    function(error) {
                        helpers.log_message('vacuum.locate failed: ' + JSON.stringify(error));
                        Vibe.vibrate('double');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, {
            title: 'Clean Spot',
            on_click: function(){
                helpers.log_message('Calling vacuum.clean_spot for ' + entity.entity_id);
                appState.haws.callService(
                    'vacuum',
                    'clean_spot',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        helpers.log_message('vacuum.clean_spot success: ' + JSON.stringify(data));
                        Vibe.vibrate('short');
                    },
                    function(error) {
                        helpers.log_message('vacuum.clean_spot failed: ' + JSON.stringify(error));
                        Vibe.vibrate('double');
                    });
            }
        });
    }

    function _renderFavoriteBtn() {
        showEntityMenu.item(2, 0, {
            title: (favoriteEntityStore.has(entity.entity_id) ? 'Remove' : 'Add') + ' Favorite',
            on_click: function(e) {
                EntityService.toggleFavorite(entity);
                _renderFavoriteBtn();
            }
        });
    }
    _renderFavoriteBtn();

    function _renderPinnedBtn() {
        showEntityMenu.item(2, 1, {
            title: (pinnedEntityStore.has(entity.entity_id) ? 'Unpin from' : 'Pin to') + ' Main Menu',
            on_click: function(e) {
                EntityService.togglePinned(entity);
                _renderPinnedBtn();
            }
        });
    }
    _renderPinnedBtn();

    showEntityMenu.on('show', function(){
        msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity.entity_id,
            },
        }, function(data) {
            // helpers.log_message(`Entity update for ${entity.entity_id}`);

            showEntityMenu.item(0, stateIndex, {
                title: 'State',
                subtitle: `${data.event.variables.trigger.to_state.state}` + (entity.attributes.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : '')
            });
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity.entity_id}]: ` + JSON.stringify(error));
        });
    });
    showEntityMenu.on('close', function(){
        if(msg_id) {
            appState.haws.unsubscribe(msg_id);
        }
    });

    showEntityMenu.show();
}


function showEntityAttributesMenu(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id];
    if(!entity){
        throw new Error(`Entity ${entity_id} not found in appState.ha_state_dict`);
    }

    // Create a menu for the attributes
    let attributesMenu = new UI.Menu({
        status: false,
        backgroundColor: 'white',
        textColor: 'black',
        highlightBackgroundColor: 'black',
        highlightTextColor: 'white',
        sections: [{
            title: 'Attributes'
        }]
    });

    // Handle select events
    attributesMenu.on('select', function(e) {
        // Handle on_click function if it exists
        if(e.item && typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    let msg_id = null;

    attributesMenu.on('show', function() {
        var arr = Object.getOwnPropertyNames(entity.attributes);
        helpers.log_message(`Showing attributes for ${entity.entity_id}: ${arr.length} attributes`);

        // Add each attribute to the menu
        for (let i = 0; i < arr.length; i++) {
            attributesMenu.item(0, i, {
                title: arr[i],
                subtitle: entity.attributes[arr[i]],
                attribute_name: arr[i] // Store attribute name for updates
            });
        }

        // Subscribe to entity updates
        msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedEntity = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedEntity;

                // Update all attribute values
                for (let i = 0; i < attributesMenu.items(0).length; i++) {
                    const item = attributesMenu.item(0, i);
                    if (item.attribute_name && updatedEntity.attributes[item.attribute_name] !== undefined) {
                        attributesMenu.item(0, i, {
                            title: item.attribute_name,
                            subtitle: updatedEntity.attributes[item.attribute_name],
                            attribute_name: item.attribute_name
                        });
                    }
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });
    });

    attributesMenu.on('hide', function() {
        // Unsubscribe from entity updates when menu is closed
        if (msg_id) {
            appState.haws.unsubscribe(msg_id);
        }
    });

    attributesMenu.show();
}


// Entity domains list - delegate to EntityListPage module
function showEntityDomainsFromList(entity_id_list, title) {
    EntityListPage.showEntityDomainsFromList(entity_id_list, title);
}

// Entity display utility functions - delegate to EntityService module
function getEntityTitle(entity) {
    return EntityService.getTitle(entity);
}

function getEntitySubtitle(entity, includeRelativeTime) {
    return EntityService.getSubtitle(entity, includeRelativeTime);
}

function getEntityMenuItem(entity, options) {
    return EntityService.getMenuItem(entity, options);
}

function updateEntityMenuItem(menu, sectionIndex, itemIndex, entity, options) {
    EntityService.updateMenuItem(menu, sectionIndex, itemIndex, entity, options);
}

function handleEntityLongPress(entity_id) {
    EntityService.handleLongPress(entity_id);
}

function getEntityIcon(entity) {
    return EntityService.getIcon(entity);
}


module.exports.showEntityMenu = showEntityMenu;
module.exports.showEntityAttributesMenu = showEntityAttributesMenu;
