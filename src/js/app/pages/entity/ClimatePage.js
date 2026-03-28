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
var simply = require('ui/simply');
var UI = require('ui');
var Vibe = require('ui/vibe');

var BaseEntityPage = require('app/pages/entity/BaseEntityPage');
var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');

// Menu selection tracking
var menuSelections = {
    climateMenu: 0
};

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// Screen ID range for ClimatePage: 4000-4099
var _climateScreenId = 4000;
function nextClimateScreenId() { return _climateScreenId++; }

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

    // Create the climate menu via native bridge
    var climateScreenId = nextClimateScreenId();
    var climateCallbacks = {};

    // Function to build/update the main climate menu items
    function buildClimateMenuItems(climateObj) {
        climate = climateObj || appState.ha_state_dict[entity_id];
        climateData = getClimateData(climate);
        supportedFeatures = getSupportedFeatures(climateData.supported_features);

        let menuIndex = 0;

        // Temperature item
        let tempSubtitle = '';
        if (climateData.hvac_mode === 'heat_cool' && climateData.target_temp_low !== undefined && climateData.target_temp_high !== undefined) {
            tempSubtitle = `Cur: ${climateData.current_temp}\u00b0 - Set: ${climateData.target_temp_low}\u00b0-${climateData.target_temp_high}\u00b0`;
        } else if (climateData.target_temp !== undefined) {
            tempSubtitle = `Cur: ${climateData.current_temp}\u00b0 - Set: ${climateData.target_temp}\u00b0`;
        } else {
            tempSubtitle = `Current: ${climateData.current_temp}\u00b0`;
        }

        climateCallbacks['0_' + menuIndex] = function() {
            let latestClimate = appState.ha_state_dict[entity_id];
            let latestData = getClimateData(latestClimate);

            if (latestData.hvac_mode === 'heat_cool') {
                showTempRangeMenu(entity_id, latestData);
            } else {
                showTemperatureMenu(entity_id, 'single', latestData.target_temp, latestData.min_temp, latestData.max_temp, latestData.temp_step);
            }
        };
        simply.impl.nativeMenuUpdate(climateScreenId, 0, menuIndex,
            'Temperature', tempSubtitle, null);
        menuIndex++;

        // HVAC Mode item
        climateCallbacks['0_' + menuIndex] = function() {
            let latestClimate = appState.ha_state_dict[entity_id];
            let latestData = getClimateData(latestClimate);
            showHvacModeMenu(entity_id, latestData.hvac_mode, latestData.hvac_modes);
        };
        simply.impl.nativeMenuUpdate(climateScreenId, 0, menuIndex,
            'HVAC Mode',
            climateData.hvac_mode ? helpers.ucwords(climateData.hvac_mode.replace('_', ' ')) : 'Unknown',
            null);
        menuIndex++;

        // Fan Mode item if supported
        if (supportedFeatures.fan_mode && climateData.fan_modes && climateData.fan_modes.length > 0) {
            climateCallbacks['0_' + menuIndex] = function() {
                let latestClimate = appState.ha_state_dict[entity_id];
                let latestData = getClimateData(latestClimate);
                showFanModeMenu(entity_id, latestData.fan_mode, latestData.fan_modes);
            };
            simply.impl.nativeMenuUpdate(climateScreenId, 0, menuIndex,
                'Fan Mode',
                climateData.fan_mode ? helpers.ucwords(climateData.fan_mode.replace('_', ' ')) : 'Unknown',
                null);
            menuIndex++;
        }

        // Preset Mode item if supported
        if (supportedFeatures.preset_mode && climateData.preset_modes && climateData.preset_modes.length > 0) {
            climateCallbacks['0_' + menuIndex] = function() {
                let latestClimate = appState.ha_state_dict[entity_id];
                let latestData = getClimateData(latestClimate);
                showPresetModeMenu(entity_id, latestData.preset_mode, latestData.preset_modes);
            };
            simply.impl.nativeMenuUpdate(climateScreenId, 0, menuIndex,
                'Preset Mode',
                climateData.preset_mode ? helpers.ucwords(climateData.preset_mode.replace('_', ' ')) : 'None',
                null);
            menuIndex++;
        }

        // Swing Mode item if supported
        if (supportedFeatures.swing_mode && climateData.swing_modes && climateData.swing_modes.length > 0) {
            climateCallbacks['0_' + menuIndex] = function() {
                let latestClimate = appState.ha_state_dict[entity_id];
                let latestData = getClimateData(latestClimate);
                showSwingModeMenu(entity_id, latestData.swing_mode, latestData.swing_modes);
            };
            simply.impl.nativeMenuUpdate(climateScreenId, 0, menuIndex,
                'Swing Mode',
                climateData.swing_mode ? helpers.ucwords(climateData.swing_mode.replace('_', ' ')) : 'Unknown',
                null);
            menuIndex++;
        }

        // More option
        climateCallbacks['0_' + menuIndex] = function() {
            GenericEntityPage.showEntityMenu(entity_id);
        };
        simply.impl.nativeMenuUpdate(climateScreenId, 0, menuIndex,
            'More', '', null);
        menuIndex++;
    }

    // Helper function to show temperature range selection menu (heat_cool mode)
    function showTempRangeMenu(entity_id, latestData) {
        let returnToIndex = selectedIndex;

        var tempRangeScreenId = nextClimateScreenId();
        var tempRangeCallbacks = {};

        tempRangeCallbacks['0_0'] = function() {
            showTemperatureMenu(entity_id, 'low', latestData.target_temp_low, latestData.min_temp, latestData.max_temp, latestData.temp_step);
        };
        tempRangeCallbacks['0_1'] = function() {
            showTemperatureMenu(entity_id, 'high', latestData.target_temp_high, latestData.min_temp, latestData.max_temp, latestData.temp_step);
        };

        // Subscribe to entity updates for temp range menu
        let temp_range_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for temperature range menu ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;
                let updatedData = getClimateData(updatedClimate);

                simply.impl.nativeMenuUpdate(tempRangeScreenId, 0, 0,
                    'Low Temperature', `${updatedData.target_temp_low}\u00b0`, null);
                simply.impl.nativeMenuUpdate(tempRangeScreenId, 0, 1,
                    'High Temperature', `${updatedData.target_temp_high}\u00b0`, null);
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        simply.impl.nativeMenuPush(tempRangeScreenId, 'Set Temperature Range', 1, {
            onSelect: function(section, index) {
                var key = section + '_' + index;
                helpers.log_message(`Temperature range menu item selected! Section: ${section}, Index: ${index}`);
                if (tempRangeCallbacks[key]) {
                    tempRangeCallbacks[key]();
                }
            },
            onBack: function() {
                if (temp_range_subscription_msg_id) {
                    appState.haws.unsubscribe(temp_range_subscription_msg_id);
                }
                selectedIndex = returnToIndex;
            }
        });
        simply.impl.nativeMenuSectionTitle(tempRangeScreenId, 0, 'Set Temperature Range');

        simply.impl.nativeMenuUpdate(tempRangeScreenId, 0, 0,
            'Low Temperature', `${latestData.target_temp_low}\u00b0`, null);
        simply.impl.nativeMenuUpdate(tempRangeScreenId, 0, 1,
            'High Temperature', `${latestData.target_temp_high}\u00b0`, null);
    }

    // Helper function to show temperature selection menu
    function showTemperatureMenu(entity_id, mode, current_temp, min_temp, max_temp, step) {
        let climate = appState.ha_state_dict[entity_id];
        let climateData = getClimateData(climate);
        let returnToIndex = selectedIndex;

        var tempScreenId = nextClimateScreenId();
        var tempCallbacks = {};

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
            (function(idx) {
                let temp = temps[idx];
                let isCurrentTemp = isCurrentTemperature(temp, mode, climateData);
                tempCallbacks['0_' + idx] = function() {
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

                    simply.impl.nativeToast('Sending...', 0);
                    appState.haws.climateSetTemp(
                        entity_id,
                        data,
                        function(data) {
                            simply.impl.nativeToast('Done', 1);
                            helpers.log_message(`Set ${mode} temperature to ${temp}\u00b0`);
                        },
                        function(error) {
                            helpers.log_message(`Error setting temperature: ${error}`);
                        }
                    );
                };
            })(i);
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
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;
                let updatedData = getClimateData(updatedClimate);

                for (let i = 0; i < temps.length; i++) {
                    let temp = temps[i];
                    let isCurrentTemp = isCurrentTemperature(temp, mode, updatedData);
                    simply.impl.nativeMenuUpdate(tempScreenId, 0, i,
                        `${temp}\u00b0`,
                        isCurrentTemp ? 'Current' : '',
                        null);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        simply.impl.nativeMenuPush(tempScreenId, 'Set Temperature', 1, {
            onSelect: function(section, index) {
                var key = section + '_' + index;
                helpers.log_message(`Temperature menu item selected! Section: ${section}, Index: ${index}`);
                if (tempCallbacks[key]) {
                    tempCallbacks[key]();
                }
            },
            onBack: function() {
                if (temp_subscription_msg_id) {
                    appState.haws.unsubscribe(temp_subscription_msg_id);
                }
                selectedIndex = returnToIndex;
            }
        });
        simply.impl.nativeMenuSectionTitle(tempScreenId, 0, 'Set Temperature');

        // Populate items
        for (let i = 0; i < temps.length; i++) {
            let temp = temps[i];
            let isCurrentTemp = isCurrentTemperature(temp, mode, climateData);
            simply.impl.nativeMenuUpdate(tempScreenId, 0, i,
                `${temp}\u00b0`,
                isCurrentTemp ? 'Current' : '',
                null);
        }
    }

    // Helper function to show HVAC mode selection menu
    function showHvacModeMenu(entity_id, current_mode, available_modes) {
        let climate = appState.ha_state_dict[entity_id];
        let climateData = getClimateData(climate);
        let returnToIndex = selectedIndex;

        var hvacScreenId = nextClimateScreenId();
        var hvacCallbacks = {};

        for (let i = 0; i < available_modes.length; i++) {
            (function(idx) {
                let mode = available_modes[idx];
                hvacCallbacks['0_' + idx] = function() {
                    simply.impl.nativeToast('Sending...', 0);
                    appState.haws.climateSetHvacMode(
                        entity_id,
                        mode,
                        function(data) {
                            simply.impl.nativeToast('Done', 1);
                            helpers.log_message(`Set HVAC mode to ${mode}`);
                        },
                        function(error) {
                            helpers.log_message(`Error setting HVAC mode: ${error}`);
                        }
                    );
                };
            })(i);
        }

        // Subscribe to entity updates
        let hvac_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for HVAC mode menu ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;
                let updatedData = getClimateData(updatedClimate);

                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.hvac_mode;
                    simply.impl.nativeMenuUpdate(hvacScreenId, 0, i,
                        helpers.ucwords(mode.replace('_', ' ')),
                        isCurrentMode ? 'Current' : '',
                        null);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        simply.impl.nativeMenuPush(hvacScreenId, 'HVAC Mode', 1, {
            onSelect: function(section, index) {
                var key = section + '_' + index;
                helpers.log_message(`HVAC mode menu item selected! Section: ${section}, Index: ${index}`);
                if (hvacCallbacks[key]) {
                    hvacCallbacks[key]();
                }
            },
            onBack: function() {
                if (hvac_subscription_msg_id) {
                    appState.haws.unsubscribe(hvac_subscription_msg_id);
                }
                selectedIndex = returnToIndex;
            }
        });
        simply.impl.nativeMenuSectionTitle(hvacScreenId, 0, 'HVAC Mode');

        // Populate items
        for (let i = 0; i < available_modes.length; i++) {
            let mode = available_modes[i];
            let isCurrentMode = mode === current_mode;
            simply.impl.nativeMenuUpdate(hvacScreenId, 0, i,
                helpers.ucwords(mode.replace('_', ' ')),
                isCurrentMode ? 'Current' : '',
                null);
        }
    }

    // Helper function to show fan mode selection menu
    function showFanModeMenu(entity_id, current_mode, available_modes) {
        let climate = appState.ha_state_dict[entity_id];
        let climateData = getClimateData(climate);
        let returnToIndex = selectedIndex;

        var fanScreenId = nextClimateScreenId();
        var fanCallbacks = {};

        for (let i = 0; i < available_modes.length; i++) {
            (function(idx) {
                let mode = available_modes[idx];
                fanCallbacks['0_' + idx] = function() {
                    simply.impl.nativeToast('Sending...', 0);
                    appState.haws.climateSetFanMode(
                        entity_id,
                        mode,
                        function(data) {
                            simply.impl.nativeToast('Done', 1);
                            helpers.log_message(`Set fan mode to ${mode}`);
                        },
                        function(error) {
                            helpers.log_message(`Error setting fan mode: ${error}`);
                        }
                    );
                };
            })(i);
        }

        // Subscribe to entity updates
        let fan_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for fan mode menu ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;
                let updatedData = getClimateData(updatedClimate);

                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.fan_mode;
                    simply.impl.nativeMenuUpdate(fanScreenId, 0, i,
                        helpers.ucwords(mode.replace('_', ' ')),
                        isCurrentMode ? 'Current' : '',
                        null);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        simply.impl.nativeMenuPush(fanScreenId, 'Fan Mode', 1, {
            onSelect: function(section, index) {
                var key = section + '_' + index;
                helpers.log_message(`Fan mode menu item selected! Section: ${section}, Index: ${index}`);
                if (fanCallbacks[key]) {
                    fanCallbacks[key]();
                }
            },
            onBack: function() {
                if (fan_subscription_msg_id) {
                    appState.haws.unsubscribe(fan_subscription_msg_id);
                }
                selectedIndex = returnToIndex;
            }
        });
        simply.impl.nativeMenuSectionTitle(fanScreenId, 0, 'Fan Mode');

        // Populate items
        for (let i = 0; i < available_modes.length; i++) {
            let mode = available_modes[i];
            let isCurrentMode = mode === current_mode;
            simply.impl.nativeMenuUpdate(fanScreenId, 0, i,
                helpers.ucwords(mode.replace('_', ' ')),
                isCurrentMode ? 'Current' : '',
                null);
        }
    }

    // Helper function to show preset mode selection menu
    function showPresetModeMenu(entity_id, current_mode, available_modes) {
        let climate = appState.ha_state_dict[entity_id];
        let climateData = getClimateData(climate);
        let returnToIndex = selectedIndex;

        var presetScreenId = nextClimateScreenId();
        var presetCallbacks = {};

        for (let i = 0; i < available_modes.length; i++) {
            (function(idx) {
                let mode = available_modes[idx];
                presetCallbacks['0_' + idx] = function() {
                    simply.impl.nativeToast('Sending...', 0);
                    appState.haws.climateSetPresetMode(
                        entity_id,
                        mode,
                        function(data) {
                            simply.impl.nativeToast('Done', 1);
                            helpers.log_message(`Set preset mode to ${mode}`);
                        },
                        function(error) {
                            helpers.log_message(`Error setting preset mode: ${error}`);
                        }
                    );
                };
            })(i);
        }

        // Subscribe to entity updates
        let preset_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for preset mode menu ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;
                let updatedData = getClimateData(updatedClimate);

                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.preset_mode;
                    simply.impl.nativeMenuUpdate(presetScreenId, 0, i,
                        helpers.ucwords(mode.replace('_', ' ')),
                        isCurrentMode ? 'Current' : '',
                        null);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        simply.impl.nativeMenuPush(presetScreenId, 'Preset Mode', 1, {
            onSelect: function(section, index) {
                var key = section + '_' + index;
                helpers.log_message(`Preset mode menu item selected! Section: ${section}, Index: ${index}`);
                if (presetCallbacks[key]) {
                    presetCallbacks[key]();
                }
            },
            onBack: function() {
                if (preset_subscription_msg_id) {
                    appState.haws.unsubscribe(preset_subscription_msg_id);
                }
                selectedIndex = returnToIndex;
            }
        });
        simply.impl.nativeMenuSectionTitle(presetScreenId, 0, 'Preset Mode');

        // Populate items
        for (let i = 0; i < available_modes.length; i++) {
            let mode = available_modes[i];
            let isCurrentMode = mode === current_mode;
            simply.impl.nativeMenuUpdate(presetScreenId, 0, i,
                helpers.ucwords(mode.replace('_', ' ')),
                isCurrentMode ? 'Current' : '',
                null);
        }
    }

    // Helper function to show swing mode selection menu
    function showSwingModeMenu(entity_id, current_mode, available_modes) {
        let climate = appState.ha_state_dict[entity_id];
        let climateData = getClimateData(climate);
        let returnToIndex = selectedIndex;

        var swingScreenId = nextClimateScreenId();
        var swingCallbacks = {};

        for (let i = 0; i < available_modes.length; i++) {
            (function(idx) {
                let mode = available_modes[idx];
                swingCallbacks['0_' + idx] = function() {
                    simply.impl.nativeToast('Sending...', 0);
                    appState.haws.climateSetSwingMode(
                        entity_id,
                        mode,
                        function(data) {
                            simply.impl.nativeToast('Done', 1);
                            helpers.log_message(`Set swing mode to ${mode}`);
                        },
                        function(error) {
                            helpers.log_message(`Error setting swing mode: ${error}`);
                        }
                    );
                };
            })(i);
        }

        // Subscribe to entity updates
        let swing_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Climate entity update for swing mode menu ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedClimate;
                let updatedData = getClimateData(updatedClimate);

                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.swing_mode;
                    simply.impl.nativeMenuUpdate(swingScreenId, 0, i,
                        helpers.ucwords(mode.replace('_', ' ')),
                        isCurrentMode ? 'Current' : '',
                        null);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        simply.impl.nativeMenuPush(swingScreenId, 'Swing Mode', 1, {
            onSelect: function(section, index) {
                var key = section + '_' + index;
                helpers.log_message(`Swing mode menu item selected! Section: ${section}, Index: ${index}`);
                if (swingCallbacks[key]) {
                    swingCallbacks[key]();
                }
            },
            onBack: function() {
                if (swing_subscription_msg_id) {
                    appState.haws.unsubscribe(swing_subscription_msg_id);
                }
                selectedIndex = returnToIndex;
            }
        });
        simply.impl.nativeMenuSectionTitle(swingScreenId, 0, 'Swing Mode');

        // Populate items
        for (let i = 0; i < available_modes.length; i++) {
            let mode = available_modes[i];
            let isCurrentMode = mode === current_mode;
            simply.impl.nativeMenuUpdate(swingScreenId, 0, i,
                helpers.ucwords(mode.replace('_', ' ')),
                isCurrentMode ? 'Current' : '',
                null);
        }
    }

    // Favorite/Pin buttons
    var favoriteEntityStore = appState.favoriteEntityStore;
    var pinnedEntityStore = appState.pinnedEntityStore;

    function _renderFavoriteBtn() {
        climateCallbacks['1_0'] = function() {
            EntityService.toggleFavorite(appState.ha_state_dict[entity_id]);
            _renderFavoriteBtn();
        };
        simply.impl.nativeMenuUpdate(climateScreenId, 1, 0,
            (favoriteEntityStore.has(entity_id) ? 'Remove from' : 'Add to') + ' Favorites',
            '', null);
    }

    function _renderPinnedBtn() {
        climateCallbacks['1_1'] = function() {
            EntityService.togglePinned(appState.ha_state_dict[entity_id]);
            _renderPinnedBtn();
        };
        simply.impl.nativeMenuUpdate(climateScreenId, 1, 1,
            (pinnedEntityStore.has(entity_id) ? 'Unpin from' : 'Pin to') + ' Main Menu',
            '', null);
    }

    // Push the native menu
    var climateTitle = climate.attributes.friendly_name ? climate.attributes.friendly_name : entity_id;
    simply.impl.nativeMenuPush(climateScreenId, climateTitle, 2, {
        onSelect: function(section, index) {
            selectedIndex = index;
            menuSelections.climateMenu = index;
            var key = section + '_' + index;
            helpers.log_message(`Climate menu item selected! Section: ${section}, Index: ${index}`);
            if (climateCallbacks[key]) {
                climateCallbacks[key]();
            }
        },
        onBack: function() {
            if (subscription_msg_id) {
                appState.haws.unsubscribe(subscription_msg_id);
            }
        }
    });

    // Set section titles
    simply.impl.nativeMenuSectionTitle(climateScreenId, 0, climateTitle);
    simply.impl.nativeMenuSectionTitle(climateScreenId, 1, 'Extra');

    // Build menu items
    buildClimateMenuItems(climate);

    // Render favorite/pin buttons
    _renderFavoriteBtn();
    _renderPinnedBtn();

    // Subscribe to entity updates
    subscription_msg_id = appState.haws.subscribeTrigger({
        "type": "subscribe_trigger",
        "trigger": {
            "platform": "state",
            "entity_id": entity_id,
        },
    }, function(data) {
        helpers.log_message(`Climate entity update for ${entity_id}`);
        if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
            let updatedClimate = data.event.variables.trigger.to_state;
            appState.ha_state_dict[entity_id] = updatedClimate;
            buildClimateMenuItems(updatedClimate);
        }
    }, function(error) {
        helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
    });
}


module.exports.showClimateEntity = showClimateEntity;
