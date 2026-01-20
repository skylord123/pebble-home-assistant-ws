/**
 * ConnectionService - Handles Home Assistant WebSocket connection lifecycle
 */
var WindowStack = require('ui/windowstack');
var Settings = require('settings');
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

    // Saved windows for reconnection
    savedWindows: null,

    /**
     * Initialize the connection service
     * @param {Object} options - Configuration options
     * @param {UI.Card} options.loadingCard - The loading card UI element
     * @param {Function} options.onAuthOk - Callback when authentication succeeds
     */
    init: function(options) {
        this.loadingCard = options.loadingCard;
        this.onAuthOk = options.onAuthOk;
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

        // Disconnect HAWS if connected
        if (appState.haws && appState.haws.isConnected()) {
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

        // Clear saved windows
        this.savedWindows = null;

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
            self.loadingCard.subtitle(evt.detail.message || 'Unknown error');
        });

        appState.haws.on('auth_ok', function(evt) {
            log("ws auth_ok: " + JSON.stringify(evt));
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

        this.loadingCard.subtitle('Reconnecting...');
        this.loadingCard.show();

        // Require multiple back button presses to exit
        var backButtonPresses = 0;
        var pressesRequiredToExit = 3;
        this.loadingCard.on('click', 'back', function(e) {
            backButtonPresses++;
            if (backButtonPresses >= pressesRequiredToExit) {
                self.loadingCard.subtitle('Press again to exit');
                return false;
            }
            return true;
        });

        // Save current windows and hide them
        this.savedWindows = WindowStack._items.slice();
        for (var i = 0; i < WindowStack._items.length; i++) {
            var window = WindowStack._items[i];
            if (window._id() !== this.loadingCard._id()) {
                window.hide();
            }
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

    /**
     * Get saved windows
     */
    getSavedWindows: function() {
        return this.savedWindows;
    },

    /**
     * Clear saved windows
     */
    clearSavedWindows: function() {
        this.savedWindows = null;
    }
};

module.exports = ConnectionService;
