/**
 * HistoryService - Fetches entity history from Home Assistant
 *
 * Numeric history uses history/history_during_period with the compressed
 * minimal response ({s: state, lu: last_updated epoch seconds} rows).
 * State-change logs use logbook/get_events, whose rows include
 * context_user_id so changes can be attributed to a person.
 */
var AppState = require('app/AppState');
var helpers = require('app/helpers');

var HistoryService = {
    /**
     * Fetch raw state history rows for one entity between two Dates.
     * Calls back with an array of {s, lu} rows in chronological order.
     */
    fetchHistory: function(entity_id, startDate, endDate, successCallback, errorCallback) {
        var appState = AppState.getInstance();
        appState.haws.send({
            type: 'history/history_during_period',
            start_time: startDate.toISOString(),
            end_time: endDate.toISOString(),
            entity_ids: [entity_id],
            minimal_response: true,
            no_attributes: true
        }, function(data) {
            var rows = (data.result && data.result[entity_id]) || [];
            successCallback(rows);
        }, function(error) {
            helpers.log_message('fetchHistory error: ' + JSON.stringify(error));
            if (errorCallback) { errorCallback(error); }
        });
    },

    /**
     * Fetch logbook entries for one entity between two Dates.
     * Calls back with an array of {when, state, context_user_id, ...} rows
     * in chronological order.
     */
    fetchLogbook: function(entity_id, startDate, endDate, successCallback, errorCallback) {
        var appState = AppState.getInstance();
        appState.haws.send({
            type: 'logbook/get_events',
            start_time: startDate.toISOString(),
            end_time: endDate.toISOString(),
            entity_ids: [entity_id]
        }, function(data) {
            successCallback(data.result || []);
        }, function(error) {
            helpers.log_message('fetchLogbook error: ' + JSON.stringify(error));
            if (errorCallback) { errorCallback(error); }
        });
    },

    /**
     * Map Home Assistant user ids to display names using the person entities
     * already present in the state dict (person entities carry the user_id
     * they are linked to), so no admin-only API is needed.
     */
    getUserNames: function() {
        var appState = AppState.getInstance();
        var names = {};
        for (var entity_id in appState.ha_state_dict) {
            if (entity_id.indexOf('person.') !== 0) { continue; }
            var entity = appState.ha_state_dict[entity_id];
            var userId = entity.attributes && entity.attributes.user_id;
            if (userId) {
                names[userId] = (entity.attributes.friendly_name || entity_id.substring(7));
            }
        }
        return names;
    }
};

module.exports = HistoryService;
