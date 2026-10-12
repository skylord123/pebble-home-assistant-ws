/**
 * ConnectionService - Handles Home Assistant WebSocket connection lifecycle
 */
var WindowStack = require('ui/windowstack');
var HAWS = require('vendor/haws');

var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');
var Theme = require('app/ui/Theme');
var Assist = require('ui/assist');
var ConfigBridge = require('app/ConfigBridge');

var ConnectionService = {
    // Reference to loading card (set by app.js)
    loadingCard: null,

    // Callback for when auth succeeds (set by app.js)
    onAuthOk: null,

    // Flag to track if app is restarting
    isRestarting: false,

    // Prevent duplicate back handlers on repeated reconnect attempts
    backHandlerAttached: false,
    // Track whether we're reconnecting from an active session
    reconnecting: false,
    hadWindowsBeforeDisconnect: false,
    // Flag to defer reconnecting dialog until dictation completes
    pendingReconnectDialog: false,
    // Home Assistant refused the token. Nothing reconnects after that, and the
    // failure has to stay on screen rather than turn into "Reconnecting".
    authFailed: false,
    // The last thing that went wrong, for a config page asking how the
    // connection is doing. Cleared when a connection authenticates.
    lastError: null,
    restartTimer: null,

    // How long a connection test waits for Home Assistant before giving up
    TEST_TIMEOUT_MS: 15000,

    /**
     * Initialize the connection service
     * @param {Object} options - Configuration options
     * @param {UI.Card} options.loadingCard - The loading card UI element
     * @param {Function} options.onAuthOk - Callback when authentication succeeds
     */
    init: function(options) {
        this.loadingCard = options.loadingCard;
        this.onAuthOk = options.onAuthOk;
        this.backHandlerAttached = false;
        this.reconnecting = false;
        this.hadWindowsBeforeDisconnect = false;
        this.pendingReconnectDialog = false;
    },

    /**
     * Restart the app after settings change
     * Disconnects HAWS, clears windows, and reinitializes
     */
    restart: function() {
        var self = this;
        var appState = AppState.getInstance();
        var log = helpers.log_message;

        log('Restarting app after settings change...');

        // Set flag to skip quick launch behavior
        this.isRestarting = true;
        this.reconnecting = false;
        this.hadWindowsBeforeDisconnect = false;
        this.pendingReconnectDialog = false;

        // Disconnect HAWS whether or not it is currently up. A instance that is
        // mid-reconnect is not "connected", but it still holds a pending retry
        // timer, and letting it fire would authenticate a second connection
        // that runs its own post-auth pipeline and throws the splash back over
        // a working UI. disconnect() clears that timer and stops it retrying.
        if (appState.haws) {
            log('Disconnecting HAWS...');
            appState.haws.disconnect();
        }

        // Clear all windows except loading card
        log('Clearing all windows...');
        var windowsToRemove = [];
        for (var i = 0; i < WindowStack._items.length; i++) {
            var window = WindowStack._items[i];
            if (window._id() !== this.loadingCard._id()) {
                windowsToRemove.push(window);
            }
        }

        // Hide all windows
        for (var j = 0; j < windowsToRemove.length; j++) {
            windowsToRemove[j].hide();
        }

        // Reset state variables in AppState
        appState.ha_state_cache = null;
        appState.ha_state_dict = null;
        appState.ha_state_cache_updated = null;
        appState.area_registry_cache = null;
        appState.floor_registry_cache = null;
        appState.device_registry_cache = null;
        appState.entity_registry_cache = null;
        appState.label_registry_cache = null;
        appState.ha_pipelines = null;
        appState.preferred_pipeline = null;
        // selected_pipeline is left alone: SettingsManager.load() has just
        // read the choice the config page saved, and clearing it here let the
        // preferred pipeline be saved over it
        appState.ha_connected = false;

        // Show loading card
        this.loadingCard.show();
        this.loadingCard.title('Home Assistant');
        this.loadingCard.body('');
        this.loadingCard.subtitle('Restarting...');

        // Reinitialize after a small delay. Two saves in quick succession
        // must still end up with one connection.
        log('Reinitializing app...');
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
        }
        this.restartTimer = setTimeout(function() {
            self.restartTimer = null;
            self.connect();
        }, 500);
    },

    /**
     * Connect to Home Assistant
     */
    connect: function() {
        var self = this;
        var appState = AppState.getInstance();
        var log = helpers.log_message;

        // An earlier auth failure or setup prompt must not linger into this attempt
        this.authFailed = false;
        this.lastError = null;
        this.loadingCard.title('Home Assistant');
        this.loadingCard.body('');

        // Check if configured
        if (!appState.ha_url || !appState.ha_password) {
            this.loadingCard.subtitle('Setup required');
            this.loadingCard.body("Configure from the Pebble app");
            this.loadingCard.setup();
            ConfigBridge.notifyStatus();
            return;
        }

        // Set up base URL and headers for REST requests
        appState.baseurl = appState.ha_url + '/api';
        appState.baseheaders = {
            'Authorization': 'Bearer ' + appState.ha_password,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };

        this.loadingCard.subtitle('Connecting');
        log('Connecting');
        log('Coalesce messages: ' + (Constants.coalesce_messages_enabled ? 'ENABLED' : 'DISABLED'));

        // Create HAWS instance
        var haws = new HAWS(
            appState.ha_url,
            appState.ha_password,
            Constants.debugHAWS,
            Constants.coalesce_messages_enabled
        );
        appState.haws = haws;

        // A restart replaces the instance, and the old socket can still
        // report its close long after the new one is up. Its events belong to
        // a connection nobody is using any more.
        function current() {
            return appState.haws === haws;
        }
        // Whether this instance ever got past authentication, which tells a
        // dropped connection apart from one that never came up
        var everAuthenticated = false;

        // Set up event handlers
        haws.on('open', function(evt) {
            if (!current()) { return; }
            self.loadingCard.subtitle('Authenticating');
        });

        haws.on('close', function(evt) {
            if (!current()) { return; }
            // A refused token has its own message, and a restart is not an
            // error. Anything else is worth telling a config page about,
            // since the splash is the only other place it shows.
            if (!self.authFailed && !self.isRestarting) {
                self.lastError = everAuthenticated
                    ? { code: 'disconnected', message: 'Lost the connection to Home Assistant, reconnecting' }
                    : { code: 'unreachable', message: 'Could not reach ' + appState.ha_url + ', retrying' };
            }
            self.handleDisconnect();
        });

        haws.on('error', function(evt) {
            if (!current()) { return; }
            self.loadingCard.subtitle('Error');
        });

        haws.on('auth_invalid', function(evt) {
            if (!current()) { return; }
            self.authFailed = true;
            self.lastError = {
                code: 'auth_invalid',
                message: (evt.detail && evt.detail.message) || 'Home Assistant refused the access token'
            };
            self.loadingCard.title('Auth Failure');
            self.loadingCard.subtitle('Check your access token');
            // The full message from Home Assistant can be long; the detail
            // line wraps while the status line would cut it off
            self.loadingCard.body(evt.detail.message || 'Unknown error');
            self.loadingCard.error();
            ConfigBridge.notifyStatus();
        });

        haws.on('auth_ok', function(evt) {
            if (!current()) { return; }
            log("ws auth_ok: " + JSON.stringify(evt));
            appState.ha_version = (evt.detail && evt.detail.ha_version) || null;
            everAuthenticated = true;
            self.lastError = null;
            ConfigBridge.notifyStatus();

            // Clear pending reconnect dialog if connection recovered before dictation completed.
            // This prevents showing the reconnecting dialog when the connection is already active.
            if (self.pendingReconnectDialog) {
                log('Connection recovered - clearing pending reconnect dialog');
                self.pendingReconnectDialog = false;
            }

            // A background following the sun needs to know where the watch is.
            // The phone is asked first and its answer kept; this is for when it
            // will not give one, since Home Assistant knows where home is.
            Theme.requestHomeLocation();

            if (self.onAuthOk) {
                self.onAuthOk(evt);
            }
        });

        haws.connect();
    },

    /**
     * Try a URL and token on a connection of their own, without touching the
     * app's. The answer says whether Home Assistant accepted them, and if not,
     * why, in words a settings page can show.
     *
     * The connection is torn down whatever happens. A refused token would
     * otherwise be retried, and a dead address retried forever.
     *
     * @param {string} url - Home Assistant base URL, scheme included
     * @param {string} token - Long-lived access token
     * @param {Function} done - Called once with { ok: true, ha_version } or
     *     { ok: false, error: { code, message } }
     */
    test: function(url, token, done) {
        var log = helpers.log_message;
        var haws = new HAWS(url, token, false, false);
        var settled = false;
        var sawError = false;

        var timer = setTimeout(function() {
            finish({ ok: false, error: {
                code: 'timeout',
                message: 'Home Assistant did not answer within ' +
                    Math.round(ConnectionService.TEST_TIMEOUT_MS / 1000) + ' seconds'
            } });
        }, this.TEST_TIMEOUT_MS);

        function finish(result) {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            // disconnect() closes the socket, and that close lands back here
            // as a 'close' event, which the settled flag now swallows
            try { haws.disconnect(); } catch (e) { /* nothing left to close */ }
            log('Connection test ' + (result.ok ? 'succeeded' : 'failed: ' + result.error.message));
            done(result);
        }

        haws.on('auth_ok', function(evt) {
            finish({ ok: true, ha_version: (evt.detail && evt.detail.ha_version) || null });
        });

        haws.on('auth_invalid', function(evt) {
            finish({ ok: false, error: {
                code: 'auth_invalid',
                message: (evt.detail && evt.detail.message) || 'Home Assistant refused the access token'
            } });
        });

        haws.on('error', function() {
            // The close that follows carries the outcome; this only says the
            // socket itself failed rather than Home Assistant hanging up
            sawError = true;
        });

        haws.on('close', function() {
            finish({ ok: false, error: {
                code: 'unreachable',
                message: sawError
                    ? 'Could not reach ' + url + '. Check the address, and that this phone can reach Home Assistant from where it is.'
                    : 'Home Assistant closed the connection before authenticating'
            } });
        });

        log('Testing a connection');
        try {
            haws.connect();
        } catch (err) {
            // new WebSocket() throws on an address it cannot make sense of
            finish({ ok: false, error: {
                code: 'bad_url',
                message: 'That does not look like a usable URL: ' + ((err && err.message) || err)
            } });
        }
    },

    /**
     * Handle disconnection
     */
    handleDisconnect: function() {
        var self = this;
        var log = helpers.log_message;

        ConfigBridge.notifyStatus();

        // If we're restarting, don't try to save/restore windows
        if (this.isRestarting) {
            log('Connection closed during restart - skipping window save');
            return;
        }

        if (this.authFailed) {
            log('Connection closed after an auth failure - not reconnecting');
            return;
        }

        // If dictation is in progress, defer the reconnecting dialog until it completes
        if (Assist.isDictating()) {
            log('Connection lost while dictating - deferring reconnect dialog');
            // The page under the conversation still holds subscriptions on
            // the dead socket and has to let go of them now. If the
            // connection comes back before the dialog is shown, hiding the
            // splash gives the page its 'show' back.
            this.loadingCard.cover();
            this.pendingReconnectDialog = true;
            this.reconnecting = true;
            this.hadWindowsBeforeDisconnect = WindowStack._items.some(function(window) {
                return window._id() !== self.loadingCard._id();
            });
            return;
        }

        this.loadingCard.subtitle('Reconnecting');
        this.loadingCard.show();
        this.reconnecting = true;
        this.hadWindowsBeforeDisconnect = WindowStack._items.some(function(window) {
            return window._id() !== self.loadingCard._id();
        });

        if (!this.backHandlerAttached) {
            this.backHandlerAttached = true;
            this.loadingCard.on('click', 'back', function(e) {
                self.loadingCard.subtitle('Hold back to exit');
                return true;
            });
        }
    },

    /**
     * Get the isRestarting flag
     */
    getIsRestarting: function() {
        return this.isRestarting;
    },

    /**
     * Set the isRestarting flag
     */
    setIsRestarting: function(value) {
        this.isRestarting = value;
    },

    shouldResumePreviousPage: function() {
        return this.reconnecting && this.hadWindowsBeforeDisconnect && !this.isRestarting;
    },

    /**
     * Show the reconnecting dialog if it was deferred due to dictation
     */
    showPendingReconnectDialog: function() {
        if (!this.pendingReconnectDialog) {
            return;
        }

        helpers.log_message('Showing deferred reconnecting dialog after dictation completed');
        this.pendingReconnectDialog = false;
        this.loadingCard.subtitle('Reconnecting');
        this.loadingCard.show();

        if (!this.backHandlerAttached) {
            var self = this;
            this.backHandlerAttached = true;
            this.loadingCard.on('click', 'back', function(e) {
                self.loadingCard.subtitle('Hold back to exit');
                return true;
            });
        }
    },

    clearReconnectState: function() {
        this.reconnecting = false;
        this.hadWindowsBeforeDisconnect = false;
        this.pendingReconnectDialog = false;
    }
};

module.exports = ConnectionService;
