/**
 * MainMenuPage - Home Assistant main menu (Native Bridge)
 */
var simply = require('ui/simply');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var EntityService = require('app/EntityService');
var EntityListPage = require('app/pages/EntityListPage');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');
var helpers = require('app/helpers');

// Lazy imports to avoid circular dependencies
function getFavoritesPage() { return require('app/pages/FavoritesPage'); }
function getAreaMenuPage() { return require('app/pages/AreaMenuPage'); }
function getLabelMenuPage() { return require('app/pages/LabelMenuPage'); }
function getToDoListPage() { return require('app/pages/ToDoListPage'); }
function getAssistPage() { return require('app/pages/AssistPage'); }
function getSettingsMenuPage() { return require('app/pages/SettingsMenuPage'); }

// Default order for main menu items
var DEFAULT_MAIN_MENU_ORDER = [
    'assistant',
    'favorites',
    'areas',
    'labels',
    'todo_lists',
    'people',
    'weather',
    'all_entities',
    'refresh',
    'settings'
];

var SCREEN_ID = 1;

// Singleton state
var mainMenuInstance = null;
var menuItems = [];       // [{title, subtitle, icon, on_click, entity_id}, ...]
var pinnedEntityIndexes = {};
var entityStates = {};
var subscriptionId = null;
var relativeTimeUpdater = null;
var isShowing = false;

function getAppState() {
    return AppState.getInstance();
}

/**
 * Get the ordered list of main menu item IDs
 */
function getMenuOrder() {
    var appState = getAppState();
    var order = [];
    var pinnedEntities = appState.pinnedEntityStore.all();

    if (appState.main_menu_custom_order_enabled &&
        appState.main_menu_order &&
        Array.isArray(appState.main_menu_order)) {
        for (var i = 0; i < appState.main_menu_order.length; i++) {
            var itemId = appState.main_menu_order[i];
            if (itemId.indexOf('pinned:') === 0) {
                var entityId = itemId.substring(7);
                if (pinnedEntities.indexOf(entityId) !== -1) {
                    order.push(itemId);
                }
            } else {
                order.push(itemId);
            }
        }

        for (var j = 0; j < DEFAULT_MAIN_MENU_ORDER.length; j++) {
            var defaultItem = DEFAULT_MAIN_MENU_ORDER[j];
            if (order.indexOf(defaultItem) === -1) {
                var settingsIndex = order.indexOf('settings');
                if (settingsIndex > -1) {
                    order.splice(settingsIndex, 0, defaultItem);
                } else {
                    order.push(defaultItem);
                }
            }
        }

        for (var k = 0; k < pinnedEntities.length; k++) {
            var pinnedId = 'pinned:' + pinnedEntities[k];
            if (order.indexOf(pinnedId) === -1) {
                order.unshift(pinnedId);
            }
        }
    } else {
        order = [];
        if (DEFAULT_MAIN_MENU_ORDER.indexOf('assistant') !== -1) {
            order.push('assistant');
        }
        for (var m = 0; m < pinnedEntities.length; m++) {
            order.push('pinned:' + pinnedEntities[m]);
        }
        for (var n = 0; n < DEFAULT_MAIN_MENU_ORDER.length; n++) {
            if (DEFAULT_MAIN_MENU_ORDER[n] !== 'assistant') {
                order.push(DEFAULT_MAIN_MENU_ORDER[n]);
            }
        }
    }

    return order;
}

/**
 * Get the menu item definition for a given item ID
 */
