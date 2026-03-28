/**
 * GenericEntityPage - Generic entity detail page (Native Bridge)
 */
var simply = require('ui/simply');
var Vibe = require('ui/vibe');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var nextScreenId = 300;

function showEntityMenu(entity_id) {
    var appState = AppState.getInstance();
    var favoriteEntityStore = appState.favoriteEntityStore;
    var pinnedEntityStore = appState.pinnedEntityStore;
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        throw new Error('Entity ' + entity_id + ' not found');
    }

    var screenId = nextScreenId++;
    var menuItems = {}; // {section: {index: {on_click, ...}}}
    var subscriptionId = null;
    var relativeTimeUpdater = null;

    var domain = entity_id.split('.')[0];

    function formatDateTime(isoString) {
        if (!isoString) return 'N/A';
        var d = new Date(isoString);
        return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' +
               String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
    }

    function getStateSubtitle(e) {
        var t = e.state;
        if (e.attributes.unit_of_measurement) t += ' ' + e.attributes.unit_of_measurement;
        t += ' > ' + helpers.humanDiff(new Date(), new Date(e.last_changed));
        return t;
    }

    function registerItem(section, index, item) {
        if (!menuItems[section]) menuItems[section] = {};
        menuItems[section][index] = item;
    }

    function callService(svc, serviceData, targetData) {
        simply.impl.nativeToast('Sending...', 0);
        appState.haws.callService(
            domain, svc, serviceData || {}, targetData || {entity_id: entity_id},
            function(data) {
                Vibe.vibrate('short');
                simply.impl.nativeToast('Done', 1);
            },
            function(error) {
                Vibe.vibrate('double');
                simply.impl.nativeToast('Error', 2);
            }
        );
    }

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

    // Determine section count
    var numSections = 3; // Info, Services, Extra
    var friendlyName = entity.attributes.friendly_name || entity_id;

    simply.impl.nativeMenuPush(screenId, friendlyName, numSections, {
        onSelect: function(section, index) {
            var item = menuItems[section] && menuItems[section][index];
            if (item && typeof item.on_click === 'function') {
                item.on_click();
            }
        },
        onLongSelect: function() {},
        onBack: cleanup
    });

    // Section titles
    simply.impl.nativeMenuSectionTitle(screenId, 1, 'Services');
    simply.impl.nativeMenuSectionTitle(screenId, 2, 'Extra');

    // Section 0: Entity info
    var infoIdx = 0;
    simply.impl.nativeMenuUpdate(screenId, 0, infoIdx, 'Entity ID', entity_id, 0);
    registerItem(0, infoIdx++, {});

    var stateIndex = infoIdx;
    simply.impl.nativeMenuUpdate(screenId, 0, infoIdx, 'State', getStateSubtitle(entity), 0);
    registerItem(0, infoIdx++, {});

    simply.impl.nativeMenuUpdate(screenId, 0, infoIdx, 'Last Changed', formatDateTime(entity.last_changed), 0);
    registerItem(0, infoIdx++, {});

    simply.impl.nativeMenuUpdate(screenId, 0, infoIdx, 'Last Updated', formatDateTime(entity.last_updated), 0);
    registerItem(0, infoIdx++, {});

    var attrs = Object.getOwnPropertyNames(entity.attributes);
    simply.impl.nativeMenuUpdate(screenId, 0, infoIdx, 'Attributes', attrs.length + ' attributes', 0);
    registerItem(0, infoIdx++, {
        on_click: function() { showEntityAttributesMenu(entity_id); }
    });

    // Section 1: Services (domain-specific)
    var svcIdx = 0;

    if (domain === 'button' || domain === 'input_button') {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Press', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('press'); } });
    }

    if (domain === 'switch' || domain === 'input_boolean' || domain === 'automation' || domain === 'script') {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Toggle', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('toggle'); } });
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Turn On', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('turn_on'); } });
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Turn Off', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('turn_off'); } });
    }

    if (domain === 'lock') {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Lock', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('lock'); } });
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Unlock', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('unlock'); } });
    }

    if (domain === 'cover') {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Open', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('open_cover'); } });
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Close', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('close_cover'); } });
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Stop', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('stop_cover'); } });
    }

    if (domain === 'scene') {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Turn On', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('turn_on'); } });
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Apply', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('apply'); } });
    }

    if (domain === 'input_number' || domain === 'counter') {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Increment', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('increment'); } });
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Decrement', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('decrement'); } });
    }

    if (domain === 'counter') {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Reset', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('reset'); } });
    }

    if (domain === 'automation') {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Trigger', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('trigger'); } });
    }

    if (domain === 'automation' || domain === 'script' || domain === 'button' || domain === 'input_boolean') {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Reload', '', 0);
        registerItem(1, svcIdx++, { on_click: function() { callService('reload'); } });
    }

    if (domain === 'vacuum') {
        var vacuumServices = ['start', 'pause', 'stop', 'return_to_base', 'locate', 'clean_spot'];
        var vacuumLabels = ['Start', 'Pause', 'Stop', 'Return to Base', 'Locate', 'Clean Spot'];
        for (var v = 0; v < vacuumServices.length; v++) {
            (function(svc, label) {
                simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, label, '', 0);
                registerItem(1, svcIdx++, { on_click: function() {
                    callService(svc, {}, {entity_id: entity_id});
                }});
            })(vacuumServices[v], vacuumLabels[v]);
        }
    }

    if (domain === 'input_number' || domain === 'number') {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Set Value', '', 0);
        registerItem(1, svcIdx++, { on_click: function() {
            showSetValueMenu(entity_id, entity);
        }});
    }

    if (domain === 'cover' && entity.attributes.current_position !== undefined) {
        simply.impl.nativeMenuUpdate(screenId, 1, svcIdx, 'Set Position', entity.attributes.current_position + '%', 0);
        registerItem(1, svcIdx++, { on_click: function() {
            showSetPositionMenu(entity_id, entity);
        }});
    }

    // Section 2: Extra
    function renderFavoriteBtn() {
        var title = (favoriteEntityStore.has(entity_id) ? 'Remove from' : 'Add to') + ' Favorites';
        simply.impl.nativeMenuUpdate(screenId, 2, 0, title, '', 0);
    }
    registerItem(2, 0, { on_click: function() {
        EntityService.toggleFavorite(appState.ha_state_dict[entity_id]);
        renderFavoriteBtn();
    }});
    renderFavoriteBtn();

    function renderPinnedBtn() {
        var title = (pinnedEntityStore.has(entity_id) ? 'Unpin from' : 'Pin to') + ' Main Menu';
        simply.impl.nativeMenuUpdate(screenId, 2, 1, title, '', 0);
    }
    registerItem(2, 1, { on_click: function() {
        EntityService.togglePinned(appState.ha_state_dict[entity_id]);
        renderPinnedBtn();
    }});
    renderPinnedBtn();

    // Real-time updates
    relativeTimeUpdater = new RelativeTimeUpdater(function() {
        var e = appState.ha_state_dict[entity_id];
        if (e) {
            simply.impl.nativeMenuUpdate(screenId, 0, stateIndex, 'State', getStateSubtitle(e), 0);
        }
    });
    relativeTimeUpdater.register(entity_id, entity.last_changed);

    subscriptionId = appState.haws.subscribeTrigger({
        type: 'subscribe_trigger',
        trigger: { platform: 'state', entity_id: entity_id }
    }, function(data) {
        if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
            var updated = data.event.variables.trigger.to_state;
            appState.ha_state_dict[entity_id] = updated;
            simply.impl.nativeMenuUpdate(screenId, 0, stateIndex, 'State', getStateSubtitle(updated), 0);
            simply.impl.nativeMenuUpdate(screenId, 0, stateIndex + 1, 'Last Changed', formatDateTime(updated.last_changed), 0);
            simply.impl.nativeMenuUpdate(screenId, 0, stateIndex + 2, 'Last Updated', formatDateTime(updated.last_updated), 0);
            if (relativeTimeUpdater) relativeTimeUpdater.update(entity_id, updated.last_changed);
        }
    }, function(error) {
        helpers.log_message('ENTITY UPDATE ERROR [' + entity_id + ']: ' + JSON.stringify(error));
    });
}

