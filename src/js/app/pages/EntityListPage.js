/**
 * EntityListPage - Entity list display with real-time updates
 */
var UI = require('ui');
var sortJSON = require('vendor/sortjson');
var BasePage = require('app/pages/BasePage');
var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');
var helpers = require('app/helpers');

// Module-level menu reference
var entityListMenu = null;

class EntityListPage extends BasePage {
    constructor(title, entityIdList, options) {
        super();
        this.title = title || "Entities";
        this.entityIdList = entityIdList || false;
        this.ignoreEntityCache = options && options.ignoreEntityCache !== undefined ? options.ignoreEntityCache : true;
        this.sortItems = options && options.sortItems !== undefined ? options.sortItems : true;
        this.skipIgnoredDomains = options && options.skipIgnoredDomains !== undefined ? options.skipIgnoredDomains : false;
        this.subscriptionId = null;
        this.currentPage = null;
        this.relativeTimeUpdater = null;
    }

    createMenu() {
        return new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: this.title
            }]
        });
    }

    show() {
        var self = this;
        this.menu = this.createMenu();

        this.menu.on('show', function(e) {
            helpers.log_message('showEntityList (title=' + self.title + '): show event called');
            self.updateStates(self.currentPage);
        });

        this.menu.on('hide', function(e) {
            helpers.log_message('showEntityList (title=' + self.title + '): hide event called');
            self.unsubscribe();
            if (self.relativeTimeUpdater) {
                self.relativeTimeUpdater.pause();
            }
        });

        this.menu.on('select', function(e) {
            helpers.log_message('showEntityList (title=' + self.title + '): select event called');
            self.appState.menuSelections.entityListMenu = e.itemIndex;

            var entity_id = e.item.entity_id;
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
                return;
            }
            helpers.log_message('Entity ' + entity_id + ' was short pressed! Index: ' + e.itemIndex);
            EntityService.show(entity_id);
        });

        this.menu.on('longSelect', function(e) {
            if (e.item && e.item.entity_id) {
                EntityService.handleLongPress(e.item.entity_id);
            }
        });

        this.menu.show();
    }

    updateStates(pageNumber) {
        var self = this;
        var appState = this.appState;
        var maxPageItems = 20;
        var paginated = false;
        var paginateMore = false;

        if (!pageNumber) {
            pageNumber = 1;
        }

        // Unsubscribe from previous subscription
        this.unsubscribe();

        // Determine which entity IDs to subscribe to
        var entitiesToSubscribe = this.entityIdList ? this.entityIdList.slice() : [];

        // Filter out ignored domains if skipIgnoredDomains is true
        if (this.skipIgnoredDomains && appState.ignore_domains && appState.ignore_domains.length > 0) {
            entitiesToSubscribe = entitiesToSubscribe.filter(function(entity_id) {
                var parts = entity_id.split('.');
                var domain = parts[0];
                return appState.ignore_domains.indexOf(domain) === -1;
            });
        }

        if (entitiesToSubscribe.length === 0) {
            helpers.log_message('No entities to subscribe to');
            this.menu.section(0).title = 'No entities';
            return;
        }

        var prevTitle = this.menu.section(0).title;
        this.menu.section(0).title = 'updating ...';

        // Local state cache for this subscription
        var entityStates = {};
        var renderedEntityIds = {};
        var initialSnapshotReceived = false;

        // Clear and recreate the RelativeTimeUpdater
        if (this.relativeTimeUpdater) {
            this.relativeTimeUpdater.destroy();
        }
        this.relativeTimeUpdater = new RelativeTimeUpdater(function(entity_id, lastChanged) {
            helpers.log_message('Relative time update for ' + entity_id);
            updateEntitySubtitle(entity_id);
        });

        // Helper to update just the subtitle of an entity
        function updateEntitySubtitle(entity_id) {
            if (renderedEntityIds[entity_id] === undefined) {
                return;
            }

            var entity = entityStates[entity_id];
            if (!entity) {
                return;
            }

            self.menu.item(0, renderedEntityIds[entity_id], {
                title: entity.attributes.friendly_name ? entity.attributes.friendly_name : entity.entity_id,
                subtitle: entity.state + (entity.attributes.unit_of_measurement ? ' ' + entity.attributes.unit_of_measurement : '') + ' > ' + helpers.humanDiff(new Date(), new Date(entity.last_changed)),
                entity_id: entity.entity_id,
                icon: EntityService.getIcon(entity)
            });
        }

        // Helper to convert subscribeEntities format to standard entity format
        function convertEntityData(entity_id, data) {
            return {
                entity_id: entity_id,
                state: data.s,
                attributes: data.a || {},
                context: data.c,
                last_changed: data.lc ? new Date(data.lc * 1000).toISOString() : new Date().toISOString()
            };
        }

        // Helper to render the menu from entityStates
        function renderMenu() {
            // Convert entityStates to array for sorting/pagination
            var data = [];
            for (var entity_id in entityStates) {
                data.push(entityStates[entity_id]);
            }

            // Filter and sort based on unavailable/unknown entity handling settings
            data = data.filter(function(entity) {
                var state = entity.state;
                if (state === 'unavailable' && appState.unavailable_entity_handling === 'hide') {
                    return false;
                }
                if (state === 'unknown' && appState.unknown_entity_handling === 'hide') {
                    return false;
                }
                return true;
            });

            // Separate entities into groups based on their state and handling settings
            var normalEntities = [];
            var unavailableToEnd = [];
            var unknownToEnd = [];

            for (var i = 0; i < data.length; i++) {
                var entity = data[i];
                var state = entity.state;
                if (state === 'unavailable' && appState.unavailable_entity_handling === 'sort_to_end') {
                    unavailableToEnd.push(entity);
                } else if (state === 'unknown' && appState.unknown_entity_handling === 'sort_to_end') {
                    unknownToEnd.push(entity);
                } else {
                    normalEntities.push(entity);
                }
            }

            // Sort each group
            if (self.sortItems) {
                normalEntities = sortJSON(normalEntities, appState.ha_order_by, appState.ha_order_dir);
                unavailableToEnd = sortJSON(unavailableToEnd, appState.ha_order_by, appState.ha_order_dir);
                unknownToEnd = sortJSON(unknownToEnd, appState.ha_order_by, appState.ha_order_dir);
            } else if (self.entityIdList) {
                // Sort items in same order as they appear in entity_id_list
                var sortByList = function(a, b) {
                    return self.entityIdList.indexOf(a.entity_id) - self.entityIdList.indexOf(b.entity_id);
                };
                normalEntities.sort(sortByList);
                unavailableToEnd.sort(sortByList);
                unknownToEnd.sort(sortByList);
            }

            // Combine: normal entities first, then unavailable, then unknown
            data = normalEntities.concat(unavailableToEnd).concat(unknownToEnd);

            var dataLength = data.length;

            function paginate(array, pageSize, pageNum) {
                return array.slice((pageNum - 1) * pageSize, pageNum * pageSize);
            }

            if (data.length > maxPageItems) {
                data = paginate(data, maxPageItems, pageNumber);
                paginated = true;
                paginateMore = (maxPageItems * pageNumber) < dataLength;
                helpers.log_message('maxPageItems:' + maxPageItems + ' pageNumber:' + pageNumber + ' dataLength:' + dataLength + ' paginateMore:' + (paginateMore ? 1 : 0));
            }

            // Clear renderedEntityIds for fresh mapping
            renderedEntityIds = {};

            // Clear existing relative time timers before re-rendering
            if (self.relativeTimeUpdater) {
                self.relativeTimeUpdater.clear();
            }

            self.menu.items(0, []); // clear items
            var menuIndex = 0;

            if (pageNumber > 1) {
                self.menu.item(0, menuIndex, {
                    title: "Prev Page",
                    on_click: function(e) {
                        self.updateStates(pageNumber - 1);
                    }
                });
                menuIndex++;
            }

            helpers.log_message('renderMenu: about to render ' + data.length + ' items to menu');
            for (var j = 0; j < data.length; j++) {
                try {
                    if (data[j].attributes.hidden) {
                        helpers.log_message('renderMenu: skipping hidden entity ' + data[j].entity_id);
                        continue;
                    }

                    var menuId = menuIndex++;
                    var itemTitle = data[j].attributes.friendly_name ? data[j].attributes.friendly_name : data[j].entity_id;
                    var itemSubtitle = data[j].state + (data[j].attributes.unit_of_measurement ? ' ' + data[j].attributes.unit_of_measurement : '') + ' > ' + helpers.humanDiff(new Date(), new Date(data[j].last_changed));

                    // Get icon path
                    var itemIcon;
                    try {
                        itemIcon = EntityService.getIcon(data[j]);
                    } catch (iconErr) {
                        helpers.log_message('renderMenu: icon error for ' + data[j].entity_id + ': ' + iconErr.message);
                        itemIcon = 'images/icon_unknown.png';
                    }

                    self.menu.item(0, menuId, {
                        title: itemTitle,
                        subtitle: itemSubtitle,
                        entity_id: data[j].entity_id,
                        icon: itemIcon
                    });
                    renderedEntityIds[data[j].entity_id] = menuId;

                    // Register entity for relative time updates
                    if (self.relativeTimeUpdater) {
                        self.relativeTimeUpdater.register(data[j].entity_id, data[j].last_changed);
                    }
                } catch (err) {
                    helpers.log_message('renderMenu: ERROR rendering entity ' + (data[j] ? data[j].entity_id : 'unknown') + ' at index ' + j + ': ' + err.message);
                }
            }
            helpers.log_message('renderMenu: rendered ' + menuIndex + ' items total');

            if (paginateMore) {
                self.menu.item(0, menuIndex, {
                    title: "Next Page",
                    on_click: function(e) {
                        self.updateStates(pageNumber + 1);
                    }
                });
            }

            self.currentPage = pageNumber;
        }

        // Helper to update a single entity in the menu
        function updateEntityInMenu(entity_id) {
            if (renderedEntityIds[entity_id] === undefined) {
                return;
            }

            var entity = entityStates[entity_id];
            if (!entity) {
                return;
            }

            self.menu.item(0, renderedEntityIds[entity_id], {
                title: entity.attributes.friendly_name ? entity.attributes.friendly_name : entity.entity_id,
                subtitle: entity.state + (entity.attributes.unit_of_measurement ? ' ' + entity.attributes.unit_of_measurement : '') + ' > ' + helpers.humanDiff(new Date(), new Date(entity.last_changed)),
                entity_id: entity.entity_id,
                icon: EntityService.getIcon(entity)
            });

            // Update the relative time timer
            if (self.relativeTimeUpdater) {
                self.relativeTimeUpdater.update(entity_id, entity.last_changed);
            }
        }

        helpers.log_message('Setting up subscribeEntities for ' + entitiesToSubscribe.length + ' entities');

        this.subscribe(entitiesToSubscribe, function(data) {
            var ev = data.event || {};

            if (ev.a) {
                helpers.log_message('subscribeEntities: received ' + Object.keys(ev.a).length + ' added entities');
            }
            if (ev.c) {
                helpers.log_message('subscribeEntities: received ' + Object.keys(ev.c).length + ' changed entities');
            }
            if (ev.r) {
                helpers.log_message('subscribeEntities: received ' + Object.keys(ev.r).length + ' removed entities');
            }

            // Handle added entities (initial snapshot)
            if (ev.a) {
                for (var entity_id in ev.a) {
                    var entityData = convertEntityData(entity_id, ev.a[entity_id]);
                    entityStates[entity_id] = entityData;
                    appState.setEntity(entity_id, entityData);
                }

                // On initial snapshot, render the full menu
                if (!initialSnapshotReceived) {
                    initialSnapshotReceived = true;
                    self.menu.section(0).title = prevTitle;
                    renderMenu();
                }
            }

            // Handle changed entities (updates)
            if (ev.c) {
                for (var changedId in ev.c) {
                    var patch = ev.c[changedId];
                    var plus = patch["+"] || {};

                    // Get existing state or create new one
                    var cur = entityStates[changedId] || { entity_id: changedId, state: '', attributes: {} };

                    // Merge the changes
                    entityStates[changedId] = {
                        entity_id: changedId,
                        state: plus.s !== undefined ? plus.s : cur.state,
                        attributes: plus.a !== undefined ? plus.a : cur.attributes,
                        context: plus.c !== undefined ? plus.c : cur.context,
                        last_changed: plus.lc !== undefined ? new Date(plus.lc * 1000).toISOString() : cur.last_changed
                    };
                    appState.setEntity(changedId, entityStates[changedId]);

                    helpers.log_message('Entity update for ' + changedId + ': ' + entityStates[changedId].state);
                    updateEntityInMenu(changedId);
                }
            }

            // Handle removed entities
            if (ev.r) {
                for (var removedId in ev.r) {
                    delete entityStates[removedId];
                    helpers.log_message('Entity removed: ' + removedId);
                    // Re-render menu if an entity was removed
                    if (initialSnapshotReceived) {
                        renderMenu();
                    }
                }
            }
        }, function(error) {
            helpers.log_message('subscribeEntities ERROR: ' + JSON.stringify(error));
            self.menu.section(0).title = 'HAWS - failed updating';
        });
    }
}

