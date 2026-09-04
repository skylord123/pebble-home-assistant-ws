/**
 * FanPage - Fan entity control page
 *
 * Features:
 * - On/off toggle
 * - Speed (percentage) control with slider
 * - Preset mode selection
 * - Oscillation toggle
 * - Direction toggle
 * - Real-time state subscription
 */
var UI = require('ui');
var Vector = require('vector2');
var Feature = require('platform/feature');
var Vibe = require('ui/vibe');

var BaseEntityPage = require('app/pages/entity/BaseEntityPage');
var AppState = require('app/AppState');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

// Menu selection tracking
var menuSelections = {
    fanMenu: 0
};

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

function showFanEntity(entity_id) {
    var appState = AppState.getInstance();
    let fan = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!fan) {
        throw new Error(`Fan entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing fan entity ${entity_id}`, JSON.stringify(fan, null, 4));

    // Helper function to get fan data
    function getFanData(fan) {
        let timeStr = helpers.humanDiff(new Date(), new Date(fan.last_changed));

        let percentage = null;
        if (fan.attributes.percentage !== undefined && fan.attributes.percentage !== null) {
            percentage = Math.round(fan.attributes.percentage);
        }

        return {
            entity_id: fan.entity_id,
            friendly_name: fan.attributes.friendly_name || fan.entity_id,
            state: fan.state,
            is_on: fan.state === "on",
            percentage: percentage,
            percentage_step: fan.attributes.percentage_step || 10,
            preset_mode: fan.attributes.preset_mode,
            preset_modes: fan.attributes.preset_modes || [],
            oscillating: fan.attributes.oscillating,
            direction: fan.attributes.direction,
            last_changed_time: timeStr
        };
    }

    // Helper function to get supported features
    function supported_features(entity) {
        // Fan feature bitfield values from Home Assistant (FanEntityFeature enum)
        const FanEntityFeature = {
            SET_SPEED: 1,
            OSCILLATE: 2,
            DIRECTION: 4,
            PRESET_MODE: 8,
            TURN_OFF: 16,
            TURN_ON: 32
        };

        const supported_features_value = entity.attributes.supported_features || 0;

        let result = {
            set_speed: !!(supported_features_value & FanEntityFeature.SET_SPEED),
            oscillate: !!(supported_features_value & FanEntityFeature.OSCILLATE),
            direction: !!(supported_features_value & FanEntityFeature.DIRECTION),
            preset_mode: !!(supported_features_value & FanEntityFeature.PRESET_MODE)
        };

        helpers.log_message(`Fan ${entity.entity_id} supported features: ${JSON.stringify(result)}`);

        return result;
    }

    // Get initial fan data
    let fanData = getFanData(fan);
    let features = supported_features(fan);

    // Create the fan menu
    let fanMenu = new UI.Menu({
        status: false,
        sections: [{
            title: fanData.friendly_name
        }]
    });

    // Function to update menu items based on current fan state
    function updateFanMenuItems(updatedFan) {
        // Get updated fan data
        let updatedData = getFanData(updatedFan);
        let menuIndex = 0;

        // Update main status item
        fanMenu.item(0, menuIndex++, {
            title: updatedData.friendly_name,
            subtitle: `${updatedData.is_on ? 'on' : 'off'} > ${updatedData.last_changed_time}`,
            icon: updatedData.is_on ? 'images/icon_switch_on.png' : 'images/icon_switch_off.png',
            on_click: function() {
                // Toggle fan on/off
                appState.haws.callService(
                    "fan",
                    "toggle",
                    {},
                    { entity_id: updatedData.entity_id },
                    function(data) {
                        Vibe.vibrate('short');
                        helpers.log_message(`Toggled fan: ${updatedData.entity_id}`);
                    },
                    function(error) {
                        Vibe.vibrate('double');
                        helpers.log_message(`Error toggling fan: ${error}`);
                    }
                );
            }
        });

        // Update speed item if supported
        if (features.set_speed) {
            fanMenu.item(0, menuIndex++, {
                title: 'Speed',
                subtitle: updatedData.is_on && updatedData.percentage !== null ? `${updatedData.percentage}%` : 'NA',
                on_click: function() {
                    showSpeedMenu(updatedData.entity_id, updatedData.percentage || 0, updatedData.percentage_step);
                }
            });
        }

        // Update preset mode item if supported
        if (features.preset_mode && updatedData.preset_modes && updatedData.preset_modes.length > 0) {
            fanMenu.item(0, menuIndex++, {
                title: 'Preset',
                subtitle: updatedData.preset_mode || 'None',
                on_click: function() {
                    showPresetModeMenu(updatedData.entity_id, updatedData.preset_mode, updatedData.preset_modes);
                }
            });
        }

        // Update oscillation item if supported
        if (features.oscillate) {
            fanMenu.item(0, menuIndex++, {
                title: 'Oscillate',
                subtitle: updatedData.oscillating ? 'On' : 'Off',
                on_click: function() {
                    appState.haws.callService(
                        "fan",
                        "oscillate",
                        { oscillating: !updatedData.oscillating },
                        { entity_id: updatedData.entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            helpers.log_message(`Set oscillation to ${!updatedData.oscillating}`);
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            helpers.log_message(`Error setting oscillation: ${error}`);
                        }
                    );
                }
            });
        }

        // Update direction item if supported
        if (features.direction) {
            fanMenu.item(0, menuIndex++, {
                title: 'Direction',
                subtitle: updatedData.direction ? helpers.ucwords(updatedData.direction) : 'Unknown',
                on_click: function() {
                    let newDirection = updatedData.direction === 'forward' ? 'reverse' : 'forward';
                    appState.haws.callService(
                        "fan",
                        "set_direction",
                        { direction: newDirection },
                        { entity_id: updatedData.entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            helpers.log_message(`Set direction to ${newDirection}`);
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            helpers.log_message(`Error setting direction: ${error}`);
                        }
                    );
                }
            });
        }

        // The fan's main click toggles it, so history gets its own item
        // (not available on aplite)
        if (require('app/pages/HistoryPage').isSupported()) {
            fanMenu.item(0, menuIndex++, {
                title: 'History',
                on_click: function() {
                    require('app/pages/HistoryPage').show(updatedData.entity_id);
                }
            });
        }

        // Add More option
        fanMenu.item(0, menuIndex++, {
            title: 'More',
            on_click: function() {
                GenericEntityPage.showEntityMenu(updatedData.entity_id);
            }
        });
    }

    // Helper function to show speed selection menu
    function showSpeedMenu(entity_id, current_percentage, percentage_step) {
        // Remember which menu item we came from
        let returnToIndex = selectedIndex;

        // Steps for adjusting speed (percentage_step can be fractional, e.g. 33.33 for 3-speed fans)
        let smallStep = percentage_step || 10;
        let largeStep = Math.max(25, smallStep);

        // Create a window for the speed slider
        let speedWindow = new UI.Window({
            backgroundColor: 'white',
            status: {
                color: 'black',
                backgroundColor: 'white',
                seperator: "dotted"
            }
        });

        // Add title
        let title = new UI.Text({
            text: "Speed",
            color: "black",
            font: "gothic_24_bold",
            position: new Vector(0, 0),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center"
        });

        // Add current value text
        let valueText = new UI.Text({
            text: `${Math.round(current_percentage)}%`,
            color: "black",
            font: "gothic_24",
            position: new Vector(0, 35),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center",
            textOverflow: 'ellipsis'
        });

        // Add slider background
        let sliderBg = new UI.Rect({
            position: new Vector(20, 70),
            size: new Vector(Feature.resolution().x - 40, 20),
            backgroundColor: 'lightGray'
        });

        // Add slider foreground (progress)
        let sliderWidth = Math.round((Feature.resolution().x - 40) * (current_percentage / 100));
        let sliderFg = new UI.Rect({
            position: new Vector(20, 70),
            size: new Vector(sliderWidth, 20),
            backgroundColor: 'black'
        });

        // Add instructions
        let instructions = new UI.Text({
            text: "UP/DOWN: Adjust | SELECT: Set",
            color: "black",
            font: "gothic_14",
            position: new Vector(0, 100),
            size: new Vector(Feature.resolution().x, 20),
            textAlign: "center"
        });

        // Add elements to window
        speedWindow.add(title);
        speedWindow.add(valueText);
        speedWindow.add(sliderBg);
        speedWindow.add(sliderFg);
        speedWindow.add(instructions);

        // Handle button events
        speedWindow.on('click', 'up', function() {
            current_percentage = Math.min(100, current_percentage + smallStep);
            updateSpeedUI();
        });

        speedWindow.on('click', 'down', function() {
            current_percentage = Math.max(0, current_percentage - smallStep);
            updateSpeedUI();
        });

        speedWindow.on('longClick', 'up', function() {
            current_percentage = Math.min(100, current_percentage + largeStep);
            updateSpeedUI();
        });

        speedWindow.on('longClick', 'down', function() {
            current_percentage = Math.max(0, current_percentage - largeStep);
            updateSpeedUI();
        });

        speedWindow.on('click', 'select', function() {
            // Set the speed (fan.set_percentage with 0 turns the fan off)
            appState.haws.callService(
                "fan",
                "set_percentage",
                { percentage: Math.round(current_percentage) },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    helpers.log_message(`Set fan speed to ${Math.round(current_percentage)}%`);
                    speedWindow.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message(`Error setting fan speed: ${error}`);
                }
            );
        });

        // Function to update the UI based on current speed
        function updateSpeedUI() {
            valueText.text(`${Math.round(current_percentage)}%`);
            sliderWidth = Math.round((Feature.resolution().x - 40) * (current_percentage / 100));
            sliderFg.size(new Vector(sliderWidth, 20));
        }

        // Subscribe to entity updates
        let speed_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Fan entity update for speed menu ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedFan = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedFan;

                let updatedData = getFanData(updatedFan);
                if (updatedData.is_on && updatedData.percentage !== null) {
                    current_percentage = updatedData.percentage;
                    updateSpeedUI();
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        speedWindow.on('hide', function() {
            // Unsubscribe from entity updates
            if (speed_subscription_msg_id) {
                appState.haws.unsubscribe(speed_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        speedWindow.show();
    }

    // Helper function to show preset mode selection menu
    function showPresetModeMenu(entity_id, current_mode, preset_modes) {
        // Remember which menu item we came from
        let returnToIndex = selectedIndex;

        // Create preset mode selection menu
        let presetMenu = new UI.Menu({
            status: false,
            sections: [{
                title: 'Select Preset'
            }]
        });

        // Add preset mode options to menu
        for (let i = 0; i < preset_modes.length; i++) {
            let mode = preset_modes[i];
            let isCurrentMode = mode === current_mode;

            presetMenu.item(0, i, {
                title: mode,
                subtitle: isCurrentMode ? 'Current' : '',
                on_click: function() {
                    appState.haws.callService(
                        "fan",
                        "set_preset_mode",
                        { preset_mode: mode },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            helpers.log_message(`Set preset mode to ${mode}`);
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            helpers.log_message(`Error setting preset mode: ${error}`);
                        }
                    );
                }
            });
        }

        // Helper function to update preset menu items
        function updatePresetMenuItems(updatedFan) {
            let updatedData = getFanData(updatedFan);

            for (let i = 0; i < preset_modes.length; i++) {
                let mode = preset_modes[i];
                let isCurrentMode = mode === updatedData.preset_mode;

                presetMenu.item(0, i, {
                    title: mode,
                    subtitle: isCurrentMode ? 'Current' : '',
                    on_click: presetMenu.items(0)[i].on_click
                });
            }
        }

        // Subscribe to entity updates
        let preset_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Fan entity update for preset menu ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedFan = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedFan;

                // Update menu items directly
                updatePresetMenuItems(updatedFan);
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        presetMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (preset_subscription_msg_id) {
                appState.haws.unsubscribe(preset_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        presetMenu.show();
    }

    // Track the selected index to restore it when returning from submenus
    let selectedIndex = 0;

    // Store the selected index when navigating to a submenu
    fanMenu.on('select', function(e) {
        // Store the current selection index
        selectedIndex = e.itemIndex;
        menuSelections.fanMenu = e.itemIndex;

        helpers.log_message(`Fan menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if(typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    // Set up event handlers for the fan menu
    fanMenu.on('show', function() {
        // Clear the menu
        fanMenu.items(0, []);

        // Get the latest fan data
        fan = appState.ha_state_dict[entity_id];
        fanData = getFanData(fan);
        features = supported_features(fan);

        // Update menu items
        updateFanMenuItems(fan);

        // Create RelativeTimeUpdater for live time updates
        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            // Get current fan and update the menu
            let currentFan = appState.ha_state_dict[entity_id];
            if (currentFan) {
                updateFanMenuItems(currentFan);
            }
        });
        relativeTimeUpdater.register(entity_id, fan.last_changed);

        // Subscribe to entity updates
        subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Fan entity update for ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedFan = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedFan;

                // Update the menu items directly without redrawing the entire menu
                updateFanMenuItems(updatedFan);

                // Update the RelativeTimeUpdater with the new timestamp
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedFan.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        // Restore the previously selected index
        setTimeout(function() {
            // First try to use the global menu selection
            if (menuSelections.fanMenu > 0 && menuSelections.fanMenu < fanMenu.items(0).length) {
                fanMenu.selection(0, menuSelections.fanMenu);
                selectedIndex = menuSelections.fanMenu;
            }
            // Fall back to the local selectedIndex if needed
            else if (selectedIndex > 0 && selectedIndex < fanMenu.items(0).length) {
                fanMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    fanMenu.on('hide', function() {
        // Unsubscribe from entity updates
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }

        // Destroy the RelativeTimeUpdater
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    // Show the menu
    fanMenu.show();
}

module.exports.showFanEntity = showFanEntity;
