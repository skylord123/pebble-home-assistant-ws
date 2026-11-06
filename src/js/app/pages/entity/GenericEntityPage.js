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
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

// Menu selection tracking
var menuSelections = {
    entityMenu: 0
};

function showEntityMenu(entity_id) {
    var appState = AppState.getInstance();
    var favoriteEntityStore = appState.favoriteEntityStore;
    var pinnedEntityStore = appState.pinnedEntityStore;
    let entity = appState.getEntity(entity_id);
    let relativeTimeUpdater = null;
    if(!entity){
        throw new Error(`Entity ${entity_id} not found in appState.ha_state_dict`);
    }

    // Helper function to format date as Y-M-D followed by the time in
    // whichever clock format the user picked
    function formatDateTime(isoString) {
        if (!isoString) return 'N/A';
        var date = new Date(isoString);
        var year = date.getFullYear();
        var month = String(date.getMonth() + 1).padStart(2, '0');
        var day = String(date.getDate()).padStart(2, '0');
        return year + '-' + month + '-' + day + ' ' +
            helpers.formatTimeOfDay(date, { seconds: true });
    }

    // Helper function to get state subtitle with relative time
    function getStateSubtitle(entity) {
        var timeStr = helpers.humanDiff(new Date(), new Date(entity.last_changed));
        return EntityService.getStateText(entity) + ' > ' + timeStr;
    }

    let showEntityMenu = new UI.Menu({
        status: false,
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
        subtitle: getStateSubtitle(entity),
        on_click: function() {
            // Opens the history graph (numeric states) or change list.
            // Not available on aplite due to memory constraints.
            var HistoryPage = require('app/pages/HistoryPage');
            if (HistoryPage.isSupported()) {
                HistoryPage.show(entity_id);
            }
        }
    });
    showEntityMenu.item(0, i++, {
        title: 'Last Changed',
        subtitle: formatDateTime(entity.last_changed)
    });
    showEntityMenu.item(0, i++, {
        title: 'Last Updated',
        subtitle: formatDateTime(entity.last_updated)
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
        domain === "script" ||
        domain === "fan" ||
        domain === "humidifier"
    )
    {
        // Fans register turn_on and turn_off behind FanEntityFeature
        // TURN_ON (32) and TURN_OFF (16), and toggle behind either
        let fanFeatures = entity.attributes.supported_features || 0;
        let canTurnOn = domain !== "fan" || !!(fanFeatures & 32);
        let canTurnOff = domain !== "fan" || !!(fanFeatures & 16);
        let onOffServiceItem = function(title, service) {
            return {
                title: title,
                on_click: function(){
                    appState.haws.callService(
                        domain,
                        service,
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
            };
        };
        if (canTurnOn || canTurnOff) {
            showEntityMenu.item(1, servicesCount++, onOffServiceItem('Toggle', 'toggle'));
        }
        if (canTurnOn) {
            showEntityMenu.item(1, servicesCount++, onOffServiceItem('Turn On', 'turn_on'));
        }
        if (canTurnOff) {
            showEntityMenu.item(1, servicesCount++, onOffServiceItem('Turn Off', 'turn_off'));
        }
    }

    if(domain === "cover") {
        // Cover feature bits from Home Assistant's CoverEntityFeature enum.
        // cover.toggle is only registered for entities supporting OPEN and CLOSE
        const sf = entity.attributes.supported_features || 0;
        const canOpen = !!(sf & 1);   // OPEN
        const canClose = !!(sf & 2);  // CLOSE
        const canStop = !!(sf & 8);   // STOP

        function coverServiceItem(title, service) {
            return {
                title: title,
                on_click: function(){
                    appState.haws.callService(
                        domain,
                        service,
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
            };
        }

        if (canOpen && canClose) {
            showEntityMenu.item(1, servicesCount++, coverServiceItem('Toggle', 'toggle'));
        }
        if (canOpen) {
            showEntityMenu.item(1, servicesCount++, coverServiceItem('Open', 'open_cover'));
        }
        if (canClose) {
            showEntityMenu.item(1, servicesCount++, coverServiceItem('Close', 'close_cover'));
        }
        if (canStop) {
            showEntityMenu.item(1, servicesCount++, coverServiceItem('Stop', 'stop_cover'));
        }
    }

    if(domain === "lock") {
        // LockPage.performAction prompts for a code when the lock has one
        // (lazy require: LockPage imports this module at top level)
        let LockPage = require('app/pages/entity/LockPage');
        let lockServiceItem = function(title, service) {
            return {
                title: title,
                on_click: function() {
                    LockPage.performAction(entity.entity_id, service);
                }
            };
        };
        showEntityMenu.item(1, servicesCount++, lockServiceItem('Lock', 'lock'));
        showEntityMenu.item(1, servicesCount++, lockServiceItem('Unlock', 'unlock'));
        // LockEntityFeature.OPEN
        if ((entity.attributes.supported_features || 0) & 1) {
            showEntityMenu.item(1, servicesCount++, lockServiceItem('Open', 'open'));
        }
    }

    if(domain === "alarm_control_panel") {
        // AlarmPanelPage.performAction handles the code prompt when the
        // panel requires one (lazy require: AlarmPanelPage imports this
        // module at top level)
        let AlarmPanelPage = require('app/pages/entity/AlarmPanelPage');
        let alarmServiceItem = function(title, service) {
            return {
                title: title,
                on_click: function() {
                    AlarmPanelPage.performAction(entity.entity_id, service);
                }
            };
        };
        let alarmFeatures = entity.attributes.supported_features || 0;

        if (entity.state !== 'disarmed') {
            showEntityMenu.item(1, servicesCount++, alarmServiceItem('Disarm', 'alarm_disarm'));
        }
        AlarmPanelPage.ARM_MODES.forEach(function(mode) {
            if (alarmFeatures & mode.feature) {
                showEntityMenu.item(1, servicesCount++, alarmServiceItem(mode.title, mode.service));
            }
        });
    }

    if(
        domain === "select" ||
        domain === "input_select"
    ) {
        let selectServiceItem = function(title, service) {
            return {
                title: title,
                on_click: function() {
                    appState.haws.callService(
                        domain,
                        service,
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
            };
        };
        showEntityMenu.item(1, servicesCount++, selectServiceItem('Next Option', 'select_next'));
        showEntityMenu.item(1, servicesCount++, selectServiceItem('Previous Option', 'select_previous'));
    }

    if(domain === "siren") {
        // SirenEntityFeature: TURN_ON 1, TURN_OFF 2. Home Assistant registers
        // each service only for the entities that advertise the matching bit,
        // and toggle only when both are present
        let sirenFeatures = entity.attributes.supported_features || 0;
        let sirenServiceItem = function(title, service) {
            return {
                title: title,
                on_click: function() {
                    appState.haws.callService(
                        domain,
                        service,
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
            };
        };
        if ((sirenFeatures & 1) && (sirenFeatures & 2)) {
            showEntityMenu.item(1, servicesCount++, sirenServiceItem('Toggle', 'toggle'));
        }
        if (sirenFeatures & 1) {
            showEntityMenu.item(1, servicesCount++, sirenServiceItem('Turn On', 'turn_on'));
        }
        if (sirenFeatures & 2) {
            showEntityMenu.item(1, servicesCount++, sirenServiceItem('Turn Off', 'turn_off'));
        }
    }

    if(domain === "timer") {
        let timerServiceItem = function(title, service, data) {
            return {
                title: title,
                on_click: function() {
                    appState.haws.callService(
                        domain,
                        service,
                        data || {},
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
            };
        };
        showEntityMenu.item(1, servicesCount++, timerServiceItem('Start', 'start'));
        showEntityMenu.item(1, servicesCount++, timerServiceItem('Pause', 'pause'));
        showEntityMenu.item(1, servicesCount++, timerServiceItem('Cancel', 'cancel'));
        showEntityMenu.item(1, servicesCount++, timerServiceItem('Finish', 'finish'));
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

    if(domain === "vacuum") {
        // Home Assistant registers each vacuum service behind its own
        // VacuumEntityFeature bit
        let vacuumFeatures = entity.attributes.supported_features || 0;
        [
            { title: 'Start', service: 'start', feature: 8192 },
            { title: 'Pause', service: 'pause', feature: 4 },
            { title: 'Stop', service: 'stop', feature: 8 },
            { title: 'Return to Base', service: 'return_to_base', feature: 16 },
            { title: 'Locate', service: 'locate', feature: 512 },
            { title: 'Clean Spot', service: 'clean_spot', feature: 1024 }
        ].forEach(function(action) {
            if (!(vacuumFeatures & action.feature)) { return; }
            showEntityMenu.item(1, servicesCount++, {
                title: action.title,
                on_click: function(){
                    helpers.log_message('Calling vacuum.' + action.service + ' for ' + entity.entity_id);
                    appState.haws.callService(
                        'vacuum',
                        action.service,
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            helpers.log_message('vacuum.' + action.service + ' success: ' + JSON.stringify(data));
                            Vibe.vibrate('short');
                        },
                        function(error) {
                            helpers.log_message('vacuum.' + action.service + ' failed: ' + JSON.stringify(error));
                            Vibe.vibrate('double');
                        });
                }
            });
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

    function _renderPluginBtn() {
        if (EntityService.isAlwaysPluginExposed(entity.entity_id)) {
            showEntityMenu.item(2, 2, {
                title: 'Plugin Exposed',
                subtitle: 'Weather is always'
            });
            return;
        }
        var exposed = EntityService.isPluginExposed(entity.entity_id);
        showEntityMenu.item(2, 2, {
            title: exposed ? 'Hide from Plugins' : 'Expose to Plugins',
            subtitle: exposed ? 'Shared with other apps' : '',
            on_click: function(e) {
                EntityService.togglePluginExposed(entity);
                _renderPluginBtn();
            }
        });
    }
    _renderPluginBtn();

    // Releases the subscription and the timer. Every trip into a child page
    // comes back through 'show', so this runs first there too: without it the
    // old subscription is only overwritten, and the server keeps sending on it
    // for the rest of the session.
    function releaseUpdates() {
        if (msg_id) {
            appState.haws.unsubscribe(msg_id);
            msg_id = null;
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    }

    showEntityMenu.on('show', function(){
        releaseUpdates();

        // Create RelativeTimeUpdater for live time updates
        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            // Get current entity and update the state field
            let currentEntity = appState.getEntity(entity_id);
            if (currentEntity) {
                showEntityMenu.item(0, stateIndex, {
                    title: 'State',
                    subtitle: getStateSubtitle(currentEntity)
                });
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        msg_id = EntityService.subscribeEntity(entity.entity_id, function(updatedEntity) {
            // Update state field with new state and relative time
            showEntityMenu.item(0, stateIndex, {
                title: 'State',
                subtitle: getStateSubtitle(updatedEntity)
            });

            // Update last changed and last updated fields
            showEntityMenu.item(0, stateIndex + 1, {
                title: 'Last Changed',
                subtitle: formatDateTime(updatedEntity.last_changed)
            });
            showEntityMenu.item(0, stateIndex + 2, {
                title: 'Last Updated',
                subtitle: formatDateTime(updatedEntity.last_updated)
            });

            // Update the RelativeTimeUpdater with the new timestamp
            if (relativeTimeUpdater) {
                relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
            }
        });
    });
    // 'hide', not 'close': the runtime has no close event, so what used to be
    // here never ran at all
    showEntityMenu.on('hide', releaseUpdates);

    showEntityMenu.show();
}


function showEntityAttributesMenu(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.getEntity(entity_id);
    if(!entity){
        throw new Error(`Entity ${entity_id} not found in appState.ha_state_dict`);
    }

    // Create a menu for the attributes
    let attributesMenu = new UI.Menu({
        status: false,
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

    function releaseUpdates() {
        if (msg_id) {
            appState.haws.unsubscribe(msg_id);
            msg_id = null;
        }
    }

    attributesMenu.on('show', function() {
        // A second 'show' can arrive without a 'hide' in between
        releaseUpdates();
        entity = appState.getEntity(entity_id) || entity;

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
        msg_id = EntityService.subscribeEntity(entity_id, function(updatedEntity) {
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
        });
    });

    attributesMenu.on('hide', releaseUpdates);

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
