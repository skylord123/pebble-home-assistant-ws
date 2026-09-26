/**
 * EntityService - Handles entity display utilities and operations
 */
var Settings = require('settings');
var Vibe = require('ui/vibe');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

/**
 * Whether a button has ever been pressed. Its state is an ISO timestamp of
 * the last press, and unknown until there has been one.
 * @param {Object} entity
 * @returns {boolean}
 */
function wasPressed(entity) {
    if (!entity || typeof entity.state !== 'string') return false;
    if (entity.state === 'unknown' || entity.state === 'unavailable') return false;
    return !isNaN(new Date(entity.state).getTime());
}

function pressedText(entity) {
    if (entity.state === 'unavailable') return entity.state;
    return wasPressed(entity) ? 'Pressed' : 'Never pressed';
}

// Compressed states send a context that is only an id as a bare string, and
// a diff sends only the context fields that changed
function mergeContext(cur, c) {
    var merged = {};
    if (typeof cur === 'string') {
        merged = { id: cur, parent_id: null, user_id: null };
    } else if (cur) {
        for (var k in cur) { merged[k] = cur[k]; }
    }
    if (typeof c === 'string') {
        merged.id = c;
        if (!cur) { merged.parent_id = null; merged.user_id = null; }
    } else if (c) {
        for (var k2 in c) { merged[k2] = c[k2]; }
    }
    return merged;
}

