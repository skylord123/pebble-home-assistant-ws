/**
 * AreaMenuPage - Areas and Floors navigation
 */
var UI = require('ui');
var BasePage = require('app/pages/BasePage');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var RegistryService = require('app/RegistryService');
var EntityListPage = require('app/pages/EntityListPage');
var helpers = require('app/helpers');

// Module-level cache for area menu
var areaMenu = null;
var areaMenuUsingFloors = null;

class AreaMenuPage extends BasePage {
    constructor() {
        super();
    }

    createMenu() {
        var appState = this.appState;
        var useFloors = appState.floor_registry_cache &&
            Object.keys(appState.floor_registry_cache).length > 0;

        // Recreate menu if floor mode changed
        if (areaMenu && areaMenuUsingFloors !== useFloors) {
            areaMenu = null;
        }

        if (!areaMenu) {
            areaMenuUsingFloors = useFloors;

            if (useFloors) {
                areaMenu = this.createFloorsMenu();
            } else {
                areaMenu = this.createAreasMenu();
            }
        }

        return areaMenu;
    }

    createFloorsMenu() {
        var self = this;
        var appState = this.appState;

        var menu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Floors'
            }]
        });

        menu.on('show', function(e) {
            // Build floors list - preserve registry order (HA 2025.12+ supports manual ordering)
            var floorEntries = [];
            for (var floor_id in appState.floor_registry_cache) {
                var floor = appState.floor_registry_cache[floor_id];
                var areasInFloor = RegistryService.getAreasForFloor(floor_id);
                var areaCount = Object.keys(areasInFloor).length;
                floorEntries.push({
                    floor_id: floor_id,
                    name: floor.name,
                    areaCount: areaCount
                });
            }

            // Check if there are any unassigned areas (areas without a floor)
            var unassignedAreas = RegistryService.getAreasForFloor(null);
            var hasUnassignedAreas = Object.keys(unassignedAreas).length > 0;

            // Add floor items to menu
            var itemIndex = 0;
            for (var i = 0; i < floorEntries.length; i++) {
                var entry = floorEntries[i];
                (function(floorEntry) {
                    menu.item(0, itemIndex++, {
                        title: floorEntry.name,
                        subtitle: floorEntry.areaCount + ' ' +
                            ((floorEntry.areaCount > 1 || floorEntry.areaCount === 0) ? 'areas' : 'area'),
                        on_click: function(e) {
                            showAreasForFloor(floorEntry.floor_id, floorEntry.name);
                        }
                    });
                })(entry);
            }

            // Add "Other Areas" for unassigned areas at the bottom
            if (hasUnassignedAreas) {
                var unassignedCount = Object.keys(unassignedAreas).length;
                menu.item(0, itemIndex++, {
                    title: 'Other Areas',
                    subtitle: unassignedCount + ' ' +
                        ((unassignedCount > 1 || unassignedCount === 0) ? 'areas' : 'area'),
                    on_click: function(e) {
                        showAreasForFloor(null, 'Other Areas');
                    }
                });
            }
        });

        menu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            } else {
                helpers.log_message("No click function for floor menu item " + e.title);
            }
        });

        return menu;
    }

    createAreasMenu() {
        var self = this;
        var appState = this.appState;

        var menu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Areas'
            }]
        });

        menu.on('show', function(e) {
            // Create an array of area entries - preserve registry order
            var areaEntries = [];
            for (var area_id in appState.area_registry_cache) {
                var area = appState.area_registry_cache[area_id];
                var area_name = area.name;

                // Skip areas without a name
                if (!area_name) continue;

                var areaObjects = RegistryService.getEntitiesForArea(area_id);
                var areaObjectCount = Object.keys(areaObjects).length;

                areaEntries.push({
                    area_id: area_id,
                    display_name: area_name,
                    areaObjectCount: areaObjectCount
                });
            }

            // Add items to menu - preserve registry order (no sorting)
            for (var i = 0; i < areaEntries.length; i++) {
                (function(entry) {
                    menu.item(0, i, {
                        title: entry.display_name,
                        subtitle: entry.areaObjectCount + ' ' +
                            ((entry.areaObjectCount > 1 || entry.areaObjectCount === 0) ? 'entities' : 'entity'),
                        on_click: function(e) {
                            var areaObjects = RegistryService.getEntitiesForArea(entry.area_id);
                            var entityKeys = Object.keys(areaObjects);

                            var shouldShowDomains = helpers.shouldShowDomainMenu(
                                entityKeys,
                                appState.domain_menu_areas,
                                {
                                    minEntities: appState.domain_menu_min_entities,
                                    minDomains: appState.domain_menu_min_domains
                                }
                            );

                            if (shouldShowDomains) {
                                EntityListPage.showEntityDomainsFromList(entityKeys, entry.display_name);
                            } else {
                                EntityListPage.showEntityList(entry.display_name, entityKeys, true, true, true);
                            }
                        }
                    });
                })(areaEntries[i]);
            }
        });

        menu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            } else {
                helpers.log_message("No click function for area menu item " + e.title);
            }
        });

        return menu;
    }

    show() {
        this.menu = this.createMenu();
        this.menu.show();
    }
}