function showSetValueMenu(entity_id, entity) {
    var appState = AppState.getInstance();
    var screenId = nextScreenId++;
    var menuItems = [];
    var domain = entity_id.split('.')[0];

    var min = entity.attributes.min !== undefined ? entity.attributes.min : 0;
    var max = entity.attributes.max !== undefined ? entity.attributes.max : 100;
    var step = entity.attributes.step !== undefined ? entity.attributes.step : 1;
    var current = parseFloat(entity.state) || 0;
    var unit = entity.attributes.unit_of_measurement || '';

    var values = [];
    for (var v = max; v >= min; v -= step) {
        values.push(Math.round(v * 1000) / 1000);
    }

    simply.impl.nativeMenuPush(screenId, 'Set Value', 1, {
        onSelect: function(section, index) {
            var item = menuItems[index];
            if (item && typeof item.on_click === 'function') item.on_click();
        },
        onLongSelect: function() {},
        onBack: function() {}
    });

    for (var i = 0; i < values.length; i++) {
        (function(val, idx) {
            var isCurrent = Math.abs(val - Math.round(current / step) * step) < 0.001;
            var title = val + (unit ? ' ' + unit : '');
            menuItems.push({
                on_click: function() {
                    appState.haws.callService(domain, 'set_value', { value: val }, { entity_id: entity_id },
                        function() { Vibe.vibrate('short'); simply.impl.nativeMenuPop(); },
                        function() { Vibe.vibrate('double'); });
                }
            });
            simply.impl.nativeMenuUpdate(screenId, 0, idx, title, isCurrent ? 'Current' : '', 0);
        })(values[i], i);
    }
}

