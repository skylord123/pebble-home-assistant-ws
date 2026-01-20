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
var UI = require('ui');
var Vector = require('vector2');
var Feature = require('platform/feature');
var Vibe = require('ui/vibe');

var BaseEntityPage = require('app/pages/entity/BaseEntityPage');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

// Menu selection tracking
var menuSelections = {
    lightMenu: 0
};

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

function showLightEntity(entity_id) {
    var appState = AppState.getInstance();
    let light = appState.ha_state_dict[entity_id],
        subscription_msg_id = null;
    if (!light) {
        throw new Error(`Light entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing light entity ${entity_id}`, JSON.stringify(light, null, 4));

    // Helper function to get light data
    function getLightData(light) {
        let timeStr = humanDiff(new Date(), new Date(light.last_changed));

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
        let entity_registry = entity_registry_cache[entity.entity_id];
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
    let features = supported_features(light);

    // Create the light menu
    let lightMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: lightData.friendly_name
        }]
    });

    // Function to update menu items based on current light state
    function updateLightMenuItems(updatedLight) {
        // Get updated light data
        let updatedData = getLightData(updatedLight);
        let menuIndex = 0;

        // Update main status item
        lightMenu.item(0, menuIndex++, {
            title: updatedData.friendly_name,
            subtitle: `${updatedData.is_on ? 'on' : 'off'} > ${updatedData.last_changed_time}`,
            icon: updatedData.is_on ? 'images/icon_bulb_on.png' : 'images/icon_bulb.png',
            on_click: function() {
                // Toggle light on/off
                appState.haws.callService(
                    "light",
                    "toggle",
                    {},
                    { entity_id: updatedData.entity_id },
                    function(data) {
                        Vibe.vibrate('short');
                        helpers.log_message(`Toggled light: ${updatedData.entity_id}`);
                    },
                    function(error) {
                        Vibe.vibrate('double');
                        helpers.log_message(`Error toggling light: ${error}`);
                    }
                );
            }
        });

        // Update brightness item if supported
        if (features.brightness) {
            lightMenu.item(0, menuIndex++, {
                title: 'Brightness',
                subtitle: updatedData.is_on ? `${updatedData.brightnessPerc}%` : 'NA',
                on_click: function() {
                    showBrightnessMenu(updatedData.entity_id, updatedData.brightnessPerc);
                }
            });
        }

        // Update color temperature item if supported
        if (features.color_temp) {
            lightMenu.item(0, menuIndex++, {
                title: 'Color Temperature',
                subtitle: updatedData.is_on && updatedData.color_temp_kelvin ?
                          `${updatedData.color_temp_kelvin}K` : 'NA',
                on_click: function() {
                    showColorTempMenu(
                        updatedData.entity_id,
                        updatedData.color_temp_kelvin,
                        updatedData.min_color_temp_kelvin,
                        updatedData.max_color_temp_kelvin
                    );
                }
            });
        }

        // Update color item if supported
        if (features.color) {
            let colorText = 'NA';
            if (updatedData.is_on && updatedData.rgb_color) {
                colorText = `RGB(${updatedData.rgb_color.join(',')})`;
                helpers.log_message(`Color menu item updated with: ${colorText}`);
            }

            lightMenu.item(0, menuIndex++, {
                title: 'Color',
                subtitle: colorText,
                on_click: function() {
                    // Make sure we pass the RGB color array correctly
                    let rgbColor = updatedData.rgb_color || [255, 255, 255];
                    helpers.log_message(`Opening color menu with color: ${JSON.stringify(rgbColor)}`);
                    showColorMenu(updatedData.entity_id, rgbColor);
                }
            });
        }

        // Update effect item if supported
        if (features.effect && updatedData.effect_list && updatedData.effect_list.length > 0) {
            lightMenu.item(0, menuIndex++, {
                title: 'Effect',
                subtitle: updatedData.effect || 'None',
                on_click: function() {
                    showEffectMenu(updatedData.entity_id, updatedData.effect, updatedData.effect_list);
                }
            });
        }

        // Add More option
        lightMenu.item(0, menuIndex++, {
            title: 'More',
            on_click: function() {
                GenericEntityPage.showEntityMenu(updatedData.entity_id);
            }
        });
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
            appState.haws.callService(
                "light",
                "turn_on",
                { brightness: brightness },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
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
            appState.haws.callService(
                "light",
                "turn_on",
                { color_temp_kelvin: current_temp },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
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

    // Helper function to show color selection menu with a colorful slider
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

        // Create a window for the color slider
        let colorWindow = new UI.Window({
            backgroundColor: 'white',
            status: {
                color: 'black',
                backgroundColor: 'white',
                seperator: "dotted"
            }
        });

        // Create a menu for color selection
        let colorMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Select Color'
            }]
        });

        // Add title
        let title = new UI.Text({
            text: "Color",
            color: "black",
            font: "gothic_24_bold",
            position: new Vector(0, 0),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center"
        });

        // Add current color name text
        let colorName = new UI.Text({
            text: "Red", // Will be updated
            color: "black",
            font: "gothic_24",
            position: new Vector(0, 35),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center"
        });

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

        // Update color name text
        colorName.text(colors[colorIndex].name);

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

        // Add color options to the menu
        for (let i = 0; i < colors.length; i++) {
            let color = colors[i];
            let isCurrentColor = arraysEqual(color.rgb, current_color);

            colorMenu.item(0, i, {
                title: color.name,
                subtitle: isCurrentColor ? 'Current' : '',
                on_click: function() {
                    // Set the selected color
                    let selectedColor = colors[i].rgb;

                    // Send command to Home Assistant
                    appState.haws.callService(
                        "light",
                        "turn_on",
                        { rgb_color: selectedColor },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            helpers.log_message(`Set color to ${colors[i].name}`);
                            colorMenu.hide();
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            helpers.log_message(`Error setting color: ${error}`);
                        }
                    );
                }
            });
        }

        // Set the initial selection to the closest color match
        colorMenu.selection(0, colorIndex);

        // Create color bars for the spectrum
        let colorBars = [];
        let barWidth = Math.floor((Feature.resolution().x - 30) / (colors.length - 1));
        let barX = 15;

        for (let i = 0; i < colors.length - 1; i++) {
            // Get colors for gradient
            let startColor = colors[i].rgb;
            let endColor = colors[i+1].rgb;

            // Create color bar
            colorBars[i] = new UI.Line({
                position: new Vector(barX, 80),
                position2: new Vector(barX + barWidth, 80),
                strokeColor: Feature.color(rgbToHex(startColor), "black"),
                strokeWidth: 6
            });

            colorWindow.add(colorBars[i]);
            barX += barWidth;
        }

        // Add slider indicator (position will be updated)
        let sliderIndicator = new UI.Rect({
            position: new Vector(15 + (colorIndex * barWidth) - 3, 70),
            size: new Vector(6, 20),
            backgroundColor: 'black'
        });

        // Add instructions
        let instructions = new UI.Text({
            text: "UP/DOWN: Change | SELECT: Set",
            color: "black",
            font: "gothic_14",
            position: new Vector(0, 120),
            size: new Vector(Feature.resolution().x, 20),
            textAlign: "center"
        });

        // Add elements to window
        colorWindow.add(title);
        colorWindow.add(colorName);
        colorWindow.add(sliderIndicator);
        colorWindow.add(instructions);

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

        // Handle button events
        colorWindow.on('click', 'up', function() {
            // Move to next color
            colorIndex = (colorIndex + 1) % colors.length;
            updateColorUI();
        });

        colorWindow.on('click', 'down', function() {
            // Move to previous color
            colorIndex = (colorIndex - 1 + colors.length) % colors.length;
            updateColorUI();
        });

        colorWindow.on('click', 'select', function() {
            // Set the selected color
            let selectedColor = colors[colorIndex].rgb;

            // Send command to Home Assistant
            appState.haws.callService(
                "light",
                "turn_on",
                { rgb_color: selectedColor },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    helpers.log_message(`Set color to ${colors[colorIndex].name}`);
                    colorWindow.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message(`Error setting color: ${error}`);
                }
            );
        });

        // Function to update the UI based on current color selection
        function updateColorUI() {
            // Update color name
            colorName.text(colors[colorIndex].name);

            // Update slider position
            sliderIndicator.animate({
                position: new Vector(15 + (colorIndex * barWidth) - 3, 70)
            }, 100);
        }

        // Handle hide event to restore selection in parent menu
        colorWindow.on('hide', function() {
            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        // Show the color window
        colorWindow.show();

        // Helper function to update color menu items
        function updateColorMenuItems(updatedLight) {
            // Get updated light data
            let updatedData = getLightData(updatedLight);

            // Log the current RGB color for debugging
            helpers.log_message(`Updating color menu with RGB color: ${JSON.stringify(updatedData.rgb_color)}`);

            if (updatedData.is_on && updatedData.rgb_color) {
                // Find closest color match
                let newColorIndex = 0;
                let newClosestDistance = 999999;

                for (let i = 0; i < colors.length; i++) {
                    let distance = colorDistance(colors[i].rgb, updatedData.rgb_color);
                    if (distance < newClosestDistance) {
                        newClosestDistance = distance;
                        newColorIndex = i;
                    }
                }

                // Update menu items to reflect current state
                for (let i = 0; i < colors.length; i++) {
                    let color = colors[i];
                    let isCurrentColor = i === newColorIndex;

                    if (isCurrentColor) {
                        helpers.log_message(`Current color matched: ${color.name}`);
                    }

                    colorMenu.item(0, i, {
                        title: color.name,
                        subtitle: isCurrentColor ? 'Current' : '',
                        on_click: colorMenu.items(0)[i].on_click
                    });
                }

                // Update the selection
                colorMenu.selection(0, newColorIndex);
            }
        }

        // Subscribe to entity updates
        let color_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Light entity update for color menu ${entity_id}`);
            // Update the light entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedLight;

                // Update menu items directly
                updateColorMenuItems(updatedLight);
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        colorMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (color_subscription_msg_id) {
                appState.haws.unsubscribe(color_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        // Choose which UI to show based on device capabilities
        if (Feature.color()) {
            // Show the color window with slider for devices that support color
            colorWindow.show();
        } else {
            // Show the simple menu for devices with limited color support
            colorMenu.show();
        }
    }

    // Helper function to show effect selection menu
    function showEffectMenu(entity_id, current_effect, effect_list) {
        // Get the latest light data
        let light = appState.ha_state_dict[entity_id];
        let lightData = getLightData(light);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;

        // Create effect selection menu
        let effectMenu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Select Effect'
            }]
        });

        // Add "None" option
        effectMenu.item(0, 0, {
            title: "None",
            subtitle: !current_effect ? 'Current' : '',
            on_click: function() {
                // Turn off effect
                appState.haws.callService(
                    "light",
                    "turn_on",
                    { effect: "none" },
                    { entity_id: entity_id },
                    function(data) {
                        Vibe.vibrate('short');
                        helpers.log_message(`Effect set to none`);
                    },
                    function(error) {
                        Vibe.vibrate('double');
                        helpers.log_message(`Error setting effect: ${error}`);
                    }
                );
            }
        });

        // Add effect options to menu
        for (let i = 0; i < effect_list.length; i++) {
            let effect = effect_list[i];
            let isCurrentEffect = effect === current_effect;

            effectMenu.item(0, i + 1, {
                title: effect,
                subtitle: isCurrentEffect ? 'Current' : '',
                on_click: function() {
                    // Set the effect
                    appState.haws.callService(
                        "light",
                        "turn_on",
                        { effect: effect },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            helpers.log_message(`Effect set to ${effect}`);
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            helpers.log_message(`Error setting effect: ${error}`);
                        }
                    );
                }
            });
        }

        // Helper function to update effect menu items
        function updateEffectMenuItems(updatedLight) {
            // Get updated light data
            let updatedData = getLightData(updatedLight);

            // Update "None" option
            effectMenu.item(0, 0, {
                title: "None",
                subtitle: !updatedData.effect ? 'Current' : '',
                on_click: effectMenu.items(0)[0].on_click
            });

            // Update effect options
            for (let i = 0; i < effect_list.length; i++) {
                let effect = effect_list[i];
                let isCurrentEffect = effect === updatedData.effect;

                effectMenu.item(0, i + 1, {
                    title: effect,
                    subtitle: isCurrentEffect ? 'Current' : '',
                    on_click: effectMenu.items(0)[i + 1].on_click
                });
            }
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
            // Update the light entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedLight;

                // Update menu items directly
                updateEffectMenuItems(updatedLight);
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        effectMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (effect_subscription_msg_id) {
                appState.haws.unsubscribe(effect_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        effectMenu.show();
    }

    // Track the selected index to restore it when returning from submenus
    let selectedIndex = 0;

    // Store the selected index when navigating to a submenu
    lightMenu.on('select', function(e) {
        // Store the current selection index
        selectedIndex = e.itemIndex;
        menuSelections.lightMenu = e.itemIndex;

        helpers.log_message(`Light menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if(typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    // Set up event handlers for the light menu
    lightMenu.on('show', function() {
        // Clear the menu
        lightMenu.items(0, []);

        // Get the latest light data
        light = appState.ha_state_dict[entity_id];
        lightData = getLightData(light);
        features = supported_features(light);

        // Update menu items
        updateLightMenuItems(light);

        // Subscribe to entity updates
        subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Light entity update for ${entity_id}`);
            // Update the light entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedLight;

                // Update the menu items directly without redrawing the entire menu
                updateLightMenuItems(updatedLight);
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        // Restore the previously selected index
        setTimeout(function() {
            // First try to use the global menu selection
            if (menuSelections.lightMenu > 0 && menuSelections.lightMenu < lightMenu.items(0).length) {
                lightMenu.selection(0, menuSelections.lightMenu);
                selectedIndex = menuSelections.lightMenu;
            }
            // Fall back to the local selectedIndex if needed
            else if (selectedIndex > 0 && selectedIndex < lightMenu.items(0).length) {
                lightMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    lightMenu.on('hide', function() {
        // Unsubscribe from entity updates
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
    });

    // Show the menu
    lightMenu.show();
}

module.exports.showLightEntity = showLightEntity;
