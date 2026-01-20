/**
 * CacheManager - Handles startup cache operations for faster app loading
 */
var Settings = require('settings');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');

var CacheManager = {
    /**
     * Save current state to startup cache
     */
    save: function() {
        if (!Constants.startup_cache_enabled) return;

        var appState = AppState.getInstance();
        var log = helpers.log_message;
        var CACHE_KEYS = Constants.CACHE_KEYS;

        try {
            log('Saving startup cache...');

            // Save each piece of data to localStorage
            if (appState.ha_state_cache) {
                localStorage.setItem(CACHE_KEYS.STATES, JSON.stringify(appState.ha_state_cache));
            }
            if (appState.area_registry_cache) {
                localStorage.setItem(CACHE_KEYS.AREAS, JSON.stringify(appState.area_registry_cache));
            }
            if (appState.floor_registry_cache) {
                localStorage.setItem(CACHE_KEYS.FLOORS, JSON.stringify(appState.floor_registry_cache));
            }
            if (appState.device_registry_cache) {
                localStorage.setItem(CACHE_KEYS.DEVICES, JSON.stringify(appState.device_registry_cache));
            }
            if (appState.entity_registry_cache) {
                localStorage.setItem(CACHE_KEYS.ENTITIES, JSON.stringify(appState.entity_registry_cache));
            }
            if (appState.label_registry_cache) {
                localStorage.setItem(CACHE_KEYS.LABELS, JSON.stringify(appState.label_registry_cache));
            }
            if (appState.ha_pipelines) {
                localStorage.setItem(CACHE_KEYS.PIPELINES, JSON.stringify({
                    pipelines: appState.ha_pipelines,
                    preferred_pipeline: appState.preferred_pipeline
                }));
            }

            // Save timestamp
            localStorage.setItem(CACHE_KEYS.TIMESTAMP, Date.now().toString());

            log('Startup cache saved successfully');
        } catch (e) {
            log('Error saving startup cache: ' + e);
        }
    },

    /**
     * Load state from startup cache
     * @returns {boolean} True if cache was loaded successfully
     */
    load: function() {
        if (!Constants.startup_cache_enabled) return false;

        var appState = AppState.getInstance();
        var log = helpers.log_message;
        var CACHE_KEYS = Constants.CACHE_KEYS;

        try {
            log('Loading startup cache...');

            // Check if we have a timestamp (indicates cache exists)
            var timestamp = localStorage.getItem(CACHE_KEYS.TIMESTAMP);
            if (!timestamp) {
                log('No startup cache found');
                return false;
            }

            // Load each piece of data
            var statesStr = localStorage.getItem(CACHE_KEYS.STATES);
            var areasStr = localStorage.getItem(CACHE_KEYS.AREAS);
            var floorsStr = localStorage.getItem(CACHE_KEYS.FLOORS);
            var devicesStr = localStorage.getItem(CACHE_KEYS.DEVICES);
            var entitiesStr = localStorage.getItem(CACHE_KEYS.ENTITIES);
            var labelsStr = localStorage.getItem(CACHE_KEYS.LABELS);
            var pipelinesStr = localStorage.getItem(CACHE_KEYS.PIPELINES);

            // Parse and assign cached data
            if (statesStr) {
                appState.ha_state_cache = JSON.parse(statesStr);
                var new_state_map = {};
                for (var i = 0; i < appState.ha_state_cache.length; i++) {
                    var entity = appState.ha_state_cache[i];
                    new_state_map[entity.entity_id] = entity;
                }
                appState.ha_state_dict = new_state_map;
                appState.ha_state_cache_updated = new Date();

                // Update favorite entity friendly names from cached state data
                if (appState.favoriteEntityStore) {
                    appState.favoriteEntityStore.updateFriendlyNames(appState.ha_state_dict);
                }
            }

            if (areasStr) {
                appState.area_registry_cache = JSON.parse(areasStr);
            }

            if (floorsStr) {
                appState.floor_registry_cache = JSON.parse(floorsStr);
            }

            if (devicesStr) {
                appState.device_registry_cache = JSON.parse(devicesStr);
            }

            if (entitiesStr) {
                appState.entity_registry_cache = JSON.parse(entitiesStr);
            }

            if (labelsStr) {
                appState.label_registry_cache = JSON.parse(labelsStr);
            }

            if (pipelinesStr) {
                var pipelineData = JSON.parse(pipelinesStr);
                appState.ha_pipelines = pipelineData.pipelines;
                appState.preferred_pipeline = pipelineData.preferred_pipeline;

                // Restore pipeline settings
                if (appState.ha_pipelines && appState.ha_pipelines.length > 0) {
                    var pipelineOptions = appState.ha_pipelines.map(function(p) {
                        return {
                            id: p.id,
                            name: p.name,
                            preferred: p.id === appState.preferred_pipeline
                        };
                    });
                    Settings.option('available_pipelines', pipelineOptions);

                    if (!appState.selected_pipeline && appState.preferred_pipeline) {
                        appState.selected_pipeline = appState.preferred_pipeline;
                    }
                }
            }

            var cacheAge = Date.now() - parseInt(timestamp);
            log('Startup cache loaded successfully (age: ' + (cacheAge / 1000).toFixed(1) + 's)');
            return true;
        } catch (e) {
            log('Error loading startup cache: ' + e);
            return false;
        }
    },

    /**
     * Clear the startup cache
     */
    clear: function() {
        if (!Constants.startup_cache_enabled) return;

        var log = helpers.log_message;
        var CACHE_KEYS = Constants.CACHE_KEYS;

        try {
            log('Clearing startup cache...');
            localStorage.removeItem(CACHE_KEYS.STATES);
            localStorage.removeItem(CACHE_KEYS.AREAS);
            localStorage.removeItem(CACHE_KEYS.FLOORS);
            localStorage.removeItem(CACHE_KEYS.DEVICES);
            localStorage.removeItem(CACHE_KEYS.ENTITIES);
            localStorage.removeItem(CACHE_KEYS.LABELS);
            localStorage.removeItem(CACHE_KEYS.PIPELINES);
            localStorage.removeItem(CACHE_KEYS.TIMESTAMP);
            log('Startup cache cleared');
        } catch (e) {
            log('Error clearing startup cache: ' + e);
        }
    }
};

module.exports = CacheManager;
