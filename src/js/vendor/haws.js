class HAWS {
    constructor(ha_url, token) {
        this.events = new EventTarget();
        this.connected = false;
        this.ha_url = ha_url;
        this.token = token;
        this.ws = null;
        this.call_ids = {};
        this._last_cmd_id = 0;
        this._commands = new Map();
        this._queuedMessages = undefined;
        this._subscriptions = [];
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

        this.ws.onopen = function(evt){
            that.connected = true;
            that.events.dispatchEvent(new CustomEvent("open", {detail: evt.detail}));
        };

        this.ws.onmessage = function(evt) {
            let data = JSON.parse(evt.data);
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
                        callback[0](data);
                    }

                    that.trigger("event", {detail: data});
                    break;

                case 'result':
                    if(typeof data.id !== 'undefined' && that._commands.has(data.id)) {
                        let callback = that._commands.get(data.id);

                        if (data.success) {
                            // ignore subscription success messages
                            if(that._subscriptions.indexOf(data.id) === -1) {
                                callback[0](data);
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
            that.ws.close();
            that.trigger("error", {detail: evt.detail});
            this.connected = false;
        };
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

        this.send({
            "type": "unsubscribe_events",
            "subscription": msg_id
        });
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

        console.log("CALLING SERVICE: " + JSON.stringify(data));

        return this.send(data, successCallback, errorCallback);
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
            this._queuedMessages = undefined;
            this._subscriptions = [];
        }
    }

    _genCmdId() {
        if(this._last_cmd_id > 9999) {
            this._last_cmd_id = 0;
        }

        return ++this._last_cmd_id;
    }
}

module.exports = HAWS;