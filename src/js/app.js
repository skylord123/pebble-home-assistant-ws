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

/**
 * True when the entity is still in Home Assistant. A pin can outlive the
 * thing it points at, and every entity page in this app throws when its
 * entity is missing from ha_state_dict, so check before opening one: the
 * launch must land on the main menu, not on an exception raised inside the
 * websocket message pump.
 */
function timelineTargetEntityExists(entity_id) {
    if (appState.getEntity(entity_id)) {
        return true;
    }
    helpers.log_message('Timeline launch: ' + entity_id + ' is no longer in Home Assistant');
    return false;
}

/**
 * Open whatever a resolve_launch result names. Unknown kinds are not an
 * error: log and stay on the main menu, which is already on screen. That is
 * how a watchapp built today survives a kind added to the integration later.
 */
function openTimelineTarget(target) {
    if (!target || !target.kind) {
        helpers.log_message('Timeline launch: resolve returned no target');
        return;
    }
    helpers.log_message('Timeline launch: target kind ' + target.kind +
        (target.entity_id ? ' ' + target.entity_id : ''));
    switch (target.kind) {
        case 'entity':
            if (!target.entity_id) {
                helpers.log_message('Timeline launch: entity target with no entity_id');
            } else if (timelineTargetEntityExists(target.entity_id)) {
                EntityService.show(target.entity_id);
            }
            break;
        case 'todo_list':
            if (!target.entity_id) {
                ToDoListPage.showToDoLists();
            } else if (timelineTargetEntityExists(target.entity_id)) {
                ToDoListPage.showToDoList(target.entity_id);
            }
            break;
        case 'assistant':
            // Matches the quick-launch gate above: a watch with voice off or
            // no microphone must not be dropped into a page it cannot use
            if (appState.voice_enabled) {
                AssistPage.showAssistMenu();
            } else {
                helpers.log_message('Timeline launch: assistant requested but voice is disabled');
            }
            break;
        case 'calendar':
            if (!target.entity_id) {
                CalendarPage.showCalendarList();
            } else if (timelineTargetEntityExists(target.entity_id)) {
                var entity = appState.getEntity(target.entity_id);
                var name = (entity && entity.attributes && entity.attributes.friendly_name) ||
                    target.entity_id.substring(target.entity_id.indexOf('.') + 1);
                CalendarPage.showCalendarEvents(name, [target.entity_id]);
            }
            break;
        case 'none':
            helpers.log_message('Timeline launch: pin has no target');
            break;
        default:
            helpers.log_message('Timeline launch: unknown target kind ' + target.kind);
            break;
    }
}

