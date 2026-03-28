/**
 * LightPage - Light entity control page
 *
 * Features:
 * - Brightness control with slider
 * - Color temperature control
 * - RGB color selection
 * - Effect selection
 * - Real-time state subscription
 */
var simply = require('ui/simply');
var UI = require('ui');
var Vector = require('vector2');
var Feature = require('platform/feature');
var Vibe = require('ui/vibe');

var BaseEntityPage = require('app/pages/entity/BaseEntityPage');
var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

// Menu selection tracking
var menuSelections = {
    lightMenu: 0
};

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// Screen ID range for LightPage: 3000-3099
var _lightScreenId = 3000;
function nextLightScreenId() { return _lightScreenId++; }

function showLightEntity(entity_id) {
    var appState = AppState.getInstance();
    let light = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!light) {
        throw new Error(`Light entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing light entity ${entity_id}`, JSON.stringify(light, null, 4));

    // Helper function to get light data
    function getLightData(light) {
        let timeStr = helpers.humanDiff(new Date(), new Date(light.last_changed));

        // Calculate brightness percentage if available
        let brightnessPerc = 0;
        if (light.attributes.brightness) {
            brightnessPerc = Math.round((100 / 255) * parseInt(light.attributes.brightness));
        }

        // Get color temperature in Kelvin if available
        let colorTempKelvin = null;
        if (light.attributes.color_temp_kelvin) {
            colorTempKelvin = light.attributes.color_temp_kelvin;
        } else if (light.attributes.color_temp) {
            // Convert mireds to Kelvin if needed
            colorTempKelvin = Math.round(1000000 / light.attributes.color_temp);
        }

        // Process RGB color data
        let rgbColor = null;
        if (light.attributes.rgb_color) {
            // Make sure rgb_color is an array of numbers
            if (Array.isArray(light.attributes.rgb_color)) {
                rgbColor = light.attributes.rgb_color.map(val => parseInt(val));
                helpers.log_message(`Processed RGB color: ${JSON.stringify(rgbColor)}`);
            }
        }

        return {
            entity_id: light.entity_id,
            friendly_name: light.attributes.friendly_name || light.entity_id,
            state: light.state,
            is_on: light.state === "on",
            brightness: light.attributes.brightness,
            brightnessPerc: brightnessPerc,
            color_temp: light.attributes.color_temp,
            color_temp_kelvin: colorTempKelvin,
            min_color_temp_kelvin: light.attributes.min_color_temp_kelvin || 2000,
            max_color_temp_kelvin: light.attributes.max_color_temp_kelvin || 6500,
            rgb_color: rgbColor,
            xy_color: light.attributes.xy_color,
            hs_color: light.attributes.hs_color,
            effect: light.attributes.effect,
            effect_list: light.attributes.effect_list || [],
            last_changed_time: timeStr
        };
    }

    // Helper function to get supported features
    function supported_features(entity) {
        let entity_registry = appState.entity_registry_cache[entity.entity_id];
        // Light feature bitfield values from Home Assistant
        // Modern Home Assistant uses LightEntityFeature enum
        const LightEntityFeature = {
            EFFECT: 4,
            FLASH: 8,
            TRANSITION: 32
        };

        // Define features map for the bitfield
        let features = {
            [LightEntityFeature.EFFECT]: "effect",
            [LightEntityFeature.FLASH]: "flash",
            [LightEntityFeature.TRANSITION]: "transition"
        };

        // Get the supported_features value from the entity
        const supported_features_value = entity.attributes.supported_features || 0;

        // Get supported color modes
        const supported_color_modes = entity.attributes.supported_color_modes || [];

        // Create result object with all features set to false by default
        let result = {
            brightness: false,
            color_temp: false,
            effect: false,
            flash: false,
            color: false,
            transition: false,
            white_value: false
        };

        // Check each feature bit from the bitfield
        for (let key in features) {
            if (!!(supported_features_value & key)) {
                result[features[key]] = true;
            }
        }

        // Check color modes for additional features
        if (supported_color_modes.length > 0) {
            // Check if brightness is supported based on color modes
            // All color modes except "onoff" support brightness
            result.brightness = supported_color_modes.some(mode =>
                mode !== "onoff"
            );

            // Check if color temperature is supported
            result.color_temp = supported_color_modes.includes("color_temp");

            // Check if color is supported (hs, xy, rgb, rgbw, rgbww)
            result.color = supported_color_modes.some(mode =>
                ["hs", "xy", "rgb", "rgbw", "rgbww"].includes(mode)
            );
        } else {
            // Fallback for older Home Assistant versions that don't use color modes
            // These use the deprecated SUPPORT_* constants
            const SUPPORT_BRIGHTNESS = 1;
            const SUPPORT_COLOR_TEMP = 2;
            const SUPPORT_COLOR = 16;

            result.brightness = !!(supported_features_value & SUPPORT_BRIGHTNESS);
            result.color_temp = !!(supported_features_value & SUPPORT_COLOR_TEMP);
            result.color = !!(supported_features_value & SUPPORT_COLOR);
        }

        helpers.log_message(`Light ${entity.entity_id} supported features: ${JSON.stringify(result)}`);
        helpers.log_message(`Light supported_features value: ${supported_features_value}`);
        helpers.log_message(`Light supported_color_modes: ${JSON.stringify(supported_color_modes)}`);
        helpers.log_message('Light registry: ', JSON.stringify(entity_registry, null, 4));

        return result;
    }

    // Get initial light data
    let lightData = getLightData(light);
    let feats = supported_features(light);

    // Create the light menu via native bridge
    var lightScreenId = nextLightScreenId();
    // Callback map for section 0 and section 1
    var lightCallbacks = {};

    // Function to update menu items based on current light state
    function updateLightMenuItems(updatedLight) {
        // Get updated light data
        let updatedData = getLightData(updatedLight);
        let menuIndex = 0;

        // Update main status item
        lightCallbacks['0_' + menuIndex] = function() {
            // Toggle light on/off
            simply.impl.nativeToast('Sending...', 0);
            appState.haws.callService(
                "light",
                "toggle",
                {},
                { entity_id: updatedData.entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    simply.impl.nativeToast('Done', 1);
                    helpers.log_message(`Toggled light: ${updatedData.entity_id}`);
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message(`Error toggling light: ${error}`);
                }
            );
        };
        simply.impl.nativeMenuUpdate(lightScreenId, 0, menuIndex,
            updatedData.friendly_name,
            `${updatedData.is_on ? 'on' : 'off'} > ${updatedData.last_changed_time}`,
            updatedData.is_on ? 'images/icon_bulb_on.png' : 'images/icon_bulb.png');
        menuIndex++;

        // Update brightness item if supported
        if (feats.brightness) {
            lightCallbacks['0_' + menuIndex] = function() {
                showBrightnessMenu(updatedData.entity_id, updatedData.brightnessPerc);
            };
            simply.impl.nativeMenuUpdate(lightScreenId, 0, menuIndex,
                'Brightness',
                updatedData.is_on ? `${updatedData.brightnessPerc}%` : 'NA',
                null);
            menuIndex++;
        }

        // Update color temperature item if supported
        if (feats.color_temp) {
            lightCallbacks['0_' + menuIndex] = function() {
                showColorTempMenu(
                    updatedData.entity_id,
                    updatedData.color_temp_kelvin,
                    updatedData.min_color_temp_kelvin,
                    updatedData.max_color_temp_kelvin
                );
            };
            simply.impl.nativeMenuUpdate(lightScreenId, 0, menuIndex,
                'Color Temperature',
                updatedData.is_on && updatedData.color_temp_kelvin ?
                    `${updatedData.color_temp_kelvin}K` : 'NA',
                null);
            menuIndex++;
        }

        // Update color item if supported
        if (feats.color) {
            let colorText = 'NA';
            if (updatedData.is_on && updatedData.rgb_color) {
                colorText = `RGB(${updatedData.rgb_color.join(',')})`;
                helpers.log_message(`Color menu item updated with: ${colorText}`);
            }

            lightCallbacks['0_' + menuIndex] = function() {
                // Make sure we pass the RGB color array correctly
                let rgbColor = updatedData.rgb_color || [255, 255, 255];
                helpers.log_message(`Opening color menu with color: ${JSON.stringify(rgbColor)}`);
                showColorMenu(updatedData.entity_id, rgbColor);
            };
            simply.impl.nativeMenuUpdate(lightScreenId, 0, menuIndex,
                'Color',
                colorText,
                null);
            menuIndex++;
        }

        // Update effect item if supported
        if (feats.effect && updatedData.effect_list && updatedData.effect_list.length > 0) {
            lightCallbacks['0_' + menuIndex] = function() {
                showEffectMenu(updatedData.entity_id, updatedData.effect, updatedData.effect_list);
            };
            simply.impl.nativeMenuUpdate(lightScreenId, 0, menuIndex,
                'Effect',
                updatedData.effect || 'None',
                null);
            menuIndex++;
        }

        // Add More option
        lightCallbacks['0_' + menuIndex] = function() {
            GenericEntityPage.showEntityMenu(updatedData.entity_id);
        };
        simply.impl.nativeMenuUpdate(lightScreenId, 0, menuIndex,
            'More', '', null);
        menuIndex++;
    }

    // Helper function to show brightness selection menu
    function showBrightnessMenu(entity_id, current_brightness) {
        // Get the latest light data
        let light = appState.ha_state_dict[entity_id];
        let lightData = getLightData(light);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;

        // Create a window for the brightness slider
        let brightnessWindow = new UI.Window({
            backgroundColor: 'white',
            status: {
                color: 'black',
                backgroundColor: 'white',
                seperator: "dotted"
            }
        });

        // Add title
        let title = new UI.Text({
            text: "Brightness",
            color: "black",
            font: "gothic_24_bold",
            position: new Vector(0, 0),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center"
        });

        // Add current value text
        let valueText = new UI.Text({
            text: `${current_brightness}%`,
            color: "black",
            font: "gothic_24",
            position: new Vector(0, 35),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center"
        });

        // Add slider background
        let sliderBg = new UI.Rect({
            position: new Vector(20, 70),
            size: new Vector(Feature.resolution().x - 40, 20),
            backgroundColor: 'lightGray'
        });

        // Add slider foreground (progress)
        let sliderWidth = Math.round((Feature.resolution().x - 40) * (current_brightness / 100));
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
        brightnessWindow.add(title);
        brightnessWindow.add(valueText);
        brightnessWindow.add(sliderBg);
        brightnessWindow.add(sliderFg);
        brightnessWindow.add(instructions);

        // Handle button events
        brightnessWindow.on('click', 'up', function() {
            // Increase brightness by 10%
            current_brightness = Math.min(100, current_brightness + 10);
            updateBrightnessUI();
        });

        brightnessWindow.on('click', 'down', function() {
            // Decrease brightness by 10%
            current_brightness = Math.max(0, current_brightness - 10);
            updateBrightnessUI();
        });

        brightnessWindow.on('longClick', 'up', function() {
            // Increase brightness by 25%
            current_brightness = Math.min(100, current_brightness + 25);
            updateBrightnessUI();
        });

        brightnessWindow.on('longClick', 'down', function() {
            // Decrease brightness by 25%
            current_brightness = Math.max(0, current_brightness - 25);
            updateBrightnessUI();
        });

        brightnessWindow.on('click', 'select', function() {
            // Set the brightness
            let brightness = Math.round((255 / 100) * current_brightness);
            simply.impl.nativeToast('Sending...', 0);
            appState.haws.callService(
                "light",
                "turn_on",
                { brightness: brightness },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    simply.impl.nativeToast('Done', 1);
                    helpers.log_message(`Set brightness to ${current_brightness}%`);
                    brightnessWindow.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message(`Error setting brightness: ${error}`);
                }
            );
        });

        // Function to update the UI based on current brightness
        function updateBrightnessUI() {
            valueText.text(`${current_brightness}%`);
            sliderWidth = Math.round((Feature.resolution().x - 40) * (current_brightness / 100));
            sliderFg.size(new Vector(sliderWidth, 20));
        }

        // Subscribe to entity updates
        let brightness_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Light entity update for brightness menu ${entity_id}`);
            // Update the light entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedLight;

                // Get updated light data
                let updatedData = getLightData(updatedLight);

                // Update the brightness value
                if (updatedData.is_on) {
                    current_brightness = updatedData.brightnessPerc;
                    updateBrightnessUI();
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        brightnessWindow.on('hide', function() {
            // Unsubscribe from entity updates
            if (brightness_subscription_msg_id) {
                appState.haws.unsubscribe(brightness_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        brightnessWindow.show();
    }

    // Helper function to show color temperature selection menu
    function showColorTempMenu(entity_id, current_temp, min_temp, max_temp) {
        // Get the latest light data
        let light = appState.ha_state_dict[entity_id];
        let lightData = getLightData(light);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;

        // Default values if not provided
        min_temp = min_temp || 2000;
        max_temp = max_temp || 6500;
        current_temp = current_temp || 3500;

        // Create a window for the color temperature slider
        let tempWindow = new UI.Window({
            backgroundColor: 'white',
            status: {
                color: 'black',
                backgroundColor: 'white',
                seperator: "dotted"
            }
        });

        // Add title
        let title = new UI.Text({
            text: "Color Temperature",
            color: "black",
            font: "gothic_24_bold",
            position: new Vector(0, 0),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center"
        });

        // Add current value text
        let valueText = new UI.Text({
            text: `${current_temp}K`,
            color: "black",
            font: "gothic_24",
            position: new Vector(0, 35),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center"
        });

        // Add slider background
        let sliderBg = new UI.Rect({
            position: new Vector(20, 70),
            size: new Vector(Feature.resolution().x - 40, 20),
            backgroundColor: 'lightGray'
        });

        // Add slider foreground (progress)
        let tempRange = max_temp - min_temp;
        let tempPosition = current_temp - min_temp;
        let sliderWidth = Math.round((Feature.resolution().x - 40) * (tempPosition / tempRange));
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
        tempWindow.add(title);
        tempWindow.add(valueText);
        tempWindow.add(sliderBg);
        tempWindow.add(sliderFg);
        tempWindow.add(instructions);

        // Calculate step sizes
        let smallStep = Math.round(tempRange / 10);
        let largeStep = Math.round(tempRange / 4);

        // Handle button events
        tempWindow.on('click', 'up', function() {
            // Increase temperature by small step
            current_temp = Math.min(max_temp, current_temp + smallStep);
            updateTempUI();
        });

        tempWindow.on('click', 'down', function() {
            // Decrease temperature by small step
            current_temp = Math.max(min_temp, current_temp - smallStep);
            updateTempUI();
        });

        tempWindow.on('longClick', 'up', function() {
            // Increase temperature by large step
            current_temp = Math.min(max_temp, current_temp + largeStep);
            updateTempUI();
        });

        tempWindow.on('longClick', 'down', function() {
            // Decrease temperature by large step
            current_temp = Math.max(min_temp, current_temp - largeStep);
            updateTempUI();
        });

        tempWindow.on('click', 'select', function() {
            // Set the color temperature
            simply.impl.nativeToast('Sending...', 0);
            appState.haws.callService(
                "light",
                "turn_on",
                { color_temp_kelvin: current_temp },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    simply.impl.nativeToast('Done', 1);
                    helpers.log_message(`Set color temperature to ${current_temp}K`);
                    tempWindow.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message(`Error setting color temperature: ${error}`);
                }
            );
        });

        // Function to update the UI based on current temperature
        function updateTempUI() {
            valueText.text(`${current_temp}K`);
            tempPosition = current_temp - min_temp;
            sliderWidth = Math.round((Feature.resolution().x - 40) * (tempPosition / tempRange));
            sliderFg.size(new Vector(sliderWidth, 20));
        }

        // Subscribe to entity updates
        let temp_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Light entity update for color temp menu ${entity_id}`);
            // Update the light entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedLight;

                // Get updated light data
                let updatedData = getLightData(updatedLight);

                // Update the color temperature value
                if (updatedData.is_on && updatedData.color_temp_kelvin) {
                    current_temp = updatedData.color_temp_kelvin;
                    updateTempUI();
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        tempWindow.on('hide', function() {
            // Unsubscribe from entity updates
            if (temp_subscription_msg_id) {
                appState.haws.unsubscribe(temp_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        tempWindow.show();
    }

    // Helper function to show color selection menu
    function showColorMenu(entity_id, current_color) {
        // Get the latest light data
        let light = appState.ha_state_dict[entity_id];
        let lightData = getLightData(light);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;

        // Default color if not provided
        current_color = current_color || [255, 0, 0];

        // Log the current color for debugging
        helpers.log_message(`Current color for ${entity_id}: ${JSON.stringify(current_color)}`);

        // Define color options in a spectrum
        let colors = [
            { name: "Red", rgb: [255, 0, 0] },
            { name: "Orange", rgb: [255, 127, 0] },
            { name: "Yellow", rgb: [255, 255, 0] },
            { name: "Green", rgb: [0, 255, 0] },
            { name: "Cyan", rgb: [0, 255, 255] },
            { name: "Blue", rgb: [0, 0, 255] },
            { name: "Purple", rgb: [127, 0, 255] },
            { name: "Magenta", rgb: [255, 0, 255] },
            { name: "White", rgb: [255, 255, 255] }
        ];

        // Helper function to calculate color distance
        function colorDistance(color1, color2) {
            return Math.sqrt(
                Math.pow(color1[0] - color2[0], 2) +
                Math.pow(color1[1] - color2[1], 2) +
                Math.pow(color1[2] - color2[2], 2)
            );
        }

        // Helper function to convert RGB to hex
        function rgbToHex(rgb) {
            return '#' + rgb.map(x => {
                const hex = x.toString(16);
                return hex.length === 1 ? '0' + hex : hex;
            }).join('');
        }

        // Helper function to compare arrays
        function arraysEqual(a, b) {
            if (!a || !b) return false;
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                // Use approximate comparison for RGB values (they might be slightly different)
                if (Math.abs(a[i] - b[i]) > 5) return false;
            }
            return true;
        }

        // Find closest color match and set initial color index
        let colorIndex = 0;
        let closestDistance = 999999;

        for (let i = 0; i < colors.length; i++) {
            let distance = colorDistance(colors[i].rgb, current_color);
            if (distance < closestDistance) {
                closestDistance = distance;
                colorIndex = i;
            }
        }

        // --- Color picker menu via native bridge ---
        var colorScreenId = nextLightScreenId();
        var colorCallbacks = {};

        for (let i = 0; i < colors.length; i++) {
            (function(idx) {
                var color = colors[idx];
                var isCurrentColor = arraysEqual(color.rgb, current_color);
                colorCallbacks['0_' + idx] = function() {
                    // Set the selected color
                    var selectedColor = colors[idx].rgb;
                    simply.impl.nativeToast('Sending...', 0);
                    appState.haws.callService(
                        "light",
                        "turn_on",
                        { rgb_color: selectedColor },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            simply.impl.nativeToast('Done', 1);
                            helpers.log_message(`Set color to ${colors[idx].name}`);
                            simply.impl.nativeMenuPop();
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            helpers.log_message(`Error setting color: ${error}`);
                        }
                    );
                };
                simply.impl.nativeMenuUpdate(colorScreenId, 0, idx,
                    color.name,
                    isCurrentColor ? 'Current' : '',
                    null);
            })(i);
        }

        // Subscribe to entity updates for the color menu
        let color_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Light entity update for color menu ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedLight;
                let updatedData = getLightData(updatedLight);

                helpers.log_message(`Updating color menu with RGB color: ${JSON.stringify(updatedData.rgb_color)}`);

                if (updatedData.is_on && updatedData.rgb_color) {
                    let newColorIndex = 0;
                    let newClosestDistance = 999999;
                    for (let i = 0; i < colors.length; i++) {
                        let distance = colorDistance(colors[i].rgb, updatedData.rgb_color);
                        if (distance < newClosestDistance) {
                            newClosestDistance = distance;
                            newColorIndex = i;
                        }
                    }
                    for (let i = 0; i < colors.length; i++) {
                        var isCurrentColor = i === newColorIndex;
                        if (isCurrentColor) {
                            helpers.log_message(`Current color matched: ${colors[i].name}`);
                        }
                        simply.impl.nativeMenuUpdate(colorScreenId, 0, i,
                            colors[i].name,
                            isCurrentColor ? 'Current' : '',
                            null);
                    }
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        // --- Color window with slider (for color-capable devices) ---
        let colorWindow = new UI.Window({
            backgroundColor: 'white',
            status: {
                color: 'black',
                backgroundColor: 'white',
                seperator: "dotted"
            }
        });

        // Add title
        let titleText = new UI.Text({
            text: "Color",
            color: "black",
            font: "gothic_24_bold",
            position: new Vector(0, 0),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center"
        });

        // Add current color name text
        let colorName = new UI.Text({
            text: colors[colorIndex].name,
            color: "black",
            font: "gothic_24",
            position: new Vector(0, 35),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center"
        });

        // Create color bars for the spectrum
        let colorBars = [];
        let barWidth = Math.floor((Feature.resolution().x - 30) / (colors.length - 1));
        let barX = 15;

        for (let i = 0; i < colors.length - 1; i++) {
            let startColor = colors[i].rgb;
            colorBars[i] = new UI.Line({
                position: new Vector(barX, 80),
                position2: new Vector(barX + barWidth, 80),
                strokeColor: Feature.color(rgbToHex(startColor), "black"),
                strokeWidth: 6
            });
            colorWindow.add(colorBars[i]);
            barX += barWidth;
        }

        // Add slider indicator
        let sliderIndicator = new UI.Rect({
            position: new Vector(15 + (colorIndex * barWidth) - 3, 70),
            size: new Vector(6, 20),
            backgroundColor: 'black'
        });

        // Add instructions
        let colorInstructions = new UI.Text({
            text: "UP/DOWN: Change | SELECT: Set",
            color: "black",
            font: "gothic_14",
            position: new Vector(0, 120),
            size: new Vector(Feature.resolution().x, 20),
            textAlign: "center"
        });

        colorWindow.add(titleText);
        colorWindow.add(colorName);
        colorWindow.add(sliderIndicator);
        colorWindow.add(colorInstructions);

        // Handle button events for color window
        colorWindow.on('click', 'up', function() {
            colorIndex = (colorIndex + 1) % colors.length;
            updateColorUI();
        });

        colorWindow.on('click', 'down', function() {
            colorIndex = (colorIndex - 1 + colors.length) % colors.length;
            updateColorUI();
        });

        colorWindow.on('click', 'select', function() {
            var selectedColor = colors[colorIndex].rgb;
            simply.impl.nativeToast('Sending...', 0);
            appState.haws.callService(
                "light",
                "turn_on",
                { rgb_color: selectedColor },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    simply.impl.nativeToast('Done', 1);
                    helpers.log_message(`Set color to ${colors[colorIndex].name}`);
                    colorWindow.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message(`Error setting color: ${error}`);
                }
            );
        });

        function updateColorUI() {
            colorName.text(colors[colorIndex].name);
            sliderIndicator.animate({
                position: new Vector(15 + (colorIndex * barWidth) - 3, 70)
            }, 100);
        }

        colorWindow.on('hide', function() {
            selectedIndex = returnToIndex;
        });

        // Choose which UI to show based on device capabilities
        if (Feature.color()) {
            // Show the color window with slider for devices that support color
            colorWindow.show();
        } else {
            // Show the native bridge color picker menu for devices with limited color support
            simply.impl.nativeMenuPush(colorScreenId, 'Select Color', 1, {
                onSelect: function(section, index) {
                    var key = section + '_' + index;
                    if (colorCallbacks[key]) {
                        colorCallbacks[key]();
                    }
                },
                onBack: function() {
                    // Unsubscribe from entity updates
                    if (color_subscription_msg_id) {
                        appState.haws.unsubscribe(color_subscription_msg_id);
                    }
                    selectedIndex = returnToIndex;
                }
            });
            simply.impl.nativeMenuSectionTitle(colorScreenId, 0, 'Select Color');
            // Re-populate items after push
            for (let i = 0; i < colors.length; i++) {
                var isCurrentColor = arraysEqual(colors[i].rgb, current_color);
                simply.impl.nativeMenuUpdate(colorScreenId, 0, i,
                    colors[i].name,
                    isCurrentColor ? 'Current' : '',
                    null);
            }
        }
    }

    // Helper function to show effect selection menu
    function showEffectMenu(entity_id, current_effect, effect_list) {
        // Get the latest light data
        let light = appState.ha_state_dict[entity_id];
        let lightData = getLightData(light);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;

        var effectScreenId = nextLightScreenId();
        var effectCallbacks = {};

        // Add "None" option
        effectCallbacks['0_0'] = function() {
            simply.impl.nativeToast('Sending...', 0);
            appState.haws.callService(
                "light",
                "turn_on",
                { effect: "none" },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    simply.impl.nativeToast('Done', 1);
                    helpers.log_message(`Effect set to none`);
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message(`Error setting effect: ${error}`);
                }
            );
        };

        // Add effect options
        for (let i = 0; i < effect_list.length; i++) {
            (function(idx) {
                var effect = effect_list[idx];
                effectCallbacks['0_' + (idx + 1)] = function() {
                    simply.impl.nativeToast('Sending...', 0);
                    appState.haws.callService(
                        "light",
                        "turn_on",
                        { effect: effect },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            simply.impl.nativeToast('Done', 1);
                            helpers.log_message(`Effect set to ${effect}`);
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            helpers.log_message(`Error setting effect: ${error}`);
                        }
                    );
                };
            })(i);
        }

        // Subscribe to entity updates
        let effect_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Light entity update for effect menu ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedLight;
                let updatedData = getLightData(updatedLight);

                // Update "None" option
                simply.impl.nativeMenuUpdate(effectScreenId, 0, 0,
                    "None",
                    !updatedData.effect ? 'Current' : '',
                    null);

                // Update effect options
                for (let i = 0; i < effect_list.length; i++) {
                    var effect = effect_list[i];
                    var isCurrentEffect = effect === updatedData.effect;
                    simply.impl.nativeMenuUpdate(effectScreenId, 0, i + 1,
                        effect,
                        isCurrentEffect ? 'Current' : '',
                        null);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        simply.impl.nativeMenuPush(effectScreenId, 'Select Effect', 1, {
            onSelect: function(section, index) {
                var key = section + '_' + index;
                if (effectCallbacks[key]) {
                    effectCallbacks[key]();
                }
            },
            onBack: function() {
                if (effect_subscription_msg_id) {
                    appState.haws.unsubscribe(effect_subscription_msg_id);
                }
                selectedIndex = returnToIndex;
            }
        });
        simply.impl.nativeMenuSectionTitle(effectScreenId, 0, 'Select Effect');

        // Populate items
        simply.impl.nativeMenuUpdate(effectScreenId, 0, 0,
            "None",
            !current_effect ? 'Current' : '',
            null);

        for (let i = 0; i < effect_list.length; i++) {
            var effect = effect_list[i];
            var isCurrentEffect = effect === current_effect;
            simply.impl.nativeMenuUpdate(effectScreenId, 0, i + 1,
                effect,
                isCurrentEffect ? 'Current' : '',
                null);
        }
    }

    // Track the selected index to restore it when returning from submenus
    let selectedIndex = 0;

    // Favorite/Pin buttons
    var favoriteEntityStore = appState.favoriteEntityStore;
    var pinnedEntityStore = appState.pinnedEntityStore;

    function _renderFavoriteBtn() {
        lightCallbacks['1_0'] = function() {
            EntityService.toggleFavorite(appState.ha_state_dict[entity_id]);
            _renderFavoriteBtn();
        };
        simply.impl.nativeMenuUpdate(lightScreenId, 1, 0,
            (favoriteEntityStore.has(entity_id) ? 'Remove from' : 'Add to') + ' Favorites',
            '', null);
    }

    function _renderPinnedBtn() {
        lightCallbacks['1_1'] = function() {
            EntityService.togglePinned(appState.ha_state_dict[entity_id]);
            _renderPinnedBtn();
        };
        simply.impl.nativeMenuUpdate(lightScreenId, 1, 1,
            (pinnedEntityStore.has(entity_id) ? 'Unpin from' : 'Pin to') + ' Main Menu',
            '', null);
    }

    // Push the native menu
    simply.impl.nativeMenuPush(lightScreenId, lightData.friendly_name, 2, {
        onSelect: function(section, index) {
            selectedIndex = index;
            menuSelections.lightMenu = index;
            var key = section + '_' + index;
            helpers.log_message(`Light menu item selected! Section: ${section}, Index: ${index}`);
            if (lightCallbacks[key]) {
                lightCallbacks[key]();
            }
        },
        onBack: function() {
            // Unsubscribe from entity updates
            if (subscription_msg_id) {
                appState.haws.unsubscribe(subscription_msg_id);
            }
            // Destroy the RelativeTimeUpdater
            if (relativeTimeUpdater) {
                relativeTimeUpdater.destroy();
                relativeTimeUpdater = null;
            }
        }
    });

    // Set section titles
    simply.impl.nativeMenuSectionTitle(lightScreenId, 0, lightData.friendly_name);
    simply.impl.nativeMenuSectionTitle(lightScreenId, 1, 'Extra');

    // Get the latest light data and populate
    light = appState.ha_state_dict[entity_id];
    lightData = getLightData(light);
    feats = supported_features(light);
    updateLightMenuItems(light);

    // Render favorite/pin buttons
    _renderFavoriteBtn();
    _renderPinnedBtn();

    // Create RelativeTimeUpdater for live time updates
    relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
        let currentLight = appState.ha_state_dict[entity_id];
        if (currentLight) {
            updateLightMenuItems(currentLight);
        }
    });
    relativeTimeUpdater.register(entity_id, light.last_changed);

    // Subscribe to entity updates
    subscription_msg_id = appState.haws.subscribeTrigger({
        "type": "subscribe_trigger",
        "trigger": {
            "platform": "state",
            "entity_id": entity_id,
        },
    }, function(data) {
        helpers.log_message(`Light entity update for ${entity_id}`);
        if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
            let updatedLight = data.event.variables.trigger.to_state;
            appState.ha_state_dict[entity_id] = updatedLight;
            updateLightMenuItems(updatedLight);
            if (relativeTimeUpdater) {
                relativeTimeUpdater.update(entity_id, updatedLight.last_changed);
            }
        }
    }, function(error) {
        helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
    });
}

module.exports.showLightEntity = showLightEntity;