/**
 * Show areas for a specific floor
 * @param {string|null} floor_id - The floor_id to show areas for, or null for unassigned areas
 * @param {string} floor_name - Display name for the floor (used as menu title)
 */
function showAreasForFloor(floor_id, floor_name) {
    var appState = AppState.getInstance();

    var floorAreasMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: floor_name
        }]
    });

    floorAreasMenu.on('show', function(e) {
        var areasInFloor = RegistryService.getAreasForFloor(floor_id);

        // Build area entries for this floor - preserve registry order
        var areaEntries = [];
        for (var area_id in areasInFloor) {
            var area = areasInFloor[area_id];
            var area_name = area.name;

            // Skip areas without a name
            if (!area_name) continue;

            var areaObjects = RegistryService.getEntitiesForArea(area_id);
            var areaObjectCount = Object.keys(areaObjects).length;

            areaEntries.push({
                area_id: area_id,
                display_name: area_name,
                areaObjectCount: areaObjectCount
            });
        }

        // Add items to menu - preserve registry order (no sorting)
        for (var i = 0; i < areaEntries.length; i++) {
            (function(entry) {
                floorAreasMenu.item(0, i, {
                    title: entry.display_name,
                    subtitle: entry.areaObjectCount + ' ' +
                        ((entry.areaObjectCount > 1 || entry.areaObjectCount === 0) ? 'entities' : 'entity'),
                    on_click: function(e) {
                        var areaObjects = RegistryService.getEntitiesForArea(entry.area_id);
                        var entityKeys = Object.keys(areaObjects);

                        var shouldShowDomains = helpers.shouldShowDomainMenu(
                            entityKeys,
                            appState.domain_menu_areas,
                            {
                                minEntities: appState.domain_menu_min_entities,
                                minDomains: appState.domain_menu_min_domains
                            }
                        );

                        if (shouldShowDomains) {
                            EntityListPage.showEntityDomainsFromList(entityKeys, entry.display_name);
                        } else {
                            EntityListPage.showEntityList(entry.display_name, entityKeys, true, true, true);
                        }
                    }
                });
            })(areaEntries[i]);
        }
    });

    floorAreasMenu.on('select', function(e) {
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        } else {
            helpers.log_message("No click function for floor areas menu item " + e.title);
        }
    });

    floorAreasMenu.show();
}

/**
 * Show the area menu (convenience function)
 */
function showAreaMenu() {
    var page = new AreaMenuPage();
    page.show();
}

/**
 * Reset the cached area menu (call when settings change)
 */
function resetAreaMenu() {
    areaMenu = null;
    areaMenuUsingFloors = null;
}

module.exports = AreaMenuPage;
module.exports.showAreaMenu = showAreaMenu;
module.exports.showAreasForFloor = showAreasForFloor;
module.exports.resetAreaMenu = resetAreaMenu;