function getMenuItem(itemId) {
    var appState = getAppState();

    if (itemId.indexOf('pinned:') === 0) {
        var entityId = itemId.substring(7);
        var entity = appState.getEntity(entityId);
        if (!entity) return null;
        var menuItem = EntityService.getMenuItem(entity);
        menuItem.id = itemId;
        menuItem.entity_id = entityId;
        return menuItem;
    }

    switch (itemId) {
        case 'assistant':
            if (!appState.voice_enabled) return null;
            return {
                id: 'assistant',
                title: "Assistant",
                on_click: function() {
                    var Voice = require('ui/voice');
                    Voice.nativeStart();
                }
            };
        case 'favorites':
            var favoriteEntities = appState.favoriteEntityStore.all();
            helpers.log_message('Main menu: favorites check, count=' + (favoriteEntities ? favoriteEntities.length : 0));
            if (!favoriteEntities || !favoriteEntities.length) return null;
            return {
                id: 'favorites',
                title: "Favorites",
                on_click: function() { getFavoritesPage().showFavorites(); }
            };
        case 'areas':
            return {
                id: 'areas',
                title: "Areas",
                on_click: function() { getAreaMenuPage().showAreaMenu(); }
            };
        case 'labels':
            return {
                id: 'labels',
                title: "Labels",
                on_click: function() { getLabelMenuPage().showLabelMenu(); }
            };
        case 'todo_lists':
            return {
                id: 'todo_lists',
                title: "To-Do Lists",
                on_click: function() { getToDoListPage().showToDoLists(); }
            };
        case 'people':
            return {
                id: 'people',
                title: "People",
                on_click: function() {
                    var personEntities = Object.keys(appState.ha_state_dict).filter(function(id) {
                        return id.indexOf('person.') === 0;
                    });
                    EntityListPage.showEntityList("People", personEntities, true, true, true);
                }
            };
        case 'weather':
            var weatherEntities = Object.keys(appState.ha_state_dict).filter(function(id) {
                return id.indexOf('weather.') === 0;
            });
            if (!weatherEntities.length) return null;
            var WeatherPage = require('app/pages/entity/WeatherPage');
            var weatherSubtitle = WeatherPage.getWeatherSubtitle(weatherEntities[0]);
            if (weatherEntities.length === 1) {
                return {
                    id: 'weather',
                    title: "Weather",
                    subtitle: weatherSubtitle,
                    on_click: function() { WeatherPage.showWeatherEntity(weatherEntities[0]); }
                };
            }
            return {
                id: 'weather',
                title: "Weather",
                subtitle: weatherSubtitle,
                on_click: function() {
                    EntityListPage.showEntityList("Weather", weatherEntities, true, true, false);
                }
            };
        case 'all_entities':
            return {
                id: 'all_entities',
                title: "All Entities",
                on_click: function() {
                    var entityKeys = Object.keys(appState.ha_state_dict);
                    var shouldShowDomains = helpers.shouldShowDomainMenu(
                        entityKeys,
                        appState.domain_menu_all_entities,
                        {
                            minEntities: appState.domain_menu_min_entities,
                            minDomains: appState.domain_menu_min_domains
                        }
                    );
                    if (shouldShowDomains) {
                        EntityListPage.showEntityDomainsFromList(entityKeys, "All Entities");
                    } else {
                        EntityListPage.showEntityList("All Entities", false, true, true, true);
                    }
                }
            };
        case 'refresh':
            return {
                id: 'refresh',
                title: "Refresh Entities",
                on_click: function(itemIndex) {
                    var Vibe = require('ui/vibe');
                    var StateService = require('app/StateService');
                    var CacheManager = require('app/CacheManager');

                    simply.impl.nativeMenuUpdate(SCREEN_ID, 0, itemIndex, "Refreshing...", "", 0);

                    StateService.getStates(function(states) {
                        var appState = getAppState();
                        var done = { areas: false, floors: false, devices: false, entities: false, labels: false };

                        function checkDone() {
                            if (done.areas && done.floors && done.devices && done.entities && done.labels) {
                                CacheManager.save();
                                simply.impl.nativeMenuUpdate(SCREEN_ID, 0, itemIndex, "Refresh Entities", "", 0);
                                Vibe.vibrate('short');
                            }
                        }

                        appState.haws.getConfigAreas(function(data) {
                            appState.area_registry_cache = {};
                            if (data.result) {
                                for (var i = 0; i < data.result.length; i++) {
                                    appState.area_registry_cache[data.result[i].area_id] = data.result[i];
                                }
                            }
                            done.areas = true; checkDone();
                        }, function() { done.areas = true; checkDone(); });

                        appState.haws.getConfigFloors(function(data) {
                            appState.floor_registry_cache = {};
                            if (data.result) {
                                for (var i = 0; i < data.result.length; i++) {
                                    appState.floor_registry_cache[data.result[i].floor_id] = data.result[i];
                                }
                            }
                            done.floors = true; checkDone();
                        }, function() { done.floors = true; checkDone(); });

                        appState.haws.getConfigDevices(function(data) {
                            appState.device_registry_cache = {};
                            if (data.result) {
                                for (var i = 0; i < data.result.length; i++) {
                                    appState.device_registry_cache[data.result[i].id] = data.result[i];
                                }
                            }
                            done.devices = true; checkDone();
                        }, function() { done.devices = true; checkDone(); });

                        appState.haws.getConfigEntities(function(data) {
                            appState.entity_registry_cache = {};
                            if (data.result) {
                                for (var i = 0; i < data.result.length; i++) {
                                    appState.entity_registry_cache[data.result[i].entity_id] = data.result[i];
                                }
                            }
                            done.entities = true; checkDone();
                        }, function() { done.entities = true; checkDone(); });

                        appState.haws.getConfigLabels(function(data) {
                            appState.label_registry_cache = {};
                            if (data.result) {
                                for (var i = 0; i < data.result.length; i++) {
                                    appState.label_registry_cache[data.result[i].label_id] = data.result[i];
                                }
                            }
                            done.labels = true; checkDone();
                        }, function() { done.labels = true; checkDone(); });
                    }, null, true);
                }
            };
        case 'settings':
            return {
                id: 'settings',
                title: "Settings",
                on_click: function() { getSettingsMenuPage().showSettingsMenu(); }
            };
        default:
            return null;
    }
}

