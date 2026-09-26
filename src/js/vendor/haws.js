/**
 * Home Assistant Web Sockets
 * @author https://github.com/skylord123
 * @description Simple library to use the Home Assistant's WebSocket API
 */
class HAWS {
    constructor(ha_url, token, debug, coalesce_messages) {
        this.events = new EventTarget();
        this.connected = false;
        // Open sockets report `connected` only once onopen lands; without a
        // separate flag a reconnect attempt can start a second socket while
        // the first is still negotiating
        this.connecting = false;
        // Set on auth_ok. Home Assistant answers anything other than the auth
        // message itself with auth_invalid, so commands wait for this, not
        // for the socket to open.
        this.authenticated = false;
        this.reconnectTimeout = null;
        this.selfDisconnect = false;
        this.ha_url = ha_url;
        this.token = token;
        this.ws = null;
        this._last_cmd_id = 0;
        this._featuresId = null;
        this._commands = new Map();
        this._subscriptions = [];
        // Retries back off from the first delay to the cap, and start over
        // once a connection authenticates
        this.reconnectInterval = 1000;
        this.maxReconnectInterval = 15000;
        this._reconnectAttempts = 0;
        this.debug = debug || false;
        this.coalesce_messages = coalesce_messages || false;

        // A phone can lose its network without the socket ever closing: the
        // TCP connection goes half-open and this side sits there believing it
        // is still connected while no events arrive. Nothing recovers from
        // that on its own, so the connection is probed on an interval and
        // treated as dead when a reply does not come back.
        this.heartbeatInterval = 30000;
        this.heartbeatTimeout = 15000;
        this._heartbeatTimer = null;
        this._pongTimer = null;
        this._pendingPingId = null;
    }

    startHeartbeat() {
        let that = this;
        this.stopHeartbeat();
        this._heartbeatTimer = setInterval(function() {
            that._sendPing();
        }, this.heartbeatInterval);
    }

