/**
 * MainMenuPage - Home Assistant main menu
 */
var UI = require('ui');
var BasePage = require('app/pages/BasePage');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var EntityService = require('app/EntityService');
var EntityListPage = require('app/pages/EntityListPage');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');
var helpers = require('app/helpers');
var Settings = require('settings');

// Lazy imports to avoid circular dependencies
function getFavoritesPage() { return require('app/pages/FavoritesPage'); }
function getAreaMenuPage() { return require('app/pages/AreaMenuPage'); }
function getLabelMenuPage() { return require('app/pages/LabelMenuPage'); }
function getToDoListPage() { return require('app/pages/ToDoListPage'); }
function getCalendarPage() { return require('app/pages/CalendarPage'); }
function getAssistPage() { return require('app/pages/AssistPage'); }
function getSettingsMenuPage() { return require('app/pages/SettingsMenuPage'); }

// Default order for main menu items
var DEFAULT_MAIN_MENU_ORDER = [
    'assistant',
    'favorites',
    'areas',
    'labels',
    'calendars',
    'todo_lists',
    'people',
    'all_entities',
    'settings'
];

class MainMenuPage extends BasePage {
    constructor() {
        super();
        this.pinnedEntityIndexes = {};
        this.entityStates = {};
    }

    createMenu() {
        return new UI.Menu({
            status: false,
            sections: [{
                title: 'Home Assistant',
                backgroundColor: Constants.colour.highlight,
                textColor: Constants.colour.highlight_text
            }]
        });
    }

    onShow() {
        var self = this;
        this.menu.items(0, []);
        this.pinnedEntityIndexes = {};
        this.entityStates = {};

        // Unsubscribe from previous subscription
        this.unsubscribe();

        // Clear and recreate the RelativeTimeUpdater
        if (this.relativeTimeUpdater) {
            this.relativeTimeUpdater.destroy();
        }
        this.relativeTimeUpdater = new RelativeTimeUpdater(function(entity_id, lastChanged) {
            self.updateEntitySubtitle(entity_id);
        });

        // Get ordered list of menu items
        var menuOrder = this.getMenuOrder();
        var i = 0;
        var pinnedEntityIds = [];

        for (var idx = 0; idx < menuOrder.length; idx++) {
            var itemId = menuOrder[idx];
            var menuItem = this.getMenuItem(itemId);
            if (menuItem) {
                this.menu.item(0, i, menuItem);

                // Track pinned entity indexes for real-time updates
                if (itemId.indexOf('pinned:') === 0) {
                    var entityId = itemId.substring(7);
                    this.pinnedEntityIndexes[entityId] = i;
                    pinnedEntityIds.push(entityId);
                }
                i++;
            }
        }

        // Subscribe to state changes for pinned entities
        if (pinnedEntityIds.length > 0) {
            this.subscribeToEntities(pinnedEntityIds);
        }

        // Restore the previously selected index
        if (this.appState.menuSelections.mainMenu > 0 &&
            this.appState.menuSelections.mainMenu < this.menu.items(0).length) {
            this.menu.selection(0, this.appState.menuSelections.mainMenu);
        }
    }

    onHide() {
        super.onHide();
        helpers.log_message('Main menu: unsubscribed from entity updates');
    }

    onSelect(e) {
        // Store the current selection index
        this.appState.menuSelections.mainMenu = e.itemIndex;

        helpers.log_message("Main menu click: " + e.item.title + " Index: " + e.itemIndex);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    }

    onSelection(e) {
        if (typeof e.itemIndex === 'number' && e.itemIndex >= 0) {
            this.appState.menuSelections.mainMenu = e.itemIndex;
        }
    }

    onLongSelect(e) {
        if (e.item && e.item.entity_id) {
            EntityService.handleLongPress(e.item.entity_id);
        }
    }

    /**
     * Get the ordered list of main menu item IDs
     */
    getMenuOrder() {
        var order = [];
        var pinnedEntities = this.appState.pinnedEntityStore.all();

        if (this.appState.main_menu_custom_order_enabled &&
            this.appState.main_menu_order &&
            Array.isArray(this.appState.main_menu_order)) {
            // Use custom order, but filter out unpinned entities
            for (var i = 0; i < this.appState.main_menu_order.length; i++) {
                var itemId = this.appState.main_menu_order[i];
                if (itemId.indexOf('pinned:') === 0) {
                    var entityId = itemId.substring(7);
                    if (pinnedEntities.indexOf(entityId) !== -1) {
                        order.push(itemId);
                    }
                } else {
                    order.push(itemId);
                }
            }

            // Check for new built-in items not in the custom order
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

            // Add any pinned entities not in the order (at the top)
            for (var k = 0; k < pinnedEntities.length; k++) {
                var pinnedId = 'pinned:' + pinnedEntities[k];
                if (order.indexOf(pinnedId) === -1) {
                    order.unshift(pinnedId);
                }
            }
        } else {
            // Use default order with pinned entities at the TOP (after assistant)
            order = [];

            if (DEFAULT_MAIN_MENU_ORDER.indexOf('assistant') !== -1) {
                order.push('assistant');
            }

            // Add pinned entities right after assistant
            for (var m = 0; m < pinnedEntities.length; m++) {
                order.push('pinned:' + pinnedEntities[m]);
            }

            // Add remaining default items (except assistant)
            for (var n = 0; n < DEFAULT_MAIN_MENU_ORDER.length; n++) {
                if (DEFAULT_MAIN_MENU_ORDER[n] !== 'assistant') {
                    order.push(DEFAULT_MAIN_MENU_ORDER[n]);
                }
            }
        }

        return order;
    }