/**
 * Build and push the main menu via native bridge
 */
function buildMenu() {
    var appState = getAppState();
    helpers.log_message('Main menu: building via native bridge');

    // Reset state
    menuItems = [];
    pinnedEntityIndexes = {};
    entityStates = {};

    // Unsubscribe previous
    if (subscriptionId && appState.haws) {
        appState.haws.unsubscribe(subscriptionId);
        subscriptionId = null;
    }

    if (relativeTimeUpdater) {
        relativeTimeUpdater.destroy();
    }
    relativeTimeUpdater = new RelativeTimeUpdater(function(entity_id) {
        updateEntitySubtitle(entity_id);
    });

    // Build item list
    var menuOrder = getMenuOrder();
    var pinnedEntityIds = [];

    for (var idx = 0; idx < menuOrder.length; idx++) {
        var itemId = menuOrder[idx];
        var item = getMenuItem(itemId);
        if (item) {
            var menuIndex = menuItems.length;
            menuItems.push(item);

            if (itemId.indexOf('pinned:') === 0) {
                var entityId = itemId.substring(7);
                pinnedEntityIndexes[entityId] = menuIndex;
                pinnedEntityIds.push(entityId);
            }
        }
    }

    // Push menu to C
    simply.impl.nativeMenuPush(SCREEN_ID, 'Home Assistant', 1, {
        onSelect: function(section, index) {
            helpers.log_message('Main menu native select: section=' + section + ' index=' + index);
            appState.menuSelections.mainMenu = index;
            var item = menuItems[index];
            if (item && typeof item.on_click === 'function') {
                item.on_click(index);
            }
        },
        onLongSelect: function(section, index) {
            var item = menuItems[index];
            if (item && item.entity_id) {
                EntityService.handleLongPress(item.entity_id);
            }
        },
        onBack: function() {
            helpers.log_message('Main menu: back pressed, cleaning up');
            isShowing = false;
            if (subscriptionId && appState.haws) {
                appState.haws.unsubscribe(subscriptionId);
                subscriptionId = null;
            }
            if (relativeTimeUpdater) {
                relativeTimeUpdater.destroy();
                relativeTimeUpdater = null;
            }
        }
    });

    // Send all items to C
    for (var i = 0; i < menuItems.length; i++) {
        var mi = menuItems[i];
        simply.impl.nativeMenuUpdate(
            SCREEN_ID, 0, i,
            mi.title || '',
            mi.subtitle || '',
            mi.icon || 0
        );
    }

    // Subscribe to pinned entity updates
    if (pinnedEntityIds.length > 0) {
        subscribeToEntities(pinnedEntityIds);
    }

    isShowing = true;
}

