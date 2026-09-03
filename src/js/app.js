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
var Settings = require('settings');
var FavoriteEntityStore = require('vendor/FavoriteEntityStore');
var PinnedEntityStore = require('vendor/PinnedEntityStore');
var AlarmCodeStore = require('vendor/AlarmCodeStore');
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
var CalendarPage = require('app/pages/CalendarPage');
var TimelineLaunch = require('app/TimelineLaunch');
var AssistPage = require('app/pages/AssistPage');

// === Timeline Launch Handlers ===
// Timeline pins launch the app with a launch code whose top byte selects the
// action; register a handler per supported action type
TimelineLaunch.registerHandler(TimelineLaunch.ACTION_CALENDAR_EVENT, function(payload, launchCode) {
    CalendarPage.showCalendarEventByLaunchCode(launchCode);
});

// === Initialize AppState ===
var appState = AppState.getInstance();

// === Initialize Stores ===
appState.favoriteEntityStore = new FavoriteEntityStore();
appState.pinnedEntityStore = new PinnedEntityStore();
appState.alarmCodeStore = new AlarmCodeStore();

// === Loading Card ===
var loadingCard = require('app/ui/SplashScreen');

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

// === Home Assistant core state gate ===
//
// Home Assistant accepts websocket connections and authenticates them well
// before it has finished starting, and a get_states asked in that window comes
// back with a fraction of the house or none of it at all. CoreState is
// reported as `state` in the get_config payload, and the move to RUNNING fires
// homeassistant_started, so the fetch waits for one or the other rather than
// racing a server that is still booting.
var CORE_GATE_CEILING_MS = 180000;
var coreGateGeneration = 0;

function whenCoreRunning(proceed) {
    var log = helpers.log_message;
    var generation = ++coreGateGeneration;
    var subscription = null;
    var ceiling = null;
    var settled = false;

    function release(reason) {
        // A connection that dropped while this gate was waiting has already
        // authenticated again and opened a gate of its own, and this one must
        // not fire a second data fetch in behind it
        if (settled || generation !== coreGateGeneration) { return; }
        settled = true;
        if (ceiling) { clearTimeout(ceiling); ceiling = null; }
        if (subscription) {
            appState.haws.unsubscribe(subscription);
            subscription = null;
        }
        if (reason) { log('Core state gate: ' + reason); }
        proceed();
    }

    // Subscribe before asking. Home Assistant can reach RUNNING in between the
    // two, and the event is then the only thing that would ever tell us.
    subscription = appState.haws.subscribeEvents('homeassistant_started', function() {
        release('homeassistant_started received');
    }) || null;

    appState.haws.getConfig(function(data) {
        var state = (data && data.result) ? data.result.state : null;
        if (!state) {
            release('no core state reported, fetching anyway');
        } else if (state === 'RUNNING') {
            release(null);
        } else {
            log('Home Assistant is ' + state + ', waiting for it to finish starting');
            loadingCard.subtitle('Starting up');
            // A Home Assistant that never finishes starting must not strand
            // the app on the splash for good
            ceiling = setTimeout(function() {
                release('gave up waiting after ' +
                    Math.round(CORE_GATE_CEILING_MS / 1000) + 's');
            }, CORE_GATE_CEILING_MS);
        }
    }, function(err) {
        release('get_config failed (' + JSON.stringify(err) + '), fetching anyway');
    });
}

// === Post-Authentication Handler ===
function on_auth_ok(evt) {
    appState.ha_connected = true;
    Settings.option('ha_connected', true);

    whenCoreRunning(start_data_fetch);
}

function start_data_fetch() {
    var log = helpers.log_message;
    var fetch_start_time = Date.now();
    log("Starting data fetch...");

    // Try to load from cache first.
    //
    // On a reconnect the live state is already in memory and is newer than
    // anything on disk, so reloading the snapshot would roll every entity back
    // to the last completed fetch and throw away everything the subscriptions
    // delivered since. A restart clears ha_state_dict, so that path still
    // loads the cache normally.
    var haveLiveState = !!(appState.ha_state_dict &&
        Object.keys(appState.ha_state_dict).length > 0);
    var cacheLoaded = haveLiveState ? true : CacheManager.load();
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

        // Timeline pin launch: dispatch the pin's launch code to the handler
        // for its action type (main menu stays underneath so backing out of
        // the launched page lands somewhere useful)
        if (launchReason === 'timelineAction') {
            var launchCode = simply.impl.state.launchArgs;
            log('Timeline launch with code: ' + launchCode);
            if (launchCode) {
                TimelineLaunch.handle(launchCode);
            }
        }
    }

    function showUIAfterAuth() {
        if (ConnectionService.getIsRestarting()) {
            log('Skipping quick launch - app is restarting');
            ConnectionService.setIsRestarting(false);
            ConnectionService.clearReconnectState();
            MainMenuPage.showMainMenu();
            loadingCard.hide();
        } else if (ConnectionService.shouldResumePreviousPage()) {
            log('Reconnect successful - resuming current page');
            ConnectionService.clearReconnectState();
            loadingCard.hide();
        } else {
            ConnectionService.clearReconnectState();
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
            } else {
                // The UI was shown from the startup cache; fresh data may add
                // or remove main menu items (e.g. Calendars)
                MainMenuPage.refreshIfVisible();
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

    appState.haws.getConfigAreas(function(data) {
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

    appState.haws.getConfigFloors(function(data) {
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

    appState.haws.getConfigDevices(function(data) {
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

    appState.haws.getConfigEntities(function(data) {
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

    appState.haws.getConfigLabels(function(data) {
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

// === Initialize Connection Service ===
ConnectionService.init({
    loadingCard: loadingCard,
    onAuthOk: on_auth_ok
});

// === Start App ===
SettingsManager.load();
loadingCard.show();
ConnectionService.connect();

