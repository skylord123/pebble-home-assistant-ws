/**
 * TimelineLaunch - Routes timeline pin launches to feature handlers.
 *
 * A pin's launchCode is a uint32 whose top byte selects the action type and
 * whose low 24 bits are an action-specific payload. Companion apps must build
 * their launch codes the same way:
 *
 *   launchCode = ((actionType & 0xFF) << 24) | (payload & 0xFFFFFF)
 *
 * Only calendar events are supported today, but new action types just need a
 * constant here and a registerHandler() call in app.js.
 */
var helpers = require('app/helpers');

var TimelineLaunch = {
    // Action types (the top byte of the launch code)
    ACTION_CALENDAR_EVENT: 1,

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
        handler(payload, launchCode);
        return true;
    }
};

module.exports = TimelineLaunch;