// A Home Assistant pin's payload is its launchRef; the destination is not
// encoded in the launch code, so ask Home Assistant what the pin points at.
// Every failure (no connection, integration uninstalled, unknown ref) just
// logs and leaves the user on the main menu - never a blank screen, never a
// retry loop.
TimelineLaunch.registerHandler(TimelineLaunch.ACTION_HA_PIN, function(payload) {
    var msg = { type: 'pebble/timeline/resolve_launch', ref: payload };
    var sent = appState.haws && appState.haws.send(msg, function(data) {
        // This runs on the websocket message pump, where an exception would
        // also swallow the rest of a coalesced batch, so nothing may escape
        try {
            // haws hands the success callback the whole result frame
            openTimelineTarget(data && data.result);
        } catch (e) {
            helpers.log_message('Timeline launch: opening target failed: ' +
                ((e && e.message) || e));
        }
    }, function(data) {
        var error = (data && data.error) || {};
        helpers.log_message('Timeline launch: resolve failed for ref ' + payload + ': ' +
            (error.code || 'unknown') + ' ' + (error.message || ''));
    });
    if (!sent) {
        helpers.log_message('Timeline launch: not connected, cannot resolve ref ' + payload);
    }
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
// reported as `state` in the get_config payload, so the fetch waits for it to
// read RUNNING rather than racing a server that is still booting. The move to
// RUNNING fires core_config_updated, which unlike homeassistant_started a
// non-admin token is allowed to subscribe to, and each one is a cue to ask
// again.
var CORE_GATE_CEILING_MS = 180000;
var coreGateGeneration = 0;

function whenCoreRunning(proceed) {
    var log = helpers.log_message;
    var generation = ++coreGateGeneration;
    var haws = appState.haws;
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
        if (subscription && appState.haws) {
            appState.haws.unsubscribe(subscription);
            subscription = null;
        }
        if (reason) { log('Core state gate: ' + reason); }
        // Pending commands fail when the socket drops, and the next auth_ok
        // opens a gate of its own
        if (appState.haws !== haws || !haws.isConnected()) { return; }
        proceed();
    }

    function check() {
        haws.getConfig(function(data) {
            if (settled) { return; }
            var state = (data && data.result) ? data.result.state : null;
            if (!state) {
                release('no core state reported, fetching anyway');
            } else if (state === 'RUNNING') {
                release(ceiling ? 'Home Assistant finished starting' : null);
            } else if (!ceiling) {
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

    // Subscribe before asking. Home Assistant can reach RUNNING in between the
    // two, and the event is then the only thing that would ever tell us.
    subscription = haws.subscribeEvents('core_config_updated', function() {
        if (!settled) { check(); }
    }, function(err) {
        log('Core state gate: could not subscribe (' + JSON.stringify(err) + ')');
    }) || null;

    check();
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
    var haws = appState.haws;
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

    // With a startup cache the UI goes up before get_states is even sent, and
    // every entity page throws on a missing state. Launch targets that read
    // states wait for the answer.
    var statesSettled = false;
    var afterStates = [];

    // Runs inside websocket callbacks, where a throw would also abort the
    // rest of this fetch
    function runLaunch(fn) {
        try {
            fn();
        } catch (e) {
            log('Launch target failed: ' + ((e && e.message) || e));
        }
    }

    function whenStatesLoaded(fn) {
        if (statesSettled || appState.ha_state_dict) {
            runLaunch(fn);
        } else {
            afterStates.push(fn);
        }
    }

    function settleStates() {
        var queued = afterStates;
        afterStates = [];
        // A dropped connection drops the launch with it; the reconnect
        // resumes whatever is on screen instead
        if (appState.haws !== haws || !haws.isConnected()) { return; }
        statesSettled = true;
        queued.forEach(runLaunch);
    }

    // Quick launch targets that open from entity states
    var STATE_LAUNCHES = { favorite_entity: true, todo_lists: true, people: true };

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
            loadingCard.hide();
        } else if (STATE_LAUNCHES[appState.quick_launch_behavior] && !statesSettled && !appState.ha_state_dict) {
            // Nothing else is on the stack, so taking the splash down now
            // would leave the app with no window until the target opens
            loadingCard.subtitle('Fetching data...');
            whenStatesLoaded(function() { loadingCard.hide(); });
        } else {
            loadingCard.hide();
        }

        if (launchReason === 'quickLaunch') {
            log('Quick launch behavior: ' + appState.quick_launch_behavior);
            runLaunch(quickLaunch);
        }

        // Timeline pin launch: dispatch the pin's launch code to the handler
        // for its action type (main menu stays underneath so backing out of
        // the launched page lands somewhere useful). Calendar pins and Home
        // Assistant pins both look their target up in the states.
        if (launchReason === 'timelineAction') {
            var launchCode = simply.impl.state.launchArgs;
            log('Timeline launch with code: ' + launchCode);
            if (launchCode) {
                whenStatesLoaded(function() {
                    TimelineLaunch.handle(launchCode);
                });
            }
        }
    }

    function quickLaunch() {
        switch (appState.quick_launch_behavior) {
            case 'assistant':
                if (appState.voice_enabled) AssistPage.showAssistMenu();
                break;
            case 'favorites':
                FavoritesPage.showFavorites();
                break;
            case 'favorite_entity':
                var favorite = appState.quick_launch_favorite_entity;
                if (favorite && appState.favoriteEntityStore.has(favorite)) {
                    whenStatesLoaded(function() {
                        if (appState.getEntity(favorite)) {
                            EntityService.show(favorite);
                        } else {
                            log('Quick launch: ' + favorite + ' is not in Home Assistant');
                        }
                    });
                }
                break;
            case 'areas':
                AreaMenuPage.showAreaMenu();
                break;
            case 'labels':
                LabelMenuPage.showLabelMenu();
                break;
            case 'todo_lists':
                whenStatesLoaded(function() {
                    ToDoListPage.showToDoLists();
                });
                break;
            case 'people':
                whenStatesLoaded(function() {
                    var personEntities = Object.keys(appState.ha_state_dict || {}).filter(function(id) {
                        return id.startsWith('person.');
                    });
                    EntityListPage.showEntityList("People", personEntities, true, true, true);
                });
                break;
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

            // Everything still pending fails when the connection drops. The
            // fetch after the next auth_ok starts over, and this one must not
            // put the UI up over the reconnect splash or cache what it missed.
            if (appState.haws !== haws || !haws.isConnected()) {
                log("Connection dropped during data fetch");
                return;
            }

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
        settleStates();
        checkAllLoaded();
    }, function(err) {
        fetchFailed = true;
        fetchError = err;
        loaded.states = true;
        settleStates();
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

