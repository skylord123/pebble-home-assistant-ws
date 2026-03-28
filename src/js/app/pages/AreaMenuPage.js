/**
 * AreaMenuPage - Areas and Floors navigation (Native Bridge)
 */
var simply = require('ui/simply');
var AppState = require('app/AppState');
var RegistryService = require('app/RegistryService');
var EntityListPage = require('app/pages/EntityListPage');
var helpers = require('app/helpers');

var nextScreenId = 100;

function showAreaList(title, areaEntries, appState) {
    var screenId = nextScreenId++;
    var menuItems = [];

    simply.impl.nativeMenuPush(screenId, title, 1, {
        onSelect: function(section, index) {
            var item = menuItems[index];
            if (item && typeof item.on_click === 'function') {
                item.on_click();
            }
        },
        onLongSelect: function() {},
        onBack: function() {}
    });

    for (var i = 0; i < areaEntries.length; i++) {
        (function(entry) {
            var subtitle = entry.count + ' ' + (entry.count !== 1 ? 'entities' : 'entity');
            menuItems.push({
                title: entry.name,
                on_click: function() {
                    var areaObjects = RegistryService.getEntitiesForArea(entry.area_id);
                    var entityKeys = Object.keys(areaObjects);
                    var shouldShowDomains = helpers.shouldShowDomainMenu(
                        entityKeys,
                        appState.domain_menu_areas,
                        { minEntities: appState.domain_menu_min_entities, minDomains: appState.domain_menu_min_domains }
                    );
                    if (shouldShowDomains) {
                        EntityListPage.showEntityDomainsFromList(entityKeys, entry.name);
                    } else {
                        EntityListPage.showEntityList(entry.name, entityKeys, true, true, true);
                    }
                }
            });
            simply.impl.nativeMenuUpdate(screenId, 0, i, entry.name, subtitle, 0);
        })(areaEntries[i]);
    }
}

function showAreasForFloor(floor_id, floor_name) {
    var appState = AppState.getInstance();
    var areasInFloor = RegistryService.getAreasForFloor(floor_id);

    var areaEntries = [];
    for (var area_id in areasInFloor) {
        var area = areasInFloor[area_id];
        if (!area.name) continue;
        var areaObjects = RegistryService.getEntitiesForArea(area_id);
        areaEntries.push({
            area_id: area_id,
            name: area.name,
            count: Object.keys(areaObjects).length
        });
    }

    showAreaList(floor_name, areaEntries, appState);
}

function showAreaMenu() {
    var appState = AppState.getInstance();
    var useFloors = appState.floor_registry_cache &&
        Object.keys(appState.floor_registry_cache).length > 0;

    if (useFloors) {
        // Show floors menu
        var screenId = nextScreenId++;
        var menuItems = [];

        simply.impl.nativeMenuPush(screenId, 'Floors', 1, {
            onSelect: function(section, index) {
                var item = menuItems[index];
                if (item && typeof item.on_click === 'function') {
                    item.on_click();
                }
            },
            onLongSelect: function() {},
            onBack: function() {}
        });

        var itemIndex = 0;
        for (var floor_id in appState.floor_registry_cache) {
            (function(fid, floor) {
                var areasInFloor = RegistryService.getAreasForFloor(fid);
                var areaCount = Object.keys(areasInFloor).length;
                var subtitle = areaCount + ' ' + (areaCount !== 1 ? 'areas' : 'area');

                menuItems.push({
                    title: floor.name,
                    on_click: function() { showAreasForFloor(fid, floor.name); }
                });
                simply.impl.nativeMenuUpdate(screenId, 0, itemIndex, floor.name, subtitle, 0);
                itemIndex++;
            })(floor_id, appState.floor_registry_cache[floor_id]);
        }

        // Unassigned areas
        var unassignedAreas = RegistryService.getAreasForFloor(null);
        if (Object.keys(unassignedAreas).length > 0) {
            var unassignedCount = Object.keys(unassignedAreas).length;
            var subtitle = unassignedCount + ' ' + (unassignedCount !== 1 ? 'areas' : 'area');
            menuItems.push({
                title: 'Other Areas',
                on_click: function() { showAreasForFloor(null, 'Other Areas'); }
            });
            simply.impl.nativeMenuUpdate(screenId, 0, itemIndex, 'Other Areas', subtitle, 0);
        }
    } else {
        // Show areas directly
        var areaEntries = [];
        for (var area_id in appState.area_registry_cache) {
            var area = appState.area_registry_cache[area_id];
            if (!area.name) continue;
            var areaObjects = RegistryService.getEntitiesForArea(area_id);
            areaEntries.push({
                area_id: area_id,
                name: area.name,
                count: Object.keys(areaObjects).length
            });
        }
        showAreaList('Areas', areaEntries, appState);
    }
}

function resetAreaMenu() {
    // No longer needed — menus are rebuilt each time
}

module.exports = {};
module.exports.showAreaMenu = showAreaMenu;
module.exports.showAreasForFloor = showAreasForFloor;
module.exports.resetAreaMenu = resetAreaMenu;
