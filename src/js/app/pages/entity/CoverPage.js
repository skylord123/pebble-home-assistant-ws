/**
 * CoverPage - Cover entity control page
 *
 * Features (each shown only when the entity supports it):
 * - Open / Close / Stop
 * - Position control with slider
 * - Tilt open / close / stop
 * - Tilt position control with slider
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
    coverMenu: 0
};

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

function showCoverEntity(entity_id) {
    var appState = AppState.getInstance();
    let cover = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!cover) {
        throw new Error(`Cover entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing cover entity ${entity_id}`, JSON.stringify(cover, null, 4));

    // Helper function to get cover data
    function getCoverData(cover) {
        let timeStr = helpers.humanDiff(new Date(), new Date(cover.last_changed));

        // Positions are 0-100 where 0 is fully closed and 100 is fully open
        let position = null;
        if (cover.attributes.current_position !== undefined && cover.attributes.current_position !== null) {
            position = Math.round(cover.attributes.current_position);
        }

        let tilt_position = null;
        if (cover.attributes.current_tilt_position !== undefined && cover.attributes.current_tilt_position !== null) {
            tilt_position = Math.round(cover.attributes.current_tilt_position);
        }

        return {
            entity_id: cover.entity_id,
            friendly_name: cover.attributes.friendly_name || cover.entity_id,
            state: cover.state,
            is_closed: cover.state === "closed",
            position: position,
            tilt_position: tilt_position,
            last_changed_time: timeStr
        };
    }

    // Helper function to get supported features
    function supported_features(entity) {
        // Cover feature bitfield values from Home Assistant (CoverEntityFeature enum)
        const CoverEntityFeature = {
            OPEN: 1,
            CLOSE: 2,
            SET_POSITION: 4,
            STOP: 8,
            OPEN_TILT: 16,
            CLOSE_TILT: 32,
            STOP_TILT: 64,
            SET_TILT_POSITION: 128
        };

        const supported_features_value = entity.attributes.supported_features || 0;

        let result = {
            open: !!(supported_features_value & CoverEntityFeature.OPEN),
            close: !!(supported_features_value & CoverEntityFeature.CLOSE),
            set_position: !!(supported_features_value & CoverEntityFeature.SET_POSITION),
            stop: !!(supported_features_value & CoverEntityFeature.STOP),
            open_tilt: !!(supported_features_value & CoverEntityFeature.OPEN_TILT),
            close_tilt: !!(supported_features_value & CoverEntityFeature.CLOSE_TILT),
            stop_tilt: !!(supported_features_value & CoverEntityFeature.STOP_TILT),
            set_tilt_position: !!(supported_features_value & CoverEntityFeature.SET_TILT_POSITION)
        };
        // Home Assistant registers cover.toggle for entities supporting both
        // OPEN and CLOSE, and cover.toggle_cover_tilt for both tilt directions
        result.toggle = result.open && result.close;
        result.toggle_tilt = result.open_tilt && result.close_tilt;

        helpers.log_message(`Cover ${entity.entity_id} supported features: ${JSON.stringify(result)}`);

        return result;
    }

    // Helper to call a cover service with standard feedback
    function callCoverService(service, data, entity_id) {
        appState.haws.callService(
            "cover",
            service,
            data || {},
            { entity_id: entity_id },
            function(result) {
                Vibe.vibrate('short');
                helpers.log_message(`cover.${service} called for ${entity_id}`);
            },
            function(error) {
                Vibe.vibrate('double');
                helpers.log_message(`Error calling cover.${service}: ${error}`);
            }
        );
    }

    // Get initial cover data
    let coverData = getCoverData(cover);
    let features = supported_features(cover);

    // Create the cover menu
    let coverMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: coverData.friendly_name
        }]
    });

    // Function to update menu items based on current cover state
    function updateCoverMenuItems(updatedCover) {
        // Get updated cover data
        let updatedData = getCoverData(updatedCover);
        let menuItems = [];

        // Main status item; states are open/opening/closed/closing
        let stateText = updatedData.state;
        if (updatedData.position !== null && updatedData.position > 0 && updatedData.position < 100) {
            stateText += ` ${updatedData.position}%`;
        }
        menuItems.push({
            title: updatedData.friendly_name,
            subtitle: `${stateText} > ${updatedData.last_changed_time}`,
            icon: updatedData.is_closed ? 'images/icon_blinds_closed.png' : 'images/icon_blinds_open.png',
            on_click: features.toggle ? function() {
                callCoverService("toggle", {}, updatedData.entity_id);
            } : undefined
        });

        if (features.open) {
            menuItems.push({
                title: 'Open',
                on_click: function() {
                    callCoverService("open_cover", {}, updatedData.entity_id);
                }
            });
        }

        if (features.close) {
            menuItems.push({
                title: 'Close',
                on_click: function() {
                    callCoverService("close_cover", {}, updatedData.entity_id);
                }
            });
        }

        if (features.stop) {
            menuItems.push({
                title: 'Stop',
                on_click: function() {
                    callCoverService("stop_cover", {}, updatedData.entity_id);
                }
            });
        }

        if (features.set_position) {
            menuItems.push({
                title: 'Position',
                subtitle: updatedData.position !== null ? `${updatedData.position}%` : 'NA',
                on_click: function() {
                    showPercentageSlider({
                        title: 'Position',
                        entity_id: updatedData.entity_id,
                        current: updatedData.position !== null ? updatedData.position : 0,
                        getCurrent: function(data) { return data.position; },
                        onSet: function(value, done) {
                            appState.haws.callService(
                                "cover",
                                "set_cover_position",
                                { position: value },
                                { entity_id: updatedData.entity_id },
                                function(result) {
                                    Vibe.vibrate('short');
                                    helpers.log_message(`Set cover position to ${value}%`);
                                    done();
                                },
                                function(error) {
                                    Vibe.vibrate('double');
                                    helpers.log_message(`Error setting cover position: ${error}`);
                                }
                            );
                        }
                    });
                }
            });
        }

        if (features.open_tilt) {
            menuItems.push({
                title: 'Open Tilt',
                on_click: function() {
                    callCoverService("open_cover_tilt", {}, updatedData.entity_id);
                }
            });
        }

        if (features.close_tilt) {
            menuItems.push({
                title: 'Close Tilt',
                on_click: function() {
                    callCoverService("close_cover_tilt", {}, updatedData.entity_id);
                }
            });
        }

        if (features.stop_tilt) {
            menuItems.push({
                title: 'Stop Tilt',
                on_click: function() {
                    callCoverService("stop_cover_tilt", {}, updatedData.entity_id);
                }
            });
        }

        if (features.set_tilt_position) {
            menuItems.push({
                title: 'Tilt Position',
                subtitle: updatedData.tilt_position !== null ? `${updatedData.tilt_position}%` : 'NA',
                on_click: function() {
                    showPercentageSlider({
                        title: 'Tilt Position',
                        entity_id: updatedData.entity_id,
                        current: updatedData.tilt_position !== null ? updatedData.tilt_position : 0,
                        getCurrent: function(data) { return data.tilt_position; },
                        onSet: function(value, done) {
                            appState.haws.callService(
                                "cover",
                                "set_cover_tilt_position",
                                { tilt_position: value },
                                { entity_id: updatedData.entity_id },
                                function(result) {
                                    Vibe.vibrate('short');
                                    helpers.log_message(`Set cover tilt position to ${value}%`);
                                    done();
                                },
                                function(error) {
                                    Vibe.vibrate('double');
                                    helpers.log_message(`Error setting cover tilt position: ${error}`);
                                }
                            );
                        }
                    });
                }
            });
        }

        // The cover rows all trigger actions, so history gets its own item
        // (not available on aplite)
        if (require('app/pages/HistoryPage').isSupported()) {
            menuItems.push({
                title: 'History',
                on_click: function() {
                    require('app/pages/HistoryPage').show(updatedData.entity_id);
                }
            });
        }

        // Add More option
        menuItems.push({
            title: 'More',
            on_click: function() {
                GenericEntityPage.showEntityMenu(updatedData.entity_id);
            }
        });

        coverMenu.items(0, menuItems);
    }

    // Slider window for position/tilt (0-100, where 0 is closed and 100 open)
    function showPercentageSlider(opts) {
        // Remember which menu item we came from
        let returnToIndex = selectedIndex;
        let current_value = opts.current;

        let sliderWindow = new UI.Window({
            backgroundColor: 'white',
            status: {
                color: 'black',
                backgroundColor: 'white',
                seperator: "dotted"
            }
        });

        // Add title
        let title = new UI.Text({
            text: opts.title,
            color: "black",
            font: "gothic_24_bold",
            position: new Vector(0, 0),
            size: new Vector(Feature.resolution().x, 30),
            textAlign: "center"
        });

        // Add current value text
        let valueText = new UI.Text({
            text: `${current_value}%`,
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
        let sliderWidth = Math.round((Feature.resolution().x - 40) * (current_value / 100));
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
        sliderWindow.add(title);
        sliderWindow.add(valueText);
        sliderWindow.add(sliderBg);
        sliderWindow.add(sliderFg);
        sliderWindow.add(instructions);

        // Handle button events
        sliderWindow.on('click', 'up', function() {
            current_value = Math.min(100, current_value + 10);
            updateSliderUI();
        });

        sliderWindow.on('click', 'down', function() {
            current_value = Math.max(0, current_value - 10);
            updateSliderUI();
        });

        sliderWindow.on('longClick', 'up', function() {
            current_value = Math.min(100, current_value + 25);
            updateSliderUI();
        });

        sliderWindow.on('longClick', 'down', function() {
            current_value = Math.max(0, current_value - 25);
            updateSliderUI();
        });

        sliderWindow.on('click', 'select', function() {
            opts.onSet(Math.round(current_value), function() {
                sliderWindow.hide();
            });
        });

        // Function to update the UI based on current value
        function updateSliderUI() {
            valueText.text(`${current_value}%`);
            sliderWidth = Math.round((Feature.resolution().x - 40) * (current_value / 100));
            sliderFg.size(new Vector(sliderWidth, 20));
        }

        // Subscribe to entity updates
        let slider_subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": opts.entity_id,
            },
        }, function(data) {
            helpers.log_message(`Cover entity update for ${opts.title} slider ${opts.entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedCover = data.event.variables.trigger.to_state;
                appState.ha_state_dict[opts.entity_id] = updatedCover;

                let value = opts.getCurrent(getCoverData(updatedCover));
                if (value !== null) {
                    current_value = value;
                    updateSliderUI();
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${opts.entity_id}]: ${JSON.stringify(error)}`);
        });

        sliderWindow.on('hide', function() {
            // Unsubscribe from entity updates
            if (slider_subscription_msg_id) {
                appState.haws.unsubscribe(slider_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        sliderWindow.show();
    }

    // Track the selected index to restore it when returning from submenus
    let selectedIndex = 0;

    // Store the selected index when navigating to a submenu
    coverMenu.on('select', function(e) {
        // Store the current selection index
        selectedIndex = e.itemIndex;
        menuSelections.coverMenu = e.itemIndex;

        helpers.log_message(`Cover menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if(typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    // Set up event handlers for the cover menu
    coverMenu.on('show', function() {
        // Get the latest cover data
        cover = appState.ha_state_dict[entity_id];
        coverData = getCoverData(cover);
        features = supported_features(cover);

        // Update menu items
        updateCoverMenuItems(cover);

        // Create RelativeTimeUpdater for live time updates
        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            // Get current cover and update the menu
            let currentCover = appState.ha_state_dict[entity_id];
            if (currentCover) {
                updateCoverMenuItems(currentCover);
            }
        });
        relativeTimeUpdater.register(entity_id, cover.last_changed);

        // Subscribe to entity updates
        subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            helpers.log_message(`Cover entity update for ${entity_id}`);
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedCover = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updatedCover;

                // Update the menu items directly without redrawing the entire menu
                updateCoverMenuItems(updatedCover);

                // Update the RelativeTimeUpdater with the new timestamp
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedCover.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        // Restore the previously selected index
        setTimeout(function() {
            // First try to use the global menu selection
            if (menuSelections.coverMenu > 0 && menuSelections.coverMenu < coverMenu.items(0).length) {
                coverMenu.selection(0, menuSelections.coverMenu);
                selectedIndex = menuSelections.coverMenu;
            }
            // Fall back to the local selectedIndex if needed
            else if (selectedIndex > 0 && selectedIndex < coverMenu.items(0).length) {
                coverMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    coverMenu.on('hide', function() {
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
    coverMenu.show();
}

module.exports.showCoverEntity = showCoverEntity;
