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
var NumberField = require('ui/numberfield');

var BaseEntityPage = require('app/pages/entity/BaseEntityPage');
var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');

// Last selected row per entity, so another entity's page (with other rows)
// doesn't open on it
var menuSelections = {};

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

function showClimateEntity(entity_id) {
    var appState = AppState.getInstance();
    let climate = appState.getEntity(entity_id),
        subscription_msg_id = null;
    if (!climate) {
        throw new Error(`Climate entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing climate entity ${entity_id}: ${JSON.stringify(climate, null, 4)}`);

    // The latest state, or the last one seen if it has left the state dict
    function currentClimate() {
        return appState.getEntity(entity_id) || climate;
    }

    // Helper function to get climate data
    function getClimateData(climate) {
        return {
            is_on: climate.state !== "off",
            current_temp: climate.attributes.current_temperature,
            target_temp: climate.attributes.temperature,
            target_temp_low: climate.attributes.target_temp_low,
            target_temp_high: climate.attributes.target_temp_high,
            hvac_mode: climate.state,
            hvac_action: climate.attributes.hvac_action,
            hvac_modes: climate.attributes.hvac_modes || [],
            fan_mode: climate.attributes.fan_mode,
            fan_modes: climate.attributes.fan_modes || [],
            preset_mode: climate.attributes.preset_mode,
            preset_modes: climate.attributes.preset_modes || [],
            swing_mode: climate.attributes.swing_mode,
            swing_modes: climate.attributes.swing_modes || [],
            min_temp: climate.attributes.min_temp || 7,
            max_temp: climate.attributes.max_temp || 35,
            // The frontend's fallback when the entity doesn't publish a step
            temp_step: climate.attributes.target_temp_step ||
                (appState.ha_temperature_unit === '\u00b0F' ? 1 : 0.5),
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
            turn_off: !!(supported_features & 128), // TURN_OFF
            turn_on: !!(supported_features & 256) // TURN_ON
        };
    }

    // Which setpoint the entity takes right now, chosen like the frontend
    // does: single when TARGET_TEMPERATURE is set and temperature is known,
    // else a range when TARGET_TEMPERATURE_RANGE is set and both ends are
    function setpointMode(data) {
        let features = getSupportedFeatures(data.supported_features);
        if (features.target_temperature && data.target_temp !== undefined && data.target_temp !== null) {
            return 'single';
        }
        if (features.target_temperature_range &&
            data.target_temp_low !== undefined && data.target_temp_low !== null &&
            data.target_temp_high !== undefined && data.target_temp_high !== null) {
            return 'range';
        }
        return null;
    }

    function hasTemperatureRow(data) {
        let features = getSupportedFeatures(data.supported_features);
        return features.target_temperature || features.target_temperature_range;
    }

    // The mode, plus what the unit is doing right now when it says
    function hvacSubtitle(data) {
        let text = data.hvac_mode ? helpers.ucwords(data.hvac_mode.replace('_', ' ')) : 'Unknown';
        if (data.hvac_action && data.hvac_action !== data.hvac_mode) {
            text += ' (' + data.hvac_action.replace('_', ' ') + ')';
        }
        return text;
    }

    function temperatureSubtitle(data) {
        let parts = [];
        if (data.current_temp !== undefined && data.current_temp !== null) {
            parts.push(`Cur: ${data.current_temp}\u00b0`);
        }
        let mode = setpointMode(data);
        if (mode === 'range') {
            parts.push(`Set: ${data.target_temp_low}\u00b0-${data.target_temp_high}\u00b0`);
        } else if (mode === 'single') {
            parts.push(`Set: ${data.target_temp}\u00b0`);
        }
        return parts.join(' - ');
    }

    // Get initial climate data
    let climateData = getClimateData(climate);
    let supportedFeatures = getSupportedFeatures(climateData.supported_features);

    // Track the selected index to restore it when returning from submenus
    let selectedIndex = 0;

    // Create the climate menu
    let climateMenu = new UI.Menu({
        status: false,
        sections: [{
            title: climate.attributes.friendly_name ? climate.attributes.friendly_name : entity_id
        }]
    });

    // 'show' runs this first too, as a second 'show' can arrive without a
    // 'hide' in between
    function releaseUpdates() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
            subscription_msg_id = null;
        }
    }

    climateMenu.on('show', function() {
        releaseUpdates();

        // Get the latest climate data, keeping the last copy if it has gone
        // from the state dict
        climate = appState.getEntity(entity_id) || climate;
        climateData = getClimateData(climate);
        supportedFeatures = getSupportedFeatures(climateData.supported_features);

        // Clear the menu
        climateMenu.items(0, []);
        let menuIndex = 0;

        // Add Temperature item, only for entities that take a setpoint
        if (hasTemperatureRow(climateData)) {
            climateMenu.item(0, menuIndex++, {
                title: 'Temperature',
                subtitle: temperatureSubtitle(climateData),
                on_click: function() {
                    // Always get the latest climate data when clicked
                    let latestClimate = currentClimate();
                    let latestData = getClimateData(latestClimate);
                    let setpoint = setpointMode(latestData);

                    if (!setpoint) {
                        // No setpoint in this mode (usually off)
                        Vibe.vibrate('double');
                        return;
                    }

                    if (setpoint === 'range') {
                        // Show menu to select high or low temp
                        let tempRangeMenu = new UI.Menu({
                            status: false,
                            sections: [{
                                title: 'Set Temperature Range'
                            }]
                        });

                        // These rows stay on screen while the setpoint changes, so
                        // the bound has to be read when the row is pressed. Closing
                        // over latestData would open the selector on the value from
                        // when the menu was built, and confirming it would quietly
                        // put back the temperature the user just moved away from.
                        function openRangeEnd(which) {
                            let d = getClimateData(currentClimate());
                            showTemperatureMenu(entity_id, which,
                                which === 'low' ? d.target_temp_low : d.target_temp_high,
                                d.min_temp, d.max_temp, d.temp_step);
                        }

                        tempRangeMenu.item(0, 0, {
                            title: 'Low Temperature',
                            subtitle: `${latestData.target_temp_low}°`,
                            on_click: function() { openRangeEnd('low'); }
                        });

                        tempRangeMenu.item(0, 1, {
                            title: 'High Temperature',
                            subtitle: `${latestData.target_temp_high}°`,
                            on_click: function() { openRangeEnd('high'); }
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

                        let temp_range_subscription_msg_id = null;
                        function releaseTempRangeUpdates() {
                            if (temp_range_subscription_msg_id) {
                                appState.haws.unsubscribe(temp_range_subscription_msg_id);
                                temp_range_subscription_msg_id = null;
                            }
                        }

                        // Subscribe on every show, so coming back after a reconnect
                        // follows the entity again
                        tempRangeMenu.on('show', function() {
                            releaseTempRangeUpdates();
                            temp_range_subscription_msg_id = EntityService.subscribeEntity(entity_id, function(updatedClimate) {
                                helpers.log_message(`Climate entity update for temperature range menu ${entity_id}`);
                                // Update menu items directly
                                updateTempRangeMenuItems(updatedClimate);
                            });
                        });

                        tempRangeMenu.on('select', function(e) {
                            helpers.log_message(`Temperature range menu item ${e.item.title} was selected!`);
                            if(typeof e.item.on_click === 'function') {
                                e.item.on_click(e);
                            }
                        });

                        tempRangeMenu.on('hide', function() {
                            releaseTempRangeUpdates();
                        });

                        tempRangeMenu.show();
                    } else {
                        // Show temperature selection menu directly
                        showTemperatureMenu(entity_id, 'single', latestData.target_temp, latestData.min_temp, latestData.max_temp, latestData.temp_step);
                    }
                }
            });
        }

        // Add HVAC Mode item
        climateMenu.item(0, menuIndex++, {
            title: 'HVAC Mode',
            subtitle: hvacSubtitle(climateData),
            on_click: function() {
                // Always get the latest climate data when clicked
                let latestClimate = currentClimate();
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
                    let latestClimate = currentClimate();
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
                    let latestClimate = currentClimate();
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
                    let latestClimate = currentClimate();
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

            // Update the temperature menu item
            if (hasTemperatureRow(updatedData)) {
                climateMenu.item(0, menuIndex++, {
                    title: 'Temperature',
                    subtitle: temperatureSubtitle(updatedData),
                    on_click: climateMenu.items(0)[menuIndex-1].on_click
                });
            }

            // Update HVAC Mode item
            climateMenu.item(0, menuIndex++, {
                title: 'HVAC Mode',
                subtitle: hvacSubtitle(updatedData),
                on_click: climateMenu.items(0)[menuIndex-1].on_click
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
        subscription_msg_id = EntityService.subscribeEntity(entity_id, function(updatedClimate) {
            helpers.log_message(`Climate entity update for ${entity_id}`);
            // Update the menu items directly without redrawing the entire menu
            updateClimateMenuItems(updatedClimate);
        });

        // Restore the previously selected index after a short delay
        setTimeout(function() {
            // First try to use the global menu selection
            if (menuSelections[entity_id] > 0 && menuSelections[entity_id] < climateMenu.items(0).length) {
                climateMenu.selection(0, menuSelections[entity_id]);
                selectedIndex = menuSelections[entity_id];
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
        menuSelections[entity_id] = e.itemIndex;

        helpers.log_message(`Climate menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if(typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    climateMenu.on('hide', releaseUpdates);

    // Temperature selection via the native number selector. mode is
    // 'single', 'low', or 'high'; low/high are bounded by each other so a
    // heat_cool range can't be set inverted.
    function showTemperatureMenu(entity_id, mode, current_temp, min_temp, max_temp, step) {
        let climateData = getClimateData(currentClimate());

        let title = 'Temperature';
        if (mode === 'low') {
            title = 'Low Temperature';
            if (climateData.target_temp_high !== undefined && climateData.target_temp_high !== null) {
                max_temp = Math.min(max_temp, climateData.target_temp_high);
            }
        } else if (mode === 'high') {
            title = 'High Temperature';
            if (climateData.target_temp_low !== undefined && climateData.target_temp_low !== null) {
                min_temp = Math.max(min_temp, climateData.target_temp_low);
            }
        }

        let stepStr = String(step);
        let decimals = stepStr.indexOf('.') === -1 ? 0 : stepStr.length - stepStr.indexOf('.') - 1;

        // Follow changes made elsewhere while the selector is open; the
        // watch ignores them while the user is actively adjusting
        let subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(eventData) {
            let updatedClimate = EntityService.applyCompressedEvent(entity_id, eventData);
            if (updatedClimate) {
                let updatedData = getClimateData(updatedClimate);
                let value = mode === 'low' ? updatedData.target_temp_low
                    : mode === 'high' ? updatedData.target_temp_high
                    : updatedData.target_temp;
                if (value !== undefined && value !== null) {
                    NumberField.value(value);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        function cleanup() {
            if (subscription_msg_id) {
                appState.haws.unsubscribe(subscription_msg_id);
                subscription_msg_id = null;
            }
        }

        NumberField.show({
            title: title,
            unit: '°',
            value: current_temp !== undefined && current_temp !== null ? current_temp : min_temp,
            min: min_temp,
            max: max_temp,
            step: step,
            decimals: decimals,
            showBar: true,
            onSet: function(value) {
                // Re-read the other end of the range at set time so a
                // concurrent change isn't clobbered with stale data
                let latestData = getClimateData(currentClimate());
                let data = {};
                if (mode === 'low') {
                    data.target_temp_low = value;
                    data.target_temp_high = latestData.target_temp_high;
                } else if (mode === 'high') {
                    data.target_temp_low = latestData.target_temp_low;
                    data.target_temp_high = value;
                } else {
                    data.temperature = value;
                }

                appState.haws.climateSetTemp(
                    entity_id,
                    data,
                    function(result) {
                        Vibe.vibrate('short');
                        helpers.log_message(`Set ${mode} temperature to ${value}°`);
                        cleanup();
                        NumberField.hide();
                    },
                    function(error) {
                        Vibe.vibrate('double');
                        helpers.log_message(`Error setting temperature: ${JSON.stringify(error)}`);
                    }
                );
            },
            onCancel: cleanup
        });
    }

    // Helper function to show HVAC mode selection menu
    function showHvacModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = currentClimate();
        let climateData = getClimateData(climate);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;
        let modeMenu = new UI.Menu({
            status: false,
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

        let hvac_subscription_msg_id = null;
        function releaseHvacUpdates() {
            if (hvac_subscription_msg_id) {
                appState.haws.unsubscribe(hvac_subscription_msg_id);
                hvac_subscription_msg_id = null;
            }
        }

        // Subscribe on every show, so coming back after a reconnect
        // follows the entity again
        modeMenu.on('show', function() {
            releaseHvacUpdates();
            hvac_subscription_msg_id = EntityService.subscribeEntity(entity_id, function(updatedClimate) {
                helpers.log_message(`Climate entity update for HVAC mode menu ${entity_id}`);
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
            });
        });

        modeMenu.on('select', function(e) {
            helpers.log_message(`HVAC mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            releaseHvacUpdates();

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    // Helper function to show fan mode selection menu
    function showFanModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = currentClimate();
        let climateData = getClimateData(climate);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;
        let modeMenu = new UI.Menu({
            status: false,
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

        let fan_subscription_msg_id = null;
        function releaseFanUpdates() {
            if (fan_subscription_msg_id) {
                appState.haws.unsubscribe(fan_subscription_msg_id);
                fan_subscription_msg_id = null;
            }
        }

        // Subscribe on every show, so coming back after a reconnect
        // follows the entity again
        modeMenu.on('show', function() {
            releaseFanUpdates();
            fan_subscription_msg_id = EntityService.subscribeEntity(entity_id, function(updatedClimate) {
                helpers.log_message(`Climate entity update for fan mode menu ${entity_id}`);
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
            });
        });

        modeMenu.on('select', function(e) {
            helpers.log_message(`Fan mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            releaseFanUpdates();

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    // Helper function to show preset mode selection menu
    function showPresetModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = currentClimate();
        let climateData = getClimateData(climate);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;
        let modeMenu = new UI.Menu({
            status: false,
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

        let preset_subscription_msg_id = null;
        function releasePresetUpdates() {
            if (preset_subscription_msg_id) {
                appState.haws.unsubscribe(preset_subscription_msg_id);
                preset_subscription_msg_id = null;
            }
        }

        // Subscribe on every show, so coming back after a reconnect
        // follows the entity again
        modeMenu.on('show', function() {
            releasePresetUpdates();
            preset_subscription_msg_id = EntityService.subscribeEntity(entity_id, function(updatedClimate) {
                helpers.log_message(`Climate entity update for preset mode menu ${entity_id}`);
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
            });
        });

        modeMenu.on('select', function(e) {
            helpers.log_message(`Preset mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            releasePresetUpdates();

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    // Helper function to show swing mode selection menu
    function showSwingModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = currentClimate();
        let climateData = getClimateData(climate);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;
        let modeMenu = new UI.Menu({
            status: false,
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

        let swing_subscription_msg_id = null;
        function releaseSwingUpdates() {
            if (swing_subscription_msg_id) {
                appState.haws.unsubscribe(swing_subscription_msg_id);
                swing_subscription_msg_id = null;
            }
        }

        // Subscribe on every show, so coming back after a reconnect
        // follows the entity again
        modeMenu.on('show', function() {
            releaseSwingUpdates();
            swing_subscription_msg_id = EntityService.subscribeEntity(entity_id, function(updatedClimate) {
                helpers.log_message(`Climate entity update for swing mode menu ${entity_id}`);
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
            });
        });

        modeMenu.on('select', function(e) {
            helpers.log_message(`Swing mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            releaseSwingUpdates();

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    climateMenu.show();
}


module.exports.showClimateEntity = showClimateEntity;
