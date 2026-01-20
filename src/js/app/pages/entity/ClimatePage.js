/**
 * ClimatePage - Climate entity control page
 *
 * Features:
 * - Temperature control (single setpoint and range)
 * - HVAC mode selection
 * - Fan mode selection
 * - Preset mode selection
 * - Swing mode selection
 * - Real-time state subscription
 */
var UI = require('ui');
var Vibe = require('ui/vibe');

var BaseEntityPage = require('app/pages/entity/BaseEntityPage');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

// Menu selection tracking
var menuSelections = {
    climateMenu: 0
};

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

function showClimateEntity(entity_id) {
    var appState = AppState.getInstance();
    let climate = appState.ha_state_dict[entity_id],
        subscription_msg_id = null;
    if (!climate) {
        throw new Error(`Climate entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing climate entity ${entity_id}: ${JSON.stringify(climate, null, 4)}`);

    // Helper function to get climate data
    function getClimateData(climate) {
        return {
            is_on: climate.state !== "off",
            current_temp: climate.attributes.current_temperature,
            target_temp: climate.attributes.temperature,
            target_temp_low: climate.attributes.target_temp_low,
            target_temp_high: climate.attributes.target_temp_high,
            hvac_mode: climate.state,
            hvac_modes: climate.attributes.hvac_modes || [],
            fan_mode: climate.attributes.fan_mode,
            fan_modes: climate.attributes.fan_modes || [],
            preset_mode: climate.attributes.preset_mode,
            preset_modes: climate.attributes.preset_modes || [],
            swing_mode: climate.attributes.swing_mode,
            swing_modes: climate.attributes.swing_modes || [],
            min_temp: climate.attributes.min_temp || 7,
            max_temp: climate.attributes.max_temp || 35,
            temp_step: climate.attributes.target_temperature_step || 0.5,
            supported_features: climate.attributes.supported_features || 0
        };
    }

    // Helper function to determine supported features
    function getSupportedFeatures(supported_features) {
        return {
            target_temperature: !!(supported_features & 1), // TARGET_TEMPERATURE
            target_temperature_range: !!(supported_features & 2), // TARGET_TEMPERATURE_RANGE
            target_humidity: !!(supported_features & 4), // TARGET_HUMIDITY
            fan_mode: !!(supported_features & 8), // FAN_MODE
            preset_mode: !!(supported_features & 16), // PRESET_MODE
            swing_mode: !!(supported_features & 32), // SWING_MODE
            turn_on: !!(supported_features & 128), // TURN_ON
            turn_off: !!(supported_features & 256) // TURN_OFF
        };
    }

    // Get initial climate data
    let climateData = getClimateData(climate);
    let supportedFeatures = getSupportedFeatures(climateData.supported_features);

    // Track the selected index to restore it when returning from submenus
    let selectedIndex = 0;

    // Create the climate menu
    let climateMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: climate.attributes.friendly_name ? climate.attributes.friendly_name : entity_id
        }]
    });

    climateMenu.on('show', function() {
        // Get the latest climate data
        climate = appState.ha_state_dict[entity_id];
        climateData = getClimateData(climate);
        supportedFeatures = getSupportedFeatures(climateData.supported_features);

        // Clear the menu
        climateMenu.items(0, []);
        let menuIndex = 0;

        // Add Temperature item
        let tempSubtitle = '';
        if (climateData.hvac_mode === 'heat_cool' && climateData.target_temp_low !== undefined && climateData.target_temp_high !== undefined) {
            tempSubtitle = `Cur: ${climateData.current_temp}° - Set: ${climateData.target_temp_low}°-${climateData.target_temp_high}°`;
        } else if (climateData.target_temp !== undefined) {
            tempSubtitle = `Cur: ${climateData.current_temp}° - Set: ${climateData.target_temp}°`;
        } else {
            tempSubtitle = `Current: ${climateData.current_temp}°`;
        }

        climateMenu.item(0, menuIndex++, {
            title: 'Temperature',
            subtitle: tempSubtitle,
            on_click: function() {
                // Always get the latest climate data when clicked
                let latestClimate = appState.ha_state_dict[entity_id];
                let latestData = getClimateData(latestClimate);

                if (latestData.hvac_mode === 'heat_cool') {
                    // Show menu to select high or low temp
                    let tempRangeMenu = new UI.Menu({
                        status: false,
                        backgroundColor: 'black',
                        textColor: 'white',
                        highlightBackgroundColor: 'white',
                        highlightTextColor: 'black',
                        sections: [{
                            title: 'Set Temperature Range'
                        }]
                    });

                    tempRangeMenu.item(0, 0, {
                        title: 'Low Temperature',
                        subtitle: `${latestData.target_temp_low}°`,
                        on_click: function() {
                            showTemperatureMenu(entity_id, 'low', latestData.target_temp_low, latestData.min_temp, latestData.max_temp, latestData.temp_step);
                        }
                    });

                    tempRangeMenu.item(0, 1, {
                        title: 'High Temperature',
                        subtitle: `${latestData.target_temp_high}°`,
                        on_click: function() {
                            showTemperatureMenu(entity_id, 'high', latestData.target_temp_high, latestData.min_temp, latestData.max_temp, latestData.temp_step);
                        }
                    });



                    // Helper function to update temperature range menu items
                    function updateTempRangeMenuItems(updatedClimate) {
                        let updatedData = getClimateData(updatedClimate);

                        // Update menu items to reflect current state
                        tempRangeMenu.item(0, 0, {
                            title: 'Low Temperature',
                            subtitle: `${updatedData.target_temp_low}°`,
                            on_click: tempRangeMenu.items(0)[0].on_click
                        });

                        tempRangeMenu.item(0, 1, {
                            title: 'High Temperature',
                            subtitle: `${updatedData.target_temp_high}°`,
                            on_click: tempRangeMenu.items(0)[1].on_click
                        });
                    }

                    // Subscribe to entity updates
                    let temp_range_subscription_msg_id = appState.haws.subscribeTrigger({
                        "type": "subscribe_trigger",
                        "trigger": {
                            "platform": "state",
                            "entity_id": entity_id,
                        },
                    }, function(data) {
                        helpers.log_message(`Climate entity update for temperature range menu ${entity_id}`);
                        // Update the climate entity in the cache
                        if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                            let updatedClimate = data.event.variables.trigger.to_state;
                            appState.ha_state_dict[entity_id] = updatedClimate;

                            // Update menu items directly
                            updateTempRangeMenuItems(updatedClimate);
                        }
                    }, function(error) {
                        helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
                    });

                    tempRangeMenu.on('select', function(e) {
                        helpers.log_message(`Temperature range menu item ${e.item.title} was selected!`);
                        if(typeof e.item.on_click === 'function') {
                            e.item.on_click(e);
                        }
                    });

                    tempRangeMenu.on('hide', function() {
                        // Unsubscribe from entity updates
                        if (temp_range_subscription_msg_id) {
                            appState.haws.unsubscribe(temp_range_subscription_msg_id);
                        }
                    });

                    tempRangeMenu.show();
                } else {
                    // Show temperature selection menu directly
                    showTemperatureMenu(entity_id, 'single', latestData.target_temp, latestData.min_temp, latestData.max_temp, latestData.temp_step);
                }
            }
        });

        // Add HVAC Mode item
        climateMenu.item(0, menuIndex++, {
            title: 'HVAC Mode',
            subtitle: climateData.hvac_mode ? helpers.ucwords(climateData.hvac_mode.replace('_', ' ')) : 'Unknown',
            on_click: function() {
                // Always get the latest climate data when clicked
                let latestClimate = appState.ha_state_dict[entity_id];
                let latestData = getClimateData(latestClimate);
                showHvacModeMenu(entity_id, latestData.hvac_mode, latestData.hvac_modes);
            }
        });

        // Add Fan Mode item if supported
        if (supportedFeatures.fan_mode && climateData.fan_modes && climateData.fan_modes.length > 0) {
            climateMenu.item(0, menuIndex++, {
                title: 'Fan Mode',
                subtitle: climateData.fan_mode ? helpers.ucwords(climateData.fan_mode.replace('_', ' ')) : 'Unknown',
                on_click: function() {
                    // Always get the latest climate data when clicked
                    let latestClimate = appState.ha_state_dict[entity_id];
                    let latestData = getClimateData(latestClimate);
                    showFanModeMenu(entity_id, latestData.fan_mode, latestData.fan_modes);
                }
            });
        }

        // Add Preset Mode item if supported
        if (supportedFeatures.preset_mode && climateData.preset_modes && climateData.preset_modes.length > 0) {
            climateMenu.item(0, menuIndex++, {
                title: 'Preset Mode',
                subtitle: climateData.preset_mode ? helpers.ucwords(climateData.preset_mode.replace('_', ' ')) : 'None',
                on_click: function() {
                    // Always get the latest climate data when clicked
                    let latestClimate = appState.ha_state_dict[entity_id];
                    let latestData = getClimateData(latestClimate);
                    showPresetModeMenu(entity_id, latestData.preset_mode, latestData.preset_modes);
                }
            });
        }

        // Add Swing Mode item if supported
        if (supportedFeatures.swing_mode && climateData.swing_modes && climateData.swing_modes.length > 0) {
            climateMenu.item(0, menuIndex++, {
                title: 'Swing Mode',
                subtitle: climateData.swing_mode ? helpers.ucwords(climateData.swing_mode.replace('_', ' ')) : 'Unknown',
                on_click: function() {
                    // Always get the latest climate data when clicked
                    let latestClimate = appState.ha_state_dict[entity_id];
                    let latestData = getClimateData(latestClimate);
                    showSwingModeMenu(entity_id, latestData.swing_mode, latestData.swing_modes);
                }
            });
        }

        // Add More option to go to full entity menu
        climateMenu.item(0, menuIndex++, {
            title: 'More',
            on_click: function() {
                GenericEntityPage.showEntityMenu(entity_id);
            }
        });

        // Helper function to update the climate menu items based on current data
        function updateClimateMenuItems(updatedClimate) {
            // Get updated climate data
            let updatedData = getClimateData(updatedClimate);
            let menuIndex = 0;

            // Update Temperature item
            let tempSubtitle = '';
            if (updatedData.hvac_mode === 'heat_cool' && updatedData.target_temp_low !== undefined && updatedData.target_temp_high !== undefined) {
                tempSubtitle = `Cur: ${updatedData.current_temp}\u00b0 - Set: ${updatedData.target_temp_low}\u00b0-${updatedData.target_temp_high}\u00b0`;
            } else if (updatedData.target_temp !== undefined) {
                tempSubtitle = `Cur: ${updatedData.current_temp}\u00b0 - Set: ${updatedData.target_temp}\u00b0`;
            } else {
                tempSubtitle = `Current: ${updatedData.current_temp}\u00b0`;
            }

            // Update the temperature menu item
            climateMenu.item(0, menuIndex++, {
                title: 'Temperature',
                subtitle: tempSubtitle,
                on_click: climateMenu.items(0)[0].on_click
            });

            // Update HVAC Mode item
            climateMenu.item(0, menuIndex++, {
                title: 'HVAC Mode',
                subtitle: updatedData.hvac_mode ? helpers.ucwords(updatedData.hvac_mode.replace('_', ' ')) : 'Unknown',
                on_click: climateMenu.items(0)[1].on_click
            });

            // Update other items based on supported features
            let supportedFeatures = getSupportedFeatures(updatedData.supported_features);

            // Fan Mode item
            if (supportedFeatures.fan_mode && updatedData.fan_modes && updatedData.fan_modes.length > 0) {
                climateMenu.item(0, menuIndex++, {
                    title: 'Fan Mode',
                    subtitle: updatedData.fan_mode ? helpers.ucwords(updatedData.fan_mode.replace('_', ' ')) : 'Unknown',
                    on_click: climateMenu.items(0)[menuIndex-1].on_click
                });
            }

            // Preset Mode item
            if (supportedFeatures.preset_mode && updatedData.preset_modes && updatedData.preset_modes.length > 0) {
                climateMenu.item(0, menuIndex++, {
                    title: 'Preset Mode',
                    subtitle: updatedData.preset_mode ? helpers.ucwords(updatedData.preset_mode.replace('_', ' ')) : 'None',
                    on_click: climateMenu.items(0)[menuIndex-1].on_click
                });
            }

            // Swing Mode item
            if (supportedFeatures.swing_mode && updatedData.swing_modes && updatedData.swing_modes.length > 0) {
                climateMenu.item(0, menuIndex++, {
                    title: 'Swing Mode',
                    subtitle: updatedData.swing_mode ? helpers.ucwords(updatedData.swing_mode.replace('_', ' ')) : 'Unknown',
                    on_click: climateMenu.items(0)[menuIndex-1].on_click
                });
            }
        }

        // Subscribe to entity updates
        subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;

                // Update the menu items directly without redrawing the entire menu
                updateClimateMenuItems(updatedClimate);
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        // Restore the previously selected index after a short delay
        setTimeout(function() {
            // First try to use the global menu selection
            if (menuSelections.climateMenu > 0 && menuSelections.climateMenu < climateMenu.items(0).length) {
                climateMenu.selection(0, menuSelections.climateMenu);
                selectedIndex = menuSelections.climateMenu;
            }
            // Fall back to the local selectedIndex if needed
            else if (selectedIndex > 0 && selectedIndex < climateMenu.items(0).length) {
                climateMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    climateMenu.on('select', function(e) {
        // Store the current selection index
        selectedIndex = e.itemIndex;
        menuSelections.climateMenu = e.itemIndex;

        helpers.log_message(`Climate menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if(typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    climateMenu.on('hide', function() {
        // Unsubscribe from entity updates
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
    });

    // Helper function to show temperature selection menu
    function showTemperatureMenu(entity_id, mode, current_temp, min_temp, max_temp, step) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = appState.ha_state_dict[entity_id];
        let climateData = getClimateData(climate);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;

        let tempMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Set Temperature'
            }]
        });

        // Create temperature options
        let temps = [];
        for (let temp = max_temp; temp >= min_temp; temp -= step) {
            temps.push(temp);
        }

        // Find the index of the current temperature to scroll to
        let currentIndex = 0;
        let roundedCurrentTemp = Math.round(current_temp / step) * step;
        for (let i = 0; i < temps.length; i++) {
            if (Math.abs(temps[i] - roundedCurrentTemp) < 0.001) {
                currentIndex = i;
                break;
            }
        }

        // Helper function to determine if a temperature is the current one
        function isCurrentTemperature(temp, mode, data) {
            if (mode === 'single' && Math.abs(temp - data.target_temp) < 0.001) {
                return true;
            } else if (mode === 'low' && Math.abs(temp - data.target_temp_low) < 0.001) {
                return true;
            } else if (mode === 'high' && Math.abs(temp - data.target_temp_high) < 0.001) {
                return true;
            }
            return false;
        }

        // Add each temperature as a menu item
        for (let i = 0; i < temps.length; i++) {
            let temp = temps[i];
            let isCurrentTemp = isCurrentTemperature(temp, mode, climateData);

            tempMenu.item(0, i, {
                title: `${temp}°`,
                subtitle: isCurrentTemp ? 'Current' : '',
                temp: temp,
                on_click: function() {
                    // Set the temperature based on mode
                    let data = {};
                    if (mode === 'single') {
                        data.temperature = temp;
                    } else if (mode === 'low') {
                        data.target_temp_low = temp;
                        data.target_temp_high = climateData.target_temp_high;
                    } else if (mode === 'high') {
                        data.target_temp_low = climateData.target_temp_low;
                        data.target_temp_high = temp;
                    }

                    appState.haws.climateSetTemp(
                        entity_id,
                        data,
                        function(data) {
                            helpers.log_message(`Set ${mode} temperature to ${temp}°`);
                            // Don't hide the menu, let the user see the update
                            // tempMenu.hide();
                        },
                        function(error) {
                            helpers.log_message(`Error setting temperature: ${error}`);
                        }
                    );
                }
            });
        }

        // Scroll to the current temperature
        tempMenu.selection(0, currentIndex);

        // Helper function to update temperature menu items
        function updateTemperatureMenuItems(updatedClimate) {
            // Get updated climate data
            let updatedData = getClimateData(updatedClimate);

            // Update menu items to reflect current state
            for (let i = 0; i < temps.length; i++) {
                let temp = temps[i];
                let isCurrentTemp = isCurrentTemperature(temp, mode, updatedData);

                tempMenu.item(0, i, {
                    title: `${temp}°`,
                    subtitle: isCurrentTemp ? 'Current' : '',
                    temp: temp,
                    on_click: tempMenu.items(0)[i].on_click
                });
            }

            // Find the index of the current temperature to scroll to
            let currentTemp;
            if (mode === 'single') {
                currentTemp = updatedData.target_temp;
            } else if (mode === 'low') {
                currentTemp = updatedData.target_temp_low;
            } else if (mode === 'high') {
                currentTemp = updatedData.target_temp_high;
            }

            if (currentTemp !== undefined) {
                let roundedCurrentTemp = Math.round(currentTemp / step) * step;
                for (let i = 0; i < temps.length; i++) {
                    if (Math.abs(temps[i] - roundedCurrentTemp) < 0.001) {
                        // Scroll to the current temperature
                        tempMenu.selection(0, i);
                        break;
                    }
                }
            }
        }

        // Subscribe to entity updates
        let temp_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for temperature menu ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;

                // Update menu items directly
                updateTemperatureMenuItems(updatedClimate);
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        tempMenu.on('select', function(e) {
            helpers.log_message(`Temperature menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        tempMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (temp_subscription_msg_id) {
                appState.haws.unsubscribe(temp_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        tempMenu.show();
    }

    // Helper function to show HVAC mode selection menu
    function showHvacModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = appState.ha_state_dict[entity_id];
        let climateData = getClimateData(climate);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;
        let modeMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'HVAC Mode'
            }]
        });

        // Find the index of the current mode to scroll to
        let currentIndex = 0;
        for (let i = 0; i < available_modes.length; i++) {
            if (available_modes[i] === current_mode) {
                currentIndex = i;
                break;
            }
        }

        // Add each mode as a menu item
        for (let i = 0; i < available_modes.length; i++) {
            let mode = available_modes[i];
            let isCurrentMode = mode === current_mode;

            modeMenu.item(0, i, {
                title: helpers.ucwords(mode.replace('_', ' ')),
                subtitle: isCurrentMode ? 'Current' : '',
                mode: mode,
                on_click: function() {
                    appState.haws.climateSetHvacMode(
                        entity_id,
                        mode,
                        function(data) {
                            helpers.log_message(`Set HVAC mode to ${mode}`);
                            // Don't hide the menu, let the user see the update
                            // modeMenu.hide();
                        },
                        function(error) {
                            helpers.log_message(`Error setting HVAC mode: ${error}`);
                        }
                    );
                }
            });
        }

        // Scroll to the current mode
        modeMenu.selection(0, currentIndex);

        // Subscribe to entity updates
        let hvac_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for HVAC mode menu ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;

                // Get updated climate data
                let updatedData = getClimateData(updatedClimate);

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.hvac_mode;

                    modeMenu.item(0, i, {
                        title: helpers.ucwords(mode.replace('_', ' ')),
                        subtitle: isCurrentMode ? 'Current' : '',
                        mode: mode,
                        on_click: modeMenu.items(0)[i].on_click
                    });
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        modeMenu.on('select', function(e) {
            helpers.log_message(`HVAC mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (hvac_subscription_msg_id) {
                appState.haws.unsubscribe(hvac_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    // Helper function to show fan mode selection menu
    function showFanModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = appState.ha_state_dict[entity_id];
        let climateData = getClimateData(climate);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;
        let modeMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Fan Mode'
            }]
        });

        // Find the index of the current mode to scroll to
        let currentIndex = 0;
        for (let i = 0; i < available_modes.length; i++) {
            if (available_modes[i] === current_mode) {
                currentIndex = i;
                break;
            }
        }

        // Add each mode as a menu item
        for (let i = 0; i < available_modes.length; i++) {
            let mode = available_modes[i];
            let isCurrentMode = mode === current_mode;

            modeMenu.item(0, i, {
                title: helpers.ucwords(mode.replace('_', ' ')),
                subtitle: isCurrentMode ? 'Current' : '',
                mode: mode,
                on_click: function() {
                    appState.haws.climateSetFanMode(
                        entity_id,
                        mode,
                        function(data) {
                            helpers.log_message(`Set fan mode to ${mode}`);
                            // Don't hide the menu, let the user see the update
                            // modeMenu.hide();
                        },
                        function(error) {
                            helpers.log_message(`Error setting fan mode: ${error}`);
                        }
                    );
                }
            });
        }

        // Scroll to the current mode
        modeMenu.selection(0, currentIndex);

        // Subscribe to entity updates
        let fan_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for fan mode menu ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;

                // Get updated climate data
                let updatedData = getClimateData(updatedClimate);

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.fan_mode;

                    modeMenu.item(0, i, {
                        title: helpers.ucwords(mode.replace('_', ' ')),
                        subtitle: isCurrentMode ? 'Current' : '',
                        mode: mode,
                        on_click: modeMenu.items(0)[i].on_click
                    });
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        modeMenu.on('select', function(e) {
            helpers.log_message(`Fan mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (fan_subscription_msg_id) {
                appState.haws.unsubscribe(fan_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    // Helper function to show preset mode selection menu
    function showPresetModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = appState.ha_state_dict[entity_id];
        let climateData = getClimateData(climate);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;
        let modeMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Preset Mode'
            }]
        });

        // Find the index of the current mode to scroll to
        let currentIndex = 0;
        for (let i = 0; i < available_modes.length; i++) {
            if (available_modes[i] === current_mode) {
                currentIndex = i;
                break;
            }
        }

        // Add each mode as a menu item
        for (let i = 0; i < available_modes.length; i++) {
            let mode = available_modes[i];
            let isCurrentMode = mode === current_mode;

            modeMenu.item(0, i, {
                title: helpers.ucwords(mode.replace('_', ' ')),
                subtitle: isCurrentMode ? 'Current' : '',
                mode: mode,
                on_click: function() {
                    appState.haws.climateSetPresetMode(
                        entity_id,
                        mode,
                        function(data) {
                            helpers.log_message(`Set preset mode to ${mode}`);
                            // Don't hide the menu, let the user see the update
                            // modeMenu.hide();
                        },
                        function(error) {
                            helpers.log_message(`Error setting preset mode: ${error}`);
                        }
                    );
                }
            });
        }

        // Scroll to the current mode
        modeMenu.selection(0, currentIndex);

        // Subscribe to entity updates
        let preset_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for preset mode menu ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;

                // Get updated climate data
                let updatedData = getClimateData(updatedClimate);

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.preset_mode;

                    modeMenu.item(0, i, {
                        title: helpers.ucwords(mode.replace('_', ' ')),
                        subtitle: isCurrentMode ? 'Current' : '',
                        mode: mode,
                        on_click: modeMenu.items(0)[i].on_click
                    });
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        modeMenu.on('select', function(e) {
            helpers.log_message(`Preset mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (preset_subscription_msg_id) {
                appState.haws.unsubscribe(preset_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    // Helper function to show swing mode selection menu
    function showSwingModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = appState.ha_state_dict[entity_id];
        let climateData = getClimateData(climate);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;
        let modeMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Swing Mode'
            }]
        });

        // Find the index of the current mode to scroll to
        let currentIndex = 0;
        for (let i = 0; i < available_modes.length; i++) {
            if (available_modes[i] === current_mode) {
                currentIndex = i;
                break;
            }
        }

        // Add each mode as a menu item
        for (let i = 0; i < available_modes.length; i++) {
            let mode = available_modes[i];
            let isCurrentMode = mode === current_mode;

            modeMenu.item(0, i, {
                title: helpers.ucwords(mode.replace('_', ' ')),
                subtitle: isCurrentMode ? 'Current' : '',
                mode: mode,
                on_click: function() {
                    appState.haws.climateSetSwingMode(
                        entity_id,
                        mode,
                        function(data) {
                            helpers.log_message(`Set swing mode to ${mode}`);
                            // Don't hide the menu, let the user see the update
                            // modeMenu.hide();
                        },
                        function(error) {
                            helpers.log_message(`Error setting swing mode: ${error}`);
                        }
                    );
                }
            });
        }

        // Scroll to the current mode
        modeMenu.selection(0, currentIndex);

        // Subscribe to entity updates
        let swing_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for swing mode menu ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;

                // Get updated climate data
                let updatedData = getClimateData(updatedClimate);

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.swing_mode;

                    modeMenu.item(0, i, {
                        title: helpers.ucwords(mode.replace('_', ' ')),
                        subtitle: isCurrentMode ? 'Current' : '',
                        mode: mode,
                        on_click: modeMenu.items(0)[i].on_click
                    });
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        modeMenu.on('select', function(e) {
            helpers.log_message(`Swing mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (swing_subscription_msg_id) {
                appState.haws.unsubscribe(swing_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    climateMenu.show();
}


module.exports.showClimateEntity = showClimateEntity;