/**
 * Subscribe to entity state updates for pinned entities
 */
function subscribeToEntities(entityIds) {
    var appState = getAppState();
    helpers.log_message('Main menu: subscribing to ' + entityIds.length + ' pinned entities');

    subscriptionId = appState.haws.subscribeEntities(
        entityIds,
        function(data) {
            var ev = data.event || {};

            if (ev.a) {
                for (var entity_id in ev.a) {
                    if (pinnedEntityIndexes[entity_id] !== undefined) {
                        var entityData = {
                            entity_id: entity_id,
                            state: ev.a[entity_id].s,
                            attributes: ev.a[entity_id].a || {},
                            last_changed: ev.a[entity_id].lc
                                ? new Date(ev.a[entity_id].lc * 1000).toISOString()
                                : new Date().toISOString()
                        };
                        appState.setEntity(entity_id, entityData);
                        entityStates[entity_id] = entityData;
                        updatePinnedEntity(entity_id, entityData);

                        if (relativeTimeUpdater) {
                            relativeTimeUpdater.register(entity_id, entityData.last_changed);
                        }
                    }
                }
            }

            if (ev.c) {
                for (var cid in ev.c) {
                    if (pinnedEntityIndexes[cid] !== undefined) {
                        var patch = ev.c[cid];
                        var plus = patch["+"] || {};
                        var cur = entityStates[cid] ||
                                  appState.getEntity(cid) ||
                                  { entity_id: cid, state: '', attributes: {} };

                        var entityData = {
                            entity_id: cid,
                            state: plus.s !== undefined ? plus.s : cur.state,
                            attributes: plus.a !== undefined ? plus.a : cur.attributes,
                            last_changed: plus.lc !== undefined
                                ? new Date(plus.lc * 1000).toISOString()
                                : cur.last_changed
                        };
                        appState.setEntity(cid, entityData);
                        entityStates[cid] = entityData;
                        updatePinnedEntity(cid, entityData);

                        if (relativeTimeUpdater) {
                            relativeTimeUpdater.update(cid, entityData.last_changed);
                        }
                    }
                }
            }
        },
        function(error) {
            helpers.log_message('Main menu subscription error: ' + JSON.stringify(error));
        }
    );
}

/**
 * Update a pinned entity's display in the native menu
 */
function updatePinnedEntity(entity_id, entity) {
    var idx = pinnedEntityIndexes[entity_id];
    if (idx === undefined || !isShowing) return;

    var title = entity.attributes.friendly_name || entity.entity_id;
    var subtitle = entity.state;
    if (entity.attributes.unit_of_measurement) {
        subtitle += ' ' + entity.attributes.unit_of_measurement;
    }
    subtitle += ' > ' + helpers.humanDiff(new Date(), new Date(entity.last_changed));
    var icon = EntityService.getIcon(entity);

    simply.impl.nativeMenuUpdate(SCREEN_ID, 0, idx, title, subtitle, icon);
}

/**
 * Update subtitle for relative time
 */
function updateEntitySubtitle(entity_id) {
    var entity = entityStates[entity_id];
    if (!entity) return;
    updatePinnedEntity(entity_id, entity);
}

/**
 * Show the main menu
 */
function showMainMenu() {
    buildMenu();
}

module.exports = {};
module.exports.showMainMenu = showMainMenu;
