/**
 * Home Assistant Web Sockets (Mock Implementation)
 * @author Claude (based on HAWS by skylord123)
 * @description Mock library to simulate the Home Assistant's WebSocket API
 */

let CustomEventTarget;
if (typeof window !== 'undefined' && typeof window.EventTarget !== 'undefined') {
    // Use the built-in EventTarget if available
    CustomEventTarget = window.EventTarget;
} else {
    // Create a simple polyfill if EventTarget is not available
    CustomEventTarget = class {
        constructor() {
            this._listeners = {};
        }

        addEventListener(type, callback) {
            if (!(type in this._listeners)) {
                this._listeners[type] = [];
            }
            this._listeners[type].push(callback);
            return this;
        }

        removeEventListener(type, callback) {
            if (!(type in this._listeners)) return;
            const stack = this._listeners[type];
            for (let i = 0, l = stack.length; i < l; i++) {
                if (stack[i] === callback) {
                    stack.splice(i, 1);
                    return;
                }
            }
        }

        dispatchEvent(event) {
            if (!(event.type in this._listeners)) return true;
            const stack = this._listeners[event.type].slice();

            for (let i = 0, l = stack.length; i < l; i++) {
                stack[i].call(this, event);
            }
            return !event.defaultPrevented;
        }
    };
}

// Do the same for CustomEvent
let CustomEventPolyfill;
if (typeof window !== 'undefined' && typeof window.CustomEvent !== 'undefined') {
    CustomEventPolyfill = window.CustomEvent;
} else {
    CustomEventPolyfill = class {
        constructor(type, eventInitDict = {}) {
            this.type = type;
            this.detail = eventInitDict.detail || null;
            this.defaultPrevented = false;
        }

        preventDefault() {
            this.defaultPrevented = true;
        }
    };
}

class HAWS {
    constructor(ha_url, token, debug) {
        this.events = new CustomEventTarget();
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

        // Mock entity data will be initialized in connect()
        this.mockEntities = {};
        this.mockAreas = {
            'living_room': 'Living Room',
            'bedroom': 'Bedroom',
            'bathroom': 'Bathroom',
            'kitchen': 'Kitchen'
        };
        this.mockDevices = {};
        this.mockEntityRegistry = {};
    }

    isConnected() {
        return this.connected;
    }

    connect() {
        if(this.connected) {
            return false;
        }

        // Initialize our mock data
        this._initializeMockData();

        // Simulate WebSocket open
        this.connected = true;
        this.trigger("open", {});

        if(this.debug) {
            console.log(`[HAWS Mock] WebSocket connected`);
        }

        // Simulate authentication flow
        setTimeout(() => {
            // Auth required
            this.trigger("auth_required", {
                detail: {
                    type: "auth_required",
                    ha_version: "2023.3.0"
                }
            });

            // Auth success (assume token is valid)
            setTimeout(() => {
                this.trigger("auth_ok", {
                    detail: {
                        type: "auth_ok",
                        ha_version: "2023.3.0"
                    }
                });
            }, 100);
        }, 100);

        return true;
    }

    disconnect() {
        if(this.debug) {
            console.log(`[HAWS Mock] Disconnecting..`);
        }
        this.selfDisconnect = true;
        this.connected = false;
        this.trigger("close", {});
    }

    send(msg, successCallback, errorCallback) {
        if(!this.connected) {
            return false;
        }

        if(!msg.id) {
            msg.id = this._genCmdId();
        }

        if(this.debug) {
            console.log(`[HAWS Mock] Received message:`, msg);
        }

        // Process different message types
        let response;
        try {
            switch(msg.type) {
                case 'get_states':
                    response = this._handleGetStates(msg, successCallback);
                    break;
                case 'get_config':
                    response = this._handleGetConfig(msg, successCallback);
                    break;
                case 'get_services':
                    response = this._handleGetServices(msg, successCallback);
                    break;
                case 'config/area_registry/list':
                    response = this._handleGetAreas(msg, successCallback);
                    break;
                case 'config/device_registry/list':
                    response = this._handleGetDevices(msg, successCallback);
                    break;
                case 'config/entity_registry/list':
                    response = this._handleGetEntities(msg, successCallback);
                    break;
                case 'call_service':
                    response = this._handleCallService(msg, successCallback);
                    break;
                case 'subscribe_trigger':
                    response = this._handleSubscribeTrigger(msg, successCallback);
                    // For subscriptions, we don't call the callback immediately
                    return msg.id;
                case 'unsubscribe_events':
                    response = this._handleUnsubscribe(msg, successCallback);
                    break;
                case 'conversation/process':
                    response = this._handleConversation(msg, successCallback);
                    break;
                case 'config/label_registry/list':
                    response = this._handleGetLabels(msg, successCallback);
                    break;
                default:
                    if(this.debug) {
                        console.log(`[HAWS Mock] Unhandled message type: ${msg.type}`);
                    }
                    if(errorCallback) {
                        errorCallback({
                            error: {
                                code: 'unknown_command',
                                message: `Unknown command type: ${msg.type}`
                            }
                        });
                    }
                    return msg.id;
            }

            // Call the success callback with the response (except for subscribe_trigger)
            if(successCallback && msg.type !== 'subscribe_trigger') {
                successCallback(response);
            }
        } catch (err) {
            console.error(`[HAWS Mock] Error processing message:`, err);
            if(errorCallback) {
                errorCallback({
                    error: {
                        code: 'internal_error',
                        message: err.message
                    }
                });
            }
        }

        return msg.id;
    }

