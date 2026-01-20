/**
 * SettingsManager - Handles loading and managing application settings
 */
var Settings = require('settings');
var Feature = require('platform/feature');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');

var SettingsManager = {
    /**
     * Load all settings from storage into AppState
     */
    load: function() {
        var appState = AppState.getInstance();
        var log = helpers.log_message;

        // Core settings
        appState.ha_url = Settings.option('ha_url');
        appState.ha_password = Settings.option('token');
        appState.ha_refresh_interval = Settings.option('refreshTime') ? Settings.option('refreshTime') : 15;
        appState.ha_order_by = Settings.option('order_by') || 'attributes.friendly_name';
        appState.ha_order_dir = Settings.option('order_dir') || 'asc';

        // Voice settings
        appState.voice_enabled = Feature.microphone(true, false) && Settings.option('voice_enabled') !== false;
        appState.voice_confirm = Settings.option('voice_confirm');
        appState.voice_backlight_trigger = Settings.option('voice_backlight_trigger') !== false;
        appState.voice_agent = Settings.option('voice_agent') ? Settings.option('voice_agent') : null;

        // Quick launch settings
        appState.quick_launch_behavior = Settings.option('quick_launch_behavior') || 'main_menu';
        appState.quick_launch_favorite_entity = Settings.option('quick_launch_favorite_entity') || null;
        appState.quick_launch_exit_on_back = Settings.option('quick_launch_exit_on_back') === true;

        // Domain menu settings
        var domainMenuSetting = Settings.option('domain_menu_enabled');
        appState.domain_menu_enabled = domainMenuSetting !== undefined ? domainMenuSetting : 'conditional';

        appState.domain_menu_all_entities = Settings.option('domain_menu_all_entities');
        appState.domain_menu_all_entities = appState.domain_menu_all_entities !== undefined
            ? appState.domain_menu_all_entities
            : appState.domain_menu_enabled;

        appState.domain_menu_areas = Settings.option('domain_menu_areas');
        appState.domain_menu_areas = appState.domain_menu_areas !== undefined
            ? appState.domain_menu_areas
            : appState.domain_menu_enabled;

        appState.domain_menu_labels = Settings.option('domain_menu_labels');
        appState.domain_menu_labels = appState.domain_menu_labels !== undefined
            ? appState.domain_menu_labels
            : appState.domain_menu_enabled;

        appState.domain_menu_favorites = Settings.option('domain_menu_favorites');
        appState.domain_menu_favorites = appState.domain_menu_favorites !== undefined
            ? appState.domain_menu_favorites
            : appState.domain_menu_enabled;

        // Conditional settings
        appState.domain_menu_min_entities = Settings.option('domain_menu_min_entities');
        appState.domain_menu_min_entities = appState.domain_menu_min_entities !== undefined
            ? appState.domain_menu_min_entities
            : 10;

        appState.domain_menu_min_domains = Settings.option('domain_menu_min_domains');
        appState.domain_menu_min_domains = appState.domain_menu_min_domains !== undefined
            ? appState.domain_menu_min_domains
            : 2;

        appState.ha_connected = Settings.option('ha_connected') || false;

        // Handle ignore_domains
        appState.ignore_domains = Settings.option('ignore_domains');
        if (appState.ignore_domains === undefined || appState.ignore_domains === null) {
            appState.ignore_domains = Constants.DEFAULT_IGNORE_DOMAINS;
        } else if (!Array.isArray(appState.ignore_domains)) {
            try {
                appState.ignore_domains = JSON.parse(appState.ignore_domains);
            } catch(e) {
                log('Error parsing ignore_domains, using defaults: ' + e);
                appState.ignore_domains = Constants.DEFAULT_IGNORE_DOMAINS;
            }
        }
        log('Ignore domains: ' + JSON.stringify(appState.ignore_domains));

        // Entity state handling settings
        appState.unavailable_entity_handling = Settings.option('unavailable_entity_handling');
        appState.unavailable_entity_handling = appState.unavailable_entity_handling !== undefined
            ? appState.unavailable_entity_handling
            : 'sort_to_end';

        appState.unknown_entity_handling = Settings.option('unknown_entity_handling');
        appState.unknown_entity_handling = appState.unknown_entity_handling !== undefined
            ? appState.unknown_entity_handling
            : 'sort_normally';

        // Automation long-press action setting
        appState.automation_longpress_action = Settings.option('automation_longpress_action');
        appState.automation_longpress_action = appState.automation_longpress_action !== undefined
            ? appState.automation_longpress_action
            : 'toggle';

        log('Entity handling - unavailable: ' + appState.unavailable_entity_handling +
            ', unknown: ' + appState.unknown_entity_handling);
        log('Automation long-press action: ' + appState.automation_longpress_action);

        // Main menu ordering settings
        appState.main_menu_custom_order_enabled = Settings.option('main_menu_custom_order_enabled') === true;
        appState.main_menu_order = Settings.option('main_menu_order');
        if (!Array.isArray(appState.main_menu_order)) {
            appState.main_menu_order = null;
        }
        log('Main menu custom order enabled: ' + appState.main_menu_custom_order_enabled);

        // Reload stores
        if (appState.pinnedEntityStore) {
            appState.pinnedEntityStore.load();
            log('Pinned entities reloaded: ' + JSON.stringify(appState.pinnedEntityStore.all()));
        }

        if (appState.favoriteEntityStore) {
            appState.favoriteEntityStore.load();
            log('Favorite entities reloaded: ' + JSON.stringify(appState.favoriteEntityStore.all()));
        }

        // Update Voice Pipeline handling
        appState.selected_pipeline = Settings.option('selected_pipeline');

        // Get timeline token
        if (Pebble.getTimelineToken && typeof Pebble.getTimelineToken === 'function') {
            Pebble.getTimelineToken(function(token) {
                log('Timeline token: ' + token);
                appState.timeline_token = token;
                Settings.option("timeline_token", token);
            }, function(error) {
                log('Error getting timeline token: ' + error);
            });
        } else {
            log('Timeline token API unavailable');
        }
    },

    /**
     * Get a specific setting value
     * @param {string} key - Setting key
     * @returns {*} Setting value
     */
    get: function(key) {
        return Settings.option(key);
    },

    /**
     * Set a specific setting value
     * @param {string} key - Setting key
     * @param {*} value - Setting value
     */
    set: function(key, value) {
        Settings.option(key, value);
    },

    /**
     * Initialize the settings config page handler
     * @param {Object} options - Configuration options
     * @param {string} options.configPageUrl - URL of the config page
     * @param {Function} options.onSettingsChanged - Callback when settings change
     */
    initConfigHandler: function(options) {
        var self = this;
        var log = helpers.log_message;

        Settings.config({
            url: options.configPageUrl
        },
        function(e) {
            log('opened configurable');
        },
        function(e) {
            log('closed configurable');
            log('returned_settings: ' + JSON.stringify(e.options));
            Settings.option(e.options);

            if (e.failed) {
                log(e.response);
            }

            // Reload settings
            self.load();

            // Call the callback if provided
            if (options.onSettingsChanged) {
                options.onSettingsChanged();
            }
        });
    }
};

module.exports = SettingsManager;