function showSetPositionMenu(entity_id, entity) {
    var appState = AppState.getInstance();
    var screenId = nextScreenId++;
    var menuItems = [];
    var currentPos = entity.attributes.current_position;

    simply.impl.nativeMenuPush(screenId, 'Set Position', 1, {
        onSelect: function(section, index) {
            var item = menuItems[index];
            if (item && typeof item.on_click === 'function') item.on_click();
        },
        onLongSelect: function() {},
        onBack: function() {}
    });

    for (var p = 100; p >= 0; p -= 10) {
        (function(pos, idx) {
            var subtitle = pos === currentPos ? 'Current' : (pos === 100 ? 'Open' : (pos === 0 ? 'Closed' : ''));
            menuItems.push({
                on_click: function() {
                    appState.haws.callService('cover', 'set_cover_position', { position: pos }, { entity_id: entity_id },
                        function() { Vibe.vibrate('short'); simply.impl.nativeMenuPop(); },
                        function() { Vibe.vibrate('double'); });
                }
            });
            simply.impl.nativeMenuUpdate(screenId, 0, idx, pos + '%', subtitle, 0);
        })(p, (100 - p) / 10);
    }
}

function showEntityAttributesMenu(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) return;

    var screenId = nextScreenId++;
    var attrs = Object.getOwnPropertyNames(entity.attributes);

    simply.impl.nativeMenuPush(screenId, 'Attributes', 1, {
        onSelect: function() {},
        onLongSelect: function() {},
        onBack: function() {}
    });

    for (var i = 0; i < attrs.length; i++) {
        simply.impl.nativeMenuUpdate(screenId, 0, i, attrs[i], String(entity.attributes[attrs[i]]), 0);
    }
}

module.exports.showEntityMenu = showEntityMenu;
module.exports.showEntityAttributesMenu = showEntityAttributesMenu;
