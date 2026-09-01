/**
 * ConnectionService - Handles Home Assistant WebSocket connection lifecycle
 */
var WindowStack = require('ui/windowstack');
var HAWS = require('vendor/haws');

var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');

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
        appState.selected_pipeline = null;
        appState.ha_connected = false;

        // Show loading card
        this.loadingCard.show();
        this.loadingCard.subtitle('Restarting...');

        // Reinitialize after a small delay
        log('Reinitializing app...');
        setTimeout(function() {
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

        // Check if configured
        if (!appState.ha_url || !appState.ha_password) {
            this.loadingCard.subtitle('Setup required');
            this.loadingCard.body("Configure from the Pebble app");
            this.loadingCard.setup();
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
        appState.haws = new HAWS(
            appState.ha_url,
            appState.ha_password,
            Constants.debugHAWS,
            Constants.coalesce_messages_enabled
        );

        // Set up event handlers
        appState.haws.on('open', function(evt) {
            self.loadingCard.subtitle('Authenticating');
        });

        appState.haws.on('close', function(evt) {
            self.handleDisconnect();
        });

        appState.haws.on('error', function(evt) {
            self.loadingCard.subtitle('Error');
        });

        appState.haws.on('auth_invalid', function(evt) {
            self.loadingCard.title('Auth Failure');
            self.loadingCard.subtitle('Check your access token');
            // The full message from Home Assistant can be long; the detail
            // line wraps while the status line would cut it off
            self.loadingCard.body(evt.detail.message || 'Unknown error');
            self.loadingCard.error();
        });

        appState.haws.on('auth_ok', function(evt) {
            log("ws auth_ok: " + JSON.stringify(evt));
            appState.ha_version = (evt.detail && evt.detail.ha_version) || null;
            if (self.onAuthOk) {
                self.onAuthOk(evt);
            }
        });

        appState.haws.connect();
    },

    /**
     * Handle disconnection
     */
    handleDisconnect: function() {
        var self = this;
        var log = helpers.log_message;

        // If we're restarting, don't try to save/restore windows
        if (this.isRestarting) {
            log('Connection closed during restart - skipping window save');
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

    clearReconnectState: function() {
        this.reconnecting = false;
        this.hadWindowsBeforeDisconnect = false;
    }
};

module.exports = ConnectionService;
