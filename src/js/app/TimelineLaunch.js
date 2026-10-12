/**
 * TimelineLaunch - Routes timeline pin launches to feature handlers.
 *
 * A pin's launchCode is a uint32 whose top byte selects the action type and
 * whose low 24 bits are an action-specific payload. Companion apps must build
 * their launch codes the same way:
 *
 *   launchCode = ((actionType & 0xFF) << 24) | (payload & 0xFFFFFF)
 *
 * New action types just need a constant here and a registerHandler() call in
 * app.js.
 */
var helpers = require('app/helpers');

var TimelineLaunch = {
    // Action types (the top byte of the launch code).
    //
    // These numbers are a cross-repo contract shared with the Android
    // companion (android-pebble-home-assistant, sync/LaunchCodes.kt) and the
    // Home Assistant integration (home-assistant-pebble). They are permanent:
    // never renumber one, never reuse a retired one. A watchapp with no
    // handler for a newer type just logs and leaves the main menu up, which is
    // how old watches survive types added later.

    // Payload is the FNV-1a24 hash of a calendar event, minted by the Android
    // app's own calendar sync and resolved locally by CalendarPage. Reserved
    // forever; it works with no Home Assistant integration installed at all.
    ACTION_CALENDAR_EVENT: 1,

    // Payload is a pin's launchRef, allocated by the Home Assistant
    // integration and never recycled. The watchapp resolves what the pin
    // points at by asking Home Assistant over the websocket
    // (pebble/timeline/resolve_launch), so the destination is not encoded in
    // the launch code and can change after the pin is delivered.
    ACTION_HA_PIN: 2,

    _handlers: {},

    /**
     * Register the handler for an action type.
     * @param {number} actionType - One of the ACTION_* constants
     * @param {Function} handler - Called with (payload, launchCode)
     */
    registerHandler: function(actionType, handler) {
        this._handlers[actionType] = handler;
    },

    /**
     * Build a launch code from an action type and a 24-bit payload
     */
    makeLaunchCode: function(actionType, payload) {
        return (((actionType & 0xFF) << 24) | (payload & 0xFFFFFF)) >>> 0;
    },

    /**
     * Dispatch a timeline launch to the registered handler for its action type.
     * @returns {boolean} true if a handler was found
     */
    handle: function(launchCode) {
        var actionType = (launchCode >>> 24) & 0xFF;
        var payload = launchCode & 0xFFFFFF;
        var handler = this._handlers[actionType];
        if (!handler) {
            helpers.log_message('TimelineLaunch: no handler for action type ' + actionType +
                ' (launch code ' + launchCode + ')');
            return false;
        }
        helpers.log_message('TimelineLaunch: dispatching action type ' + actionType);
        // A launch runs off the main menu the app has already shown. A handler
        // that throws must leave that menu up rather than take the app down,
        // so failures are contained here instead of at every call site.
        try {
            handler(payload, launchCode);
        } catch (e) {
            helpers.log_message('TimelineLaunch: handler for action type ' + actionType +
                ' failed: ' + ((e && e.message) || e));
        }
        return true;
    }
};

module.exports = TimelineLaunch;
