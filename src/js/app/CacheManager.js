/**
 * CacheManager - Handles startup cache operations for faster app loading
 */
var Settings = require('settings');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');

// Caches older than this are ignored at startup rather than shown as-is
var MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

var CacheManager = {
    /**
     * Save current state to startup cache
     */
    save: function() {
        if (!Constants.startup_cache_enabled) return;

        var appState = AppState.getInstance();
        var log = helpers.log_message;
        var CACHE_KEYS = Constants.CACHE_KEYS;

        // Entity states are deliberately not cached. On a large instance the
        // states blob is megabytes, which is past the localStorage quota, so
        // the write always threw. Because it was the first write in this
        // function, that exception skipped every other key including the
        // timestamp the loader gates on, and the whole cache silently never
        // existed. States come from a subscription for whatever is on screen
        // instead, which is both smaller and always current.
        //
        // Each key is written on its own so that one oversized value can never
        // take the rest of the cache down with it again.
        var wrote = 0;
        function put(key, value) {
            if (value === null || value === undefined) { return; }
            try {
                var payload = JSON.stringify(value);
                localStorage.setItem(key, payload);
                log('Startup cache: ' + key + ' ' + payload.length + 'B');
                wrote++;
            } catch (e) {
                log('Startup cache: could not save ' + key + ': ' + e);
                try { localStorage.removeItem(key); } catch (ignored) {}
            }
        }

        log('Saving startup cache...');
        put(CACHE_KEYS.AREAS, appState.area_registry_cache);
        put(CACHE_KEYS.FLOORS, appState.floor_registry_cache);
        put(CACHE_KEYS.DEVICES, appState.device_registry_cache);
        put(CACHE_KEYS.ENTITIES, appState.entity_registry_cache);
        put(CACHE_KEYS.LABELS, appState.label_registry_cache);
        if (appState.ha_pipelines) {
            put(CACHE_KEYS.PIPELINES, {
                pipelines: appState.ha_pipelines,
                preferred_pipeline: appState.preferred_pipeline
            });
        }

        // Last, and only if something above survived: the loader treats this
        // as "a cache exists", so it must never outlive the data it stamps
        if (wrote > 0) {
            try {
                localStorage.setItem(CACHE_KEYS.TIMESTAMP, Date.now().toString());
                log('Startup cache saved (' + wrote + ' items)');
            } catch (e) {
                log('Error stamping startup cache: ' + e);
            }
        } else {
            log('Startup cache: nothing saved');
            try { localStorage.removeItem(CACHE_KEYS.TIMESTAMP); } catch (ignored) {}
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

            // A build before this one may have left a multi megabyte states
            // blob behind. It is never read now, so drop it and give the quota
            // back to the things that do get cached.
            if (localStorage.getItem(CACHE_KEYS.STATES) !== null) {
                try {
                    localStorage.removeItem(CACHE_KEYS.STATES);
                    log('Startup cache: dropped the legacy states blob');
                } catch (e) {
                    log('Startup cache: could not drop legacy states: ' + e);
                }
            }

            // Check if we have a timestamp (indicates cache exists)
            var timestamp = localStorage.getItem(CACHE_KEYS.TIMESTAMP);
            if (!timestamp) {
                log('No startup cache found');
                return false;
            }

            // Ignore caches that are too old to be trusted for instant UI:
            // the menu renders from this data, and if saving has been failing
            // (e.g. quota exceeded) the cache can lag reality by weeks
            var cacheAgeMs = Date.now() - parseInt(timestamp);
            if (cacheAgeMs > MAX_CACHE_AGE_MS) {
                log('Startup cache too old (' + (cacheAgeMs / 1000).toFixed(0) + 's), ignoring');
                return false;
            }

            // Load each piece of data. States are not cached; see save().
            var areasStr = localStorage.getItem(CACHE_KEYS.AREAS);
            var floorsStr = localStorage.getItem(CACHE_KEYS.FLOORS);
            var devicesStr = localStorage.getItem(CACHE_KEYS.DEVICES);
            var entitiesStr = localStorage.getItem(CACHE_KEYS.ENTITIES);
            var labelsStr = localStorage.getItem(CACHE_KEYS.LABELS);
            var pipelinesStr = localStorage.getItem(CACHE_KEYS.PIPELINES);

            var parseStart = Date.now();
            var bytes = 0;
            [areasStr, floorsStr, devicesStr, entitiesStr, labelsStr, pipelinesStr]
                .forEach(function(str) { if (str) { bytes += str.length; } });

            // Parse and assign cached data
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
            log('Startup cache loaded successfully (age: ' + (cacheAge / 1000).toFixed(1) + 's, ' +
                bytes + 'B, parsed in ' + (Date.now() - parseStart) + 'ms)');
            log('Startup cache breakdown: areas ' + (areasStr ? areasStr.length : 0) +
                'B, floors ' + (floorsStr ? floorsStr.length : 0) +
                'B, devices ' + (devicesStr ? devicesStr.length : 0) +
                'B, entities ' + (entitiesStr ? entitiesStr.length : 0) +
                'B, labels ' + (labelsStr ? labelsStr.length : 0) +
                'B, pipelines ' + (pipelinesStr ? pipelinesStr.length : 0) + 'B');
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
            localStorage.removeItem(CACHE_KEYS.STATES);   // legacy, no longer written
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
