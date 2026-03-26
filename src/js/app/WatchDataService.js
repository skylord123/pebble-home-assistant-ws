/**
 * WatchDataService - Syncs watch battery and step data to Home Assistant sensors
 */
var ajax = require('lib/ajax');
var AppState = require('app/AppState');
var helpers = require('app/helpers');
var simply = require('ui/simply');

var WatchDataService = {
    /**
     * Initialize watch data sync
     * Enables the C-side battery/health monitoring and registers the callback
     */
    init: function() {
        var appState = AppState.getInstance();
        var log = helpers.log_message;

        if (!appState.watch_data_sync) {
            log('Watch data sync disabled');
            return;
        }

        // Register callback for when C sends watch data
        if (simply.impl && simply.impl.state) {
            simply.impl.state.watchDataCallback = function(battery, charging, steps) {
                WatchDataService.syncToHA(battery, charging, steps);
            };
        }

        // Enable C-side battery monitoring
        if (simply.impl && simply.impl.watchDataEnable) {
            simply.impl.watchDataEnable(true);
            log('Watch data sync enabled');
        }
    },

    /**
     * Sync watch data to HA via REST API
     */
    syncToHA: function(battery, charging, steps) {
        var appState = AppState.getInstance();
        var log = helpers.log_message;

        if (!appState.ha_url || !appState.ha_password) {
            return;
        }

        var baseUrl = appState.ha_url;
        var headers = {
            'Authorization': 'Bearer ' + appState.ha_password,
            'Content-Type': 'application/json'
        };

        // Sync battery level
        if (battery !== undefined) {
            ajax({
                url: baseUrl + '/api/states/sensor.pebble_battery',
                method: 'POST',
                type: 'json',
                headers: headers,
                data: {
                    state: String(battery),
                    attributes: {
                        unit_of_measurement: '%',
                        device_class: 'battery',
                        friendly_name: 'Pebble Battery',
                        icon: 'mdi:watch'
                    }
                }
            }, function() {
                log('Battery synced: ' + battery + '%');
            }, function(err) {
                log('Battery sync failed: ' + err);
            });
        }

        // Sync charging state
        if (charging !== undefined) {
            ajax({
                url: baseUrl + '/api/states/binary_sensor.pebble_charging',
                method: 'POST',
                type: 'json',
                headers: headers,
                data: {
                    state: charging ? 'on' : 'off',
                    attributes: {
                        device_class: 'battery_charging',
                        friendly_name: 'Pebble Charging',
                        icon: 'mdi:watch'
                    }
                }
            }, function() {
                log('Charging synced');
            }, function(err) {
                log('Charging sync failed: ' + err);
            });
        }

        // Sync step count
        if (steps !== undefined && steps > 0) {
            ajax({
                url: baseUrl + '/api/states/sensor.pebble_steps',
                method: 'POST',
                type: 'json',
                headers: headers,
                data: {
                    state: String(steps),
                    attributes: {
                        unit_of_measurement: 'steps',
                        icon: 'mdi:shoe-print',
                        friendly_name: 'Pebble Steps'
                    }
                }
            }, function() {
                log('Steps synced: ' + steps);
            }, function(err) {
                log('Steps sync failed: ' + err);
            });
        }
    },

    /**
     * Disable watch data sync
     */
    disable: function() {
        if (simply.impl && simply.impl.watchDataEnable) {
            simply.impl.watchDataEnable(false);
        }
        if (simply.impl && simply.impl.state) {
            delete simply.impl.state.watchDataCallback;
        }
    }
};

module.exports = WatchDataService;
