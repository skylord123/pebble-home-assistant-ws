/**
 * pebble-home-assistant-ws
 *
 * Created by Skylord123 (https://skylar.tech)
 *
 * Entry point for the Home Assistant Pebble app.
 * All functionality is delegated to modular services and pages.
 */

// === Core Imports ===
var UI = require('ui');
var WindowStack = require('ui/windowstack');
var Settings = require('settings');
var FavoriteEntityStore = require('vendor/FavoriteEntityStore');
var PinnedEntityStore = require('vendor/PinnedEntityStore');
var simply = require('ui/simply');

// === Module Imports ===
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');
var SettingsManager = require('app/SettingsManager');
var CacheManager = require('app/CacheManager');
var StateService = require('app/StateService');
var ConnectionService = require('app/ConnectionService');
var EntityService = require('app/EntityService');

// === Page Imports ===
var MainMenuPage = require('app/pages/MainMenuPage');
var FavoritesPage = require('app/pages/FavoritesPage');
var AreaMenuPage = require('app/pages/AreaMenuPage');
var LabelMenuPage = require('app/pages/LabelMenuPage');
var EntityListPage = require('app/pages/EntityListPage');
var ToDoListPage = require('app/pages/ToDoListPage');
var AssistPage = require('app/pages/AssistPage');

// === Initialize AppState ===
var appState = AppState.getInstance();

// === Initialize Stores ===
appState.favoriteEntityStore = new FavoriteEntityStore();
appState.pinnedEntityStore = new PinnedEntityStore();

// === Loading Card ===
var loadingCard = new UI.Card({
    title: 'Home Assistant WS',
    status: false
});

// === Logging ===
helpers.log_message('Started! v' + Constants.appVersion);
var accountToken = (Pebble.getAccountToken && typeof Pebble.getAccountToken === 'function')
    ? Pebble.getAccountToken()
    : 'unavailable';
helpers.log_message('AccountToken: ' + accountToken);

// === Settings Config Handler ===
SettingsManager.initConfigHandler({
    configPageUrl: Constants.configPageUrl,
    onSettingsChanged: function() {
        ConnectionService.restart();
    }
});

