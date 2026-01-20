/**
 * LabelMenuPage - Labels navigation
 */
var UI = require('ui');
var BasePage = require('app/pages/BasePage');
var AppState = require('app/AppState');
var RegistryService = require('app/RegistryService');
var EntityListPage = require('app/pages/EntityListPage');
var helpers = require('app/helpers');

class LabelMenuPage extends BasePage {
    constructor() {
        super();
    }

    createMenu() {
        var self = this;
        var appState = this.appState;

        return new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Labels'
            }]
        });
    }

    onShow() {
        var self = this;
        var appState = this.appState;

        // Sort labels by name
        var sortedLabels = [];
        for (var label_id in appState.label_registry_cache) {
            var label = appState.label_registry_cache[label_id];
            if (label && label.name) {
                sortedLabels.push(label);
            }
        }
        sortedLabels.sort(function(a, b) {
            if (a.name < b.name) return -1;
            if (a.name > b.name) return 1;
            return 0;
        });

        if (sortedLabels.length === 0) {
            this.menu.item(0, 0, {
                title: 'No Labels Found',
                subtitle: 'No labels are configured'
            });
        } else {
            for (var i = 0; i < sortedLabels.length; i++) {
                (function(label) {
                    var entities = RegistryService.getEntitiesForLabel(label.label_id);
                    var entityCount = Object.keys(entities).length;

                    self.menu.item(0, i, {
                        title: label.name,
                        subtitle: entityCount + ' ' +
                            ((entityCount > 1 || entityCount === 0) ? 'entities' : 'entity'),
                        on_click: function(e) {
                            showEntitiesForLabel(label.label_id);
                        }
                    });
                })(sortedLabels[i]);
            }
        }
    }

    onSelect(e) {
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        } else {
            helpers.log_message("No click function for label menu item " + e.title);
        }
    }
}

/**
 * Show entities for a specific label
 * @param {string} label_id - The label ID
 */
function showEntitiesForLabel(label_id) {
    var appState = AppState.getInstance();
    var entities = RegistryService.getEntitiesForLabel(label_id);
    var label = appState.label_registry_cache[label_id];

    if (!entities) {
        return;
    }

    var entityKeys = Object.keys(entities);

    // Use the specific setting for Labels
    var shouldShowDomains = helpers.shouldShowDomainMenu(
        entityKeys,
        appState.domain_menu_labels,
        {
            minEntities: appState.domain_menu_min_entities,
            minDomains: appState.domain_menu_min_domains
        }
    );

    if (shouldShowDomains) {
        EntityListPage.showEntityDomainsFromList(entityKeys, label.name);
    } else {
        EntityListPage.showEntityList(label.name, entityKeys, true, true, true);
    }
}

/**
 * Show the label menu (convenience function)
 */
function showLabelMenu() {
    var page = new LabelMenuPage();
    page.show();
}

module.exports = LabelMenuPage;
module.exports.showLabelMenu = showLabelMenu;
module.exports.showEntitiesForLabel = showEntitiesForLabel;
