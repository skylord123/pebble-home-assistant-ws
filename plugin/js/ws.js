/**
 * Home Assistant over its WebSocket, for what REST cannot reach: the assist
 * pipelines. A plugin's socket closes when the request that opened it ends and
 * there are no timers, so this connects, sends one command, waits for the
 * answer and closes. If Home Assistant never answers, the phone ends the
 * request after 20 seconds.
 *
 * Like ha.js, nothing here logs the address or the token.
 */
var ha = require('ha');
var PluginError = ha.PluginError;

//! The id of the one command each connection sends
var COMMAND_ID = 1;

function socketUrl(conn) {
    var secure = /^https:/i.test(conn.url);
    return (secure ? 'wss' : 'ws') + conn.url.replace(/^https?/i, '') + '/api/websocket';
}

function commandError(error) {
    var code = error && error.code;
    var message = (error && error.message) || 'Home Assistant could not do that';
    if (code === 'unauthorized') {
        return new PluginError('PERMISSION_DENIED', 'Home Assistant does not let this token\'s user do that');
    }
    if (code === 'invalid_format' || code === 'pipeline-not-found') {
        return new PluginError('INVALID_ARGS', message);
    }
    return new PluginError('UNKNOWN', message);
}

/**
 * Send `command` once logged in and hand every message about it to
 * `onMessage(msg, settle)`, until it calls `settle(value)` or throws. A
 * refused command ends it with an error before `onMessage` sees it.
 * @returns {Promise} whatever was settled with
 */
function run(conn, command, onMessage) {
    if (ha.tokenRefused(conn)) {
        return Promise.reject(new PluginError('AUTH_REQUIRED', ha.REFUSED));
    }
    if (ha.recentlyUnreachable()) {
        return Promise.reject(new PluginError('PLUGIN_UNAVAILABLE', ha.UNREACHABLE));
    }

    return new Promise(function(resolve, reject) {
        var socket;
        var done = false;
        var loggedIn = false;

        function finish(err, value) {
            if (done) { return; }
            done = true;
            try { socket.close(); } catch (e) { /* already closing */ }
            if (err) { reject(err); } else { resolve(value); }
        }

        try {
            socket = new WebSocket(socketUrl(conn));
        } catch (e) {
            reject(new PluginError('PLUGIN_UNAVAILABLE', ha.UNREACHABLE));
            return;
        }

        socket.onmessage = function(event) {
            var msg;
            try {
                msg = JSON.parse(event.data);
            } catch (e) {
                return;
            }

            // auth_required is the first thing sent once the socket is open
            if (msg.type === 'auth_required') {
                socket.send(JSON.stringify({ type: 'auth', access_token: conn.token }));
                return;
            }
            if (msg.type === 'auth_invalid') {
                ha.markRefused(conn);
                finish(new PluginError('AUTH_REQUIRED', ha.REFUSED));
                return;
            }
            if (msg.type === 'auth_ok') {
                loggedIn = true;
                command.id = COMMAND_ID;
                socket.send(JSON.stringify(command));
                return;
            }

            if (msg.id !== COMMAND_ID) { return; }
            if (msg.type === 'result' && !msg.success) {
                finish(commandError(msg.error));
                return;
            }
            try {
                onMessage(msg, function(value) { finish(null, value); });
            } catch (err) {
                finish(err);
            }
        };

        // A failed connection gives no reason, whether the host is down, a
        // proxy refused the upgrade or the phone has not allowed the address.
        // A close always follows.
        socket.onerror = function() {};
        socket.onclose = function() {
            if (!loggedIn) { ha.markUnreachable(); }
            finish(new PluginError('PLUGIN_UNAVAILABLE', loggedIn ?
                'Home Assistant closed the connection' : ha.UNREACHABLE));
        };
    });
}

module.exports = {
    run: run
};