// === Post-Authentication Handler ===
function on_auth_ok(evt) {
    var log = helpers.log_message;
    var fetch_start_time = Date.now();
    log("Starting data fetch...");

    appState.ha_connected = true;
    Settings.option('ha_connected', true);

    // Try to load from cache first
    var cacheLoaded = CacheManager.load();
    var isFetchingInBackground = cacheLoaded;

    // Quick launch handler
    function handleQuickLaunch(retryCount) {
        retryCount = retryCount || 0;
        var launchReason = simply.impl.state.launchReason;
        log('Launch reason: ' + launchReason);

        if (!launchReason && retryCount < 10) {
            setTimeout(function() { handleQuickLaunch(retryCount + 1); }, 10);
            return;
        }

        var skipMainMenu = launchReason === 'quickLaunch' &&
            appState.quick_launch_behavior !== 'main_menu' &&
            appState.quick_launch_exit_on_back;

        if (!skipMainMenu) {
            MainMenuPage.showMainMenu();
        }
        loadingCard.hide();

        if (launchReason === 'quickLaunch') {
            log('Quick launch behavior: ' + appState.quick_launch_behavior);
            switch (appState.quick_launch_behavior) {
                case 'assistant':
                    if (appState.voice_enabled) AssistPage.showAssistMenu();
                    break;
                case 'favorites':
                    FavoritesPage.showFavorites();
                    break;
                case 'favorite_entity':
                    if (appState.quick_launch_favorite_entity &&
                        appState.favoriteEntityStore.has(appState.quick_launch_favorite_entity)) {
                        EntityService.show(appState.quick_launch_favorite_entity);
                    }
                    break;
                case 'areas':
                    AreaMenuPage.showAreaMenu();
                    break;
                case 'labels':
                    LabelMenuPage.showLabelMenu();
                    break;
                case 'todo_lists':
                    ToDoListPage.showToDoLists();
                    break;
                case 'people':
                    var personEntities = Object.keys(appState.ha_state_dict).filter(function(id) {
                        return id.startsWith('person.');
                    });
                    EntityListPage.showEntityList("People", personEntities, true, true, true);
                    break;
            }
        }
    }

    function showUIAfterAuth() {
        var savedWindows = ConnectionService.getSavedWindows();
        if (savedWindows) {
            WindowStack._items = savedWindows.slice();
            ConnectionService.clearSavedWindows();
            loadingCard.hide();
        } else if (ConnectionService.getIsRestarting()) {
            log('Skipping quick launch - app is restarting');
            ConnectionService.setIsRestarting(false);
            MainMenuPage.showMainMenu();
            loadingCard.hide();
        } else {
            handleQuickLaunch();
        }
    }

    if (cacheLoaded) {
        log("Cache loaded, showing UI immediately");
        showUIAfterAuth();
    } else {
        loadingCard.subtitle("Fetching data...");
    }

    // Track loading progress
    var loaded = {
        pipelines: false, states: false, areas: false,
        floors: false, devices: false, entities: false, labels: false
    };
    var fetchFailed = false;
    var fetchError = null;

    function checkAllLoaded() {
        if (loaded.states && loaded.areas && loaded.floors &&
            loaded.devices && loaded.entities && loaded.labels && loaded.pipelines) {

            var elapsed = Date.now() - fetch_start_time;
            log("Data fetch complete in " + elapsed + "ms");

            CacheManager.save();

            if (isFetchingInBackground && fetchFailed) {
                log("Background fetch failed: " + fetchError);
                return;
            }

            if (!isFetchingInBackground) {
                showUIAfterAuth();
            }
        }
    }

    // Fetch all data
    StateService.getStates(function() {
        loaded.states = true;
        checkAllLoaded();
    }, function(err) {
        fetchFailed = true;
        fetchError = err;
        loaded.states = true;
        checkAllLoaded();
    }, true);

    appState.haws.getAreaRegistry(function(data) {
        appState.area_registry_cache = {};
        if (data.result) {
            for (var i = 0; i < data.result.length; i++) {
                var area = data.result[i];
                appState.area_registry_cache[area.area_id] = area;
            }
        }
        loaded.areas = true;
        checkAllLoaded();
    }, function() { loaded.areas = true; checkAllLoaded(); });

    appState.haws.getFloorRegistry(function(data) {
        appState.floor_registry_cache = {};
        if (data.result) {
            for (var i = 0; i < data.result.length; i++) {
                var floor = data.result[i];
                appState.floor_registry_cache[floor.floor_id] = floor;
            }
        }
        loaded.floors = true;
        checkAllLoaded();
    }, function() { loaded.floors = true; checkAllLoaded(); });

    appState.haws.getDeviceRegistry(function(data) {
        appState.device_registry_cache = {};
        if (data.result) {
            for (var i = 0; i < data.result.length; i++) {
                var device = data.result[i];
                appState.device_registry_cache[device.id] = device;
            }
        }
        loaded.devices = true;
        checkAllLoaded();
    }, function() { loaded.devices = true; checkAllLoaded(); });

    appState.haws.getEntityRegistry(function(data) {
        appState.entity_registry_cache = {};
        if (data.result) {
            for (var i = 0; i < data.result.length; i++) {
                var entity = data.result[i];
                appState.entity_registry_cache[entity.entity_id] = entity;
            }
        }
        loaded.entities = true;
        checkAllLoaded();
    }, function() { loaded.entities = true; checkAllLoaded(); });

    appState.haws.getLabelRegistry(function(data) {
        appState.label_registry_cache = {};
        if (data.result) {
            for (var i = 0; i < data.result.length; i++) {
                var label = data.result[i];
                appState.label_registry_cache[label.label_id] = label;
            }
        }
        loaded.labels = true;
        checkAllLoaded();
    }, function() { loaded.labels = true; checkAllLoaded(); });

    AssistPage.loadAssistPipelines(function() {
        loaded.pipelines = true;
        checkAllLoaded();
    });
}

// === Auto-refresh Timer ===
var refreshInterval = appState.ha_refresh_interval || 15;
setInterval(function() {
    if (appState.haws && appState.haws.isConnected()) {
        helpers.log_message('Auto-refreshing states');
        StateService.getStates();
    }
}, 60000 * refreshInterval);

// === Initialize Connection Service ===
ConnectionService.init({
    loadingCard: loadingCard,
    onAuthOk: on_auth_ok
});

// === Start App ===
SettingsManager.load();
loadingCard.show();
ConnectionService.connect();