    stopHeartbeat() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
        if (this._pongTimer) {
            clearTimeout(this._pongTimer);
            this._pongTimer = null;
        }
        this._pendingPingId = null;
    }

    _sendPing() {
        let that = this;
        if (!this.connected) { return; }

        // Still waiting on the previous one: the link is already unhealthy, so
        // let its timeout make the call rather than queueing another
        if (this._pendingPingId !== null) { return; }

        let id = this.send({ type: 'ping' });
        if (id === false) { return; }
        this._pendingPingId = id;

        this._pongTimer = setTimeout(function() {
            that._pongTimer = null;
            that._pendingPingId = null;
            that._handleConnectionLost('no pong within ' + (that.heartbeatTimeout / 1000) + 's');
        }, this.heartbeatTimeout);
    }

    /**
     * Tear down a connection that is gone but has not told us so.
     *
     * The socket is detached before anything else, because a half-open one may
     * fire its own onclose much later (or never) and must not run this twice.
     */
    _handleConnectionLost(reason) {
        if (!this.connected && !this.connecting) { return; }

        console.log(`[HAWS] ${reason}; treating the connection as lost`);

        let dead = this.ws;
        this.ws = null;
        this.connected = false;
        this.authenticated = false;
        this.connecting = false;
        this.stopHeartbeat();
        this._resetConnectionState();

        if (dead) {
            try {
                dead.close();
            } catch (e) {
                // already unusable, nothing to do
            }
        }

        this.events.dispatchEvent(new CustomEvent("close", {
            detail: { code: 4000, reason: reason, wasClean: false }
        }));

        if (!this.selfDisconnect) {
            this.startAttemptingToEstablishConnection();
        }
    }

    // Usable for commands, which is later than the socket being open
    isConnected() {
        return this.authenticated;
    }

    /**
     * Build a human-readable description of a WebSocket CloseEvent.
     * The native onclose event is a CloseEvent (code/reason/wasClean),
     * NOT a CustomEvent, so evt.detail is always undefined.
     */
    static _describeCloseEvent(evt) {
        if (!evt || typeof evt.code === 'undefined') {
            // Not a standard CloseEvent - dump whatever we got so it isn't just "undefined"
            return JSON.stringify(evt, null, 4);
        }

        let meaning = HAWS.CLOSE_CODES[evt.code] || 'Unknown close code';
        let reason = evt.reason ? ` reason="${evt.reason}"` : '';
        return `code=${evt.code} (${meaning})${reason} wasClean=${!!evt.wasClean}`;
    }

    /**
     * Drop everything that only made sense on the socket that just died.
     *
     * Pending callbacks and subscription ids are scoped to a single
     * connection: Home Assistant forgets every subscription when the socket
     * drops. The id counter is not reset. Pages keep their subscription ids
     * across a reconnect and unsubscribe them later, and an id reused on the
     * new socket would cancel whatever now holds it.
     *
     * Commands still waiting on an answer are failed rather than forgotten,
     * so their callers can stop waiting. Subscriptions are left alone: pages
     * take new ones when the reconnect splash comes down.
     */
    _resetConnectionState() {
        let pending = [];
        this._commands.forEach((callback, id) => {
            if (callback[2] || this._subscriptions.indexOf(id) === -1) {
                pending.push([id, callback[1]]);
            }
        });

        this._commands = new Map();
        this._subscriptions = [];

        pending.forEach(function(entry) {
            if (typeof entry[1] !== 'function') { return; }
            try {
                entry[1](HAWS._failure(entry[0], 'connection_lost', 'Lost the connection to Home Assistant'));
            } catch (e) {
                console.log(`[HAWS] error callback for ${entry[0]} threw: ${e}`);
            }
        });
    }

    connect() {
        // A socket that is open, or one still negotiating, must not be
        // replaced. Orphaning it leaves its handlers firing against this same
        // object, which produces duplicate closes and a reconnect storm.
        if(this.connected || this.connecting) {
            return false;
        }

        let that = this,
            ws_url = this.ha_url.replace('http','ws').replace(/\/+$/, '') + '/api/websocket';

        this.connecting = true;
        let socket = new WebSocket(ws_url);
        this.ws = socket;

        // Anything arriving from a socket we have already replaced is ignored
        function isCurrent() {
            return that.ws === socket;
        }

        socket.onclose = function(evt) {
            if (!isCurrent()) { return; }
            that.connecting = false;

            // Order matters. Listeners respond to this event by unsubscribing,
            // and send() only writes when `connected` is true. Clearing the
            // flag after the dispatch meant those unsubscribes tried to write
            // to a socket that had already closed, which throws and aborts the
            // rest of the listener before it could release its timers.
            that.connected = false;
            that.authenticated = false;
            that.stopHeartbeat();
            that._resetConnectionState();

            that.events.dispatchEvent(new CustomEvent("close", {detail: evt}));

            if (!that.selfDisconnect) {
                console.log(`[HAWS] WebSocket closed: ${HAWS._describeCloseEvent(evt)}`);
                that.startAttemptingToEstablishConnection();
            }
        };

        socket.onopen = function(evt){
            if (!isCurrent()) { return; }
            that.connecting = false;
            that.connected = true;
            that.events.dispatchEvent(new CustomEvent("open", {detail: evt.detail}));
            if(that.debug) {
                console.log(`[HAWS] WebSocket connected: ${JSON.stringify(evt.detail, null, 4)}`);
            }
        };

        socket.onmessage = function(evt) {
            if (!isCurrent()) { return; }
            let data;
            try {
                data = JSON.parse(evt.data);
            } catch (e) {
                console.log(`[HAWS] could not parse message: ${e}`);
                return;
            }

            // Handle coalesced messages (array of messages)
            if(Array.isArray(data)) {
                if(that.debug) {
                    console.log(`[HAWS] WebSocket received ${data.length} coalesced messages`);
                }
                for(let message of data) {
                    that._handleMessageSafely(message);
                }
            } else {
                that._handleMessageSafely(data);
            }
        };

        socket.onerror = function(evt) {
            if (!isCurrent()) { return; }
            if(that.debug) {
                console.log(`[HAWS] WebSocket error: ${JSON.stringify(evt.detail, null, 4)}`);
            }
            // This callback is not an arrow function, so `this` is the socket:
            // the old `this.connected = false` here set a flag on the
            // WebSocket and left HAWS believing it was still connected.
            that.trigger("error", {detail: evt.detail});
            // onclose does the teardown, and closing an already-closed socket
            // is a no-op
            socket.close();
        };
    }

    // A callback that throws must not take the rest of a coalesced batch
    // with it, command results included
    _handleMessageSafely(data) {
        try {
            this._handleMessage(data);
        } catch (e) {
            console.log(`[HAWS] handling ${data && data.type} ${data && data.id} threw: ${e && e.stack || e}`);
        }
    }

    _handleMessage(data) {
        if(this.debug) {
            // objects that are too big cause console.log to stop responding
            console.log(`[HAWS] WebSocket msg: ${JSON.stringify(data).length <= 2048 ? JSON.stringify(data, null, 4) : '<truncated>'}`);
        }

        switch(data.type) {
            case 'auth_required':
                this.ws.send(
                    JSON.stringify({
                        type: 'auth',
                        access_token: this.token,
                    })
                );
                break;

            case 'auth_ok':
                // Nothing issued on a previous socket can be answered on this
                // one
                this._resetConnectionState();
                this.authenticated = true;
                this._reconnectAttempts = 0;

                // Send supported_features if coalesce_messages is enabled
                if(this.coalesce_messages) {
                    this._featuresId = this._genCmdId();
                    this.ws.send(JSON.stringify({
                        id: this._featuresId,
                        type: 'supported_features',
                        features: { coalesce_messages: 1 }
                    }));
                    if(this.debug) {
                        console.log('[HAWS] Sent supported_features with coalesce_messages enabled');
                    }
                }
                // Only probe once the connection is actually usable
                this.startHeartbeat();
                this.trigger("auth_ok", {detail: data});
                break;

            case 'pong':
                // Answers to ping come back as their own type rather than a
                // result, so without this the pending callback would sit in
                // _commands forever and the watchdog would never be cleared
                if (this._pongTimer) {
                    clearTimeout(this._pongTimer);
                    this._pongTimer = null;
                }
                this._pendingPingId = null;
                if (typeof data.id !== 'undefined') {
                    this._commands.delete(data.id);
                }
                break;

            case 'auth_invalid':
                // Retrying a token Home Assistant has just refused only piles
                // up failed logins, and with ip_ban_enabled enough of those
                // ban the phone. A new token comes with a new instance.
                this.selfDisconnect = true;
                if (this.reconnectTimeout) {
                    clearTimeout(this.reconnectTimeout);
                    this.reconnectTimeout = null;
                }
                this.trigger("auth_invalid", {detail: data});
                this.close();
                break;

            case 'event':
                if(typeof data.id !== 'undefined' && this._commands.has(data.id)) {
                    let callback = this._commands.get(data.id);
                    if(typeof callback[0] == "function") {
                        callback[0](data);
                    }
                }

                this.trigger("event", {detail: data});
                break;

            case 'result':
                // Ignore the result from supported_features
                if(data.id === this._featuresId) {
                    if(this.debug) {
                        console.log('[HAWS] Received supported_features response');
                    }
                    break;
                }

                if(typeof data.id !== 'undefined' && this._commands.has(data.id)) {
                    let callback = this._commands.get(data.id);

                    // Answered either way, so removed before a callback can
                    // throw and leave it to be failed again on disconnect
                    if (data.success) {
                        // ignore subscription success messages
                        if(this._subscriptions.indexOf(data.id) === -1) {
                            this._commands.delete(data.id);
                            if(typeof callback[0] == "function") {
                                callback[0](data);
                            }
                        }
                    } else {
                        this._commands.delete(data.id);
                        if(typeof callback[1] === 'function') {
                            callback[1](data);
                        }
                    }
                }

                this.trigger("result", {detail: data});
                break;
        }
    }

    startAttemptingToEstablishConnection() {
        let that = this;

        // Overwriting the handle without clearing left the previous timer
        // running, so two closes meant two pending attempts and two sockets
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        let delay = Math.min(this.reconnectInterval * Math.pow(2, this._reconnectAttempts),
            this.maxReconnectInterval);
        this._reconnectAttempts++;

        if(this.debug) {
            console.log(`[HAWS] Reconnection attempt in ${delay/1000}s`);
        }

        this.reconnectTimeout = setTimeout(function(){
            that.reconnectTimeout = null;
            if(that.debug) {
                console.log(`[HAWS] Attempting connection`);
            }
            that.connect();
        }, delay);
    }

    disconnect() {
        if(this.debug) {
            console.log(`[HAWS] Disconnecting..`);
        }
        this.selfDisconnect = true;
        this.stopHeartbeat();
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        // connect() may never have run, or may have failed before assigning
        if (this.ws) {
            this.ws.close();
        }
        this.connecting = false;
    }

    send(msg, successCallback, errorCallback) {
        if(this.authenticated) {
            if(!msg.id) {
                msg.id = this._genCmdId();
            }
            this.ws.send(JSON.stringify(msg));
            this._commands.set(msg.id, [ successCallback, errorCallback ]);
            return msg.id;
        }

        // Nothing will ever answer this, so say so now rather than leave the
        // caller waiting on a callback that cannot come
        if (typeof errorCallback === 'function') {
            errorCallback(HAWS._failure(msg.id, 'not_connected', 'Not connected to Home Assistant'));
        }
        return false;
    }

    // Shaped like a failed result frame, which is what error callbacks get
    static _failure(id, code, message) {
        return { id: id, type: 'result', success: false, error: { code: code, message: message } };
    }

    unsubscribe(msg_id) {
        let subscriptionIndex = this._subscriptions ? this._subscriptions.indexOf(msg_id) : -1;
        if(subscriptionIndex > -1) {
            this._subscriptions.splice(subscriptionIndex, 1);
        }
        if(this._commands.has(msg_id)) {
            this._commands.delete(msg_id);
        }

        let data = {
            "type": "unsubscribe_events",
            "subscription": msg_id
        };
        this.send(data);

        if(this.debug) {
            console.log(`[HAWS] unsubscribe: ${JSON.stringify(data, null, 4)}`);
        }
    }

    // https://developers.home-assistant.io/docs/api/websocket#subscribe-to-trigger
    // trigger options: https://www.home-assistant.io/docs/automation/trigger/#state-trigger
    subscribeTrigger(data, successCallback, errorCallback ) {
        // {
        //     "id": 2,
        //     "type": "subscribe_trigger",
        //     "trigger": {
        //         "platform": "state",
        //         "entity_id": "binary_sensor.motion_occupancy", // can be array or single string
        //         "from": "off",
        //         "to":"on"
        //     },
        // }
        let msg_id = this.send(data, successCallback, errorCallback);
        // send returns false while disconnected, and false never matches an
        // incoming id, so tracking it only grows the list
        if (msg_id !== false) {
            this._subscriptions.push(msg_id);
        }

        if(this.debug) {
            console.log(`[HAWS] subscribe: ${JSON.stringify(data, null, 4)}`);
        }

        return msg_id;
    }

    // Subscribe to events on the bus, optionally of one type only
    // https://developers.home-assistant.io/docs/api/websocket#subscribe-to-events
    subscribeEvents(event_type, successCallback, errorCallback) {
        let msg = { type: 'subscribe_events' };
        if (event_type) {
            msg.event_type = event_type;
        }

        let msg_id = this.send(msg, successCallback, errorCallback);
        // send returns false while disconnected, and false never matches an
        // incoming id, so tracking it only grows the list
        if (msg_id !== false) {
            this._subscriptions.push(msg_id);
        }

        if(this.debug) {
            console.log(`[HAWS] subscribe: ${JSON.stringify(msg, null, 4)}`);
        }

        return msg_id;
    }

    // Subscribe to entity state changes
    // https://developers.home-assistant.io/docs/api/websocket#subscribe-to-entity-changes
    subscribeEntities(entity_ids, successCallback, errorCallback) {
        // {
        //     "id": <unique_int>,
        //     "type": "subscribe_entities",
        //     "entity_ids": ["light.office", "sensor.co2_living_room"]
        // }
        //
        // Response events contain:
        //   event.a = added entities (initial snapshot has full state here)
        //   event.c = changed entities (contains "+" object with changed fields)
        //   event.r = removed entities
        //
        // Entity data format:
        //   { "s": "<state>", "a": {attributes}, "c": "<context>", "lc": <last_changed_timestamp> }

        let data = {
            "type": "subscribe_entities",
            "entity_ids": Array.isArray(entity_ids) ? entity_ids : [entity_ids]
        };

        let msg_id = this.send(data, successCallback, errorCallback);
        // send returns false while disconnected, and false never matches an
        // incoming id, so tracking it only grows the list
        if (msg_id !== false) {
            this._subscriptions.push(msg_id);
        }

        if(this.debug) {
            console.log(`[HAWS] subscribeEntities: ${JSON.stringify(data, null, 4)}`);
        }

        return msg_id;
    }

    // https://developers.home-assistant.io/docs/api/websocket#calling-a-service
    callService(domain, service, service_data, target, successCallback, errorCallback) {
        // let data = {
        //     "id": 24,
        //     "type": "call_service",
        //     "domain": "light",
        //     "service": "turn_on",
        //     // Optional
        //     "service_data": {
        //         "color_name": "beige",
        //         "brightness": "101"
        //     }
        //     // Optional
        //     "target": {
        //         "entity_id": "light.kitchen"
        //     }
        // };

        let data = {
            "type": "call_service",
            "domain": domain,
            "service": service
        };

        if(service_data) {
            data['service_data'] = service_data;
        }

        if(target) {
            data['target'] = target;
        }

        if(this.debug) {
            console.log(`[HAWS] call_service: ${JSON.stringify(data, null, 4)}`);
        }

        return this.send(data, successCallback, errorCallback);
    }

    /**
     * Generic turn on service
     * @param entity_id single entity_id or array of multiple
     * @param successCallback
     * @param errorCallback
     */
    turnOn(entity_id, successCallback, errorCallback) {
        this.callService('homeassistant', 'turn_on', {}, {entity_id: entity_id}, successCallback, errorCallback);
    }

    /**
     * Generic turn off service
     * @param entity_id single entity_id or array of multiple
     * @param successCallback
     * @param errorCallback
     */
    turnOff(entity_id, successCallback, errorCallback) {
        this.callService('homeassistant', 'turn_off', {}, {entity_id: entity_id}, successCallback, errorCallback);
    }

    /**
     * Generic toggle service
     * @param entity_id single entity_id or array of multiple
     * @param successCallback
     * @param errorCallback
     */
    toggle(entity_id, successCallback, errorCallback) {
        this.callService('homeassistant', 'toggle', {}, {entity_id: entity_id}, successCallback, errorCallback);
    }

    mediaPlayerPlayPause(entity_id, successCallback, errorCallback) {
        this.callService('media_player', 'media_play_pause', {}, {entity_id: entity_id}, successCallback, errorCallback);
    }

    mediaPlayerPlay(entity_id, successCallback, errorCallback) {
        this.callService('media_player', 'media_play', {}, {entity_id: entity_id}, successCallback, errorCallback);
    }

    mediaPlayerPause(entity_id, successCallback, errorCallback) {
        this.callService('media_player', 'media_pause', {}, {entity_id: entity_id}, successCallback, errorCallback);
    }

    mediaPlayerNextTrack(entity_id, successCallback, errorCallback) {
        this.callService('media_player', 'media_next_track', {}, {entity_id: entity_id}, successCallback, errorCallback);
    }

    mediaPlayerPreviousTrack(entity_id, successCallback, errorCallback) {
        this.callService('media_player', 'media_previous_track', {}, {entity_id: entity_id}, successCallback, errorCallback);
    }

    mediaPlayerSeek(entity_id, seek_position, successCallback, errorCallback) {
        this.callService('media_player', 'media_seek', { seek_position: seek_position }, {entity_id: entity_id}, successCallback, errorCallback);
    }

    mediaPlayerVolumeSet(entity_id, volume_level, successCallback, errorCallback) {
        this.callService('media_player', 'volume_set', { volume_level: volume_level }, {entity_id: entity_id}, successCallback, errorCallback);
    }

    mediaPlayerVolumeUp(entity_id, successCallback, errorCallback) {
        this.callService('media_player', 'volume_up', {}, { entity_id: entity_id }, successCallback, errorCallback);
    }

    mediaPlayerVolumeDown(entity_id, successCallback, errorCallback) {
        this.callService('media_player', 'volume_down', {}, { entity_id: entity_id }, successCallback, errorCallback);
    }

    mediaPlayerMute(entity_id, is_volume_muted, successCallback, errorCallback) {
        this.callService('media_player', 'volume_mute', { is_volume_muted: is_volume_muted }, { entity_id: entity_id }, successCallback, errorCallback);
    }

    /**
     *
     * @docs https://www.home-assistant.io/integrations/climate/#service-climateset_temperature
     * @param entity_id
     * @param data - object with keys temperature, target_temp_high, target_temp_low, and hvac mode
     * @param successCallback
     * @param errorCallback
     */
    climateSetTemp(entity_id, data, successCallback, errorCallback) {
        this.callService(
            'climate',
            'set_temperature',
            typeof data == 'object' ? data : {temperature: data},
            {entity_id: entity_id},
            successCallback,
            errorCallback);
    }

    climateSetFanMode(entity_id, fan_mode, successCallback, errorCallback) {
        this.callService(
            'climate',
            'set_fan_mode',
            {fan_mode: fan_mode},
            {entity_id: entity_id},
            successCallback,
            errorCallback);
    }

    climateSetHvacMode(entity_id, hvac_mode, successCallback, errorCallback) {
        this.callService(
            'climate',
            'set_hvac_mode',
            {hvac_mode: hvac_mode},
            {entity_id: entity_id},
            successCallback,
            errorCallback);
    }

    climateSetPresetMode(entity_id, preset_mode, successCallback, errorCallback) {
        this.callService(
            'climate',
            'set_preset_mode',
            {preset_mode: preset_mode},
            {entity_id: entity_id},
            successCallback,
            errorCallback);
    }

    climateSetSwingMode(entity_id, swing_mode, successCallback, errorCallback) {
        this.callService(
            'climate',
            'set_swing_mode',
            {swing_mode: swing_mode},
            {entity_id: entity_id},
            successCallback,
            errorCallback);
    }

    // https://developers.home-assistant.io/docs/api/websocket#fetching-services
    getStates(successCallback, errorCallback) {
        return this.send({ type: 'get_states' }, successCallback, errorCallback);
    }

    // https://developers.home-assistant.io/docs/api/websocket#fetching-services
    getConfig(successCallback, errorCallback) {
        return this.send({ type: 'get_config' }, successCallback, errorCallback);
    }

    // https://developers.home-assistant.io/docs/api/websocket#fetching-services
    getServices(successCallback, errorCallback) {
        return this.send({ type: 'get_services' }, successCallback, errorCallback);
    }

    // https://developers.home-assistant.io/docs/api/websocket#fetching-panels
    getPanels(successCallback, errorCallback) {
        return this.send({ type: 'get_panels' }, successCallback, errorCallback);
    }

    getConfigAreas(successCallback, errorCallback) {
        return this.send({ type: 'config/area_registry/list'}, successCallback, errorCallback);
    }

    getConfigFloors(successCallback, errorCallback) {
        return this.send({ type: 'config/floor_registry/list'}, successCallback, errorCallback);
    }

    getConfigDevices(successCallback, errorCallback) {
        return this.send({ type: 'config/device_registry/list'}, successCallback, errorCallback);
    }

    getConfigEntities(successCallback, errorCallback) {
        return this.send({ type: 'config/entity_registry/list'}, successCallback, errorCallback);
    }

    getConfigLabels(successCallback, errorCallback) {
        return this.send({ type: 'config/label_registry/list'}, successCallback, errorCallback);
    }

    on(event, callback) {
        return this.events.addEventListener(event, callback);
    }

    trigger(event, data) {
        return this.events.dispatchEvent(new CustomEvent(event, data));
    }

    close() {
        this.stopHeartbeat();
        if(this.connected) {
            this.ws.close();
            this.connected = false;
            this.authenticated = false;
            this._resetConnectionState();
        }
    }

    _genCmdId() {
        // No wrap. Home Assistant rejects any id that is not greater than the
        // last one it saw on this connection (error code id_reuse). It only
        // asks that they climb, so one counter serves every connection.
        return ++this._last_cmd_id;
    }

    // Add new method for listing pipelines
    getPipelines(successCallback, errorCallback) {
        return this.send({ type: 'assist_pipeline/pipeline/list' }, successCallback, errorCallback);
    }

    /**
     * Run an assist pipeline.
     *
     * `progressCallback` is optional and only ever called where Home Assistant
     * streams the answer as the agent writes it (intent-progress events, core
     * 2025.3 and later). It receives each new piece of text on its own; an
     * older instance simply never sends them and the answer arrives whole at
     * the end as it always did.
     */
    runPipeline(data, successCallback, errorCallback, progressCallback) {
        const msg = {
            type: 'assist_pipeline/run',
            ...data
        };

        // Writing straight to the socket skipped every check send() makes: a
        // dropped connection either threw or swallowed the request, and
        // neither callback ever ran
        if (!this.authenticated) {
            if (errorCallback) {
                errorCallback(HAWS._failure(undefined, 'not_connected', 'Not connected to Home Assistant'));
            }
            return false;
        }

        msg.id = this._genCmdId();

        // Store the subscription callback before sending
        const subscriptionId = msg.id;
        this._subscriptions.push(subscriptionId);

        // Which message the streamed deltas currently belong to. A delta with
        // a role opens a new one and the ones after it continue it, the same
        // as Home Assistant's chat log and its own frontend read them.
        let deltaRole = '';

        // A run answers once, so losing the connection after the answer
        // arrived must not report a failure as well
        let settled = false;
        const fail = (error) => {
            if (settled) { return; }
            settled = true;
            if (errorCallback) {
                errorCallback(error);
            }
        };

        // Create a handler for the subscription responses
        const handler = (response) => {
            if (response.type === 'result') {
                if (!response.success) {
                    fail(response.error || 'Failed to start pipeline');
                    this.unsubscribe(subscriptionId);
                    return;
                }
                return; // Just acknowledge receipt, don't call success callback yet
            }

            // Handle event responses
            if (response.type === 'event') {
                const event = response.event;

                // Check for run-end event to clean up subscription
                if (event.type === 'run-end') {
                    this.unsubscribe(subscriptionId);
                    return;
                }

                // Check for error event
                if (event.type === 'error') {
                    const errorMessage = event.data && event.data.message ? event.data.message : 'Pipeline error';
                    const errorCode = event.data && event.data.code ? event.data.code : 'unknown';
                    fail({
                        error: errorMessage,
                        code: errorCode
                    });
                    this.unsubscribe(subscriptionId);
                    return;
                }

                // A piece of the answer, while the agent is still writing it.
                // The delta carries whatever the agent felt like reporting,
                // including its own private reasoning under other keys, so
                // only actual answer text is taken and only when it is text.
                //
                // A delta carrying a role closes the message before it and
                // opens a new one, and the same delta may carry the first of
                // the new message's content. Only the assistant writes what
                // the wearer reads, so anything said under another role, a
                // tool result's included, is passed over.
                if (event.type === 'intent-progress' && progressCallback &&
                    event.data && event.data.chat_log_delta) {
                    const delta = event.data.chat_log_delta;
                    if (delta.role) {
                        deltaRole = delta.role;
                    }
                    if (deltaRole !== 'assistant') {
                        return;
                    }
                    const opens = delta.role === 'assistant';
                    const piece = typeof delta.content === 'string' ? delta.content : '';
                    if (opens || piece.length) {
                        progressCallback(piece, opens);
                    }
                    return;
                }

                // Check for intent-end event to get the response
                if (event.type === 'intent-end' && event.data && event.data.intent_output) {
                    settled = true;
                    if (successCallback) {
                        successCallback({
                            success: true,
                            response: event.data.intent_output.response,
                            conversation_id: event.data.intent_output.conversation_id,
                            // The agent asked something back and expects the
                            // mic to reopen for the answer
                            continue_conversation: !!event.data.intent_output.continue_conversation
                        });
                    }
                }
            }
        };

        // Store the command and handler. The third slot marks it to be failed
        // if the connection drops, which subscriptions otherwise are not.
        this._commands.set(subscriptionId, [handler, fail, true]);

        // Send the message
        this.ws.send(JSON.stringify(msg));
        return subscriptionId;
    }
}

/**
 * Standard WebSocket close codes (RFC 6455) plus common reasons,
 * used to turn an opaque close code into something actionable in the logs.
 */
HAWS.CLOSE_CODES = {
    1000: 'Normal closure',
    1001: 'Going away (server shutting down or browser navigating away)',
    1002: 'Protocol error',
    1003: 'Unsupported data',
    1005: 'No status received (connection closed without a close frame - often network drop or wrong URL/port)',
    1006: 'Abnormal closure (connection failed - check HA URL, that HA is reachable, and TLS/SSL settings)',
    1007: 'Invalid frame payload data',
    1008: 'Policy violation',
    1009: 'Message too big',
    1010: 'Missing extension',
    1011: 'Internal server error',
    1012: 'Service restart',
    1013: 'Try again later',
    1014: 'Bad gateway',
    1015: 'TLS handshake failure (HTTPS/SSL problem - verify the certificate and that the URL scheme matches)'
};

module.exports = HAWS;