/**
 * Show entity domains list from a list of entity IDs
 * @param {string[]} entityIdList - List of entity IDs
 * @param {string} title - Menu title
 */
function showEntityDomainsFromList(entityIdList, title) {
    var appState = AppState.getInstance();

    var domainListMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: title ? title : "Home Assistant"
        }]
    });

    domainListMenu.on('show', function() {
        helpers.log_message('showEntityDomainsFromList: building domain list from ' + entityIdList.length + ' entities');

        // Loop over entity id list and index them by their domain
        var domainEntities = {};
        var missingEntities = [];
        for (var i = 0; i < entityIdList.length; i++) {
            var entity_id = entityIdList[i];
            var entity = appState.getEntity(entity_id);
            if (!entity) {
                missingEntities.push(entity_id);
                continue;
            }

            var parts = entity_id.split('.');
            var domain = parts[0];

            // Skip domains that should be ignored
            if (appState.ignore_domains && appState.ignore_domains.indexOf(domain) !== -1) {
                continue;
            }

            if (domain in domainEntities) {
                domainEntities[domain].push(entity_id);
            } else {
                domainEntities[domain] = [entity_id];
            }
        }

        if (missingEntities.length > 0) {
            helpers.log_message('showEntityDomainsFromList: WARNING - ' + missingEntities.length + ' entities missing from ha_state_dict');
        }

        // Sort domain list
        domainEntities = helpers.sortObjectByKeys(domainEntities);

        // Log domain counts
        for (var d in domainEntities) {
            helpers.log_message('showEntityDomainsFromList: domain \'' + d + '\' has ' + domainEntities[d].length + ' entities');
        }

        // Add domain entries into menu
        var menuIdx = 0;
        for (var domainName in domainEntities) {
            (function(dom, entities) {
                var displayName = helpers.ucwords(dom.replace('_', ' '));
                domainListMenu.item(0, menuIdx++, {
                    title: displayName,
                    subtitle: entities.length + ' ' + (entities.length > 1 ? 'entities' : 'entity'),
                    on_click: function(e) {
                        helpers.log_message('showEntityDomainsFromList: clicked domain \'' + dom + '\' with ' + entities.length + ' entities');
                        showEntityList(displayName, entities);
                    }
                });
            })(domainName, domainEntities[domainName]);
        }
    });

    domainListMenu.on('select', function(e) {
        helpers.log_message('Domain list item ' + e.item.title + ' was short pressed!');
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    domainListMenu.show();
}

/**
 * Show entity list (convenience function)
 * @param {string} title - Menu title
 * @param {string[]|boolean} entityIdList - List of entity IDs, or false for all entities
 * @param {boolean} ignoreEntityCache - Whether to ignore entity cache
 * @param {boolean} sortItems - Whether to sort items
 * @param {boolean} skipIgnoredDomains - Whether to skip ignored domains
 */
function showEntityList(title, entityIdList, ignoreEntityCache, sortItems, skipIgnoredDomains) {
    var page = new EntityListPage(title, entityIdList, {
        ignoreEntityCache: ignoreEntityCache !== undefined ? ignoreEntityCache : true,
        sortItems: sortItems !== undefined ? sortItems : true,
        skipIgnoredDomains: skipIgnoredDomains !== undefined ? skipIgnoredDomains : false
    });
    page.show();
}

module.exports = EntityListPage;
module.exports.showEntityList = showEntityList;
module.exports.showEntityDomainsFromList = showEntityDomainsFromList;