    /**
     * A row for an entity whose state has not arrived yet.
     *
     * Both the pinned and favourite stores keep the friendly name alongside the
     * entity_id for exactly this, so the row can carry its real name straight
     * away and only the value is outstanding.
     */
    placeholderRow(entityId, store) {
        var name = entityId;
        if (store && typeof store.allWithNames === 'function') {
            var entries = store.allWithNames() || [];
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].entity_id === entityId && entries[i].name) {
                    name = entries[i].name;
                    break;
                }
            }
        }
        return {
            title: name,
            subtitle: 'Loading',
            entity_id: entityId,
            on_click: function() {
                EntityService.show(entityId);
            }
        };
    }

    /**
     * How many calendars this instance has, as far as we know without asking.
     * The last completed fetch publishes them to settings for the config page,
     * which makes that list a usable answer before any state has arrived.
     */
    getCalendarCount() {
        var dict = this.appState.ha_state_dict;
        if (dict) {
            var live = Object.keys(dict).filter(function(entity_id) {
                return entity_id.indexOf('calendar.') === 0;
            });
            return live.length;
        }
        var published = Settings.option('available_calendars');
        return Array.isArray(published) ? published.length : 0;
    }

    /**
     * Get the menu item definition for a given item ID
     */
    getMenuItem(itemId) {
        var self = this;

        // Handle pinned entities (format: "pinned:entity_id")
        if (itemId.indexOf('pinned:') === 0) {
            var entityId = itemId.substring(7);
            var entity = this.appState.getEntity(entityId);
            var menuItem;
            if (entity) {
                menuItem = EntityService.getMenuItem(entity);
            } else {
                // No state yet. Dropping the row here used to lose it for the
                // whole session: the id never reached pinnedEntityIds, so
                // nothing subscribed to it and nothing could ever fill it in.
                // The store keeps the name, so the row is drawn now and the
                // subscription's first snapshot replaces this in place.
                menuItem = self.placeholderRow(entityId,
                    self.appState.pinnedEntityStore, 'pinnedEntities');
            }
            menuItem.id = itemId;
            return menuItem;
        }

        // Built-in menu items
        switch (itemId) {
            case 'assistant':
                if (!this.appState.voice_enabled) return null;
                return {
                    id: 'assistant',
                    title: "Assistant",
                    on_click: function(e) {
                        getAssistPage().showAssistMenu();
                    }
                };
            case 'favorites':
                var favoriteEntities = this.appState.favoriteEntityStore.all();
                if (!favoriteEntities || !favoriteEntities.length) return null;
                return {
                    id: 'favorites',
                    title: "Favorites",
                    on_click: function(e) {
                        getFavoritesPage().showFavorites();
                    }
                };
            case 'areas':
                return {
                    id: 'areas',
                    title: "Areas",
                    on_click: function(e) {
                        getAreaMenuPage().showAreaMenu();
                    }
                };
            case 'labels':
                return {
                    id: 'labels',
                    title: "Labels",
                    on_click: function(e) {
                        getLabelMenuPage().showLabelMenu();
                    }
                };
            case 'calendars':
                // Decided from the calendar list the last fetch published to
                // settings, not from the state dict. The dict is empty until
                // states arrive, and Object.keys(null) threw outright, which is
                // the only reason the first paint ever had to wait for them.
                // refreshIfVisible() corrects the row once the fetch lands.
                var calendarCount = this.getCalendarCount();
                helpers.log_message('Main menu: ' + calendarCount + ' calendar entities known');
                if (calendarCount === 0) return null;
                return {
                    id: 'calendars',
                    title: "Calendars",
                    on_click: function(e) {
                        getCalendarPage().showCalendarList();
                    }
                };
            case 'todo_lists':
                return {
                    id: 'todo_lists',
                    title: "To-Do Lists",
                    on_click: function(e) {
                        getToDoListPage().showToDoLists();
                    }
                };
            case 'people':
                return {
                    id: 'people',
                    title: "People",
                    on_click: function(e) {
                        var personEntities = Object.keys(self.appState.ha_state_dict).filter(function(entity_id) {
                            return entity_id.indexOf('person.') === 0;
                        });
                        EntityListPage.showEntityList("People", personEntities, true, true, true);
                    }
                };
            case 'all_entities':
                return {
                    id: 'all_entities',
                    title: "All Entities",
                    on_click: function(e) {
                        var entityKeys = Object.keys(self.appState.ha_state_dict);
                        var shouldShowDomains = helpers.shouldShowDomainMenu(
                            entityKeys,
                            self.appState.domain_menu_all_entities,
                            {
                                minEntities: self.appState.domain_menu_min_entities,
                                minDomains: self.appState.domain_menu_min_domains
                            }
                        );
                        if (shouldShowDomains) {
                            EntityListPage.showEntityDomainsFromList(entityKeys, "All Entities");
                        } else {
                            EntityListPage.showEntityList("All Entities", false, true, true, true);
                        }
                    }
                };
            case 'settings':
                return {
                    id: 'settings',
                    title: "Settings",
                    on_click: function(e) {
                        getSettingsMenuPage().showSettingsMenu();
                    }
                };
            default:
                return null;
        }
    }

    /**
     * Subscribe to entity state updates for pinned entities
     */
    subscribeToEntities(entityIds) {
        var self = this;
        helpers.log_message('Main menu: subscribing to ' + entityIds.length + ' pinned entities');

        this.subscribe(entityIds, function(data) {
            var ev = data.event || {};

            // Handle added entities (initial snapshot)
            if (ev.a) {
                for (var entity_id in ev.a) {
                    if (self.pinnedEntityIndexes[entity_id] !== undefined) {
                        var entityData = {
                            entity_id: entity_id,
                            state: ev.a[entity_id].s,
                            attributes: ev.a[entity_id].a || {},
                            last_changed: ev.a[entity_id].lc
                                ? new Date(ev.a[entity_id].lc * 1000).toISOString()
                                : new Date().toISOString()
                        };
                        self.appState.setEntity(entity_id, entityData);
                        self.entityStates[entity_id] = entityData;
                        EntityService.updateMenuItem(
                            self.menu, 0,
                            self.pinnedEntityIndexes[entity_id],
                            entityData
                        );

                        if (self.relativeTimeUpdater) {
                            self.relativeTimeUpdater.register(entity_id, entityData.last_changed);
                        }
                    }
                }
            }

            // Handle changed entities (updates)
            if (ev.c) {
                for (var entity_id in ev.c) {
                    if (self.pinnedEntityIndexes[entity_id] !== undefined) {
                        var patch = ev.c[entity_id];
                        var plus = patch["+"] || {};
                        var cur = self.entityStates[entity_id] ||
                                  self.appState.getEntity(entity_id) ||
                                  { entity_id: entity_id, state: '', attributes: {} };

                        var entityData = {
                            entity_id: entity_id,
                            state: plus.s !== undefined ? plus.s : cur.state,
                            attributes: plus.a !== undefined ? plus.a : cur.attributes,
                            last_changed: plus.lc !== undefined
                                ? new Date(plus.lc * 1000).toISOString()
                                : cur.last_changed
                        };
                        self.appState.setEntity(entity_id, entityData);
                        self.entityStates[entity_id] = entityData;

                        helpers.log_message('Main menu: entity update for ' + entity_id + ': ' + entityData.state);
                        EntityService.updateMenuItem(
                            self.menu, 0,
                            self.pinnedEntityIndexes[entity_id],
                            entityData
                        );

                        if (self.relativeTimeUpdater) {
                            self.relativeTimeUpdater.update(entity_id, entityData.last_changed);
                        }
                    }
                }
            }
        });
    }

    /**
     * Update just the subtitle of a pinned entity (for relative time updates)
     */
    updateEntitySubtitle(entity_id) {
        if (this.pinnedEntityIndexes[entity_id] === undefined) {
            return;
        }

        var entity = this.entityStates[entity_id];
        if (!entity) {
            return;
        }

        EntityService.updateMenuItem(
            this.menu, 0,
            this.pinnedEntityIndexes[entity_id],
            entity
        );
    }
}

// Singleton instance
var mainMenuPageInstance = null;

/**
 * Show the main menu (singleton pattern)
 */
function showMainMenu() {
    if (!mainMenuPageInstance) {
        mainMenuPageInstance = new MainMenuPage();
    }
    mainMenuPageInstance.show();
}

/**
 * Rebuild the main menu items if the main menu is the visible window. Used
 * after a background data refresh, since the menu may have been rendered from
 * the startup cache and items like Calendars appear based on fetched data.
 */
function refreshIfVisible() {
    if (!mainMenuPageInstance || !mainMenuPageInstance.menu) {
        return;
    }
    var WindowStack = require('ui/windowstack');
    if (WindowStack.top() === mainMenuPageInstance.menu) {
        helpers.log_message('Main menu: refreshing after background data update');
        mainMenuPageInstance.onShow();
    }
}

module.exports = MainMenuPage;
module.exports.showMainMenu = showMainMenu;
module.exports.refreshIfVisible = refreshIfVisible;