var EntityService = {
    /**
     * Get the display title for an entity
     * @param {Object} entity - The entity object
     * @returns {string} The friendly name or entity_id
     */
    getTitle: function(entity) {
        if (!entity) return 'Unknown';
        return entity.attributes && entity.attributes.friendly_name
            ? entity.attributes.friendly_name
            : entity.entity_id;
    },

    /**
     * Get the state portion of an entity's subtitle (state + unit, or for
     * climate entities the mode plus set/current temperatures)
     * @param {Object} entity - The entity object
     * @returns {string} The formatted state text
     */
    getStateText: function(entity) {
        if (!entity) return '';

        var text = entity.state;
        var attrs = entity.attributes || {};
        var domain = entity.entity_id ? entity.entity_id.split('.')[0] : '';

        if (domain === 'climate') {
            // Mode plus set/current, e.g. "heat 70°/68°" (heat_cool ranges
            // show as "68-74°/71°")
            var target = null;
            if (attrs.temperature !== undefined && attrs.temperature !== null) {
                target = attrs.temperature + '°';
            } else if (attrs.target_temp_low !== undefined && attrs.target_temp_low !== null &&
                       attrs.target_temp_high !== undefined && attrs.target_temp_high !== null) {
                target = attrs.target_temp_low + '-' + attrs.target_temp_high + '°';
            }
            var current = (attrs.current_temperature !== undefined && attrs.current_temperature !== null)
                ? attrs.current_temperature + '°'
                : null;

            if (target && current) {
                text += ' ' + target + '/' + current;
            } else if (target || current) {
                text += ' ' + (target || current);
            }
        } else if (domain === 'timer') {
            // Countdown rather than the bare state, e.g. "Running 4:32"
            text = require('app/pages/entity/TimerPage').statusText(entity);
        } else if (domain === 'humidifier') {
            // What it is doing plus the readings, e.g. "humidifying 41%, set 55%"
            text = require('app/pages/entity/HumidifierPage').statusText(entity);
        } else if (domain === 'text' || domain === 'input_text') {
            // Password entities must not spell out their value in a list
            text = require('app/pages/entity/TextPage').displayValue(entity);
        } else if (domain === 'button' || domain === 'input_button') {
            // A button's state is when it was last pressed, not a condition,
            // so the raw timestamp is noise. The relative time that follows
            // is the same instant and keeps counting on its own.
            text = pressedText(entity);
        } else if (domain === 'update') {
            // Which version is waiting, rather than a bare on or off
            text = require('app/pages/entity/UpdatePage').statusText(entity);
        } else if (domain === 'remote') {
            // Whatever activity it is running, where the remote has them
            text = require('app/pages/entity/RemotePage').statusText(entity);
        } else if (domain === 'lawn_mower') {
            // What it is doing, plus a battery level for the custom
            // integrations that report one
            text = require('app/pages/entity/LawnMowerPage').statusText(entity);
        } else if (domain === 'water_heater') {
            // The state is the operation mode, so pair it with the readings
            text = require('app/pages/entity/WaterHeaterPage').statusText(entity);
        } else if (domain === 'valve') {
            // How far open it is, where the valve reports it
            text = require('app/pages/entity/ValvePage').statusText(entity);
        } else if (domain === 'input_datetime' || domain === 'datetime' ||
                   domain === 'date' || domain === 'time') {
            // Readable local value rather than a raw ISO string
            text = require('app/pages/entity/DateTimePage').displayValue(entity);
        } else if (attrs.unit_of_measurement) {
            text += ' ' + attrs.unit_of_measurement;
        }

        return text;
    },

    /**
     * Get the display subtitle for an entity (state text + relative time)
     * @param {Object} entity - The entity object
     * @param {boolean} [includeRelativeTime=true] - Whether to include relative time
     * @returns {string} The formatted subtitle
     */
    getSubtitle: function(entity, includeRelativeTime) {
        if (!entity) return '';
        if (includeRelativeTime === undefined) includeRelativeTime = true;

        var subtitle = this.getStateText(entity);

        // Add relative time if requested and last_changed is available
        if (includeRelativeTime && entity.last_changed && !this.hidesRelativeTime(entity)) {
            subtitle += ' > ' + helpers.humanDiff(new Date(), new Date(entity.last_changed));
        }

        return subtitle;
    },

    /**
     * Whether the relative time would say something untrue. A button that
     * has never been pressed still has a last_changed, but it marks when
     * Home Assistant started rather than anything the user did.
     * @param {Object} entity
     * @returns {boolean}
     */
    hidesRelativeTime: function(entity) {
        if (!entity || !entity.entity_id) return false;
        var domain = entity.entity_id.split('.')[0];
        if (domain !== 'button' && domain !== 'input_button') return false;
        // Only the never pressed case: an unavailable button's last_changed
        // is the moment it went unavailable, which is worth showing
        return entity.state !== 'unavailable' && !wasPressed(entity);
    },

    /**
     * Get icon path for an entity based on domain and state
     * @param {Object} entity - The entity object
     * @returns {string} Path to the icon image
     */
    getIcon: function(entity) {
        if (!entity) return 'images/icon_unknown.png';

        var appState = AppState.getInstance();
        var domain = entity.entity_id.split('.')[0];
        var state = entity.state;

        // Handle different domains
        switch (domain) {
            case 'light':
                return state === 'on' ? 'images/icon_bulb_on.png' : 'images/icon_bulb.png';

            case 'switch':
            case 'input_boolean':
            case 'fan':
            case 'humidifier':
            case 'siren':
            case 'remote':
                return state === 'on' ? 'images/icon_switch_on.png' : 'images/icon_switch_off.png';

            case 'cover':
                return state === 'open' ? 'images/icon_blinds_open.png' : 'images/icon_blinds_closed.png';

            case 'valve':
                // No valve artwork exists, and open or shut is the thing that
                // matters, so the door icons carry it
                return state === 'closed' ? 'images/icon_door_closed.png' : 'images/icon_door_open.png';

            case 'lock':
                return state === 'locked' ? 'images/icon_locked.png' : 'images/icon_unlocked.png';

            case 'alarm_control_panel':
                if (state === 'unavailable' || state === 'unknown') {
                    return 'images/icon_unknown.png';
                }
                return (state === 'disarmed' || state === 'disarming')
                    ? 'images/icon_unlocked.png'
                    : 'images/icon_locked.png';

            case 'sensor':
                // Check for temperature sensors
                if (entity.attributes.device_class === 'temperature') {
                    return 'images/icon_temp.png';
                }
                return 'images/icon_sensor.png';

            case 'binary_sensor':
                // Check for door/window sensors
                if (
                    entity.attributes.device_class === 'opening' ||
                    entity.attributes.device_class === 'door' ||
                    entity.attributes.device_class === 'garage_door'
                ) {
                    return state === 'on' ? 'images/icon_door_open.png' : 'images/icon_door_closed.png';
                } else if (entity.attributes.device_class === 'window') {
                    return state === 'on' ? 'images/icon_blinds_open.png' : 'images/icon_blinds_closed.png';
                } else if (entity.attributes.device_class === 'light') {
                    return state === 'on' ? 'images/icon_bulb_on.png' : 'images/icon_bulb.png';
                }
                return 'images/icon_sensor.png';

            case 'automation':
                return state === 'on' ? 'images/icon_auto_on.png' : 'images/icon_auto_off.png';

            case 'media_player':
                return 'images/icon_media.png';

            case 'script':
                return 'images/icon_script.png';

            case 'scene':
                return 'images/icon_scene.png';

            case 'timer':
                return 'images/icon_timer.png';

            case 'button':
            case 'input_button':
                // Buttons carry a device class of restart, identify or update
                return entity.attributes.device_class === 'restart'
                    ? 'images/icon_refresh.png'
                    : 'images/icon_power.png';

            case 'water_heater':
                return 'images/icon_temp.png';

            case 'update':
                // Something waiting to install, or a tick for up to date
                return state === 'on' ? 'images/icon_refresh.png' : 'images/icon_yes.png';

            case 'counter':
                return 'images/icon_sensor.png';

            case 'date':
            case 'datetime':
                return 'images/icon_calendar.png';

            case 'time':
                return 'images/icon_clock.png';

            case 'input_datetime':
                // A date helper gets the calendar, a time only one the clock
                return entity.attributes.has_date === false
                    ? 'images/icon_clock.png'
                    : 'images/icon_calendar.png';

            case 'vacuum':
            case 'lawn_mower':
                // No mower artwork, and the robot that drives itself around
                // is the same idea
                return 'images/icon_vacuum.png';

            default:
                return 'images/icon_unknown.png';
        }
    },

    /**
     * Convert a subscribe_entities event for one entity into a standard
     * entity object and store it in AppState. The initial snapshot (event.a)
     * carries full state; diffs (event.c) carry only changed attributes in
     * "+", so those are merged over the current attributes (a wholesale
     * replace would drop everything that didn't change).
     * @param {string} entity_id - The entity the subscription is for
     * @param {Object} data - The raw subscription callback payload
     * @param {Object} [base] - The caller's last known copy of the entity,
     *                          used when the state dict doesn't have it
     * @returns {Object|null} The updated entity, or null if the event
     *                        didn't concern this entity
     */
    applyCompressedEvent: function(entity_id, data, base) {
        var appState = AppState.getInstance();
        var ev = data.event || {};
        var updated = null;

        if (ev.a && ev.a[entity_id]) {
            var d = ev.a[entity_id];
            updated = {
                entity_id: entity_id,
                state: d.s,
                attributes: d.a || {},
                context: mergeContext(null, d.c),
                last_changed: d.lc ? new Date(d.lc * 1000).toISOString() : new Date().toISOString()
            };
            // lu is only sent when it differs from lc
            updated.last_updated = d.lu ? new Date(d.lu * 1000).toISOString() : updated.last_changed;
        } else if (ev.c && ev.c[entity_id]) {
            var plus = ev.c[entity_id]['+'] || {};
            var cur = appState.getEntity(entity_id) || base || { entity_id: entity_id, state: '', attributes: {} };
            var attributes = cur.attributes || {};
            var minus = ev.c[entity_id]['-'];
            var removesAttrs = minus && Array.isArray(minus.a);
            // Copy before touching so the previous object (which other
            // holders may share) is left as it was
            if (plus.a !== undefined || removesAttrs) {
                attributes = {};
                for (var k in cur.attributes) { attributes[k] = cur.attributes[k]; }
                for (var k2 in plus.a) { attributes[k2] = plus.a[k2]; }
            }
            if (removesAttrs) {
                minus.a.forEach(function(removedKey) { delete attributes[removedKey]; });
            }
            updated = {
                entity_id: entity_id,
                state: plus.s !== undefined ? plus.s : cur.state,
                attributes: attributes,
                context: plus.c !== undefined ? mergeContext(cur.context, plus.c) : cur.context,
                last_changed: plus.lc !== undefined ? new Date(plus.lc * 1000).toISOString() : cur.last_changed
            };
            // A diff carries lc when it changed (lu then equals it), else lu
            updated.last_updated = plus.lc !== undefined ? updated.last_changed
                : plus.lu !== undefined ? new Date(plus.lu * 1000).toISOString()
                : cur.last_updated;
        }

        if (updated) {
            appState.setEntity(entity_id, updated);
        }
        return updated;
    },

    /**
     * Follow one entity with subscribe_entities (subscribe_trigger needs an
     * admin token). The first event is a snapshot of the current state, so
     * onUpdate runs once straight away and then on every change.
     * @param {string} entity_id
     * @param {Function} onUpdate - Called with the merged entity, and true
     *                              when it is the initial snapshot
     * @returns {number|false} The subscription id, for haws.unsubscribe
     */
    subscribeEntity: function(entity_id, onUpdate) {
        var self = this;
        return AppState.getInstance().haws.subscribeEntities([entity_id], function(data) {
            var updated = self.applyCompressedEvent(entity_id, data);
            if (updated) {
                onUpdate(updated, !!(data.event && data.event.a));
            }
        }, function(error) {
            helpers.log_message('ENTITY UPDATE ERROR [' + entity_id + ']: ' + JSON.stringify(error));
        });
    },

    /**
     * Get a complete menu item object for an entity
     * @param {Object} entity - The entity object
     * @param {Object} [options] - Optional configuration
     * @param {boolean} [options.includeRelativeTime=true] - Include relative time in subtitle
     * @param {boolean} [options.includeIcon=true] - Include icon
     * @param {Function} [options.on_click] - Custom click handler
     * @returns {Object} Menu item object
     */
    getMenuItem: function(entity, options) {
        var self = this;
        options = options || {};

        if (!entity) return null;

        var includeRelativeTime = options.includeRelativeTime !== false;
        var includeIcon = options.includeIcon !== false;

        var menuItem = {
            title: this.getTitle(entity),
            subtitle: this.getSubtitle(entity, includeRelativeTime),
            entity_id: entity.entity_id
        };

        if (includeIcon) {
            menuItem.icon = this.getIcon(entity);
        }

        if (options.on_click) {
            menuItem.on_click = options.on_click;
        } else {
            // Default click handler
            menuItem.on_click = function(e) {
                self.show(entity.entity_id);
            };
        }

        return menuItem;
    },

    /**
     * Update an entity's display in a menu
     * @param {Object} menu - The UI.Menu object
     * @param {number} sectionIndex - The section index
     * @param {number} itemIndex - The item index
     * @param {Object} entity - The entity object
     * @param {Object} [options] - Optional configuration
     */
    updateMenuItem: function(menu, sectionIndex, itemIndex, entity, options) {
        if (!menu || !entity) return;

        var menuItem = this.getMenuItem(entity, options);
        if (menuItem) {
            menu.item(sectionIndex, itemIndex, menuItem);
        }
    },

    /**
     * Show the appropriate entity menu based on the entity's domain
     * @param {string} entity_id - The entity ID to show
     */
    show: function(entity_id) {
        if (!entity_id) {
            helpers.log_message('showEntity: No entity_id provided');
            return;
        }

        // Every page reads the entity on open, and throws without it: before
        // get_states lands, or once the entity is gone from HA
        if (!AppState.getInstance().getEntity(entity_id)) {
            helpers.log_message('showEntity: ' + entity_id + ' is not in the state dict');
            Vibe.vibrate('double');
            return;
        }

        var domain = entity_id.split('.')[0];

        // Lazy-load page modules to avoid circular dependency
        // (page modules import EntityService, so top-level require would cause a cycle)
        switch (domain) {
            case 'media_player':
                require('app/pages/entity/MediaPlayerPage').showMediaPlayerEntity(entity_id);
                break;
            case 'light':
                require('app/pages/entity/LightPage').showLightEntity(entity_id);
                break;
            case 'climate':
                require('app/pages/entity/ClimatePage').showClimateEntity(entity_id);
                break;
            case 'fan':
                require('app/pages/entity/FanPage').showFanEntity(entity_id);
                break;
            case 'cover':
                require('app/pages/entity/CoverPage').showCoverEntity(entity_id);
                break;
            case 'alarm_control_panel':
                require('app/pages/entity/AlarmPanelPage').showAlarmEntity(entity_id);
                break;
            case 'lock':
                require('app/pages/entity/LockPage').showLockEntity(entity_id);
                break;
            case 'select':
            case 'input_select':
                require('app/pages/entity/SelectPage').showSelectEntity(entity_id);
                break;
            case 'number':
            case 'input_number':
                require('app/pages/entity/NumberPage').showNumberEntity(entity_id);
                break;
            case 'timer':
                require('app/pages/entity/TimerPage').showTimerEntity(entity_id);
                break;
            case 'humidifier':
                require('app/pages/entity/HumidifierPage').showHumidifierEntity(entity_id);
                break;
            case 'siren':
                require('app/pages/entity/SirenPage').showSirenEntity(entity_id);
                break;
            case 'text':
            case 'input_text':
                require('app/pages/entity/TextPage').showTextEntity(entity_id);
                break;
            case 'input_datetime':
            case 'datetime':
            case 'date':
            case 'time':
                require('app/pages/entity/DateTimePage').showDateTimeEntity(entity_id);
                break;
            case 'valve':
                require('app/pages/entity/ValvePage').showValveEntity(entity_id);
                break;
            case 'water_heater':
                require('app/pages/entity/WaterHeaterPage').showWaterHeaterEntity(entity_id);
                break;
            case 'counter':
                require('app/pages/entity/CounterPage').showCounterEntity(entity_id);
                break;
            case 'lawn_mower':
                require('app/pages/entity/LawnMowerPage').showLawnMowerEntity(entity_id);
                break;
            case 'remote':
                require('app/pages/entity/RemotePage').showRemoteEntity(entity_id);
                break;
            case 'update':
                require('app/pages/entity/UpdatePage').showUpdateEntity(entity_id);
                break;
            default:
                require('app/pages/entity/GenericEntityPage').showEntityMenu(entity_id);
                break;
        }
    },

    /**
     * Handle long-press action on an entity
     * @param {string} entity_id - The entity ID that was long-pressed
     */
    handleLongPress: function(entity_id) {
        if (!entity_id) {
            helpers.log_message('handleEntityLongPress: No entity_id provided');
            return;
        }

        var appState = AppState.getInstance();
        var log = helpers.log_message;

        log('handleEntityLongPress: ' + entity_id);
        var domain = entity_id.split('.')[0];

        if (domain === "automation") {
            var service = appState.automation_longpress_action === 'trigger' ? 'trigger' : 'toggle';
            log('Automation long-press: calling ' + service + ' for ' + entity_id);
            appState.haws.callService(
                domain,
                service,
                {},
                { entity_id: entity_id },
                function(data) {
                    log(JSON.stringify(data));
                    Vibe.vibrate('short');
                },
                function(error) {
                    log('no response');
                    Vibe.vibrate('double');
                }
            );
        } else if (
            domain === "switch" ||
            domain === "light" ||
            domain === "fan" ||
            domain === "input_boolean" ||
            domain === "script" ||
            domain === "cover" ||
            domain === "humidifier"
        ) {
            appState.haws.callService(
                domain,
                'toggle',
                {},
                { entity_id: entity_id },
                function(data) {
                    log(JSON.stringify(data));
                    Vibe.vibrate('short');
                },
                function(error) {
                    log('no response');
                    Vibe.vibrate('double');
                }
            );
        } else if (domain === "lock") {
            // Locks at once, but asks before unlocking, and handles any code
            require('app/pages/entity/LockPage').quickAction(entity_id);
        } else if (domain === "scene") {
            appState.haws.callService(
                domain,
                "turn_on",
                {},
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    log(JSON.stringify(data));
                },
                function(error) {
                    Vibe.vibrate('double');
                    log('no response');
                }
            );
        } else if (domain === "vacuum") {
            var entity = appState.ha_state_dict[entity_id];
            if (!entity) {
                log('handleEntityLongPress: entity ' + entity_id + ' not found in state dict');
                return;
            }
            var state = entity.state;
            var vacuumFeatures = entity.attributes.supported_features || 0;
            var service = null;

            // Determine which service to call based on state, using only
            // the services this vacuum supports (PAUSE 4, STOP 8,
            // RETURN_HOME 16, START 8192)
            if (state === "cleaning" || state === "returning") {
                if (vacuumFeatures & 4) {
                    service = "pause";
                } else if (vacuumFeatures & 8) {
                    service = "stop";
                } else if (state === "cleaning" && (vacuumFeatures & 16)) {
                    service = "return_to_base";
                }
            } else if (state === "docked" || state === "idle" || state === "paused" || state === "error") {
                if (vacuumFeatures & 8192) {
                    service = "start";
                }
            }

            if (service) {
                log('Calling vacuum.' + service + ' for ' + entity_id + ' (state: ' + state + ')');
                appState.haws.callService(
                    'vacuum',
                    service,
                    {},
                    { entity_id: entity_id },
                    function(data) {
                        log('vacuum.' + service + ' success: ' + JSON.stringify(data));
                        Vibe.vibrate('short');
                    },
                    function(error) {
                        log('vacuum.' + service + ' failed: ' + JSON.stringify(error));
                        Vibe.vibrate('double');
                    }
                );
            } else {
                log('Vacuum ' + entity_id + ' in state ' + state + ' - no action taken');
            }
        } else if (domain === "alarm_control_panel") {
            // Disarm when armed, arm when disarmed; the page module owns the
            // state logic and any code prompt
            require('app/pages/entity/AlarmPanelPage').quickAction(entity_id);
        } else if (domain === "number" || domain === "input_number") {
            // Jump straight to the value editor
            require('app/pages/entity/NumberPage').showValueEditor(entity_id);
        } else if (domain === "timer") {
            // Start when idle or paused, pause when running
            require('app/pages/entity/TimerPage').quickAction(entity_id);
        } else if (domain === "input_datetime" || domain === "datetime" ||
                   domain === "date" || domain === "time") {
            // Straight into the editor
            require('app/pages/entity/DateTimePage').editValue(entity_id);
        } else if (domain === "text" || domain === "input_text") {
            // Straight to dictation, the only way to type on a watch
            require('app/pages/entity/TextPage').dictateValue(entity_id);
        } else if (domain === "remote") {
            require('app/pages/entity/RemotePage').quickAction(entity_id);
        } else if (domain === "lawn_mower") {
            // Stop a mower that is moving, set a stopped one going
            require('app/pages/entity/LawnMowerPage').quickAction(entity_id);
        } else if (domain === "counter") {
            // Counting up is what a counter is usually for
            require('app/pages/entity/CounterPage').quickAction(entity_id);
        } else if (domain === "water_heater") {
            // No toggle service exists, so the direction comes from the state
            require('app/pages/entity/WaterHeaterPage').quickAction(entity_id);
        } else if (domain === "valve") {
            // Toggle where the valve does both, otherwise its one direction
            require('app/pages/entity/ValvePage').quickAction(entity_id);
        } else if (domain === "siren") {
            // Home Assistant gates each of these on its own feature bit, and
            // only offers toggle when the siren can do both, so a siren that
            // cannot be turned off remotely still gets its panic action
            var siren = appState.ha_state_dict[entity_id];
            if (!siren) {
                log('handleEntityLongPress: entity ' + entity_id + ' not found in state dict');
                return;
            }
            var sirenFeatures = siren.attributes.supported_features || 0;
            var sirenService = null;
            if ((sirenFeatures & 1) && (sirenFeatures & 2)) {
                sirenService = 'toggle';
            } else if (sirenFeatures & 1) {
                sirenService = 'turn_on';
            } else if (sirenFeatures & 2) {
                sirenService = 'turn_off';
            }
            if (!sirenService) {
                log('Siren ' + entity_id + ' supports no on/off services - no action taken');
                return;
            }
            appState.haws.callService(
                domain,
                sirenService,
                {},
                { entity_id: entity_id },
                function(data) {
                    log(JSON.stringify(data));
                    Vibe.vibrate('short');
                },
                function(error) {
                    log('no response');
                    Vibe.vibrate('double');
                }
            );
        } else if (domain === "select" || domain === "input_select") {
            // Cycle to the next option (select_next wraps by default)
            appState.haws.callService(
                domain,
                'select_next',
                {},
                { entity_id: entity_id },
                function(data) {
                    log(JSON.stringify(data));
                    Vibe.vibrate('short');
                },
                function(error) {
                    log('no response');
                    Vibe.vibrate('double');
                }
            );
        } else if (domain === "button" || domain === "input_button") {
            appState.haws.callService(
                domain,
                'press',
                {},
                { entity_id: entity_id },
                function(data) {
                    log(JSON.stringify(data));
                    Vibe.vibrate('short');
                },
                function(error) {
                    log('no response');
                    Vibe.vibrate('double');
                }
            );
        }
    },

    /**
     * Toggle favorite status for an entity
     * @param {Object} entity - The entity object
     * @returns {boolean} true if added to favorites, false if removed
     */
    toggleFavorite: function(entity) {
        if (!entity || !entity.entity_id) {
            helpers.log_message('toggleFavorite: Invalid entity provided');
            return false;
        }

        var appState = AppState.getInstance();
        var log = helpers.log_message;
        var entityId = entity.entity_id;
        var wasAdded = !appState.favoriteEntityStore.has(entityId);

        if (wasAdded) {
            log('Adding ' + entityId + ' to favorites');
            var friendlyName = entity.attributes && entity.attributes.friendly_name
                ? entity.attributes.friendly_name
                : null;
            appState.favoriteEntityStore.add(entityId, friendlyName);
        } else {
            log('Removing ' + entityId + ' from favorites');
            appState.favoriteEntityStore.remove(entityId);

            // If this entity was configured as the quick launch favorite entity, reset to main_menu
            if (appState.quick_launch_favorite_entity === entityId) {
                log('Removed entity ' + entityId + ' was configured as quick launch target, resetting to main_menu');
                appState.quick_launch_behavior = 'main_menu';
                appState.quick_launch_favorite_entity = null;
                Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
                Settings.option('quick_launch_favorite_entity', appState.quick_launch_favorite_entity);
            }
        }

        return wasAdded;
    },

    /**
     * Toggle pinned status for an entity
     * @param {Object} entity - The entity object
     * @returns {boolean} true if pinned, false if unpinned
     */
    togglePinned: function(entity) {
        if (!entity || !entity.entity_id) {
            helpers.log_message('togglePinned: Invalid entity provided');
            return false;
        }

        var appState = AppState.getInstance();
        var log = helpers.log_message;
        var entityId = entity.entity_id;
        var pinnedId = 'pinned:' + entityId;
        var wasPinned = !appState.pinnedEntityStore.has(entityId);

        if (wasPinned) {
            log('Pinning ' + entityId + ' to Main Menu');
            var friendlyName = entity.attributes && entity.attributes.friendly_name
                ? entity.attributes.friendly_name
                : null;
            appState.pinnedEntityStore.add(entityId, friendlyName);

            // Also add to main_menu_order if custom ordering is enabled
            if (appState.main_menu_custom_order_enabled &&
                appState.main_menu_order &&
                Array.isArray(appState.main_menu_order)) {
                // Check if already in order
                if (appState.main_menu_order.indexOf(pinnedId) === -1) {
                    // Add at the very top
                    appState.main_menu_order.unshift(pinnedId);
                    Settings.option('main_menu_order', appState.main_menu_order);
                    log('Added ' + pinnedId + ' to top of main_menu_order');
                }
            }
        } else {
            log('Unpinning ' + entityId + ' from Main Menu');
            appState.pinnedEntityStore.remove(entityId);

            // Also remove from main_menu_order if custom ordering is enabled
            if (appState.main_menu_custom_order_enabled &&
                appState.main_menu_order &&
                Array.isArray(appState.main_menu_order)) {
                var index = appState.main_menu_order.indexOf(pinnedId);
                if (index > -1) {
                    appState.main_menu_order.splice(index, 1);
                    Settings.option('main_menu_order', appState.main_menu_order);
                    log('Removed ' + pinnedId + ' from main_menu_order');
                }
            }
        }

        return wasPinned;
    }
};

module.exports = EntityService;
