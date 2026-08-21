/**
 * EntityService - Handles entity display utilities and operations
 */
var Settings = require('settings');
var Vibe = require('ui/vibe');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

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
        if (includeRelativeTime && entity.last_changed) {
            subtitle += ' > ' + helpers.humanDiff(new Date(), new Date(entity.last_changed));
        }

        return subtitle;
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
                return state === 'on' ? 'images/icon_switch_on.png' : 'images/icon_switch_off.png';

            case 'cover':
                return state === 'open' ? 'images/icon_blinds_open.png' : 'images/icon_blinds_closed.png';

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

            case 'vacuum':
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
     * @returns {Object|null} The updated entity, or null if the event
     *                        didn't concern this entity
     */
    applyCompressedEvent: function(entity_id, data) {
        var appState = AppState.getInstance();
        var ev = data.event || {};
        var updated = null;

        if (ev.a && ev.a[entity_id]) {
            var d = ev.a[entity_id];
            updated = {
                entity_id: entity_id,
                state: d.s,
                attributes: d.a || {},
                context: d.c,
                last_changed: d.lc ? new Date(d.lc * 1000).toISOString() : new Date().toISOString()
            };
        } else if (ev.c && ev.c[entity_id]) {
            var plus = ev.c[entity_id]['+'] || {};
            var cur = appState.ha_state_dict[entity_id] || { entity_id: entity_id, state: '', attributes: {} };
            var attributes = cur.attributes;
            if (plus.a !== undefined) {
                attributes = {};
                for (var k in cur.attributes) { attributes[k] = cur.attributes[k]; }
                for (var k2 in plus.a) { attributes[k2] = plus.a[k2]; }
            }
            var minus = ev.c[entity_id]['-'];
            if (minus && Array.isArray(minus.a)) {
                minus.a.forEach(function(removedKey) { delete attributes[removedKey]; });
            }
            updated = {
                entity_id: entity_id,
                state: plus.s !== undefined ? plus.s : cur.state,
                attributes: attributes,
                context: plus.c !== undefined ? plus.c : cur.context,
                last_changed: plus.lc !== undefined ? new Date(plus.lc * 1000).toISOString() : cur.last_changed
            };
        }

        if (updated) {
            appState.setEntity(entity_id, updated);
        }
        return updated;
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
            var entity = appState.ha_state_dict[entity_id];
            if (!entity) {
                log('handleEntityLongPress: entity ' + entity_id + ' not found in state dict');
                return;
            }
            appState.haws.callService(
                domain,
                entity.state === "locked" ? "unlock" : "lock",
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
            var service = null;

            // Determine which service to call based on state
            if (state === "cleaning" || state === "returning") {
                service = "pause";
            } else if (state === "docked" || state === "idle" || state === "paused" || state === "error") {
                service = "start";
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
