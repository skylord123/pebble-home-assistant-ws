/**
 * LabelMenuPage - Labels navigation (Native Bridge)
 */
var simply = require('ui/simply');
var AppState = require('app/AppState');
var RegistryService = require('app/RegistryService');
var EntityListPage = require('app/pages/EntityListPage');
var helpers = require('app/helpers');

var nextScreenId = 200;

function showEntitiesForLabel(label_id) {
    var appState = AppState.getInstance();
    var entities = RegistryService.getEntitiesForLabel(label_id);
    var label = appState.label_registry_cache[label_id];
    if (!entities) return;

    var entityKeys = Object.keys(entities);
    var shouldShowDomains = helpers.shouldShowDomainMenu(
        entityKeys,
        appState.domain_menu_labels,
        { minEntities: appState.domain_menu_min_entities, minDomains: appState.domain_menu_min_domains }
    );

    if (shouldShowDomains) {
        EntityListPage.showEntityDomainsFromList(entityKeys, label.name);
    } else {
        EntityListPage.showEntityList(label.name, entityKeys, true, true, true);
    }
}

function showLabelMenu() {
    var appState = AppState.getInstance();
    var screenId = nextScreenId++;
    var menuItems = [];

    // Sort labels by name
    var sortedLabels = [];
    for (var label_id in appState.label_registry_cache) {
        var label = appState.label_registry_cache[label_id];
        if (label && label.name) {
            sortedLabels.push(label);
        }
    }
    sortedLabels.sort(function(a, b) {
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });

    simply.impl.nativeMenuPush(screenId, 'Labels', 1, {
        onSelect: function(section, index) {
            var item = menuItems[index];
            if (item && typeof item.on_click === 'function') {
                item.on_click();
            }
        },
        onLongSelect: function() {},
        onBack: function() {}
    });

    if (sortedLabels.length === 0) {
        menuItems.push({ title: 'No Labels Found' });
        simply.impl.nativeMenuUpdate(screenId, 0, 0, 'No Labels Found', 'No labels are configured', 0);
    } else {
        for (var i = 0; i < sortedLabels.length; i++) {
            (function(label) {
                var entities = RegistryService.getEntitiesForLabel(label.label_id);
                var entityCount = Object.keys(entities).length;
                var subtitle = entityCount + ' ' + (entityCount !== 1 ? 'entities' : 'entity');
                menuItems.push({
                    title: label.name,
                    on_click: function() { showEntitiesForLabel(label.label_id); }
                });
                simply.impl.nativeMenuUpdate(screenId, 0, i, label.name, subtitle, 0);
            })(sortedLabels[i]);
        }
    }
}

module.exports = {};
module.exports.showLabelMenu = showLabelMenu;
module.exports.showEntitiesForLabel = showEntitiesForLabel;
