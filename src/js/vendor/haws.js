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

                case 'result':
                    if(typeof data.id !== 'undefined' && that._commands.has(data.id)) {
                        let callback = that._commands.get(data.id);

                        if (data.success) {
                            callback[0](data);
                            // Don't remove subscriptions.
                            if (!("subscribe" in data)) {
                                that._commands.delete(data.id);
                            }
                        }
                        else {
                            callback[1](data);
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
            msg.id = this._genCmdId();
            this.ws.send(JSON.stringify(msg));
            this._commands.set(msg.id, [ successCallback, errorCallback ]);
            return true;
        }

        return false;
    }

    call(msg, callback) {

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