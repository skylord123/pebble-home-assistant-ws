/**
 * MenuTheme - resolves menu colors based on settings and sun position.
 */

var AppState = require('app/AppState');
var Constants = require('app/Constants');
var SunCalc = require('app/suncalc');

var MenuTheme = {
    getMode: function() {
        var appState = AppState.getInstance();
        var mode = appState.menu_background_mode;

        if (mode === Constants.menuBackgroundModes.BLACK ||
            mode === Constants.menuBackgroundModes.WHITE ||
            mode === Constants.menuBackgroundModes.SUN) {
            return mode;
        }

        return Constants.menuBackgroundModes.SUN;
    },

    getMenuColors: function() {
        var backgroundColor = this._resolveBackgroundColor();
        var isBlack = backgroundColor === 'black';

        return {
            backgroundColor: backgroundColor,
            textColor: isBlack ? 'white' : 'black',
            highlightBackgroundColor: isBlack ? 'white' : 'black',
            highlightTextColor: isBlack ? 'black' : 'white'
        };
    },

    applyToMenu: function(menu) {
        if (!menu || !menu.state) {
            return;
        }

        var colors = this.getMenuColors();
        menu.state.backgroundColor = colors.backgroundColor;
        menu.state.textColor = colors.textColor;
        menu.state.highlightBackgroundColor = colors.highlightBackgroundColor;
        menu.state.highlightTextColor = colors.highlightTextColor;

        if (typeof menu._prop === 'function') {
            menu._prop(menu.state);
        }
    },

    _resolveBackgroundColor: function() {
        var mode = this.getMode();

        if (mode === Constants.menuBackgroundModes.BLACK) {
            return 'black';
        }

        if (mode === Constants.menuBackgroundModes.WHITE) {
            return 'white';
        }

        return this._resolveSunBasedBackground();
    },

    _resolveSunBasedBackground: function() {
        var appState = AppState.getInstance();

        if (appState.latitude === null || appState.latitude === undefined ||
            appState.longitude === null || appState.longitude === undefined) {
            return 'black';
        }

        var now = new Date();
        var times = SunCalc.getTimes(now, appState.latitude, appState.longitude);
        if (!times || !times.sunrise || !times.sunset) {
            return 'black';
        }

        if (isNaN(times.sunrise.getTime()) || isNaN(times.sunset.getTime())) {
            return 'black';
        }

        var isDay = now >= times.sunrise && now < times.sunset;
        return isDay ? 'white' : 'black';
    }
};

module.exports = MenuTheme;
