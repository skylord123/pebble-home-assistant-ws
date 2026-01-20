/**
 * StateService - Handles fetching and caching entity states from Home Assistant
 */
var AppState = require('app/AppState');
var helpers = require('app/helpers');

var StateService = {
    /**
     * Get all entity states from Home Assistant
     * Uses caching based on refresh interval
     * @param {Function} successCallback - Called with state data on success
     * @param {Function} errorCallback - Called on error
     * @param {boolean} ignoreCache - If true, bypass cache and fetch fresh data
     */
    getStates: function(successCallback, errorCallback, ignoreCache) {
        var appState = AppState.getInstance();
        var log = helpers.log_message;

        ignoreCache = ignoreCache || false;

        if (!ignoreCache) {
            // Check if last fetch is recent enough to use cache
            if (appState.ha_state_cache && appState.ha_state_cache_updated) {
                var secondsAgo = ((new Date()).getTime() - appState.ha_state_cache_updated.getTime()) / 1000;
                if (secondsAgo <= appState.ha_refresh_interval) {
                    log('HA states loaded from cache (age ' + secondsAgo + ' <= interval ' + appState.ha_refresh_interval + ')');
                    if (typeof successCallback === 'function') {
                        successCallback(appState.ha_state_cache);
                    }
                    return;
                }
            }
        }

        appState.haws.getStates(
            function(data) {
                appState.ha_state_cache = data.result;
                var new_state_map = {};
                for (var i = 0; i < appState.ha_state_cache.length; i++) {
                    var entity = appState.ha_state_cache[i];
                    new_state_map[entity.entity_id] = entity;
                }
                appState.ha_state_dict = new_state_map;
                appState.ha_state_cache_updated = new Date();

                // Update favorite entity friendly names from current state data
                if (appState.favoriteEntityStore) {
                    appState.favoriteEntityStore.updateFriendlyNames(appState.ha_state_dict);
                }

                if (typeof successCallback === 'function') {
                    successCallback(data.result);
                }
            },
            function(error, status, request) {
                log('HA States failed: ' + error + ' status: ' + status);
                if (typeof errorCallback === 'function') {
                    errorCallback(error, status, request);
                }
            }
        );
    },

    /**
     * Refresh states from Home Assistant (ignores cache)
     * @param {Function} callback - Called when complete
     */
    refresh: function(callback) {
        this.getStates(callback, null, true);
    }
};

module.exports = StateService;