    // Handle conversation requests
    _handleConversation(msg, callback) {
        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: {
                conversation_id: "mock-conversation-" + this._generateRandomId(),
                response: {
                    response_type: "action_done",
                    data: {},
                    speech: {
                        plain: {
                            speech: "I've processed your request: " + msg.text
                        }
                    }
                }
            }
        };

        if(callback) {
            callback(response);
        }

        return response;
    }

    // Handler methods for different message types
    _handleGetStates(msg, callback) {
        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: Object.values(this.mockEntities)
        };

        if(callback) {
            callback(response);
        }

        return response;
    }

    _handleGetConfig(msg, callback) {
        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: {
                components: ['light', 'media_player', 'cover', 'fan', 'switch', 'climate'],
                config_dir: '/config',
                elevation: 0,
                latitude: 40.7128,
                longitude: -74.0060,
                location_name: 'Mock Home',
                time_zone: 'America/New_York',
                unit_system: {
                    length: 'mi',
                    mass: 'lb',
                    temperature: '°F',
                    volume: 'gal'
                },
                version: '2023.3.0'
            }
        };

        if(callback) {
            callback(response);
        }

        return response;
    }

    _handleGetServices(msg, callback) {
        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: {
                light: {
                    turn_on: { description: 'Turn on light' },
                    turn_off: { description: 'Turn off light' },
                    toggle: { description: 'Toggle light' }
                },
                media_player: {
                    turn_on: { description: 'Turn on media player' },
                    turn_off: { description: 'Turn off media player' },
                    toggle: { description: 'Toggle media player' },
                    volume_up: { description: 'Volume up' },
                    volume_down: { description: 'Volume down' },
                    volume_set: { description: 'Set volume' },
                    volume_mute: { description: 'Mute' },
                    media_play_pause: { description: 'Play/pause' },
                    media_play: { description: 'Play' },
                    media_pause: { description: 'Pause' },
                    media_stop: { description: 'Stop' },
                    media_next_track: { description: 'Next track' },
                    media_previous_track: { description: 'Previous track' }
                },
                cover: {
                    open_cover: { description: 'Open cover' },
                    close_cover: { description: 'Close cover' },
                    stop_cover: { description: 'Stop cover' }
                },
                fan: {
                    turn_on: { description: 'Turn on fan' },
                    turn_off: { description: 'Turn off fan' },
                    toggle: { description: 'Toggle fan' }
                },
                climate: {
                    turn_on: { description: 'Turn on climate device' },
                    turn_off: { description: 'Turn off climate device' },
                    set_temperature: { description: 'Set target temperature' },
                    set_hvac_mode: { description: 'Set HVAC mode' },
                    set_fan_mode: { description: 'Set fan mode' },
                    set_preset_mode: { description: 'Set preset mode' },
                    set_swing_mode: { description: 'Set swing mode' }
                }
            }
        };

        if(callback) {
            callback(response);
        }

        return response;
    }

    _handleGetAreas(msg, callback) {
        const areas = Object.entries(this.mockAreas).map(([area_id, name]) => ({
            area_id: area_id,
            name: name,
            picture: null
        }));

        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: areas
        };

        if(callback) {
            callback(response);
        }

        return response;
    }

    _handleGetDevices(msg, callback) {
        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: Object.values(this.mockDevices)
        };

        if(callback) {
            callback(response);
        }

        return response;
    }

    _handleGetEntities(msg, callback) {
        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: Object.values(this.mockEntityRegistry)
        };

        if(callback) {
            callback(response);
        }

        return response;
    }

    _handleCallService(msg, callback) {
        const { domain, service, service_data, target } = msg;
        const entity_id = target?.entity_id;

        if(this.debug) {
            console.log(`[HAWS Mock] Service call: ${domain}.${service} for ${entity_id}`, service_data);
        }

        // Process service call based on domain and service
        if(entity_id && this.mockEntities[entity_id]) {
            const entity = this.mockEntities[entity_id];

            // Create a deep copy of the entity before updating it
            const previousState = JSON.parse(JSON.stringify(entity));

            const updated = this._updateEntityState(entity, domain, service, service_data);

            if(updated) {
                // Notify subscribers with both previous and new state
                this._notifyStateChanged(entity_id, previousState);
            }
        }

        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: {
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: 'mock-user-id'
                }
            }
        };

        if(callback) {
            callback(response);
        }

        return response;
    }

    _handleSubscribeTrigger(msg, callback) {
        const subscription_id = msg.id;
        this._subscriptions.push(subscription_id);

        // Store the callback for later use with state updates
        if(callback) {
            this._commands.set(subscription_id, [callback]);
        }

        // Return success response, but DON'T call the callback with it
        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: null
        };

        // Send initial state update after a short delay
        setTimeout(() => {
            if (msg.trigger && msg.trigger.entity_id) {
                // Handle both single entity_id and array of entity_ids
                const entityIds = Array.isArray(msg.trigger.entity_id) ?
                    msg.trigger.entity_id : [msg.trigger.entity_id];

                for (const entity_id of entityIds) {
                    const entity = this.mockEntities[entity_id];
                    if (entity) {
                        // Create a deep copy of the entity to use as both from_state and to_state
                        const entityCopy = JSON.parse(JSON.stringify(entity));

                        // Send state event directly to callback
                        this._sendStateEvent(subscription_id, entityCopy, entity);
                    }
                }
            }
        }, 100);

        return response;
    }

    _sendStateEvent(subscription_id, from_state, to_state) {
        const callbacks = this._commands.get(subscription_id);
        if (!callbacks || callbacks.length === 0) return;

        const callback = callbacks[0];

        const event_data = {
            id: subscription_id,
            type: 'event',
            event: {
                variables: {
                    trigger: {
                        from_state: from_state,
                        to_state: to_state
                    }
                },
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            }
        };

        callback(event_data);
    }

    _handleUnsubscribe(msg, callback) {
        const subscription = msg.subscription;
        const index = this._subscriptions.indexOf(subscription);

        if(index !== -1) {
            this._subscriptions.splice(index, 1);
        }

        if(this._commands.has(subscription)) {
            this._commands.delete(subscription);
        }

        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: null
        };

        if(callback) {
            callback(response);
        }

        return response;
    }

    // Update entity state based on service call
    _updateEntityState(entity, domain, service, data) {
        if(!entity) return false;

        const currentTime = new Date().toISOString();
        let updated = false;

        switch(domain) {
            case 'light':
                if(service === 'turn_on') {
                    entity.state = 'on';
                    if(data?.brightness !== undefined) {
                        entity.attributes.brightness = data.brightness;
                    }
                    if(data?.color_temp !== undefined) {
                        entity.attributes.color_temp = data.color_temp;
                    }
                    if(data?.rgb_color !== undefined) {
                        entity.attributes.rgb_color = data.rgb_color;
                    }
                    updated = true;
                } else if(service === 'turn_off') {
                    entity.state = 'off';
                    updated = true;
                } else if(service === 'toggle') {
                    entity.state = entity.state === 'on' ? 'off' : 'on';
                    updated = true;
                }
                break;

            case 'media_player':
                if(service === 'turn_on') {
                    entity.state = 'idle';
                    updated = true;
                } else if(service === 'turn_off') {
                    entity.state = 'off';
                    updated = true;
                } else if(service === 'media_play') {
                    if(entity.state !== 'off') {
                        entity.state = 'playing';
                        updated = true;
                    }
                } else if(service === 'media_pause') {
                    if(entity.state === 'playing') {
                        entity.state = 'paused';
                        updated = true;
                    }
                } else if(service === 'media_play_pause') {
                    if(entity.state === 'playing') {
                        entity.state = 'paused';
                    } else if(entity.state === 'paused' || entity.state === 'idle') {
                        entity.state = 'playing';
                    }
                    updated = true;
                } else if(service === 'volume_set' && data?.volume_level !== undefined) {
                    entity.attributes.volume_level = data.volume_level;
                    updated = true;
                } else if(service === 'volume_up') {
                    let vol = entity.attributes.volume_level || 0;
                    vol = Math.min(1, vol + 0.1);
                    entity.attributes.volume_level = vol;
                    updated = true;
                } else if(service === 'volume_down') {
                    let vol = entity.attributes.volume_level || 0;
                    vol = Math.max(0, vol - 0.1);
                    entity.attributes.volume_level = vol;
                    updated = true;
                } else if(service === 'volume_mute' && data?.is_volume_muted !== undefined) {
                    entity.attributes.is_volume_muted = data.is_volume_muted;
                    updated = true;
                }
                break;

            case 'cover':
                if(service === 'open_cover') {
                    entity.state = 'open';
                    entity.attributes.current_position = 100;
                    updated = true;
                } else if(service === 'close_cover') {
                    entity.state = 'closed';
                    entity.attributes.current_position = 0;
                    updated = true;
                } else if(service === 'set_cover_position' && data?.position !== undefined) {
                    entity.attributes.current_position = data.position;
                    entity.state = data.position > 0 ? 'open' : 'closed';
                    updated = true;
                }
                break;

            case 'fan':
                if(service === 'turn_on') {
                    entity.state = 'on';
                    updated = true;
                } else if(service === 'turn_off') {
                    entity.state = 'off';
                    updated = true;
                } else if(service === 'toggle') {
                    entity.state = entity.state === 'on' ? 'off' : 'on';
                    updated = true;
                } else if(service === 'set_percentage' && data?.percentage !== undefined) {
                    entity.attributes.percentage = data.percentage;
                    updated = true;
                }
                break;

            case 'climate':
                if(service === 'turn_on') {
                    // Restore previous HVAC mode or default to 'heat'
                    entity.state = entity.attributes.previous_hvac_mode || 'heat';
                    updated = true;
                } else if(service === 'turn_off') {
                    // Store current HVAC mode before turning off
                    if (entity.state !== 'off') {
                        entity.attributes.previous_hvac_mode = entity.state;
                    }
                    entity.state = 'off';
                    updated = true;
                } else if(service === 'set_temperature') {
                    // Handle single temperature
                    if(data?.temperature !== undefined) {
                        entity.attributes.temperature = data.temperature;
                        updated = true;
                    }
                    // Handle temperature range for heat_cool mode
                    if(data?.target_temp_low !== undefined) {
                        entity.attributes.target_temp_low = data.target_temp_low;
                        updated = true;
                    }
                    if(data?.target_temp_high !== undefined) {
                        entity.attributes.target_temp_high = data.target_temp_high;
                        updated = true;
                    }
                } else if(service === 'set_hvac_mode' && data?.hvac_mode !== undefined) {
                    entity.state = data.hvac_mode;
                    updated = true;
                } else if(service === 'set_fan_mode' && data?.fan_mode !== undefined) {
                    entity.attributes.fan_mode = data.fan_mode;
                    updated = true;
                } else if(service === 'set_preset_mode' && data?.preset_mode !== undefined) {
                    entity.attributes.preset_mode = data.preset_mode;
                    updated = true;
                } else if(service === 'set_swing_mode' && data?.swing_mode !== undefined) {
                    entity.attributes.swing_mode = data.swing_mode;
                    updated = true;
                }
                break;

            // Handle homeassistant domain (generic services)
            case 'homeassistant':
                if(service === 'turn_on' || service === 'turn_off' || service === 'toggle') {
                    // Find domain from entity_id
                    const domain = entity.entity_id.split('.')[0];
                    updated = this._updateEntityState(entity, domain, service, data);
                }
                break;
        }

        if(updated) {
            entity.last_changed = currentTime;
            entity.last_updated = currentTime;
        }

        return updated;
    }

    // Notify subscribers about state changes
    _notifyStateChanged(entity_id, previousState) {
        const entity = this.mockEntities[entity_id];
        if(!entity) return;

        for(const subscription_id of this._subscriptions) {
            this._sendStateEvent(subscription_id, previousState, entity);
        }
    }

    // Helper methods
    _generateRandomId() {
        return Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);
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
            console.log(`[HAWS Mock] unsubscribe: ${JSON.stringify(data, null, 4)}`);
        }
    }

    subscribe(data, successCallback, errorCallback) {
        // Generate ID if not provided
        if (!data.id) {
            data.id = this._genCmdId();
        }

        const msg_id = data.id;

        this.send(data, successCallback, errorCallback);

        // Make sure this subscription ID is tracked
        if (this._subscriptions.indexOf(msg_id) === -1) {
            this._subscriptions.push(msg_id);
        }

        if(this.debug) {
            console.log(`[HAWS Mock] subscribe: ${JSON.stringify(data, null, 4)}, id: ${msg_id}`);
        }

        return msg_id;
    }

    callService(domain, service, service_data, target, successCallback, errorCallback) {
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
            console.log(`[HAWS Mock] call_service: ${JSON.stringify(data, null, 4)}`);
        }

        return this.send(data, successCallback, errorCallback);
    }

    // Original helper methods (keeping interface identical)
    turnOn(entity_id, successCallback, errorCallback) {
        this.callService('homeassistant', 'turn_on', {}, {entity_id: entity_id}, successCallback, errorCallback);
    }

    turnOff(entity_id, successCallback, errorCallback) {
        this.callService('homeassistant', 'turn_off', {}, {entity_id: entity_id}, successCallback, errorCallback);
    }

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

    // Climate helper methods
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

    getStates(successCallback, errorCallback) {
        return this.send({ type: 'get_states' }, successCallback, errorCallback);
    }

    getConfig(successCallback, errorCallback) {
        return this.send({ type: 'get_config' }, successCallback, errorCallback);
    }

    getServices(successCallback, errorCallback) {
        return this.send({ type: 'get_services' }, successCallback, errorCallback);
    }

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
        return this.events.dispatchEvent(new CustomEventPolyfill(event, data));
    }

    close() {
        if(this.connected) {
            this.connected = false;
            this._last_cmd_id = 0;
            this._commands = new Map();
            this._subscriptions = [];
            this.trigger("close", {});
        }
    }

    _genCmdId() {
        if(this._last_cmd_id > 9999) {
            this._last_cmd_id = 0;
        }

        return ++this._last_cmd_id;
    }

    // Initialize mock data structures
    _initializeMockData() {
        const currentTime = new Date().toISOString();

        // Create climate devices
        this.mockDevices = {
            'device_house_thermostat': {
                id: 'device_house_thermostat',
                area_id: 'living_room',
                name: 'House Thermostat',
                manufacturer: 'Nest',
                model: 'Learning Thermostat',
            },
            'device_bedroom_ac': {
                id: 'device_bedroom_ac',
                area_id: 'bedroom',
                name: 'Bedroom AC',
                manufacturer: 'LG',
                model: 'Window AC Unit',
            },
            'device_living_room_ac': {
                id: 'device_living_room_ac',
                area_id: 'living_room',
                name: 'Living Room AC',
                manufacturer: 'Daikin',
                model: 'Mini Split',
            },
            'device_living_room_lights': {
                id: 'device_living_room_lights',
                area_id: 'living_room',
                name: 'Living Room Lights',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Light',
            },
            'device_living_room_tv': {
                id: 'device_living_room_tv',
                area_id: 'living_room',
                name: 'Living Room TV',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock TV',
            },
            'device_living_room_blinds': {
                id: 'device_living_room_blinds',
                area_id: 'living_room',
                name: 'Living Room Blinds',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Blinds',
            },
            'device_living_room_fan': {
                id: 'device_living_room_fan',
                area_id: 'living_room',
                name: 'Living Room Fan',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Fan',
            },
            'device_bedroom_lights': {
                id: 'device_bedroom_lights',
                area_id: 'bedroom',
                name: 'Bedroom Lights',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Light',
            },
            'device_bedroom_speaker': {
                id: 'device_bedroom_speaker',
                area_id: 'bedroom',
                name: 'Bedroom Speaker',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Speaker',
            },
            'device_bedroom_blinds': {
                id: 'device_bedroom_blinds',
                area_id: 'bedroom',
                name: 'Bedroom Blinds',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Blinds',
            },
            'device_bedroom_fan': {
                id: 'device_bedroom_fan',
                area_id: 'bedroom',
                name: 'Bedroom Fan',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Fan',
            },
            'device_bathroom_lights': {
                id: 'device_bathroom_lights',
                area_id: 'bathroom',
                name: 'Bathroom Lights',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Light',
            },
            'device_bathroom_blinds': {
                id: 'device_bathroom_blinds',
                area_id: 'bathroom',
                name: 'Bathroom Blinds',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Blinds',
            },
            'device_bathroom_fan': {
                id: 'device_bathroom_fan',
                area_id: 'bathroom',
                name: 'Bathroom Fan',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Fan',
            },
            'device_kitchen_lights': {
                id: 'device_kitchen_lights',
                area_id: 'kitchen',
                name: 'Kitchen Lights',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Light',
            },
            'device_kitchen_blinds': {
                id: 'device_kitchen_blinds',
                area_id: 'kitchen',
                name: 'Kitchen Blinds',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Blinds',
            },
            'device_kitchen_fan': {
                id: 'device_kitchen_fan',
                area_id: 'kitchen',
                name: 'Kitchen Fan',
                manufacturer: 'Mock Manufacturer',
                model: 'Mock Fan',
            },
            'device_work_pc': {
                id: 'device_work_pc',
                area_id: 'office',
                name: 'Work Computer',
                manufacturer: 'Microsoft',
                model: 'Windows PC',
            }
        };

        // Create entity registry entries
        this.mockEntityRegistry = {
            'climate.house_thermostat': {
                entity_id: 'climate.house_thermostat',
                area_id: 'living_room',
                device_id: 'device_house_thermostat',
                platform: 'mock',
                name: 'House Thermostat',
                icon: 'mdi:thermostat',
                disabled_by: null,
                hidden_by: null
            },
            'climate.bedroom_ac': {
                entity_id: 'climate.bedroom_ac',
                area_id: 'bedroom',
                device_id: 'device_bedroom_ac',
                platform: 'mock',
                name: 'Bedroom AC',
                icon: 'mdi:air-conditioner',
                disabled_by: null,
                hidden_by: null
            },
            'climate.living_room_ac': {
                entity_id: 'climate.living_room_ac',
                area_id: 'living_room',
                device_id: 'device_living_room_ac',
                platform: 'mock',
                name: 'Living Room AC',
                icon: 'mdi:air-conditioner',
                disabled_by: null,
                hidden_by: null
            },
            'light.living_room': {
                entity_id: 'light.living_room',
                area_id: 'living_room',
                device_id: 'device_living_room_lights',
                platform: 'mock',
                name: 'Living Room Light',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'media_player.living_room_tv': {
                entity_id: 'media_player.living_room_tv',
                area_id: 'living_room',
                device_id: 'device_living_room_tv',
                platform: 'mock',
                name: 'Living Room TV',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'cover.living_room_blinds': {
                entity_id: 'cover.living_room_blinds',
                area_id: 'living_room',
                device_id: 'device_living_room_blinds',
                platform: 'mock',
                name: 'Living Room Blinds',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'fan.living_room': {
                entity_id: 'fan.living_room',
                area_id: 'living_room',
                device_id: 'device_living_room_fan',
                platform: 'mock',
                name: 'Living Room Fan',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'light.bedroom': {
                entity_id: 'light.bedroom',
                area_id: 'bedroom',
                device_id: 'device_bedroom_lights',
                platform: 'mock',
                name: 'Bedroom Light',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'media_player.bedroom_speaker': {
                entity_id: 'media_player.bedroom_speaker',
                area_id: 'bedroom',
                device_id: 'device_bedroom_speaker',
                platform: 'mock',
                name: 'Bedroom Speaker',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'cover.bedroom_blinds': {
                entity_id: 'cover.bedroom_blinds',
                area_id: 'bedroom',
                device_id: 'device_bedroom_blinds',
                platform: 'mock',
                name: 'Bedroom Blinds',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'fan.bedroom': {
                entity_id: 'fan.bedroom',
                area_id: 'bedroom',
                device_id: 'device_bedroom_fan',
                platform: 'mock',
                name: 'Bedroom Fan',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'light.bathroom': {
                entity_id: 'light.bathroom',
                area_id: 'bathroom',
                device_id: 'device_bathroom_lights',
                platform: 'mock',
                name: 'Bathroom Light',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'cover.bathroom_blinds': {
                entity_id: 'cover.bathroom_blinds',
                area_id: 'bathroom',
                device_id: 'device_bathroom_blinds',
                platform: 'mock',
                name: 'Bathroom Blinds',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'fan.bathroom_vent': {
                entity_id: 'fan.bathroom_vent',
                area_id: 'bathroom',
                device_id: 'device_bathroom_fan',
                platform: 'mock',
                name: 'Bathroom Vent Fan',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'light.kitchen': {
                entity_id: 'light.kitchen',
                area_id: 'kitchen',
                device_id: 'device_kitchen_lights',
                platform: 'mock',
                name: 'Kitchen Light',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'cover.kitchen_blinds': {
                entity_id: 'cover.kitchen_blinds',
                area_id: 'kitchen',
                device_id: 'device_kitchen_blinds',
                platform: 'mock',
                name: 'Kitchen Blinds',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'fan.kitchen_hood': {
                entity_id: 'fan.kitchen_hood',
                area_id: 'kitchen',
                device_id: 'device_kitchen_fan',
                platform: 'mock',
                name: 'Kitchen Hood Fan',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'conversation.home_assistant': {
                entity_id: 'conversation.home_assistant',
                area_id: null,
                device_id: null,
                platform: 'mock',
                name: 'Home Assistant',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'conversation.chatgpt': {
                entity_id: 'conversation.chatgpt',
                area_id: null,
                device_id: null,
                platform: 'mock',
                name: 'ChatGPT',
                icon: null,
                disabled_by: null,
                hidden_by: null
            },
            'binary_sensor.work_pc_active': {
                entity_id: 'binary_sensor.work_pc_active',
                area_id: 'office',
                device_id: 'device_work_pc',
                platform: 'mock',
                name: 'Work PC Active Long name goes on and on and on',
                icon: 'mdi:desktop-tower-monitor',
                disabled_by: null,
                hidden_by: null,
                labels: ['work_pc']
            },
            'binary_sensor.work_pc_active2': {
                entity_id: 'binary_sensor.work_pc_active2',
                area_id: 'office',
                device_id: 'device_work_pc',
                platform: 'mock',
                name: 'Work PC Active Long name goes on and on and on',
                icon: 'mdi:desktop-tower-monitor',
                disabled_by: null,
                hidden_by: null,
                labels: ['work_pc']
            },
            'sensor.teams_status': {
                entity_id: 'sensor.teams_status',
                area_id: 'office',
                device_id: 'device_work_pc',
                platform: 'mock',
                name: 'Teams Status',
                icon: 'mdi:microsoft-teams',
                disabled_by: null,
                hidden_by: null,
                labels: ['work_pc', 'communication']
            },
            'media_player.work_pc_spotify': {
                entity_id: 'media_player.work_pc_spotify',
                area_id: 'office',
                device_id: 'device_work_pc',
                platform: 'mock',
                name: 'Work PC Spotify',
                icon: 'mdi:spotify',
                disabled_by: null,
                hidden_by: null,
                labels: ['work_pc', 'entertainment']
            }
        };

        // Create actual entities
        this.mockEntities = {
            // CLIMATE ENTITIES
            'climate.house_thermostat': {
                entity_id: 'climate.house_thermostat',
                state: 'heat',
                attributes: {
                    friendly_name: 'House Thermostat',
                    hvac_modes: ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'],
                    min_temp: 50,
                    max_temp: 90,
                    current_temperature: 72,
                    temperature: 68,
                    target_temp_low: 68,
                    target_temp_high: 74,
                    target_temperature_step: 1,
                    fan_modes: ['auto', 'low', 'medium', 'high'],
                    fan_mode: 'auto',
                    preset_modes: ['eco', 'away', 'boost', 'comfort', 'home', 'sleep'],
                    preset_mode: 'home',
                    supported_features: 59, // TARGET_TEMPERATURE | TARGET_TEMPERATURE_RANGE | FAN_MODE | PRESET_MODE | TURN_ON | TURN_OFF
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'climate.bedroom_ac': {
                entity_id: 'climate.bedroom_ac',
                state: 'cool',
                attributes: {
                    friendly_name: 'Bedroom AC',
                    hvac_modes: ['off', 'cool', 'fan_only'],
                    min_temp: 60,
                    max_temp: 85,
                    current_temperature: 76,
                    temperature: 70,
                    target_temperature_step: 1,
                    fan_modes: ['auto', 'low', 'medium', 'high'],
                    fan_mode: 'medium',
                    swing_modes: ['off', 'horizontal', 'vertical'],
                    swing_mode: 'horizontal',
                    supported_features: 41, // TARGET_TEMPERATURE | FAN_MODE | SWING_MODE | TURN_ON | TURN_OFF
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'climate.living_room_ac': {
                entity_id: 'climate.living_room_ac',
                state: 'off',
                attributes: {
                    friendly_name: 'Living Room AC',
                    hvac_modes: ['off', 'cool', 'heat', 'dry', 'fan_only'],
                    min_temp: 60,
                    max_temp: 86,
                    current_temperature: 74,
                    temperature: 72,
                    target_temperature_step: 1,
                    fan_modes: ['auto', 'quiet', 'low', 'medium', 'high', 'turbo'],
                    fan_mode: 'auto',
                    swing_modes: ['off', 'horizontal', 'vertical', 'both'],
                    swing_mode: 'off',
                    preset_modes: ['none', 'eco', 'boost', 'sleep'],
                    preset_mode: 'none',
                    supported_features: 57, // TARGET_TEMPERATURE | FAN_MODE | PRESET_MODE | SWING_MODE | TURN_ON | TURN_OFF
                    previous_hvac_mode: 'cool'
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            // LIVING ROOM
            'light.living_room': {
                entity_id: 'light.living_room',
                state: 'on',
                attributes: {
                    friendly_name: 'Living Room Light',
                    brightness: 180,
                    color_temp: 300,
                    rgb_color: [255, 200, 150],
                    supported_features: 63
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'media_player.living_room_tv': {
                entity_id: 'media_player.living_room_tv',
                state: 'playing',
                attributes: {
                    friendly_name: 'Living Room TV',
                    media_title: 'Sample Media',
                    media_artist: 'Sample Artist',
                    volume_level: 0.6,
                    is_volume_muted: false,
                    media_duration: 300,
                    media_position: 125,
                    media_position_updated_at: currentTime,
                    supported_features: 152463
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'cover.living_room_blinds': {
                entity_id: 'cover.living_room_blinds',
                state: 'open',
                attributes: {
                    friendly_name: 'Living Room Blinds',
                    current_position: 80,
                    supported_features: 15
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'fan.living_room': {
                entity_id: 'fan.living_room',
                state: 'on',
                attributes: {
                    friendly_name: 'Living Room Fan',
                    speed: 'medium',
                    percentage: 50,
                    supported_features: 7
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },

            // BEDROOM
            'light.bedroom': {
                entity_id: 'light.bedroom',
                state: 'on',
                attributes: {
                    friendly_name: 'Bedroom Light',
                    brightness: 100,
                    color_temp: 350,
                    rgb_color: [220, 180, 140],
                    supported_features: 63
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'media_player.bedroom_speaker': {
                entity_id: 'media_player.bedroom_speaker',
                state: 'idle',
                attributes: {
                    friendly_name: 'Bedroom Speaker',
                    volume_level: 0.4,
                    is_volume_muted: false,
                    supported_features: 152463
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'cover.bedroom_blinds': {
                entity_id: 'cover.bedroom_blinds',
                state: 'closed',
                attributes: {
                    friendly_name: 'Bedroom Blinds',
                    current_position: 0,
                    supported_features: 15
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'fan.bedroom': {
                entity_id: 'fan.bedroom',
                state: 'off',
                attributes: {
                    friendly_name: 'Bedroom Fan',
                    speed: 'off',
                    percentage: 0,
                    supported_features: 7
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },

            // BATHROOM
            'light.bathroom': {
                entity_id: 'light.bathroom',
                state: 'off',
                attributes: {
                    friendly_name: 'Bathroom Light',
                    brightness: 0,
                    supported_features: 1
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'cover.bathroom_blinds': {
                entity_id: 'cover.bathroom_blinds',
                state: 'closed',
                attributes: {
                    friendly_name: 'Bathroom Blinds',
                    current_position: 0,
                    supported_features: 15
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'fan.bathroom_vent': {
                entity_id: 'fan.bathroom_vent',
                state: 'off',
                attributes: {
                    friendly_name: 'Bathroom Vent Fan',
                    speed: 'off',
                    percentage: 0,
                    supported_features: 1
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },

            // KITCHEN
            'light.kitchen': {
                entity_id: 'light.kitchen',
                state: 'on',
                attributes: {
                    friendly_name: 'Kitchen Light',
                    brightness: 200,
                    supported_features: 1
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'cover.kitchen_blinds': {
                entity_id: 'cover.kitchen_blinds',
                state: 'open',
                attributes: {
                    friendly_name: 'Kitchen Blinds',
                    current_position: 100,
                    supported_features: 15
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'fan.kitchen_hood': {
                entity_id: 'fan.kitchen_hood',
                state: 'off',
                attributes: {
                    friendly_name: 'Kitchen Hood Fan',
                    speed: 'off',
                    percentage: 0,
                    supported_features: 7
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },

            // CONVERSATION ENTITIES
            'conversation.home_assistant': {
                entity_id: 'conversation.home_assistant',
                state: 'unknown',
                attributes: {
                    friendly_name: 'Home Assistant',
                    supported_features: 0
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'conversation.chatgpt': {
                entity_id: 'conversation.chatgpt',
                state: 'unknown',
                attributes: {
                    friendly_name: 'ChatGPT',
                    supported_features: 0
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'binary_sensor.work_pc_active': {
                entity_id: 'binary_sensor.work_pc_active',
                state: 'on',
                attributes: {
                    friendly_name: 'Work PC Active Long name goes on and on and on',
                    device_class: 'power',
                    labels: ['work_pc']
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'binary_sensor.work_pc_active2': {
                entity_id: 'binary_sensor.work_pc_active2',
                state: 'on',
                attributes: {
                    friendly_name: 'Work PC Active Long name goes on and on and on',
                    device_class: 'power',
                    labels: ['work_pc']
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'sensor.teams_status': {
                entity_id: 'sensor.teams_status',
                state: 'Busy',
                attributes: {
                    friendly_name: 'Teams Status',
                    icon: 'mdi:microsoft-teams',
                    status_color: 'red',
                    labels: ['work_pc', 'communication'],
                    options: [
                        'Available',
                        'Busy',
                        'Do not disturb',
                        'Be right back',
                        'Away',
                        'Offline'
                    ]
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            },
            'media_player.work_pc_spotify': {
                entity_id: 'media_player.work_pc_spotify',
                state: 'playing',
                attributes: {
                    friendly_name: 'Work PC Spotify',
                    media_title: 'Focus Music',
                    media_artist: 'Various Artists',
                    volume_level: 0.3,
                    is_volume_muted: false,
                    source: 'Spotify',
                    labels: ['work_pc', 'entertainment'],
                    supported_features: 4096
                },
                last_changed: currentTime,
                last_updated: currentTime,
                context: {
                    id: this._generateRandomId(),
                    parent_id: null,
                    user_id: null
                }
            }
        };

        // Add mock pipelines
        this.mockPipelines = {
            pipelines: [
                {
                    id: "default_pipeline",
                    name: "Home Assistant",
                    conversation_engine: "conversation.home_assistant",
                    language: "en",
                    conversation_language: "en",
                    stt_engine: "stt.whisper",
                    stt_language: "en",
                    tts_engine: "tts.cloud",
                    tts_language: "en-US",
                    tts_voice: "en-US-Neural2-F"
                }
            ],
            preferred_pipeline: "default_pipeline"
        };
    }

    _handleGetLabels(msg, callback) {
        const response = {
            id: msg.id,
            type: 'result',
            success: true,
            result: [
                {
                    color: "brown",
                    created_at: 1743985196.985991,
                    description: "Grouping of entities related to my work computer",
                    icon: "mdi:briefcase",
                    label_id: "work_pc",
                    name: "Work PC",
                    modified_at: 1743985196.985999
                },
                {
                    color: "blue",
                    created_at: 1743985196.986000,
                    description: "Entertainment devices and media players",
                    icon: "mdi:television",
                    label_id: "entertainment",
                    name: "Entertainment",
                    modified_at: 1743985196.986000
                },
                {
                    color: "purple",
                    created_at: 1743985196.986001,
                    description: "Communication and messaging services",
                    icon: "mdi:message",
                    label_id: "communication",
                    name: "Communication",
                    modified_at: 1743985196.986001
                }
            ]
        };

        if(callback) {
            callback(response);
        }

        return response;
    }

    getPipelines(successCallback, errorCallback) {
        if (successCallback) {
            successCallback({
                success: true,
                result: this.mockPipelines
            });
        }
    }

    runPipeline(data, successCallback, errorCallback) {
        const cmdId = this._genCmdId();

        // Store the subscription callback before sending
        this._subscriptions.push(cmdId);

        // Create a handler for the subscription responses
        const handler = (response) => {
            if (response.type === 'result') {
                if (!response.success) {
                    if (errorCallback) {
                        errorCallback(response.error || 'Failed to start pipeline');
                    }
                    this.unsubscribe(cmdId);
                    return;
                }
                return; // Just acknowledge receipt
            }

            // Handle event responses
            if (response.type === 'event') {
                const event = response.event;

                // Check for run-end event to clean up subscription
                if (event.type === 'run-end') {
                    this.unsubscribe(cmdId);
                    return;
                }

                // Check for intent-end event to get the response
                if (event.type === 'intent-end' && event.data && event.data.intent_output) {
                    if (successCallback) {
                        successCallback({
                            success: true,
                            response: event.data.intent_output.response,
                            conversation_id: event.data.intent_output.conversation_id || `mock-conversation-${this._generateRandomId()}`
                        });
                    }
                }
            }
        };

        // Store the command and handler
        this._commands.set(cmdId, [handler, errorCallback]);

        // Simulate the sequence of events
        setTimeout(() => {
            // Initial result response
            handler({
                type: 'result',
                success: true
            });

            // Run start event
            setTimeout(() => {
                handler({
                    type: 'event',
                    event: {
                        type: 'run-start',
                        data: {
                            pipeline: 'mock-pipeline',
                            language: 'en'
                        }
                    }
                });

                // Intent end event with actual response
                setTimeout(() => {
                    handler({
                        type: 'event',
                        event: {
                            type: 'intent-end',
                            data: {
                                intent_output: {
                                    response: {
                                        speech: {
                                            plain: {
                                                speech: "This is a mock response to: " + data.text
                                            }
                                        },
                                        language: "en",
                                        response_type: "action_done",
                                        data: {}
                                    },
                                    conversation_id: `mock-conversation-${this._generateRandomId()}`
                                }
                            }
                        }
                    });

                    // Run end event
                    setTimeout(() => {
                        handler({
                            type: 'event',
                            event: {
                                type: 'run-end',
                                data: {
                                    pipeline: 'mock-pipeline'
                                }
                            }
                        });
                    }, 100);
                }, 500);
            }, 100);
        }, 100);

        return cmdId;
    }
}

module.exports = HAWS;