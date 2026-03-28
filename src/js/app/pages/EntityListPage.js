/**
 * EntityListPage - Entity list display with real-time updates (Native Bridge)
 */
var sortJSON = require('vendor/sortjson');
var simply = require('ui/simply');
var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');
var helpers = require('app/helpers');

var nextScreenId = 10; // Start at 10 to avoid conflicts with main menu

/**
 * Show a list of entities using the native bridge
 */
function showEntityList(title, entityIdList, ignoreEntityCache, sortItems, skipIgnoredDomains, entityIdListProvider) {
    var appState = AppState.getInstance();
    var screenId = nextScreenId++;
    var subscriptionId = null;
    var relativeTimeUpdater = null;
    var renderedEntityIds = {};
    var entityStates = {};
    var menuItems = []; // [{entity_id, title, subtitle, icon, on_click}, ...]
    var currentPage = 1;
    var maxPageItems = 20;

    sortItems = sortItems !== undefined ? sortItems : true;
    skipIgnoredDomains = skipIgnoredDomains !== undefined ? skipIgnoredDomains : false;

    function cleanup() {
        if (subscriptionId && appState.haws) {
            appState.haws.unsubscribe(subscriptionId);
            subscriptionId = null;
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    }

    function getEntitySubtitle(entity) {
        var sub = entity.state;
        if (entity.attributes.unit_of_measurement) {
            sub += ' ' + entity.attributes.unit_of_measurement;
        }
        sub += ' > ' + helpers.humanDiff(new Date(), new Date(entity.last_changed));
        return sub;
    }

    function convertEntityData(entity_id, data) {
        return {
            entity_id: entity_id,
            state: data.s,
            attributes: data.a || {},
            context: data.c,
            last_changed: data.lc ? new Date(data.lc * 1000).toISOString() : new Date().toISOString()
        };
    }

    function renderMenu(pageNumber) {
        if (!pageNumber) pageNumber = 1;
        currentPage = pageNumber;

        // Refresh from provider
        if (entityIdListProvider) {
            entityIdList = entityIdListProvider();
            if (!entityIdList || entityIdList.length === 0) {
                simply.impl.nativeMenuPop();
                return;
            }
        }

        // Build data array
        var data = [];
        for (var eid in entityStates) {
            if (entityIdList && entityIdList.indexOf(eid) === -1) continue;
            data.push(entityStates[eid]);
        }

        // Filter
        data = data.filter(function(entity) {
            if (entity.state === 'unavailable' && appState.unavailable_entity_handling === 'hide') return false;
            if (entity.state === 'unknown' && appState.unknown_entity_handling === 'hide') return false;
            return true;
        });

        // Separate and sort
        var normal = [], unavail = [], unknown = [];
        for (var i = 0; i < data.length; i++) {
            var s = data[i].state;
            if (s === 'unavailable' && appState.unavailable_entity_handling === 'sort_to_end') unavail.push(data[i]);
            else if (s === 'unknown' && appState.unknown_entity_handling === 'sort_to_end') unknown.push(data[i]);
            else normal.push(data[i]);
        }

        if (sortItems) {
            normal = sortJSON(normal, appState.ha_order_by, appState.ha_order_dir);
            unavail = sortJSON(unavail, appState.ha_order_by, appState.ha_order_dir);
            unknown = sortJSON(unknown, appState.ha_order_by, appState.ha_order_dir);
        } else if (entityIdList) {
            var sortByList = function(a, b) {
                return entityIdList.indexOf(a.entity_id) - entityIdList.indexOf(b.entity_id);
            };
            normal.sort(sortByList);
            unavail.sort(sortByList);
            unknown.sort(sortByList);
        }

        data = normal.concat(unavail).concat(unknown);
        var totalCount = data.length;

        // Paginate
        var paginated = false, paginateMore = false;
        if (data.length > maxPageItems) {
            data = data.slice((pageNumber - 1) * maxPageItems, pageNumber * maxPageItems);
            paginated = true;
            paginateMore = (maxPageItems * pageNumber) < totalCount;
        }

        // Reset
        renderedEntityIds = {};
        menuItems = [];
        if (relativeTimeUpdater) relativeTimeUpdater.clear();

        var menuIndex = 0;

        // Prev page
        if (pageNumber > 1) {
            menuItems.push({
                title: "Prev Page",
                on_click: function() { renderMenu(pageNumber - 1); }
            });
            simply.impl.nativeMenuUpdate(screenId, 0, menuIndex, "Prev Page", "", 0);
            menuIndex++;
        }

        // Entity items
        for (var j = 0; j < data.length; j++) {
            try {
                if (data[j].attributes.hidden) continue;

                var itemTitle = data[j].attributes.friendly_name || data[j].entity_id;
                var itemSubtitle = getEntitySubtitle(data[j]);
                var itemIcon;
                try { itemIcon = EntityService.getIcon(data[j]); }
                catch (e) { itemIcon = 'images/icon_unknown.png'; }

                menuItems.push({
                    entity_id: data[j].entity_id,
                    title: itemTitle,
                    subtitle: itemSubtitle,
                    icon: itemIcon
                });
                renderedEntityIds[data[j].entity_id] = menuIndex;

                simply.impl.nativeMenuUpdate(screenId, 0, menuIndex, itemTitle, itemSubtitle, itemIcon);

                if (relativeTimeUpdater) {
                    relativeTimeUpdater.register(data[j].entity_id, data[j].last_changed);
                }
                menuIndex++;
            } catch (err) {
                helpers.log_message('renderMenu: ERROR ' + err.message);
            }
        }

        // Next page
        if (paginateMore) {
            menuItems.push({
                title: "Next Page",
                on_click: function() { renderMenu(pageNumber + 1); }
            });
            simply.impl.nativeMenuUpdate(screenId, 0, menuIndex, "Next Page", "", 0);
        }
    }

    function updateEntityInMenu(entity_id) {
        var idx = renderedEntityIds[entity_id];
        if (idx === undefined) return;
        var entity = entityStates[entity_id];
        if (!entity) return;

        var updatedTitle = entity.attributes.friendly_name || entity.entity_id;
        var updatedSubtitle = getEntitySubtitle(entity);
        var updatedIcon;
        try { updatedIcon = EntityService.getIcon(entity); }
        catch (e) { updatedIcon = 'images/icon_unknown.png'; }

        simply.impl.nativeMenuUpdate(screenId, 0, idx, updatedTitle, updatedSubtitle, updatedIcon);
    }

    // Create relative time updater
    relativeTimeUpdater = new RelativeTimeUpdater(function(entity_id) {
        updateEntityInMenu(entity_id);
    });

    // Push native menu
    simply.impl.nativeMenuPush(screenId, title || 'Entities', 1, {
        onSelect: function(section, index) {
            var item = menuItems[index];
            if (!item) return;
            if (typeof item.on_click === 'function') {
                item.on_click();
                return;
            }
            if (item.entity_id) {
                EntityService.show(item.entity_id);
            }
        },
        onLongSelect: function(section, index) {
            var item = menuItems[index];
            if (item && item.entity_id) {
                EntityService.handleLongPress(item.entity_id);
            }
        },
        onBack: function() {
            cleanup();
        }
    });

    // Determine entities to subscribe to
    var entitiesToSubscribe = entityIdList ? entityIdList.slice() : [];
    if (skipIgnoredDomains && appState.ignore_domains && appState.ignore_domains.length > 0) {
        entitiesToSubscribe = entitiesToSubscribe.filter(function(id) {
            return appState.ignore_domains.indexOf(id.split('.')[0]) === -1;
        });
    }

    if (entitiesToSubscribe.length === 0 && !entityIdList) {
        // Subscribe to all entities
        entitiesToSubscribe = Object.keys(appState.ha_state_dict);
    }

    if (entitiesToSubscribe.length === 0) {
        simply.impl.nativeMenuUpdate(screenId, 0, 0, "No entities", "", 0);
        menuItems.push({ title: "No entities" });
        return;
    }

    // Subscribe
    var initialSnapshotReceived = false;
    subscriptionId = appState.haws.subscribeEntities(
        entitiesToSubscribe,
        function(data) {
            var ev = data.event || {};

            if (ev.a) {
                for (var entity_id in ev.a) {
                    var entityData = convertEntityData(entity_id, ev.a[entity_id]);
                    entityStates[entity_id] = entityData;
                    appState.setEntity(entity_id, entityData);
                }
                if (!initialSnapshotReceived) {
                    initialSnapshotReceived = true;
                    renderMenu(1);
                }
            }

            if (ev.c) {
                for (var cid in ev.c) {
                    var patch = ev.c[cid];
                    var plus = patch["+"] || {};
                    var cur = entityStates[cid] || { entity_id: cid, state: '', attributes: {} };
                    entityStates[cid] = {
                        entity_id: cid,
                        state: plus.s !== undefined ? plus.s : cur.state,
                        attributes: plus.a !== undefined ? plus.a : cur.attributes,
                        context: plus.c !== undefined ? plus.c : cur.context,
                        last_changed: plus.lc !== undefined ? new Date(plus.lc * 1000).toISOString() : cur.last_changed
                    };
                    appState.setEntity(cid, entityStates[cid]);
                    updateEntityInMenu(cid);
                }
            }

            if (ev.r) {
                for (var rid in ev.r) {
                    delete entityStates[rid];
                    if (initialSnapshotReceived) renderMenu(currentPage);
                }
            }
        },
        function(error) {
            helpers.log_message('subscribeEntities ERROR: ' + JSON.stringify(error));
        }
    );
}

/**
 * Show entity domains list using native bridge
 */
function showEntityDomainsFromList(entityIdList, title) {
    var appState = AppState.getInstance();
    var screenId = nextScreenId++;
    var menuItems = [];

    // Build domain map
    var domainEntities = {};
    for (var i = 0; i < entityIdList.length; i++) {
        var entity_id = entityIdList[i];
        var entity = appState.getEntity(entity_id);
        if (!entity) continue;

        var domain = entity_id.split('.')[0];
        if (appState.ignore_domains && appState.ignore_domains.indexOf(domain) !== -1) continue;

        if (domain in domainEntities) {
            domainEntities[domain].push(entity_id);
        } else {
            domainEntities[domain] = [entity_id];
        }
    }

    domainEntities = helpers.sortObjectByKeys(domainEntities);

    // Push native menu
    simply.impl.nativeMenuPush(screenId, title || 'Domains', 1, {
        onSelect: function(section, index) {
            var item = menuItems[index];
            if (item && typeof item.on_click === 'function') {
                item.on_click();
            }
        },
        onLongSelect: function() {},
        onBack: function() {}
    });

    // Send domain items
    var menuIndex = 0;
    for (var domainName in domainEntities) {
        (function(dom, entities) {
            var displayName = helpers.ucwords(dom.replace('_', ' '));
            var subtitle = entities.length + ' ' + (entities.length > 1 ? 'entities' : 'entity');
            menuItems.push({
                title: displayName,
                on_click: function() {
                    showEntityList(displayName, entities);
                }
            });
            simply.impl.nativeMenuUpdate(screenId, 0, menuIndex, displayName, subtitle, 0);
            menuIndex++;
        })(domainName, domainEntities[domainName]);
    }
}

module.exports = {};
module.exports.showEntityList = showEntityList;
module.exports.showEntityDomainsFromList = showEntityDomainsFromList;
