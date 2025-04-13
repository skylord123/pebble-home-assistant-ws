/**
 * Home Assistant Web Sockets
 * @author https://github.com/skylord123
 * @description Simple library to use the Home Assistant's WebSocket API
 */
class HAWS {
    constructor(ha_url, token, debug) {
        this.events = new EventTarget();
        this.connected = false;
        this.reconnectTimeout = null;
        this.selfDisconnect = false;
        this.ha_url = ha_url;
        this.token = token;
        this.ws = null;
        this._last_cmd_id = 0;
        this._commands = new Map();
        this._subscriptions = [];
        this.reconnectInterval = 2500;
        this.debug = debug || false;
    }

    isConnected() {
        return this.connected;
    }

    connect() {
        if(this.connected) {
            return false;
        }

        let that = this,
            ws_url = this.ha_url.replace('http','ws').replace(/\/+$/, '') + '/api/websocket';
        this.ws = new WebSocket(ws_url);
        this.ws.onclose = (evt) => {
            that.events.dispatchEvent(new CustomEvent("close", {detail: evt.detail}));
            this.connected = false;
            if (!this.selfDisconnect) {
                console.log(`[HAWS] WebSocket closed: ${JSON.stringify(evt.detail, null, 4)}`);
                this.startAttemptingToEstablishConnection();
            }
        }

        this.ws.onopen = function(evt){
            that.connected = true;
            that.events.dispatchEvent(new CustomEvent("open", {detail: evt.detail}));
            if(that.debug) {
                console.log(`[HAWS] WebSocket connected: ${JSON.stringify(evt.detail, null, 4)}`);
            }
        };

        this.ws.onmessage = function(evt) {
            let data = JSON.parse(evt.data);
            if(that.debug) {
                // objects that are too big cause console.log to stop responding
                console.log(`[HAWS] WebSocket msg: ${evt.data.length <= 2048 ? JSON.stringify(data, null, 4) : '<truncated>'}`);
            }
            switch(data.type) {
                case 'auth_required':
                    that.ws.send(
                        JSON.stringify({
                            type: 'auth',
                            access_token: that.token,
                        })
                    );
                    break;

                case 'auth_ok':
                    that.trigger("auth_ok", {detail: data});
                    break;

                case 'auth_invalid':
                    that.trigger("auth_invalid", {detail: data});
                    that.close();
                    break;

                case 'event':
                    if(typeof data.id !== 'undefined' && that._commands.has(data.id)) {
                        let callback = that._commands.get(data.id);
                        if(typeof callback[0] == "function") {
                            callback[0](data);
                        }
                    }

                    that.trigger("event", {detail: data});
                    break;

                case 'result':
                    if(typeof data.id !== 'undefined' && that._commands.has(data.id)) {
                        let callback = that._commands.get(data.id);

                        if (data.success) {
                            // ignore subscription success messages
                            if(that._subscriptions.indexOf(data.id) === -1) {
                                if(typeof callback[0] == "function") {
                                    callback[0](data);
                                }
                                that._commands.delete(data.id);
                            }
                        } else {
                            if(typeof callback[1] !== 'undefined') {
                                callback[1](data);
                            }
                            that._commands.delete(data.id);
                        }
                    }

                    that.trigger("result", {detail: data});
                    break;
            }
        };

        this.ws.onerror = function(evt) {
            if(that.debug) {
                console.log(`[HAWS] WebSocket error: ${JSON.stringify(evt.detail, null, 4)}`);
            }
            that.ws.close();
            that.trigger("error", {detail: evt.detail});
            this.connected = false;
        };
    }

    startAttemptingToEstablishConnection() {
        let that = this;
        if(this.debug) {
            console.log(`[HAWS] Reconnection attempt in ${this.reconnectInterval/1000}s`);
        }

        this.reconnectTimeout = setTimeout(function(){
            if(that.debug) {
                console.log(`[HAWS] Attempting connection`);
            }
            that.connect();
        }, this.reconnectInterval);
    }

    disconnect() {
        if(this.debug) {
            console.log(`[HAWS] Disconnecting..`);
        }
        this.selfDisconnect = true;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.ws.close();

    }

    send(msg, successCallback, errorCallback) {
        if(this.connected) {
            if(!msg.id) {
                msg.id = this._genCmdId();
            }
            this.ws.send(JSON.stringify(msg));
            this._commands.set(msg.id, [ successCallback, errorCallback ]);
            return msg.id;
        }

        return false;
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
    subscribe(data, successCallback, errorCallback ) {
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
        this._subscriptions.push(msg_id);

        if(this.debug) {
            console.log(`[HAWS] subscribe: ${JSON.stringify(data, null, 4)}`);
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
        if(this.connected) {
            this.ws.close();
            this.connected = false;
            this._last_cmd_id = 0;
            this._commands = new Map();
            this._subscriptions = [];
        }
    }

    _genCmdId() {
        if(this._last_cmd_id > 9999) {
            this._last_cmd_id = 0;
        }

        return ++this._last_cmd_id;
    }

    // Add new method for listing pipelines
    getPipelines(successCallback, errorCallback) {
        return this.send({ type: 'assist_pipeline/pipeline/list' }, successCallback, errorCallback);
    }

    // Add new method for running pipeline
    runPipeline(data, successCallback, errorCallback) {
        const msg = {
            type: 'assist_pipeline/run',
            ...data
        };

        msg.id = this._genCmdId();

        // Store the subscription callback before sending
        const subscriptionId = msg.id;
        this._subscriptions.push(subscriptionId);

        // Create a handler for the subscription responses
        const handler = (response) => {
            if (response.type === 'result') {
                if (!response.success) {
                    if (errorCallback) {
                        errorCallback(response.error || 'Failed to start pipeline');
                    }
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
                    if (errorCallback) {
                        const errorMessage = event.data && event.data.message ? event.data.message : 'Pipeline error';
                        const errorCode = event.data && event.data.code ? event.data.code : 'unknown';
                        errorCallback({
                            error: errorMessage,
                            code: errorCode
                        });
                    }
                    this.unsubscribe(subscriptionId);
                    return;
                }

                // Check for intent-end event to get the response
                if (event.type === 'intent-end' && event.data && event.data.intent_output) {
                    if (successCallback) {
                        successCallback({
                            success: true,
                            response: event.data.intent_output.response,
                            conversation_id: event.data.intent_output.conversation_id
                        });
                    }
                }
            }
        };

        // Store the command and handler
        this._commands.set(subscriptionId, [handler, errorCallback]);

        // Send the message
        this.ws.send(JSON.stringify(msg));
        return subscriptionId;
    }
}

module.exports = HAWS;