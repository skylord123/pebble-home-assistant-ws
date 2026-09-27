/**
 * ConfigBridge - Live messaging with a settings page bundled in the pbw
 *
 * Newer Pebble phone apps can open a settings page shipped inside the pbw
 * (appinfo.json `configPage`) and let it talk to this JS while it is open:
 * the page calls `Pebble.sendMessage('pkjs', {...})`, which lands here as a
 * `configmessage` event, and this side can push at the page at any time with
 * `Pebble.sendConfigMessage({...})`.
 *
 * Older phone apps have neither, so nothing here registers unless the runtime
 * offers `Pebble.sendConfigMessage`. Those apps keep the classic flow: the
 * page is opened from the URL in Constants.configPageUrl, gets the settings in
 * its hash and hands them back through `pebblejs://close#`.
 *
 * Every request is `{ type: '...' }` plus its fields, and every reply is
 * `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`. Pushes
 * from this side are `{ type: 'status', status, settings }`. See
 * config/README.md for the whole protocol.
 */
var Settings = require('settings');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');
var LogBuffer = require('app/LogBuffer');

// Settings the page cannot edit, only read, that change while it is open. A
// status push carries them so the page can fill its pipeline dropdown and
// calendar list as soon as a fresh connection has fetched them.
var LIVE_SETTINGS = ['ha_connected', 'available_pipelines', 'available_calendars', 'selected_pipeline'];

var SEARCH_LIMIT_DEFAULT = 30;
var SEARCH_LIMIT_MAX = 100;

