/**
 * InactivityTimer - Exits the app after a configurable period with no user
 * activity on the watch.
 *
 * The timer runs on the phone side and is re-armed every time the watch
 * reports user input (button clicks, menu navigation, back presses,
 * dictation) via the onUserActivity hook in simply-pebble. Remote entity
 * updates pushed from Home Assistant do not count as activity, so leaving
 * the app open on a changing entity still times out.
 */
var WindowStack = require('ui/windowstack');
var simply = require('ui/simply');
var helpers = require('app/helpers');

var InactivityTimer = {
    _timer: null,
    _timeoutSeconds: 0,

    /**
     * Set the timeout and (re)start the countdown.
     * @param {number} seconds - Timeout in seconds, 0 or less disables it
     */
    configure: function(seconds) {
        var self = this;
        seconds = parseInt(seconds, 10);
        this._timeoutSeconds = seconds > 0 ? seconds : 0;
        helpers.log_message('InactivityTimer: timeout ' +
            (this._timeoutSeconds ? this._timeoutSeconds + 's' : 'disabled'));

        // Register for user-input notifications from the watch
        if (simply.impl) {
            simply.impl.onUserActivity = function() {
                self.reset();
            };
        }

        this.reset();
    },

    /**
     * Restart the countdown from now. Called on every user interaction.
     */
    reset: function() {
        var self = this;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        if (!this._timeoutSeconds) {
            return;
        }
        this._timer = setTimeout(function() {
            self._expire();
        }, this._timeoutSeconds * 1000);
    },

    stop: function() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    },

    _expire: function() {
        this._timer = null;
        helpers.log_message('InactivityTimer: no activity for ' +
            this._timeoutSeconds + 's, exiting app');

        // Hiding the top window without showing another pops the only window
        // the watch keeps on its native stack, which exits the app. If a
        // system window (e.g. dictation) is on top, the watch ignores the
        // hide and the app stays open; dictation counts as activity anyway.
        var top = WindowStack.top();
        if (top && simply.impl && simply.impl.windowHide) {
            simply.impl.windowHide(top._id());
        }
    }
};

module.exports = InactivityTimer;
