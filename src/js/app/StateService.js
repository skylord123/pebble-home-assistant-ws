/**
 * StateService - Handles fetching and caching entity states from Home Assistant
 */
var Settings = require('settings');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

/**
 * Publish the available calendars to settings so the config page can offer
 * per-calendar visibility and ordering. The array order matches Home
 * Assistant's state order, which is the default calendar order.
 */
function publishAvailableCalendars(appState) {
    var calendars = [];
    for (var i = 0; i < appState.ha_state_cache.length; i++) {
        var entity = appState.ha_state_cache[i];
        if (entity.entity_id.indexOf('calendar.') === 0) {
            calendars.push({
                entity_id: entity.entity_id,
                name: entity.attributes && entity.attributes.friendly_name
                    ? entity.attributes.friendly_name
                    : entity.entity_id.substring(9)
            });
        }
    }

    var previous = Settings.option('available_calendars');
    if (JSON.stringify(calendars) !== JSON.stringify(previous || [])) {
        Settings.option('available_calendars', calendars);
        helpers.log_message('Published ' + calendars.length + ' calendars for config page');
    }
}

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

                publishAvailableCalendars(appState);

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