var ConfigBridge = {
    // Set by init(): runs after a save so the app applies the new settings
    onSettingsChanged: null,
    // Whether this runtime can talk to a bundled page at all
    available: false,
    statusTimer: null,

    /**
     * Register the configmessage handler if this phone app supports it
     * @param {Object} options
     * @param {Function} options.onSettingsChanged - Called after settings are saved
     */
    init: function(options) {
        var log = helpers.log_message;
        this.onSettingsChanged = options && options.onSettingsChanged;
        this.available = typeof Pebble.sendConfigMessage === 'function';

        if (!this.available) {
            log('Config bridge: not supported by this phone app, using the hosted config page');
            return;
        }

        var self = this;
        try {
            Pebble.addEventListener('configmessage', function(e) {
                self.handleMessage(e);
            });
            log('Config bridge: ready for a bundled config page');
        } catch (err) {
            this.available = false;
            log('Config bridge: could not register: ' + ((err && err.message) || err));
        }
    },

    /**
     * Dispatch one request from the page. Every path answers exactly once:
     * a request left unanswered makes the page wait on the host's timeout.
     */
    handleMessage: function(e) {
        var log = helpers.log_message;
        var message = (e && e.data && typeof e.data === 'object') ? e.data : {};
        var answered = false;

        function respond(reply) {
            if (answered) { return; }
            answered = true;
            try {
                e.respond(reply);
            } catch (err) {
                log('Config bridge: respond failed: ' + ((err && err.message) || err));
            }
        }

        function fail(code, text) {
            respond({ ok: false, error: { code: code, message: text } });
        }

        // Own keys only: a type like "constructor" must not find Object's
        var handler = Object.prototype.hasOwnProperty.call(ConfigBridge.handlers, message.type)
            ? ConfigBridge.handlers[message.type]
            : null;
        if (!handler) {
            fail('unknown_type', 'Unknown request type: ' + message.type);
            return;
        }

        log('Config bridge: ' + message.type);
        try {
            handler.call(this, message, respond, fail);
        } catch (err) {
            log('Config bridge: ' + message.type + ' threw: ' + ((err && err.stack) || err));
            fail('internal', 'The watch app hit an error: ' + ((err && err.message) || err));
        }
    },

    handlers: {
        /**
         * Everything the page needs to draw itself: the whole options object
         * (the same shape the hosted page reads from its hash) plus the
         * connection status.
         */
        get_settings: function(message, respond) {
            respond({
                ok: true,
                app_version: Constants.appVersion,
                conf_version: Constants.confVersion,
                settings: Settings.option(),
                status: ConfigBridge.status()
            });
        },

        get_status: function(message, respond) {
            respond({ ok: true, status: ConfigBridge.status() });
        },

        /**
         * Persist a set of options and apply them, exactly as closing the
         * hosted page does. The page stays open, so this can happen more than
         * once a visit.
         */
        save_settings: function(message, respond, fail) {
            var settings = message.settings;
            if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
                fail('bad_request', 'save_settings needs a settings object');
                return;
            }
            if (!settings.ha_url || !settings.token) {
                fail('bad_request', 'A Home Assistant URL and access token are required');
                return;
            }

            ConfigBridge.applySettings(settings);
            respond({ ok: true });
        },

        /**
         * Try the given URL and token on a throwaway connection. Only when
         * Home Assistant accepts them are they saved and the app reconnected,
         * so a typo never replaces working credentials.
         */
        connect: function(message, respond, fail) {
            var url = ConfigBridge.normalizeUrl(message.ha_url);
            var token = typeof message.token === 'string' ? message.token.trim() : '';
            // Kept out of the log from here on, whether or not they work
            LogBuffer.addSecret(url);
            LogBuffer.addSecret(token);

            if (!url) {
                fail('bad_url', 'The URL must begin with http:// or https://');
                return;
            }
            if (!token) {
                fail('missing_token', 'An access token is required');
                return;
            }

            var ConnectionService = require('app/ConnectionService');
            ConnectionService.test(url, token, function(result) {
                if (!result.ok) {
                    respond(result);
                    return;
                }

                // This runs from the test connection's events, outside the
                // try/catch around the handler, so it needs its own
                try {
                    ConfigBridge.applySettings({ ha_url: url, token: token });
                } catch (err) {
                    helpers.log_message('Config bridge: applying the connection failed: ' +
                        ((err && err.stack) || err));
                    fail('internal', 'Connected, but the watch app failed to apply the settings: ' +
                        ((err && err.message) || err));
                    return;
                }
                respond({ ok: true, ha_version: result.ha_version || null });
            });
        },

        /**
         * Entities matching a query, with their current state, for the page
         * to offer as favourites or pins. Needs the states from a live
         * connection; before they arrive the page is told to wait.
         */
        search_entities: function(message, respond, fail) {
            var appState = AppState.getInstance();
            if (!appState.ha_state_dict) {
                fail('not_loaded', 'Entities have not been loaded from Home Assistant yet');
                return;
            }

            var query = typeof message.query === 'string' ? message.query : '';
            var limit = parseInt(message.limit, 10);
            if (!(limit > 0)) { limit = SEARCH_LIMIT_DEFAULT; }
            if (limit > SEARCH_LIMIT_MAX) { limit = SEARCH_LIMIT_MAX; }

            var EntityService = require('app/EntityService');
            var found = EntityService.search(query, limit);
            respond({ ok: true, results: found.results, total: found.total });
        },

        /**
         * The app's log, for reading on the page or attaching to a bug
         * report. Already redacted line by line; the header is too.
         */
        get_logs: function(message, respond) {
            var text = LogBuffer.text(ConfigBridge.logHeader());
            respond({
                ok: true,
                text: text,
                lines: LogBuffer.lines().length,
                previous_lines: LogBuffer.previousLines().length
            });
        },

        clear_logs: function(message, respond) {
            LogBuffer.clear();
            respond({ ok: true });
        }
    },

    /**
     * What a bug report needs alongside the lines: versions and platforms
     */
    logHeader: function() {
        var appState = AppState.getInstance();
        var watch = null;
        try {
            watch = Pebble.getActiveWatchInfo ? Pebble.getActiveWatchInfo() : null;
        } catch (e) { /* not every runtime answers */ }
        var firmware = watch && watch.firmware
            ? [watch.firmware.major, watch.firmware.minor, watch.firmware.patch].join('.') +
                (watch.firmware.suffix ? '-' + watch.firmware.suffix : '')
            : 'unknown';
        var status = this.status();
        return [
            'Home Assistant WS log',
            'Generated: ' + new Date().toString(),
            'App version: ' + Constants.appVersion + ' (config page ' + Constants.confVersion + ')',
            'Debug mode: ' + (Constants.debugMode ? 'on' : 'off'),
            'Watch: ' + (watch ? (watch.platform || '?') + ' / ' + (watch.model || '?') : 'unknown') +
                ', firmware ' + firmware,
            'Phone: ' + (typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : 'unknown'),
            'Home Assistant: ' + (appState.ha_version || 'unknown') + ', connection ' + status.phase +
                (status.error ? ' (' + status.error.message + ')' : ''),
            'Entities loaded: ' + status.entity_count
        ];
    },

    /**
     * Merge options into the store and apply them
     */
    applySettings: function(settings) {
        var SettingsManager = require('app/SettingsManager');
        Settings.option(settings);
        SettingsManager.load();
        if (typeof this.onSettingsChanged === 'function') {
            this.onSettingsChanged();
        }
    },

    /**
     * A Home Assistant base URL with the scheme checked and any trailing
     * slashes dropped, or null when it is not usable
     */
    normalizeUrl: function(url) {
        if (typeof url !== 'string') { return null; }
        url = url.trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^\/\s]+/i.test(url)) { return null; }
        return url;
    },

    /**
     * Where the connection stands right now, for the page's status line
     */
    status: function() {
        var appState = AppState.getInstance();
        var ConnectionService = require('app/ConnectionService');
        var haws = appState.haws;
        var configured = !!(appState.ha_url && appState.ha_password);
        var connected = !!(haws && haws.isConnected());
        var entityCount = appState.ha_state_dict ? Object.keys(appState.ha_state_dict).length : 0;

        var phase;
        if (!configured) {
            phase = 'unconfigured';
        } else if (ConnectionService.authFailed) {
            phase = 'auth_failed';
        } else if (connected) {
            phase = 'connected';
        } else {
            phase = 'connecting';
        }

        return {
            phase: phase,
            connected: connected,
            ha_url: appState.ha_url || null,
            ha_version: appState.ha_version || null,
            states_loaded: entityCount > 0,
            entity_count: entityCount,
            error: ConnectionService.lastError || null
        };
    },

    /**
     * Push the current status at the page, if one is open. Calls close
     * together are folded into one push; a push with no page open is dropped
     * by the phone, so this is safe to call from anywhere.
     */
    notifyStatus: function() {
        if (!this.available) { return; }
        var self = this;
        if (this.statusTimer) { clearTimeout(this.statusTimer); }
        this.statusTimer = setTimeout(function() {
            self.statusTimer = null;
            var settings = {};
            var options = Settings.option() || {};
            for (var i = 0; i < LIVE_SETTINGS.length; i++) {
                settings[LIVE_SETTINGS[i]] = options[LIVE_SETTINGS[i]];
            }
            try {
                Pebble.sendConfigMessage({
                    type: 'status',
                    status: self.status(),
                    settings: settings
                });
            } catch (err) {
                helpers.log_message('Config bridge: push failed: ' + ((err && err.message) || err));
            }
        }, 150);
    }
};

module.exports = ConfigBridge;
