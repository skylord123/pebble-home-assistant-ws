/**
 * pebble-home-assistant-ws
 *
 * Created by Skylord123 (https://skylar.tech)
 */

const appVersion = '0.7.0',
    confVersion = '0.7.0',
    debugMode = false,
    debugHAWS = false,
    hawsFaker = false,
    DEFAULT_IGNORE_DOMAINS = ['assist_satellite', 'conversation', 'tts', 'stt', 'wake_word', 'tag', 'todo', 'update', 'zone'],
    UI = require('ui'),
    WindowStack = require('ui/windowstack'),
    ajax = require('ajax'),
    Settings = require('settings'),
    Voice = require('ui/voice'),
    HAWS = hawsFaker ? require('vendor/haws_faker') : require('vendor/haws'),
    FavoriteEntityStore = require('vendor/FavoriteEntityStore'),
    Feature = require('platform/feature'),
    Vector = require('vector2'),
    sortJSON = require('vendor/sortjson'),
    Light = require('ui/light'),
    enableIcons = true,
    sortObjectByKeys = function(object) {
        return Object.fromEntries(
            Object.entries(object).sort(function(a, b) {
                return a[0] < b[0] ? -1 : 1;
            })
        );
    },
    cloneObject = function(obj) {
        if (null == obj || "object" != typeof obj) return obj;
        var copy = obj.constructor();
        for (var attr in obj) {
            if (obj.hasOwnProperty(attr)) copy[attr] = obj[attr];
        }
        return copy;
    },
    ucword = function( str ){
        return str.replace(/^\w/, function(s) { return s.toUpperCase() });
    },
    ucwords = function( str ){
        return str.replace(/(\b\w)/g, function(s) { return s.toUpperCase() } );
    }
colour = {
    highlight: Feature.color("#00AAFF", "#000000"),
    highlight_text: Feature.color("black", "white")
};

// Add to global variables
let ha_pipelines = [],
    preferred_pipeline = null,
    selected_pipeline = null;

// only call console.log if debug is enabled
function log_message(msg, extra) {
    if(!debugMode) return;

    if(extra){
        console.log(`[App] ${msg}`, extra);
        return;
    }

    console.log(`[App] ${msg}`);
}

log_message('Started!' + appVersion);
log_message('   Version: v' + appVersion);
log_message('   AccountToken:' + Pebble.getAccountToken());
// log_message('   TimelineToken:' + Pebble.getTimelineToken());

Settings.config({
        url: 'https://skylar.tech/uploads/wrist-ha-' + confVersion + '.htm',
    },
    function(e) {
        log_message('opened configurable');
    },
    function(e) {
        log_message('closed configurable');

        // Show the parsed response
        log_message('returned_settings: ' + JSON.stringify(e.options));
        Settings.option(e.options);

        // Show the raw response if parsing failed
        if (e.failed) {
            log_message(e.response);
        }

        // reload settings
        load_settings();
        // @todo restart HAWS after config is saved on phone
        // @todo need some way of resetting all the windows in the app
    }
);

// Set some variables for quicker access
let ha_url = null,
    ha_password = null,
    ha_refresh_interval = null,
    ha_filter = null,
    ha_order_by = null,
    ha_order_dir = null,
    voice_enabled = null,
    voice_confirm = null,
    voice_agent = null,
    domain_menu_enabled = null,
    domain_menu_all_entities = null,
    domain_menu_areas = null,
    domain_menu_labels = null,
    domain_menu_favorites = null,
    domain_menu_min_entities = null,
    domain_menu_min_domains = null,
    timeline_token = null,
    ignore_domains = null,
    ha_connected = false;

function load_settings() {
    // Set some variables for quicker access
    ha_url = Settings.option('ha_url');
    ha_password = Settings.option('token');
    ha_refresh_interval = Settings.option('refreshTime') ? Settings.option('refreshTime') : 15;
    ha_filter = Settings.option('filter');
    ha_order_by = Settings.option('order_by');
    ha_order_dir = Settings.option('order_dir');
    voice_enabled = Feature.microphone(true, false) && Settings.option('voice_enabled') !== false;
    voice_confirm = Settings.option('voice_confirm');
    voice_agent = Settings.option('voice_agent') ? Settings.option('voice_agent') : null;

    // Domain menu settings
    const domainMenuSetting = Settings.option('domain_menu_enabled');
    domain_menu_enabled = domainMenuSetting !== undefined ? domainMenuSetting : 'conditional';

    // Specific domain menu settings for different sections
    domain_menu_all_entities = Settings.option('domain_menu_all_entities');
    domain_menu_all_entities = domain_menu_all_entities !== undefined ? domain_menu_all_entities : domain_menu_enabled;

    domain_menu_areas = Settings.option('domain_menu_areas');
    domain_menu_areas = domain_menu_areas !== undefined ? domain_menu_areas : domain_menu_enabled;

    domain_menu_labels = Settings.option('domain_menu_labels');
    domain_menu_labels = domain_menu_labels !== undefined ? domain_menu_labels : domain_menu_enabled;

    domain_menu_favorites = Settings.option('domain_menu_favorites');
    domain_menu_favorites = domain_menu_favorites !== undefined ? domain_menu_favorites : domain_menu_enabled;

    // Conditional settings
    domain_menu_min_entities = Settings.option('domain_menu_min_entities');
    domain_menu_min_entities = domain_menu_min_entities !== undefined ? domain_menu_min_entities : 10;

    domain_menu_min_domains = Settings.option('domain_menu_min_domains');
    domain_menu_min_domains = domain_menu_min_domains !== undefined ? domain_menu_min_domains : 2;

    ha_connected = Settings.option('ha_connected') || false;

    // Handle ignore_domains
    ignore_domains = Settings.option('ignore_domains');
    if (ignore_domains === undefined || ignore_domains === null) {
        // Use defaults if not set
        ignore_domains = DEFAULT_IGNORE_DOMAINS;
    } else if (!Array.isArray(ignore_domains)) {
        // Handle case where it might be a string or other type
        try {
            ignore_domains = JSON.parse(ignore_domains);
        } catch(e) {
            log_message('Error parsing ignore_domains, using defaults: ' + e);
            ignore_domains = DEFAULT_IGNORE_DOMAINS;
        }
    }
    // If ignore_domains is an empty array, respect user's choice to show all domains
    log_message('Ignore domains: ' + JSON.stringify(ignore_domains));

    // Update Voice Pipeline handling
    selected_pipeline = Settings.option('selected_pipeline');

    Pebble.getTimelineToken(function(token) {
        log_message('Timeline token: ' + token);
        timeline_token = token;
        Settings.option("timeline_token", token);
    }, function(error) {
        console.log('Error getting timeline token: ' + error);
    });
}

let haws = null,
    baseurl = null,
    baseheaders = null,
    area_registry_cache = null,
    device_registry_cache = null,
    entity_registry_cache = null,
    favoriteEntityStore = new FavoriteEntityStore(),
    label_registry_cache = null;

let device_status,
    ha_state_cache = null,
    ha_state_dict = null,
    ha_state_cache_updated = null,
    saved_windows = null;
//let events;

log_message('ha_url: ' + baseurl);

// Initial screen
let loadingCard = new UI.Card({
    title: 'Home Assistant WS v' + appVersion
});

let mainMenu = null;
function showMainMenu() {
    if(!mainMenu) {
        mainMenu = new UI.Menu({
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Home Assistant',
                backgroundColor: colour.highlight,
                textColor: colour.highlight_text
            }]
        });

        mainMenu.on('show', function(){
            mainMenu.items(0, []);

            // add items to menu
            let i = 0;
            if(voice_enabled) {
                mainMenu.item(0, i++, {
                    title: "Assistant",
                    // subtitle: thisDevice.attributes[arr[i]],
                    on_click: function(e) {
                        showAssistMenu();
                    }
                });
            }
            let favoriteEntities = favoriteEntityStore.all();
            if(favoriteEntities && favoriteEntities.length) {
                mainMenu.item(0, i++, {
                    title: "Favorites",
                    // subtitle: thisDevice.attributes[arr[i]],
                    on_click: function(e) {
                        // Check if we should show domains based on settings for Favorites
                        const shouldShowDomains = shouldShowDomainMenu(favoriteEntities, domain_menu_favorites);

                        if(shouldShowDomains) {
                            showEntityDomainsFromList(favoriteEntities, "Favorites");
                        } else {
                            showEntityList("Favorites", favoriteEntities, true, false, true);
                        }
                    }
                });
            }
            mainMenu.item(0, i++, {
                title: "Areas",
                // subtitle: thisDevice.attributes[arr[i]],
                on_click: function(e) {
                    showAreaMenu();
                }
            });
            mainMenu.item(0, i++, {
                title: "Labels",
                // subtitle: thisDevice.attributes[arr[i]],
                on_click: function(e) {
                    showLabelMenu();
                }
            });
            mainMenu.item(0, i++, {
                title: "All Entities",
                // subtitle: thisDevice.attributes[arr[i]],
                on_click: function(e) {
                    const entityKeys = Object.keys(ha_state_dict);
                    // Use the specific setting for All Entities
                    const shouldShowDomains = shouldShowDomainMenu(entityKeys, domain_menu_all_entities);

                    if(shouldShowDomains) {
                        showEntityDomainsFromList(entityKeys, "All Entities");
                    } else {
                        showEntityList("All Entities", false, true, true, true);
                    }
                }
            });

            // Add Settings menu item at the bottom
            mainMenu.item(0, i++, {
                title: "Settings",
                on_click: function(e) {
                    showSettingsMenu();
                }
            });
        });

        // menu item pressed, if it has an event fn call it
        mainMenu.on('select', function(e) {
            log_message("Main menu click: " + e.item.title);
            if(typeof e.item.on_click == 'function') {
                e.item.on_click(e);
            } else {
                log_message("No click function for main menu item " + e.title);
            }
        });

        mainMenu.show();
    }
}

function showSettingsMenu() {
    // Create a menu for settings
    let settingsMenu = new UI.Menu({
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Settings',
            backgroundColor: colour.highlight,
            textColor: colour.highlight_text
        }]
    });

    settingsMenu.on('show', function() {
        // Clear the menu
        settingsMenu.items(0, []);

        let i = 0;

        // Only show Assistant settings if we have microphone support
        if ( Feature.microphone(true, false) ) {
            settingsMenu.item(0, i++, {
                title: "Assistant",
                on_click: function(e) {
                    showVoiceAssistantSettings();
                }
            });
        }

        settingsMenu.item(0, i++, {
            title: "Entity Settings",
            on_click: function(e) {
                showEntitySettings();
            }
        });

        settingsMenu.item(0, i++, {
            title: "Domain Filters",
            on_click: function(e) {
                showDomainFilterSettings();
            }
        });
    });

    settingsMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    settingsMenu.show();
}

function showDomainFilterSettings() {
    // Create a menu for domain filter settings
    let domainFilterMenu = new UI.Menu({
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Ignored Domains'
        }]
    });

    domainFilterMenu.on('show', function() {
        // Clear the menu
        domainFilterMenu.items(0, []);

        // Add heading with instruction
        domainFilterMenu.item(0, 0, {
            title: "Long press to remove",
            subtitle: "Settings > Configure"
        });

        // Add each ignored domain to the menu
        let index = 1;
        if (ignore_domains && ignore_domains.length > 0) {
            for (let i = 0; i < ignore_domains.length; i++) {
                domainFilterMenu.item(0, index++, {
                    title: ignore_domains[i],
                    domain: ignore_domains[i],
                    is_domain: true
                });
            }
        } else {
            domainFilterMenu.item(0, index++, {
                title: "No domains ignored",
                subtitle: "Using all domains"
            });
        }

        // Add reset option
        domainFilterMenu.item(0, index, {
            title: "Reset to defaults",
            on_click: function(e) {
                // Reset to defaults
                ignore_domains = DEFAULT_IGNORE_DOMAINS; // create a copy
                Settings.option('ignore_domains', ignore_domains);
                domainFilterMenu.hide(); // Close menu and reopen to refresh
                showDomainFilterSettings();
            }
        });
    });

    // Handle long press to remove a domain
    domainFilterMenu.on('longSelect', function(e) {
        if (e.item.is_domain) {
            const domain = e.item.domain;
            const index = ignore_domains.indexOf(domain);
            if (index !== -1) {
                ignore_domains.splice(index, 1);
                Settings.option('ignore_domains', ignore_domains);
                // Refresh the menu
                domainFilterMenu.hide();
                showDomainFilterSettings();
            }
        }
    });

    domainFilterMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    domainFilterMenu.show();
}

function showVoiceAssistantSettings() {
    // Create a menu for assistant settings
    const voiceSettingsMenu = new UI.Menu({
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Assistant Settings'
        }]
    });

    function updateMenuItems() {
        // Clear the menu
        voiceSettingsMenu.items(0, []);
        let menuIndex = 0;

        // Enabled setting
        voiceSettingsMenu.item(0, menuIndex++, {
            title: "Enabled",
            subtitle: voice_enabled ? "True" : "False",
            on_click: function(e) {
                voice_enabled = !voice_enabled;
                Settings.option('voice_enabled', voice_enabled);
                updateMenuItems();
            }
        });

        // Font Size setting
        const initialFontSize = Settings.option('voice_font_size') || 18;
        voiceSettingsMenu.item(0, menuIndex++, {
            title: "Font Size",
            subtitle: initialFontSize + "px",
            on_click: function(e) {
                // Get the current font size each time
                const currentFontSize = Settings.option('voice_font_size') || 18;

                // Cycle through available sizes: 14 -> 18 -> 24 -> 28
                const availableSizes = [14, 18, 24, 28];
                const currentIndex = availableSizes.indexOf(currentFontSize);
                const nextSize = availableSizes[(currentIndex + 1) % availableSizes.length];
                Settings.option('voice_font_size', nextSize);

                // Update only this menu item instead of entire menu
                voiceSettingsMenu.item(0, e.itemIndex, {
                    title: "Font Size",
                    subtitle: nextSize + "px",
                    on_click: e.item.on_click
                });
            }
        });

        // Agent setting
        let currentAgentName = "Home Assistant";
        if (selected_pipeline && ha_pipelines) {
            const pipeline = ha_pipelines.find(p => p.id === selected_pipeline);
            if (pipeline) {
                currentAgentName = pipeline.name;
            }
        }

        voiceSettingsMenu.item(0, menuIndex++, {
            title: "Pipeline",
            subtitle: currentAgentName,
            on_click: function(e) {
                showVoicePipelineMenu();
            }
        });

        // Confirm Dictate setting
        voiceSettingsMenu.item(0, menuIndex++, {
            title: "Confirm Dictation",
            subtitle: voice_confirm ? "True" : "False",
            on_click: function(e) {
                voice_confirm = !voice_confirm;
                Settings.option('voice_confirm', voice_confirm);
                updateMenuItems();
            }
        });
    }

    voiceSettingsMenu.on('show', updateMenuItems);
    voiceSettingsMenu.on('select', function(e) {
        if(typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    voiceSettingsMenu.show();
}

function showEntitySettings() {
    // Entity Settings Menu
    function createEntitySettingsMenu() {
        let entitySettingsMenu = new UI.Menu({
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Entity Settings'
            }]
        });

        entitySettingsMenu.on('show', function() {
            // Clear the menu
            entitySettingsMenu.items(0, []);

            // Add Order By setting
            let orderByText = "Name";
            if (ha_order_by === "entity_id") {
                orderByText = "Entity ID";
            } else if (ha_order_by === "attributes.last_updated") {
                orderByText = "Last Updated";
            }

            entitySettingsMenu.item(0, 0, {
                title: "Order By",
                subtitle: orderByText,
                on_click: function(e) {
                    showOrderByMenu();
                }
            });

            // Add Order Direction setting
            entitySettingsMenu.item(0, 1, {
                title: "Order Direction",
                subtitle: ha_order_dir === "desc" ? "Descending" : "Ascending",
                on_click: function(e) {
                    // Toggle order direction
                    ha_order_dir = ha_order_dir === "desc" ? "asc" : "desc";
                    // Save to settings
                    Settings.option('order_dir', ha_order_dir);

                    // Update menu item
                    entitySettingsMenu.item(0, 1, {
                        title: "Order Direction",
                        subtitle: ha_order_dir === "desc" ? "Descending" : "Ascending",
                        on_click: e.item.on_click
                    });
                }
            });
        });

        entitySettingsMenu.on('select', function(e) {
            if(typeof e.item.on_click == 'function') {
                e.item.on_click(e);
            }
        });

        return entitySettingsMenu;
    }

    // Order By Menu
    function showOrderByMenu() {
        let orderByMenu = new UI.Menu({
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Order By'
            }]
        });

        orderByMenu.on('show', function() {
            // Clear the menu
            orderByMenu.items(0, []);

            // Add options
            orderByMenu.item(0, 0, {
                title: "Name",
                subtitle: ha_order_by === "attributes.friendly_name" ? "Current" : "",
                value: "attributes.friendly_name"
            });

            orderByMenu.item(0, 1, {
                title: "Entity ID",
                subtitle: ha_order_by === "entity_id" ? "Current" : "",
                value: "entity_id"
            });

            orderByMenu.item(0, 2, {
                title: "Last Updated",
                subtitle: ha_order_by === "attributes.last_updated" ? "Current" : "",
                value: "attributes.last_updated"
            });
        });

        orderByMenu.on('select', function(e) {
            // Set the order by value
            ha_order_by = e.item.value;

            // Save to settings
            Settings.option('order_by', ha_order_by);

            // Close the menu after a brief delay to show the selection
            setTimeout(function() {
                orderByMenu.hide();
            }, 500);
        });

        orderByMenu.show();
    }

    // Create and show the entity settings menu
    let entitySettingsMenu = createEntitySettingsMenu();
    entitySettingsMenu.show();
}

function showVoicePipelineMenu() {
    // Create a menu for selecting Voice Pipelines
    let voicePipelineMenu = new UI.Menu({
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Assist Pipeline'
        }]
    });

    voicePipelineMenu.on('show', function() {
        // Clear the menu
        voicePipelineMenu.items(0, []);

        for (let i = 0; i < ha_pipelines.length; i++) {
            const pipeline = ha_pipelines[i];
            let subtitle = '';

            // Determine subtitle based on current and preferred status
            if (selected_pipeline === pipeline.id && preferred_pipeline === pipeline.id) {
                subtitle = 'Current - Preferred';
            } else if (selected_pipeline === pipeline.id) {
                subtitle = 'Current';
            } else if (preferred_pipeline === pipeline.id) {
                subtitle = 'Preferred';
            }

            voicePipelineMenu.item(0, i, {
                title: pipeline.name,
                subtitle: subtitle,
                pipeline_id: pipeline.id
            });
        }
    });

    voicePipelineMenu.on('select', function(e) {
        selected_pipeline = e.item.pipeline_id;
        Settings.option('selected_pipeline', selected_pipeline);

        // Update menu items
        for (let i = 0; i < voicePipelineMenu.items(0).length; i++) {
            const item = voicePipelineMenu.item(0, i);
            let subtitle = '';

            // Determine subtitle based on current and preferred status
            if (selected_pipeline === item.pipeline_id && preferred_pipeline === item.pipeline_id) {
                subtitle = 'Current - Preferred';
            } else if (selected_pipeline === item.pipeline_id) {
                subtitle = 'Current';
            } else if (preferred_pipeline === item.pipeline_id) {
                subtitle = 'Preferred';
            }

            voicePipelineMenu.item(0, i, {
                title: item.title,
                subtitle: subtitle,
                pipeline_id: item.pipeline_id
            });
        }

        // Close the menu after a brief delay to show the selection
        setTimeout(function() {
            voicePipelineMenu.hide();
        }, 500);
    });

    voicePipelineMenu.show();
}


// Add this new function to check for conversation agents
function loadAssistPipelines(callback) {
    haws.getPipelines(
        function(data) {
            if (!data.success) {
                log_message("Failed to get pipelines");
                callback(false);
                return;
            }

            ha_pipelines = data.result.pipelines;
            preferred_pipeline = data.result.preferred_pipeline;

            // Save pipelines to settings for config page
            const pipelineOptions = ha_pipelines.map(p => ({
                id: p.id,
                name: p.name,
                preferred: p.id === preferred_pipeline
            }));
            Settings.option('available_pipelines', pipelineOptions);

            // If we have a previous voice_agent setting, try to match it to a pipeline
            if (voice_agent && !selected_pipeline) {
                const matchingPipeline = ha_pipelines.find(p =>
                    p.conversation_engine === voice_agent
                );
                if (matchingPipeline) {
                    selected_pipeline = matchingPipeline.id;
                }
            }

            // If no pipeline selected, use preferred
            if (!selected_pipeline && preferred_pipeline) {
                selected_pipeline = preferred_pipeline;
            }

            // Save selected pipeline
            if (selected_pipeline) {
                Settings.option('selected_pipeline', selected_pipeline);
            }

            callback(true);
        },
        function(error) {
            log_message("Error getting pipelines: " + error);
            callback(false);
        }
    );
}

let conversation_id = null;
function showAssistMenu() {
    if (!selected_pipeline) {
        let errorCard = new UI.Card({
            title: 'Assistant Error',
            body: 'No assist pipeline available. Please configure Home Assistant Assist.',
            scrollable: true
        });

        errorCard.on('click', 'back', function() {
            errorCard.hide();
        });

        errorCard.show();
        return;
    }

    let assistWindow = new UI.Window({
        backgroundColor: Feature.color('white', 'black'),
        scrollable: true
    });

    // Configuration for message spacing
    let MESSAGE_PADDING = 0; // Padding between messages
    let SCROLL_PADDING = 0; // Padding at the bottom when scrolling

    // Message keys for scrolling
    const MESSAGE_KEY_SCROLL_Y = 1000;
    const MESSAGE_KEY_ANIMATED = 1001;

    // Custom scrolling function for the window
    function scrollWindowTo(window, y, animated = false) {
        if (!window || !window.state || !window.state.scrollable) {
            log_message('Cannot scroll a non-scrollable window');
            return;
        }

        // Negative values scroll down (content moves up)
        const scrollY = -y;

        // Create message payload
        var payload = {};
        payload[MESSAGE_KEY_SCROLL_Y] = scrollY;
        payload[MESSAGE_KEY_ANIMATED] = animated ? 1 : 0;

        // Send a message to the watch to scroll the window
        Pebble.sendAppMessage(payload, function() {
            log_message('Scroll message sent successfully to ' + scrollY);
        }, function(e) {
            log_message('Error sending scroll message: ' + e.error);
        });
    }

    let currentY = 24; // Start position below title bar
    let conversationElements = []; // Track all elements for cleanup
    let currentErrorMessage = null; // Track current error message element
    let errorMessageHeight = 0; // Track the height of the error message

    // Add a title bar
    let titleBar = new UI.Text({
        position: new Vector(0, 0),
        size: new Vector(Feature.resolution().x, 24),
        text: 'Assistant',
        font: 'gothic-18-bold',
        color: Feature.color('black', 'white'),
        textAlign: 'center',
        backgroundColor: colour.highlight
    });
    assistWindow.add(titleBar);

    // Loading animation dots
    let loadingDots = [];
    const DOT_SIZE = 8; // Size of each dot
    const DOT_SPACING = 12; // Space between dots
    const DOT_COLOR = Feature.color('#0000FF', '#FFFFFF');

    // Create three dots for the animation
    for (let i = 0; i < 3; i++) {
        loadingDots.push(new UI.Circle({
            position: new Vector(0, 0), // Will be positioned when shown
            radius: DOT_SIZE / 2,
            backgroundColor: DOT_COLOR
        }));
    }

    function showError(message) {
        if (currentErrorMessage) {
            assistWindow.remove(currentErrorMessage.title);
            assistWindow.remove(currentErrorMessage.message);
            // Reset error message height
            errorMessageHeight = 0;
        }

        // Add error title
        let errorTitle = new UI.Text({
            position: new Vector(5, currentY),
            size: new Vector(Feature.resolution().x - 10, 20),
            text: 'Error:',
            font: 'gothic-18-bold',
            color: Feature.color('red', 'white'),
            textAlign: 'left'
        });

        // Add error message
        let errorMessage = new UI.Text({
            position: new Vector(5, currentY + 20),
            size: new Vector(Feature.resolution().x - 10, 1000),
            text: message,
            font: 'gothic-18',
            color: Feature.color('red', 'white'),
            textAlign: 'left',
            textOverflow: 'wrap'
        });

        assistWindow.add(errorTitle);
        conversationElements.push(errorTitle);

        // Get the actual height of the error message
        errorMessage.getHeight(function(height) {
            // Ensure we have a reasonable height (minimum 20px)
            height = Math.max(height, 20);

            // Log the calculated height for debugging
            log_message("Text height calculation for error: " + height + "px for text: " + message.substring(0, 30) + "...");

            // Update the error message element size with the actual height
            // Add extra padding to ensure text isn't cut off
            errorMessage.size(new Vector(Feature.resolution().x - 10, height + 10));

            // Add the error message to the window
            assistWindow.add(errorMessage);
            conversationElements.push(errorMessage);

            currentErrorMessage = {
                title: errorTitle,
                message: errorMessage
            };

            // Update position for next message with configurable padding
            currentY += height + MESSAGE_PADDING; // title (20) + message height + padding
            log_message("New currentY position for error: " + currentY);

            // Store the total height of the error message for later adjustment
            errorMessageHeight = height + 20; // Text height + error title
            log_message("Stored error message height: " + errorMessageHeight);

            // Update the window's content size to ensure proper scrolling
            // Add more padding at the bottom to ensure content isn't cut off
            const contentHeight = currentY + 20; // Add 20px padding at the bottom
            assistWindow.size(new Vector(Feature.resolution().x, contentHeight));
            log_message("Updated error window size to: " + contentHeight + " for currentY: " + currentY);

            // Store positions for scrolling reference
            const messageBottom = currentY;
            const messageHeight = height + 20; // Text height + error title
            const messageTop = messageBottom - messageHeight;
            const screenHeight = Feature.resolution().y;

            // Determine how to scroll based on message size
            let scrollTarget;

            // If the message is taller than the display, scroll to show the title at the top
            if (messageHeight > screenHeight * 0.8) { // If message takes up more than 80% of screen
                // Scroll to the title position (error title)
                scrollTarget = messageTop - 5; // 5px padding above title
                log_message("Long error message detected (" + messageHeight + "px), scrolling to title at position: " + scrollTarget);
            } else {
                // For shorter messages, scroll to show the bottom with padding
                scrollTarget = messageBottom - screenHeight + 5; // 5px padding
                log_message("Normal error message, scrolling to bottom: " + scrollTarget);
            }

            // Only scroll if needed
            if (scrollTarget > 0) {
                // Add a small delay before scrolling to ensure the UI is updated
                setTimeout(function() {
                    // Use our custom scrolling function
                    scrollWindowTo(assistWindow, scrollTarget, true);
                    log_message("Scrolling error to target: " + scrollTarget);
                }, 100);
            }

            log_message("Error message added, content height: " + currentY);
        });
    }

    // Get configured font size or default to 18
    const FONT_SIZE = Settings.option('voice_font_size') || 18;

    // Define fonts based on size
    const SPEAKER_FONT = `gothic-${FONT_SIZE}-bold`;
    const MESSAGE_FONT = `gothic-${FONT_SIZE}`;

    // Update the existing MESSAGE_PADDING value based on font size
    // MESSAGE_PADDING = Math.max(0, (FONT_SIZE - 18) * 2); // Increase padding with larger fonts
    const SPEAKER_HEIGHT = FONT_SIZE + 2; // Base height for speaker label

    function getDisplayName(speaker) {
        // Use shorter name for Home Assistant when font size is large
        if (speaker === "Home Assistant" && FONT_SIZE > 18) {
            return "HA";
        }
        return speaker;
    }

    function addMessage(speaker, message, callback) {
        log_message("Adding message from " + speaker + ": " + message);

        // Remove error message if exists
        if (currentErrorMessage) {
            assistWindow.remove(currentErrorMessage.title);
            assistWindow.remove(currentErrorMessage.message);

            // Adjust currentY to remove the gap left by the error message
            if (errorMessageHeight > 0) {
                currentY -= errorMessageHeight;
                log_message("Adjusted currentY after removing error: " + currentY);
                errorMessageHeight = 0;
            }

            currentErrorMessage = null;
        }

        try {
            const speakerId = Math.floor(Math.random() * 100000);
            const messageId = Math.floor(Math.random() * 100000);

            // Add speaker label with display name
            let speakerLabel = new UI.Text({
                id: speakerId,
                position: new Vector(5, currentY),
                size: new Vector(Feature.resolution().x - 10, SPEAKER_HEIGHT),
                text: getDisplayName(speaker) + ':',
                font: SPEAKER_FONT,
                color: Feature.color('black', 'white'),
                textAlign: 'left'
            });
            assistWindow.add(speakerLabel);
            conversationElements.push(speakerLabel);

            // Add message text
            let messageText = new UI.Text({
                id: messageId,
                position: new Vector(5, currentY + SPEAKER_HEIGHT),
                size: new Vector(Feature.resolution().x - 10, 2000),
                text: message,
                font: MESSAGE_FONT,
                color: Feature.color('black', 'white'),
                textAlign: 'left',
                textOverflow: 'wrap'
            });

            messageText.getHeight(function(height) {
                height = Math.max(height, FONT_SIZE); // Changed from fontSize to FONT_SIZE
                messageText.size(new Vector(Feature.resolution().x - 10, height + 10));
                assistWindow.add(messageText);
                conversationElements.push(messageText);

                // Update position with adjusted padding
                currentY += SPEAKER_HEIGHT + height + MESSAGE_PADDING;

                // Update window content size
                const contentHeight = currentY + 20;
                assistWindow.size(new Vector(Feature.resolution().x, contentHeight));
                log_message("Updated window size to: " + contentHeight + " for currentY: " + currentY);

                // Store positions for scrolling reference
                const messageBottom = currentY;
                const messageHeight = height + 20; // Text height + speaker label
                const messageTop = messageBottom - messageHeight;
                const screenHeight = Feature.resolution().y;

                // Determine how to scroll based on message size
                let scrollTarget;

                // If the message is taller than the display, scroll to show the title at the top
                if (messageHeight > screenHeight * 0.8) { // If message takes up more than 80% of screen
                    // Scroll to the title position (speaker label)
                    scrollTarget = messageTop - 5; // 5px padding above title
                    log_message("Long message detected (" + messageHeight + "px), scrolling to title at position: " + scrollTarget);
                } else {
                    // For shorter messages, scroll to show the bottom with padding
                    scrollTarget = messageBottom - screenHeight + 5; // 5px padding
                    log_message("Normal message, scrolling to bottom: " + scrollTarget);
                }

                // Only scroll if needed
                if (scrollTarget > 0) {
                    // Add a small delay before scrolling to ensure the UI is updated
                    setTimeout(function() {
                        // Use our custom scrolling function
                        scrollWindowTo(assistWindow, scrollTarget, true);
                        log_message("Scrolling to target: " + scrollTarget);
                    }, 100);
                }

                log_message("Message added successfully, content height: " + currentY);

                if (callback) {
                    log_message("Executing callback");
                    callback();
                }
            });
        } catch (err) {
            log_message("Error in addMessage: " + err.toString());
            showError('Failed to add message');
        }
    }

    function startLoadingAnimation() {
        // Configuration for message spacing
        const MESSAGE_PADDING = 0; // Padding between messages
        const SCROLL_PADDING = 0; // Padding at the bottom when scrolling

        // Message keys for scrolling
        const MESSAGE_KEY_SCROLL_Y = 1000;
        const MESSAGE_KEY_ANIMATED = 1001;

        // Position dots below the last message, but 20px higher than before
        const centerX = Feature.resolution().x / 2;
        const startY = currentY + 5;

        // Calculate the starting X position for the first dot
        // Center the three dots with spacing
        const startX = centerX - DOT_SPACING - DOT_SIZE/2;

        // Store dot positions for reuse in the animation
        const dotPositions = [];
        for (let i = 0; i < loadingDots.length; i++) {
            const dotX = startX + (i * DOT_SPACING);
            dotPositions.push(new Vector(dotX, startY));
            // Set the position but don't add to window yet
            loadingDots[i].position(dotPositions[i]);
            loadingDots[i].radius(DOT_SIZE / 2); // Set the proper radius
        }

        // Calculate the bottom position of the animation
        const loadingBottom = startY + DOT_SIZE + 10; // Dots position + size + padding

        // Make sure the window is tall enough to show the full animation
        // Add significant extra padding to ensure the animation is fully visible
        assistWindow.size(new Vector(Feature.resolution().x, loadingBottom + 50)); // 50px extra padding
        log_message("Set window size for animation: " + (loadingBottom + 50));

        // Calculate scroll target to ensure the dots are fully visible
        const screenHeight = Feature.resolution().y;

        // Make sure we scroll enough to show the full animation plus padding
        // We want to show the animation with some context above it
        const animationHeight = DOT_SIZE + 20; // Height of dots plus some padding

        // Calculate how much we need to scroll to show the full animation
        // We want the animation to be positioned in the lower part of the screen
        const scrollTarget = loadingBottom - screenHeight + animationHeight;

        // Always scroll to show the animation properly
        // Add a small delay before scrolling to ensure the UI is updated
        setTimeout(function() {
            // Use our custom scrolling function
            scrollWindowTo(assistWindow, scrollTarget, true);
            log_message("Scrolling loading indicator to target: " + scrollTarget);
        }, 100);

        // Animation states
        // 0: first dot only
        // 1: first and second dots
        // 2: all three dots
        // 3: second and third dots
        // 4: third dot only
        let animationState = 0;

        // Start the animation
        return setInterval(function() {
            // Remove all dots from the window first
            for (let i = 0; i < loadingDots.length; i++) {
                assistWindow.remove(loadingDots[i]);
            }

            // Add only the dots that should be visible based on current animation state
            switch (animationState) {
                case 0: // First dot only
                    assistWindow.add(loadingDots[0]);
                    break;
                case 1: // First and second dots
                    assistWindow.add(loadingDots[0]);
                    assistWindow.add(loadingDots[1]);
                    break;
                case 2: // All three dots
                    assistWindow.add(loadingDots[0]);
                    assistWindow.add(loadingDots[1]);
                    assistWindow.add(loadingDots[2]);
                    break;
                case 3: // Second and third dots
                    assistWindow.add(loadingDots[1]);
                    assistWindow.add(loadingDots[2]);
                    break;
                case 4: // Third dot only
                    assistWindow.add(loadingDots[2]);
                    break;
            }

            // Move to next animation state
            animationState = (animationState + 1) % 5;
        }, 300); // Change animation every 300ms
    }

    function stopLoadingAnimation(animationTimer) {
        if (animationTimer) {
            clearInterval(animationTimer);
        }
        // Remove all dots from the window
        for (let i = 0; i < loadingDots.length; i++) {
            assistWindow.remove(loadingDots[i]);
        }
    }

    function startAssist() {
        log_message("startAssist");
        Voice.dictate('start', voice_confirm, function(e) {
            if (e.err) {
                if (e.err === "systemAborted") {
                    log_message("assist cancelled by user");
                    return;
                }
                log_message("Transcription error: " + e.err);
                showError('Transcription error - ' + e.err);
                return;
            }

            log_message("Transcription received: " + e.transcription);

            // Add user's message
            addMessage('Me', e.transcription, function() {
                log_message("Starting API call");
                let animationTimer = startLoadingAnimation();

                const body = {
                    start_stage: "intent",
                    end_stage: "intent",
                    input: {
                        text: e.transcription
                    },
                    pipeline: selected_pipeline,
                    conversation_id: conversation_id,
                    timeout: 30 // Add a 30-second timeout to prevent hanging
                };

                log_message("Sending assist_pipeline/run request");
                haws.runPipeline(body,
                    function(data) {
                        log_message("assist_pipeline/run response: " + JSON.stringify(data));
                        stopLoadingAnimation(animationTimer);

                        if (!data.success) {
                            showError('Request failed');
                            return;
                        }

                        try {
                            // Get the response text and conversation ID
                            const reply = data.response.speech.plain.speech;
                            const conversationId = data.conversation_id;

                            addMessage('Assistant', reply, null);
                            if (conversationId) {
                                conversation_id = conversationId;
                            }
                        } catch (err) {
                            showError('Invalid response format from Home Assistant');
                            log_message("Response format error: " + err.toString());
                        }
                    },
                    function(error) {
                        log_message("conversation/process error: " + JSON.stringify(error));
                        stopLoadingAnimation(animationTimer);

                        // Handle specific error codes from the pipeline
                        if (error && error.code) {
                            switch(error.code) {
                                case 'wake-engine-missing':
                                    showError('No wake word engine installed');
                                    break;
                                case 'wake-provider-missing':
                                    showError('Wake word provider not available');
                                    break;
                                case 'wake-stream-failed':
                                    showError('Wake word detection failed');
                                    break;
                                case 'wake-word-timeout':
                                    showError('Wake word detection timed out');
                                    break;
                                case 'stt-provider-missing':
                                    showError('Speech-to-text provider not available');
                                    break;
                                case 'stt-provider-unsupported-metadata':
                                    showError('Unsupported audio format');
                                    break;
                                case 'stt-stream-failed':
                                    showError('Speech-to-text failed');
                                    break;
                                case 'stt-no-text-recognized':
                                    showError('No speech detected');
                                    break;
                                case 'intent-not-supported':
                                    showError('Conversation agent not available');
                                    break;
                                case 'intent-failed':
                                    showError('Intent recognition failed');
                                    break;
                                case 'tts-not-supported':
                                    showError('Text-to-speech not available');
                                    break;
                                case 'tts-failed':
                                    showError('Text-to-speech failed');
                                    break;
                                default:
                                    showError(error.error || 'Connection error');
                            }
                        } else {
                            showError(error.error || 'Connection error');
                        }
                    }
                );
            });
        });
    }

    assistWindow.on('click', 'select', function(e) {
        log_message("Assist button pressed", e);
        startAssist();
    });

    assistWindow.on('longClick', 'select', showVoicePipelineMenu);

    assistWindow.on('show', function() {
        startAssist();
    });

    assistWindow.on('hide', function() {
        conversation_id = null;
    });

    assistWindow.show();
}

let areaMenu = null;
function showAreaMenu() {
    if(!areaMenu) {
        areaMenu = new UI.Menu({
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Areas'
            }]
        });

        areaMenu.on('show', function(e){
            // Create an array of area entries to sort
            let areaEntries = [];
            for(let area_id in area_registry_cache) {
                let area_name = area_registry_cache[area_id];
                let display_name = area_name ? area_name : 'Unassigned';
                let areaObjects = getEntitiesForArea(area_name ? area_id : null);
                let areaObjectCount = Object.keys(areaObjects).length;

                areaEntries.push({
                    area_id: area_id,
                    display_name: display_name,
                    areaObjectCount: areaObjectCount,
                    isUnassigned: !area_name
                });
            }

            // Sort areas by display_name, with Unassigned at the bottom
            areaEntries.sort(function(a, b) {
                // If one is Unassigned, it goes at the bottom
                if (a.isUnassigned && !b.isUnassigned) return 1;
                if (!a.isUnassigned && b.isUnassigned) return -1;

                // Otherwise, sort alphabetically by display_name
                return a.display_name.localeCompare(b.display_name);
            });

            // Add items to menu
            for(let i = 0; i < areaEntries.length; i++) {
                let entry = areaEntries[i];

                areaMenu.item(0, i, {
                    title: entry.display_name,
                    subtitle: `${entry.areaObjectCount} ${(entry.areaObjectCount > 1 || entry.areaObjectCount === 0) ? 'entities' : 'entity'}`,
                    on_click: function(e) {
                        // Get area_id, considering special case for Unassigned
                        let targetAreaId = entry.isUnassigned ? null : entry.area_id;
                        let areaObjects = getEntitiesForArea(targetAreaId);
                        const entityKeys = Object.keys(areaObjects);

                        // Use the specific setting for Areas
                        const shouldShowDomains = shouldShowDomainMenu(entityKeys, domain_menu_areas);

                        if(shouldShowDomains) {
                            showEntityDomainsFromList(entityKeys, entry.display_name);
                        } else {
                            showEntityList(entry.display_name, entityKeys, true, true, true);
                        }
                    }
                });
            }
        });

        // menu item pressed, if it has an event fn call it
        areaMenu.on('select', function(e) {
            if(typeof e.item.on_click == 'function') {
                e.item.on_click(e);
            } else {
                log_message("No click function for main menu item " + e.title);
            }
        });
    }

    areaMenu.show();
}

function showLabelMenu() {
    let labelMenu = new UI.Menu({
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Labels'
        }]
    });

    labelMenu.on('show', function(e) {
        // Sort labels by name
        let sortedLabels = Object.values(label_registry_cache)
            .filter(label => label && label.name) // Ensure valid labels
            .sort((a, b) => a.name.localeCompare(b.name));

        if (sortedLabels.length === 0) {
            labelMenu.item(0, 0, {
                title: 'No Labels Found',
                subtitle: 'No labels are configured'
            });
        } else {
            for(let i = 0; i < sortedLabels.length; i++) {
                let label = sortedLabels[i];
                let entities = getEntitiesForLabel(label.label_id);
                let entityCount = Object.keys(entities).length;

                labelMenu.item(0, i, {
                    title: label.name,
                    subtitle: `${entityCount} ${(entityCount > 1 || entityCount === 0) ? 'entities' : 'entity'}`,
                    on_click: function(e) {
                        showEntitiesForLabel(label.label_id);
                    }
                });
            }
        }
    });

    // menu item pressed, if it has an event fn call it
    labelMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        } else {
            log_message("No click function for label menu item " + e.title);
        }
    });

    labelMenu.show();
}

function showEntitiesForLabel(label_id) {
    let entities = getEntitiesForLabel(label_id);
    let label = label_registry_cache[label_id];

    if(!entities) {
        return;
    }

    const entityKeys = Object.keys(entities);

    // Use the specific setting for Labels
    const shouldShowDomains = shouldShowDomainMenu(entityKeys, domain_menu_labels);

    if(shouldShowDomains) {
        showEntityDomainsFromList(entityKeys, label.name);
    } else {
        showEntityList(label.name, entityKeys, true, true, true);
    }
}

function getEntitiesForLabel(label_id) {
    if(!entity_registry_cache) {
        return false;
    }

    const results = {};
    for (const entity_id in entity_registry_cache) {
        let entity = entity_registry_cache[entity_id];
        if (entity.labels && entity.labels.includes(label_id)) {
            results[entity_id] = entity;
        }
    }

    return results;
}

//{
//     "entity_id": "media_player.chromecast1079",
//     "state": "playing",
//     "attributes": {
//         "volume_level": 0.7693484425544739,
//         "is_volume_muted": false,
//         "media_content_id": "uA3C-PlTaiQ",
//         "media_duration": 1001.281,
//         "media_position": 571.375,
//         "media_position_updated_at": "2022-08-28T09:30:54.052091+00:00",
//         "media_title": "The VICE Guide to Vegas Pt 3: Cannabis Tours, Strip Clubs and Fake Bruno Mars",
//         "app_id": "233637DE",
//         "app_name": "YouTube",
//         "entity_picture_local": "/api/media_player_proxy/media_player.chromecast1079?token=152e620ced2b03b1fca74ac9b8eccf4847705503e2b4831a28c59f2d901885d4&cache=c53739a106b0d891",
//         "entity_picture": "https://i.ytimg.com/vi/uA3C-PlTaiQ/maxresdefault.jpg",
//         "friendly_name": "Living Room TV",
//         "supported_features": 152463
//     },
//     "last_changed": "2022-08-28T09:30:54.052599+00:00",
//     "last_updated": "2022-08-28T09:30:54.052599+00:00",
//     "context": {
//         "id": "01GBHWMB741BRKJ91JF8C6PZJS",
//         "parent_id": null,
//         "user_id": null
//     }
// }
function showMediaPlayerEntity(entity_id) {
    let mediaPlayer = ha_state_dict[entity_id],
        subscription_msg_id = null;
    if (!mediaPlayer) {
        throw new Error(`Media player entity ${entity_id} not found in ha_state_dict`);
    }

    const PAUSE = 'Pause',
        SEEK = "Seek",
        VOLUME_SET = "Volume Set",
        VOLUME_MUTE = "Volume Mute",
        PREVIOUS_TRACK = "Previous Track",
        NEXT_TRACK = "Next Track",
        TURN_ON = "Turn On",
        TURN_OFF = "Turn Off",
        PLAY_MEDIA = "Play Media",
        VOLUME_STEP = "Volume Step",
        SELECT_SOURCE = "Select Source",
        STOP = "Stop",
        CLEAR_PLAYLIST = "Clear Playlist",
        PLAY = "Play",
        SHUFFLE_SET = "Shuffle Set",
        SELECT_SOUND_MODE = "Select Sound Mode",
        BROWSE_MEDIA = "Browse Media",
        REPEAT_SET = "Repeat Set",
        GROUPING = "Grouping";
    // Supported features helper remains the same.
    function supported_features(entity) {
        let features = {
            1: PAUSE,
            2: SEEK,
            4: VOLUME_SET,
            8: VOLUME_MUTE,
            16: PREVIOUS_TRACK,
            32: NEXT_TRACK,
            128: TURN_ON,
            256: TURN_OFF,
            512: PLAY_MEDIA,
            1024: VOLUME_STEP,
            2048: SELECT_SOURCE,
            4096: STOP,
            8192: CLEAR_PLAYLIST,
            16384: PLAY,
            32768: SHUFFLE_SET,
            65536: SELECT_SOUND_MODE,
            131072: BROWSE_MEDIA,
            262144: REPEAT_SET,
            524288: GROUPING,
        };
        let supported = [];
        for (let key in features) {
            if (!!(entity.attributes.supported_features & key)) {
                supported.push(features[key]);
            }
        }
        return supported;
    }

    log_message(`Showing entity ${mediaPlayer.entity_id}: ${JSON.stringify(mediaPlayer, null, 4)}`);
    log_message(`Supported features: ${supported_features(mediaPlayer)}`);

    var is_muted = mediaPlayer.attributes.is_volume_muted;
    let mediaControlWindow = new UI.Window({
        status: {
            color: 'black',
            backgroundColor: 'white',
            seperator: "dotted"
        },
        backgroundColor: "white",
        action: {
            up: "IMAGE_ICON_VOLUME_UP",
            select: "IMAGE_ICON_PLAYPAUSE",
            down: "IMAGE_ICON_VOLUME_DOWN",
        }
    });

    // Calculate available width so the media name doesn't get hidden by the action bar.
    var availableWidth = Feature.resolution().x - Feature.actionBarWidth() - 10;
    var titleFont = "gothic_24_bold";
    var titleY = 3;
    if (mediaPlayer.attributes.friendly_name.length > 17) {
        titleFont = "gothic_14_bold";
        titleY = 6;
    }
    var mediaName = new UI.Text({
        text: mediaPlayer.attributes.friendly_name,
        color: Feature.color(colour.highlight, "black"),
        font: titleFont,
        position: Feature.round(new Vector(10, titleY), new Vector(5, titleY)),
        size: new Vector(availableWidth, 30),
        textAlign: "left"  // left-align to avoid overlapping the action bar
    });

    var mediaIcon = new UI.Image({
        position: new Vector(6, 115),
        size: new Vector(25, 25),
        compositing: "set",
        backgroundColor: 'transparent',
        image: "IMAGE_ICON_MEDIA"
    });

    let position_y = 30;
    if (enableIcons) {
        var muteIcon = new UI.Image({
            position: new Vector(9, 82 + position_y),
            size: new Vector(20, 13),
            compositing: "set",
            backgroundColor: 'transparent',
            image: "IMAGE_ICON_UNMUTED"
        });
        if (mediaPlayer.attributes.is_volume_muted) {
            muteIcon.image("IMAGE_ICON_MUTED");
        }
    }
    var volume_label = new UI.Text({
        text: "%",
        color: "black",
        font: "gothic_14",
        position: new Vector(Feature.resolution().x - Feature.actionBarWidth() - 30, 80 + position_y),
        size: new Vector(30, 30),
        textAlign: "center"
    });
    var volume_progress_bg = new UI.Line({
        position: new Vector(10, 105 + position_y),
        position2: new Vector(134 - Feature.actionBarWidth(), 105 + position_y),
        strokeColor: 'black',
        strokeWidth: 5,
    });
    var volume_progress_bg_inner = new UI.Line({
        position: new Vector(10, 105 + position_y),
        position2: new Vector(134 - Feature.actionBarWidth(), 105 + position_y),
        strokeColor: 'white',
        strokeWidth: 3,
    });
    var volume_progress_fg = new UI.Line({
        position: new Vector(10, 105 + position_y),
        position2: new Vector(10, 105 + position_y),
        strokeColor: 'black',
        strokeWidth: 3,
    });
    volume_progress_fg.maxWidth = volume_progress_bg_inner.position2().x - volume_progress_bg_inner.position().x;

    position_y = -10;
    var position_label = new UI.Text({
        text: "-:-- / -:--",
        color: "black",
        font: "gothic_14",
        position: new Vector(Feature.resolution().x - Feature.actionBarWidth() - 80, 80 + position_y),
        size: new Vector(80, 30),
        textAlign: "center"
    });
    var position_progress_bg = new UI.Line({
        position: new Vector(10, 105 + position_y),
        position2: new Vector(134 - Feature.actionBarWidth(), 105 + position_y),
        strokeColor: 'black',
        strokeWidth: 5,
    });
    var position_progress_bg_inner = new UI.Line({
        position: new Vector(10, 105 + position_y),
        position2: new Vector(134 - Feature.actionBarWidth(), 105 + position_y),
        strokeColor: 'white',
        strokeWidth: 3,
    });
    var position_progress_fg = new UI.Line({
        position: new Vector(10, 105 + position_y),
        position2: new Vector(10, 105 + position_y),
        strokeColor: 'black',
        strokeWidth: 3,
    });
    position_progress_fg.maxWidth = position_progress_bg_inner.position2().x - position_progress_bg_inner.position().x;

    mediaControlWindow.on('show', function(){
        subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            console.log("TEST", JSON.stringify(data) );
            updateMediaWindow(data.event.variables.trigger.to_state);
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity.entity_id}]: ` + JSON.stringify(error));
        });

        mediaControlWindow.on('click', 'select', function(e) {
            haws.mediaPlayerPlayPause(entity_id);
        });

        mediaControlWindow.on('longClick', 'select', function(e) {
            showEntityMenu(entity_id);
        });

        mediaControlWindow.on('click', 'up', function(e) {
            haws.mediaPlayerVolumeUp(mediaPlayer.entity_id, function(d) {
                // if (d[0] != null) {
                //     updateMediaWindow(d[0]);
                // }
            });
        });

        mediaControlWindow.on('longClick', 'up', function(e) {
            haws.mediaPlayerNextTrack(entity_id);
        });

        mediaControlWindow.on('click', 'down', function(e) {
            haws.mediaPlayerVolumeDown(mediaPlayer.entity_id, function(d) {
                // if (d[0] != null) {
                //     updateMediaWindow(d[0]);
                // }
            });
        });

        mediaControlWindow.on('longClick', 'down', function(e) {
            if (is_muted) {
                haws.mediaPlayerMute(mediaPlayer.entity_id, false, function(d) {
                    // if (d[0] != null) {
                    //     updateMediaWindow(d[0]);
                    // }
                    is_muted = false;
                });
            } else {
                haws.mediaPlayerMute(mediaPlayer.entity_id, true, function(d) {
                    // if (d[0] != null) {
                    //     updateMediaWindow(d[0]);
                    // }
                    is_muted = true;
                });
            }
        });

        updateMediaWindow(mediaPlayer);
    });

    mediaControlWindow.on('close', function(){
        if (subscription_msg_id) {
            haws.unsubscribe(subscription_msg_id);
        }
    });

    function secToTime(seconds, separator) {
        return [
            parseInt(seconds / 60 / 60),
            parseInt(seconds / 60 % 60),
            parseInt(seconds % 60)
        ].join(separator ? separator : ':')
            .replace(/\b(\d)\b/g, "0$1").replace(/^00\:/, '');
    }

    function updateMediaWindow(mediaPlayer) {
        if (!mediaPlayer) { return; }
        log_message(`MEDIA PLAYER WINDOW UPDATE ${mediaPlayer.entity_id}: ${JSON.stringify(mediaPlayer, null, 4)}`);

        // Update volume progress: use Math.round for smoother transition.
        let newVolumeWidth = volume_progress_fg.maxWidth * mediaPlayer.attributes.volume_level;
        let volume_x2 = volume_progress_fg.position().x + Math.round(newVolumeWidth);
        volume_progress_fg.position2(new Vector(volume_x2, volume_progress_fg.position2().y));

        // Update volume label.
        if (mediaPlayer.attributes.is_volume_muted) {
            if (enableIcons) {
                muteIcon.image("IMAGE_ICON_MUTED");
            }
            volume_label.text("");
        } else {
            if (enableIcons) {
                muteIcon.image("IMAGE_ICON_UNMUTED");
            }
            if (mediaPlayer.attributes.volume_level) {
                let percentage = Math.round(mediaPlayer.attributes.volume_level * 100);
                volume_label.text(percentage === 100 ? 'MAX' : percentage + "%");
            } else {
                volume_label.text("0%");
            }
        }

        // Update media position progress.
        let positionRatio = (mediaPlayer.attributes.media_position && mediaPlayer.attributes.media_duration)
            ? mediaPlayer.attributes.media_position / mediaPlayer.attributes.media_duration
            : 0;
        let newPositionWidth = position_progress_fg.maxWidth * positionRatio;
        let position_x2 = position_progress_fg.position().x + Math.round(newPositionWidth);
        position_progress_fg.position2(new Vector(position_x2, position_progress_fg.position2().y));

        // Update position label.
        if (mediaPlayer.attributes.media_position && mediaPlayer.attributes.media_duration) {
            position_label.text(`${secToTime(mediaPlayer.attributes.media_position)} / ${secToTime(mediaPlayer.attributes.media_duration)}`);
        } else {
            position_label.text("-:-- / -:--");
        }

        // Add UI elements to the window.
        mediaControlWindow.add(volume_progress_bg);
        mediaControlWindow.add(volume_progress_bg_inner);
        mediaControlWindow.add(volume_progress_fg);
        mediaControlWindow.add(volume_label);
        mediaControlWindow.add(position_progress_bg);
        mediaControlWindow.add(position_progress_bg_inner);
        mediaControlWindow.add(position_progress_fg);
        mediaControlWindow.add(position_label);
        mediaControlWindow.add(mediaName);
        if (enableIcons && Feature.rectangle()) {
            mediaControlWindow.add(muteIcon);
        }
    }

    mediaControlWindow.show();
}

function showClimateEntity(entity_id) {
    let climate = ha_state_dict[entity_id],
        subscription_msg_id = null;
    if (!climate) {
        throw new Error(`Climate entity ${entity_id} not found in ha_state_dict`);
    }

    log_message(`Showing climate entity ${entity_id}: ${JSON.stringify(climate, null, 4)}`);

    // Get current state and attributes
    const is_on = climate.state !== "off";
    const current_temp = climate.attributes.current_temperature;
    const target_temp = climate.attributes.temperature;
    const target_temp_low = climate.attributes.target_temp_low;
    const target_temp_high = climate.attributes.target_temp_high;
    const hvac_mode = climate.state;
    const hvac_modes = climate.attributes.hvac_modes || [];
    const fan_mode = climate.attributes.fan_mode;
    const fan_modes = climate.attributes.fan_modes || [];
    const preset_mode = climate.attributes.preset_mode;
    const preset_modes = climate.attributes.preset_modes || [];
    const swing_mode = climate.attributes.swing_mode;
    const swing_modes = climate.attributes.swing_modes || [];
    const min_temp = climate.attributes.min_temp || 7;
    const max_temp = climate.attributes.max_temp || 35;
    const temp_step = climate.attributes.target_temperature_step || 0.5;
    const supported_features = climate.attributes.supported_features || 0;

    // Determine supported features
    const supports_target_temperature = !!(supported_features & 1); // TARGET_TEMPERATURE
    const supports_target_temperature_range = !!(supported_features & 2); // TARGET_TEMPERATURE_RANGE
    const supports_target_humidity = !!(supported_features & 4); // TARGET_HUMIDITY
    const supports_fan_mode = !!(supported_features & 8); // FAN_MODE
    const supports_preset_mode = !!(supported_features & 16); // PRESET_MODE
    const supports_swing_mode = !!(supported_features & 32); // SWING_MODE
    const supports_turn_on = !!(supported_features & 128); // TURN_ON
    const supports_turn_off = !!(supported_features & 256); // TURN_OFF

    // Create the climate menu
    let climateMenu = new UI.Menu({
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: climate.attributes.friendly_name ? climate.attributes.friendly_name : entity_id
        }]
    });

    climateMenu.on('show', function() {
        // Clear the menu
        climateMenu.items(0, []);
        let menuIndex = 0;

        // Add Temperature item
        let tempSubtitle = '';
        if (hvac_mode === 'heat_cool' && target_temp_low !== undefined && target_temp_high !== undefined) {
            tempSubtitle = `Cur: ${current_temp}° - Set: ${target_temp_low}°-${target_temp_high}°`;
        } else if (target_temp !== undefined) {
            tempSubtitle = `Cur: ${current_temp}° - Set: ${target_temp}°`;
        } else {
            tempSubtitle = `Current: ${current_temp}°`;
        }

        climateMenu.item(0, menuIndex++, {
            title: 'Temperature',
            subtitle: tempSubtitle,
            on_click: function() {
                if (hvac_mode === 'heat_cool') {
                    // Show menu to select high or low temp
                    let tempRangeMenu = new UI.Menu({
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
                        subtitle: `${target_temp_low}°`,
                        on_click: function() {
                            showTemperatureMenu(entity_id, 'low', target_temp_low, min_temp, max_temp, temp_step);
                        }
                    });

                    tempRangeMenu.item(0, 1, {
                        title: 'High Temperature',
                        subtitle: `${target_temp_high}°`,
                        on_click: function() {
                            showTemperatureMenu(entity_id, 'high', target_temp_high, min_temp, max_temp, temp_step);
                        }
                    });

                    // Subscribe to entity updates
                    let temp_range_subscription_msg_id = haws.subscribe({
                        "type": "subscribe_trigger",
                        "trigger": {
                            "platform": "state",
                            "entity_id": entity_id,
                        },
                    }, function(data) {
                        log_message(`Climate entity update for temperature range menu ${entity_id}`);
                        // Update the climate entity in the cache
                        if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                            let updatedClimate = data.event.variables.trigger.to_state;
                            ha_state_dict[entity_id] = updatedClimate;

                            // Get updated temperature values
                            let updatedTempLow = updatedClimate.attributes.target_temp_low;
                            let updatedTempHigh = updatedClimate.attributes.target_temp_high;

                            // Update menu items to reflect current state
                            tempRangeMenu.item(0, 0, {
                                title: 'Low Temperature',
                                subtitle: `${updatedTempLow}°`,
                                on_click: tempRangeMenu.items(0)[0].on_click
                            });

                            tempRangeMenu.item(0, 1, {
                                title: 'High Temperature',
                                subtitle: `${updatedTempHigh}°`,
                                on_click: tempRangeMenu.items(0)[1].on_click
                            });
                        }
                    }, function(error) {
                        log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
                    });

                    tempRangeMenu.on('select', function(e) {
                        log_message(`Temperature range menu item ${e.item.title} was selected!`);
                        if(typeof e.item.on_click === 'function') {
                            e.item.on_click(e);
                        }
                    });

                    tempRangeMenu.on('hide', function() {
                        // Unsubscribe from entity updates
                        if (temp_range_subscription_msg_id) {
                            haws.unsubscribe(temp_range_subscription_msg_id);
                        }
                    });

                    tempRangeMenu.show();
                } else {
                    // Show temperature selection menu directly
                    showTemperatureMenu(entity_id, 'single', target_temp, min_temp, max_temp, temp_step);
                }
            }
        });

        // Add HVAC Mode item
        climateMenu.item(0, menuIndex++, {
            title: 'HVAC Mode',
            subtitle: hvac_mode ? ucwords(hvac_mode.replace('_', ' ')) : 'Unknown',
            on_click: function() {
                showHvacModeMenu(entity_id, hvac_mode, hvac_modes);
            }
        });

        // Add Fan Mode item if supported
        if (supports_fan_mode && fan_modes && fan_modes.length > 0) {
            climateMenu.item(0, menuIndex++, {
                title: 'Fan Mode',
                subtitle: fan_mode ? ucwords(fan_mode.replace('_', ' ')) : 'Unknown',
                on_click: function() {
                    showFanModeMenu(entity_id, fan_mode, fan_modes);
                }
            });
        }

        // Add Preset Mode item if supported
        if (supports_preset_mode && preset_modes && preset_modes.length > 0) {
            climateMenu.item(0, menuIndex++, {
                title: 'Preset Mode',
                subtitle: preset_mode ? ucwords(preset_mode.replace('_', ' ')) : 'None',
                on_click: function() {
                    showPresetModeMenu(entity_id, preset_mode, preset_modes);
                }
            });
        }

        // Add Swing Mode item if supported
        if (supports_swing_mode && swing_modes && swing_modes.length > 0) {
            climateMenu.item(0, menuIndex++, {
                title: 'Swing Mode',
                subtitle: swing_mode ? ucwords(swing_mode.replace('_', ' ')) : 'Unknown',
                on_click: function() {
                    showSwingModeMenu(entity_id, swing_mode, swing_modes);
                }
            });
        }

        // Add More option to go to full entity menu
        climateMenu.item(0, menuIndex++, {
            title: 'More',
            on_click: function() {
                showEntityMenu(entity_id);
            }
        });

        // Subscribe to entity updates
        subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Climate entity update for ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                ha_state_dict[entity_id] = data.event.variables.trigger.to_state;
                // Hide and show the menu to refresh it
                climateMenu.hide();
                showClimateEntity(entity_id);
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });
    });

    climateMenu.on('select', function(e) {
        log_message(`Climate menu item ${e.item.title} was selected!`);
        if(typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    climateMenu.on('hide', function() {
        // Unsubscribe from entity updates
        if (subscription_msg_id) {
            haws.unsubscribe(subscription_msg_id);
        }
    });

    // Helper function to show temperature selection menu
    function showTemperatureMenu(entity_id, mode, current_temp, min_temp, max_temp, step) {
        let tempMenu = new UI.Menu({
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
        for (let temp = min_temp; temp <= max_temp; temp += step) {
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

        // Add each temperature as a menu item
        for (let i = 0; i < temps.length; i++) {
            let temp = temps[i];
            let isCurrentTemp = false;

            // Determine if this is the current temperature
            if (mode === 'single' && Math.abs(temp - current_temp) < 0.001) {
                isCurrentTemp = true;
            } else if (mode === 'low' && Math.abs(temp - target_temp_low) < 0.001) {
                isCurrentTemp = true;
            } else if (mode === 'high' && Math.abs(temp - target_temp_high) < 0.001) {
                isCurrentTemp = true;
            }

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
                        data.target_temp_high = target_temp_high;
                    } else if (mode === 'high') {
                        data.target_temp_low = target_temp_low;
                        data.target_temp_high = temp;
                    }

                    haws.climateSetTemp(
                        entity_id,
                        data,
                        function(data) {
                            log_message(`Set ${mode} temperature to ${temp}°`);
                            // Don't hide the menu, let the user see the update
                            // tempMenu.hide();
                        },
                        function(error) {
                            log_message(`Error setting temperature: ${error}`);
                        }
                    );
                }
            });
        }

        // Scroll to the current temperature
        tempMenu.selection(0, currentIndex);

        // Subscribe to entity updates
        let temp_subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Climate entity update for temperature menu ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedClimate;

                // Get updated temperature values
                let updatedTemp = updatedClimate.attributes.temperature;
                let updatedTempLow = updatedClimate.attributes.target_temp_low;
                let updatedTempHigh = updatedClimate.attributes.target_temp_high;

                // Update menu items to reflect current state
                for (let i = 0; i < temps.length; i++) {
                    let temp = temps[i];
                    let isCurrentTemp = false;

                    if (mode === 'single' && Math.abs(temp - updatedTemp) < 0.001) {
                        isCurrentTemp = true;
                    } else if (mode === 'low' && Math.abs(temp - updatedTempLow) < 0.001) {
                        isCurrentTemp = true;
                    } else if (mode === 'high' && Math.abs(temp - updatedTempHigh) < 0.001) {
                        isCurrentTemp = true;
                    }

                    tempMenu.item(0, i, {
                        title: `${temp}°`,
                        subtitle: isCurrentTemp ? 'Current' : '',
                        temp: temp,
                        on_click: tempMenu.items(0)[i].on_click
                    });
                }
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        tempMenu.on('select', function(e) {
            log_message(`Temperature menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        tempMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (temp_subscription_msg_id) {
                haws.unsubscribe(temp_subscription_msg_id);
            }
        });

        tempMenu.show();
    }

    // Helper function to show HVAC mode selection menu
    function showHvacModeMenu(entity_id, current_mode, available_modes) {
        let modeMenu = new UI.Menu({
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
                title: ucwords(mode.replace('_', ' ')),
                subtitle: isCurrentMode ? 'Current' : '',
                mode: mode,
                on_click: function() {
                    haws.climateSetHvacMode(
                        entity_id,
                        mode,
                        function(data) {
                            log_message(`Set HVAC mode to ${mode}`);
                            // Don't hide the menu, let the user see the update
                            // modeMenu.hide();
                        },
                        function(error) {
                            log_message(`Error setting HVAC mode: ${error}`);
                        }
                    );
                }
            });
        }

        // Scroll to the current mode
        modeMenu.selection(0, currentIndex);

        // Subscribe to entity updates
        let hvac_subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Climate entity update for HVAC mode menu ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedClimate;

                // Get updated HVAC mode
                let updatedMode = updatedClimate.state;

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedMode;

                    modeMenu.item(0, i, {
                        title: ucwords(mode.replace('_', ' ')),
                        subtitle: isCurrentMode ? 'Current' : '',
                        mode: mode,
                        on_click: modeMenu.items(0)[i].on_click
                    });
                }
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        modeMenu.on('select', function(e) {
            log_message(`HVAC mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (hvac_subscription_msg_id) {
                haws.unsubscribe(hvac_subscription_msg_id);
            }
        });

        modeMenu.show();
    }

    // Helper function to show fan mode selection menu
    function showFanModeMenu(entity_id, current_mode, available_modes) {
        let modeMenu = new UI.Menu({
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
                title: ucwords(mode.replace('_', ' ')),
                subtitle: isCurrentMode ? 'Current' : '',
                mode: mode,
                on_click: function() {
                    haws.climateSetFanMode(
                        entity_id,
                        mode,
                        function(data) {
                            log_message(`Set fan mode to ${mode}`);
                            // Don't hide the menu, let the user see the update
                            // modeMenu.hide();
                        },
                        function(error) {
                            log_message(`Error setting fan mode: ${error}`);
                        }
                    );
                }
            });
        }

        // Scroll to the current mode
        modeMenu.selection(0, currentIndex);

        // Subscribe to entity updates
        let fan_subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Climate entity update for fan mode menu ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedClimate;

                // Get updated fan mode
                let updatedMode = updatedClimate.attributes.fan_mode;

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedMode;

                    modeMenu.item(0, i, {
                        title: ucwords(mode.replace('_', ' ')),
                        subtitle: isCurrentMode ? 'Current' : '',
                        mode: mode,
                        on_click: modeMenu.items(0)[i].on_click
                    });
                }
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        modeMenu.on('select', function(e) {
            log_message(`Fan mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (fan_subscription_msg_id) {
                haws.unsubscribe(fan_subscription_msg_id);
            }
        });

        modeMenu.show();
    }

    // Helper function to show preset mode selection menu
    function showPresetModeMenu(entity_id, current_mode, available_modes) {
        let modeMenu = new UI.Menu({
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
                title: ucwords(mode.replace('_', ' ')),
                subtitle: isCurrentMode ? 'Current' : '',
                mode: mode,
                on_click: function() {
                    haws.climateSetPresetMode(
                        entity_id,
                        mode,
                        function(data) {
                            log_message(`Set preset mode to ${mode}`);
                            // Don't hide the menu, let the user see the update
                            // modeMenu.hide();
                        },
                        function(error) {
                            log_message(`Error setting preset mode: ${error}`);
                        }
                    );
                }
            });
        }

        // Scroll to the current mode
        modeMenu.selection(0, currentIndex);

        // Subscribe to entity updates
        let preset_subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Climate entity update for preset mode menu ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedClimate;

                // Get updated preset mode
                let updatedMode = updatedClimate.attributes.preset_mode;

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedMode;

                    modeMenu.item(0, i, {
                        title: ucwords(mode.replace('_', ' ')),
                        subtitle: isCurrentMode ? 'Current' : '',
                        mode: mode,
                        on_click: modeMenu.items(0)[i].on_click
                    });
                }
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        modeMenu.on('select', function(e) {
            log_message(`Preset mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (preset_subscription_msg_id) {
                haws.unsubscribe(preset_subscription_msg_id);
            }
        });

        modeMenu.show();
    }

    // Helper function to show swing mode selection menu
    function showSwingModeMenu(entity_id, current_mode, available_modes) {
        let modeMenu = new UI.Menu({
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
                title: ucwords(mode.replace('_', ' ')),
                subtitle: isCurrentMode ? 'Current' : '',
                mode: mode,
                on_click: function() {
                    haws.climateSetSwingMode(
                        entity_id,
                        mode,
                        function(data) {
                            log_message(`Set swing mode to ${mode}`);
                            // Don't hide the menu, let the user see the update
                            // modeMenu.hide();
                        },
                        function(error) {
                            log_message(`Error setting swing mode: ${error}`);
                        }
                    );
                }
            });
        }

        // Scroll to the current mode
        modeMenu.selection(0, currentIndex);

        // Subscribe to entity updates
        let swing_subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Climate entity update for swing mode menu ${entity_id}`);
            // Update the climate entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedClimate = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedClimate;

                // Get updated swing mode
                let updatedMode = updatedClimate.attributes.swing_mode;

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedMode;

                    modeMenu.item(0, i, {
                        title: ucwords(mode.replace('_', ' ')),
                        subtitle: isCurrentMode ? 'Current' : '',
                        mode: mode,
                        on_click: modeMenu.items(0)[i].on_click
                    });
                }
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        modeMenu.on('select', function(e) {
            log_message(`Swing mode menu item ${e.item.title} was selected!`);
            if(typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        modeMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (swing_subscription_msg_id) {
                haws.unsubscribe(swing_subscription_msg_id);
            }
        });

        modeMenu.show();
    }

    climateMenu.show();
}

function showLightEntity(entity_id) {
    let light = ha_state_dict[entity_id],
        subscription_msg_id = null;
    if (!light) {
        throw new Error(`Light entity ${entity_id} not found in ha_state_dict`);
    }

    // Handle unavailable state and determine supported features
    let supportsRGB = light.attributes.hasOwnProperty("rgb_color");
    let supportsTemperature = (light.state == "on" && light.attributes.hasOwnProperty("max_mireds"));
    let is_on = light.state === "on";

    // Set default brightness to 0 if not available
    if (!light.attributes.hasOwnProperty("brightness")) {
        light.attributes.brightness = 0;
    }

    // Calculate brightness percentage
    let brightnessPerc = Math.round((100 / 255) * parseInt(light.attributes.brightness));

    // Calculate mired step sizes for temperature if supported
    let miredJumpSmall = 0;
    let miredJumpLarge = 0;
    if (supportsTemperature) {
        let miredRange = light.attributes.max_mireds - light.attributes.min_mireds;
        miredJumpSmall = Math.floor((miredRange / 100) * 10);
        miredJumpLarge = Math.floor((miredRange / 100) * 30);
    }

    // UI State variables
    let mode = "select"; // "select" or "edit"

    // Create the light control window
    let lightControlWindow = new UI.Window({
        status: {
            color: 'black',
            backgroundColor: 'white',
            seperator: "dotted"
        },
        backgroundColor: "white"
    });

    // Calculate available width, accounting for icon space
    let iconWidth = 30; // Width for the icon including margin
    let availableWidth = Feature.resolution().x - 10;
    let nameWidth = enableIcons ? availableWidth - iconWidth : availableWidth;

    let titleFont = "gothic_24_bold";
    let titleY = 3;
    if (light.attributes.friendly_name && light.attributes.friendly_name.length > 17) {
        titleFont = "gothic_14_bold";
        titleY = 6;
    }

    // Create UI elements for the header
    let lightName = new UI.Text({
        text: light.attributes.friendly_name || light.entity_id,
        color: Feature.color(colour.highlight, "black"),
        font: titleFont,
        position: Feature.round(new Vector(10, titleY), new Vector(5, titleY)),
        size: new Vector(nameWidth, 30),
        textAlign: "left"
    });

    let lightIcon;
    if (enableIcons) {
        // Use different icons based on light state
        lightIcon = new UI.Image({
            position: Feature.round(new Vector(nameWidth + 5, titleY + 5), new Vector(nameWidth + 5, titleY + 5)),
            size: new Vector(25, 25),
            compositing: "set",
            backgroundColor: 'transparent',
            image: is_on ? "IMAGE_ICON_BULB_ON" : "IMAGE_ICON_BULB"
        });
    }

    // Build menu options dynamically
    let menuItems = [];
    let itemSpacing = 30; // Vertical spacing between items
    let startY = 40; // Starting Y position for the first menu item

    // Add Toggle option
    menuItems.push({
        id: "toggle",
        title: "Toggle",
        subtitle: is_on ? "On" : "Off",
        y: startY,
        action: function() {
            // Toggle light on/off
            haws.callService(
                "light",
                "toggle",
                {},
                { entity_id: light.entity_id },
                function(data) {
                    log_message(`Toggled light: ${light.entity_id}`);
                },
                function(error) {
                    log_message(`Error toggling light: ${error}`);
                }
            );
        }
    });

    // Add Brightness option if light is on
    menuItems.push({
        id: "brightness",
        title: "Brightness",
        subtitle: is_on ? `${brightnessPerc}%` : "NA",
        y: startY + itemSpacing,
        value: brightnessPerc,
        min: 0,
        max: 100,
        showBar: true,
        action: function(direction) {
            if (!is_on) return;

            let change = direction === "up" ? 10 : -10;
            if (mode === "edit" && Pebble.getActiveWatchInfo().platform !== "aplite") {
                // Higher precision adjustments when in edit mode
                change = direction === "up" ? 5 : -5;
            }

            let newValue = menuItems[selectedIndex].value + change;
            if (newValue < 0) newValue = 0;
            if (newValue > 100) newValue = 100;

            // Don't update UI immediately, wait for server update

            // Send command to Home Assistant
            let brightnessValue = Math.round((newValue / 100) * 255);
            haws.callService(
                "light",
                "turn_on",
                { brightness: brightnessValue },
                { entity_id: light.entity_id },
                function(data) {
                    log_message(`Updated brightness: ${newValue}%`);
                },
                function(error) {
                    log_message(`Error updating brightness: ${error}`);
                }
            );
        }
    });

    // Add Color Temperature option if supported
    if (supportsTemperature) {
        let tempValue = 0;
        let kelvinTemp = 0;

        if (light.attributes.color_temp) {
            let temp_range = light.attributes.max_mireds - light.attributes.min_mireds;
            let current_temp_pos = light.attributes.color_temp - light.attributes.min_mireds;
            tempValue = Math.round((current_temp_pos / temp_range) * 100);
            kelvinTemp = Math.round(1000000 / light.attributes.color_temp);
        }

        menuItems.push({
            id: "temperature",
            title: "Temp",
            subtitle: is_on ? `${kelvinTemp}K` : "NA",
            y: startY + (itemSpacing * 2),
            value: light.attributes.color_temp,
            min: light.attributes.min_mireds,
            max: light.attributes.max_mireds,
            kelvin: kelvinTemp,
            showBar: true,
            action: function(direction) {
                if (!is_on) return;

                let change = direction === "up" ? -miredJumpSmall : miredJumpSmall;
                // Note: decreasing mireds = increasing Kelvin temperature

                if (mode === "edit" && Pebble.getActiveWatchInfo().platform !== "aplite") {
                    // Higher precision adjustments when in edit mode
                    change = direction === "up" ? -Math.floor(miredJumpSmall/2) : Math.floor(miredJumpSmall/2);
                }

                let newValue = menuItems[selectedIndex].value + change;
                if (newValue < menuItems[selectedIndex].min) newValue = menuItems[selectedIndex].min;
                if (newValue > menuItems[selectedIndex].max) newValue = menuItems[selectedIndex].max;

                // Don't update UI immediately, wait for server update

                // Send command to Home Assistant
                haws.callService(
                    "light",
                    "turn_on",
                    { color_temp: newValue },
                    { entity_id: light.entity_id },
                    function(data) {
                        log_message(`Updated color temp: ${newValue} mireds (${Math.round(1000000/newValue)}K)`);
                    },
                    function(error) {
                        log_message(`Error updating color temp: ${error}`);
                    }
                );
            }
        });
    }

    // Add More option
    menuItems.push({
        id: "more",
        title: "More Options",
        subtitle: "",
        y: startY + (itemSpacing * (supportsTemperature ? 3 : 2)),
        action: function() {
            showEntityMenu(entity_id);
        }
    });

    // Create UI elements for menu items
    let menuTexts = [];
    let menuSubtexts = [];
    let menuBars = [];
    let menuBarsFg = [];
    let menuBoxes = [];

    // Margins for selection box
    let boxLeftMargin = 5;

    // Create triangle pointer for selection - moved right by boxLeftMargin
    let pointer = {
        line1: new UI.Line({
            position: new Vector(5 + boxLeftMargin, menuItems[0].y + 8),
            position2: new Vector(12 + boxLeftMargin, menuItems[0].y + 12),
            strokeColor: colour.highlight,
            strokeWidth: 2
        }),
        line2: new UI.Line({
            position: new Vector(12 + boxLeftMargin, menuItems[0].y + 12),
            position2: new Vector(5 + boxLeftMargin, menuItems[0].y + 16),
            strokeColor: colour.highlight,
            strokeWidth: 2
        }),
        line3: new UI.Line({
            position: new Vector(5 + boxLeftMargin, menuItems[0].y + 8),
            position2: new Vector(5 + boxLeftMargin, menuItems[0].y + 16),
            strokeColor: colour.highlight,
            strokeWidth: 2
        })
    };

    // Create UI elements for each menu item
    for (let i = 0; i < menuItems.length; i++) {
        let item = menuItems[i];

        // Menu item text - moved right by boxLeftMargin
        menuTexts[i] = new UI.Text({
            text: item.title,
            color: "black",
            font: "gothic_18_bold",
            position: new Vector(20 + boxLeftMargin, item.y),
            size: new Vector(availableWidth - 50 - boxLeftMargin, 22),
            textAlign: "left"
        });

        // Menu item subtext (value/status)
        menuSubtexts[i] = new UI.Text({
            text: item.subtitle,
            color: "black",
            font: "gothic_18",
            position: new Vector(availableWidth - 40, item.y),
            size: new Vector(40, 22),
            textAlign: "right"
        });

        // Create progress bars for items that need them
        if (item.showBar) {
            // Background bar - moved right by boxLeftMargin
            menuBars[i] = new UI.Line({
                position: new Vector(20 + boxLeftMargin, item.y + 22),
                position2: new Vector(134, item.y + 22),
                strokeColor: 'black',
                strokeWidth: 3,
            });

            // Foreground bar (filled portion) - moved right by boxLeftMargin
            let barWidth = 0;

            if (item.id === "brightness") {
                barWidth = (114 - boxLeftMargin) * (item.value / 100);
            } else if (item.id === "temperature") {
                let range = item.max - item.min;
                let position = item.value - item.min;
                barWidth = (114 - boxLeftMargin) * (1 - (position / range));
            }

            // Always use highlight color for progress bars
            menuBarsFg[i] = new UI.Line({
                position: new Vector(20 + boxLeftMargin, item.y + 22),
                position2: new Vector(20 + boxLeftMargin + barWidth, item.y + 22),
                strokeColor: colour.highlight,
                strokeWidth: 3,
            });
        }

        // Create selection box (hidden initially)
        // Adjusted with more equal margins on left and right
        menuBoxes[i] = new UI.Rect({
            position: new Vector(boxLeftMargin, item.y - 2),  // Left margin matches arrow position
            size: new Vector(Feature.resolution().x - (boxLeftMargin * 2), 32),  // Equal margins on both sides
            borderColor: 'black',
            backgroundColor: 'transparent',
            borderWidth: 3
        });
    }

    // Instructions at the bottom
    let instructionsText = new UI.Text({
        text: "SELECT: Choose | BACK: Return",
        color: "black",
        font: "gothic_14",
        position: new Vector(0, 150),
        size: new Vector(Feature.resolution().x, 20),
        textAlign: "center"
    });

    // Track selected menu item
    let selectedIndex = 0;

    // Add elements to window
    lightControlWindow.add(lightName);
    if (enableIcons) {
        lightControlWindow.add(lightIcon);
    }

    // Add menu item elements
    for (let i = 0; i < menuItems.length; i++) {
        lightControlWindow.add(menuTexts[i]);
        lightControlWindow.add(menuSubtexts[i]);

        if (menuItems[i].showBar) {
            lightControlWindow.add(menuBars[i]);
            lightControlWindow.add(menuBarsFg[i]);
        }

        // Don't add boxes initially - they're only shown in edit mode
    }

    // Add pointer
    lightControlWindow.add(pointer.line1);
    lightControlWindow.add(pointer.line2);
    lightControlWindow.add(pointer.line3);

    // Add instructions
    lightControlWindow.add(instructionsText);

    // Function to update pointer position and color
    function updatePointerPosition() {
        // Remove current pointer
        lightControlWindow.remove(pointer.line1);
        lightControlWindow.remove(pointer.line2);
        lightControlWindow.remove(pointer.line3);

        // Set pointer color based on mode
        let pointerColor = mode === "select" ? colour.highlight : 'black';

        // Create new pointer at the position of the selected item
        pointer = {
            line1: new UI.Line({
                position: new Vector(5 + boxLeftMargin, menuItems[selectedIndex].y + 8),
                position2: new Vector(12 + boxLeftMargin, menuItems[selectedIndex].y + 12),
                strokeColor: pointerColor,
                strokeWidth: 2
            }),
            line2: new UI.Line({
                position: new Vector(12 + boxLeftMargin, menuItems[selectedIndex].y + 12),
                position2: new Vector(5 + boxLeftMargin, menuItems[selectedIndex].y + 16),
                strokeWidth: 2
            }),
            line3: new UI.Line({
                position: new Vector(5 + boxLeftMargin, menuItems[selectedIndex].y + 8),
                position2: new Vector(5 + boxLeftMargin, menuItems[selectedIndex].y + 16),
                strokeColor: pointerColor,
                strokeWidth: 2
            })
        };

        // Add new pointer to window
        lightControlWindow.add(pointer.line1);
        lightControlWindow.add(pointer.line2);
        lightControlWindow.add(pointer.line3);
    }

    // Function to update UI based on entity state
    function updateUI() {
        // Update menu item subtexts and progress bars
        for (let i = 0; i < menuItems.length; i++) {
            let item = menuItems[i];

            if (item.id === "toggle") {
                menuSubtexts[i].text(is_on ? "On" : "Off");
            } else if (item.id === "brightness") {
                menuSubtexts[i].text(is_on ? `${item.value}%` : "NA");

                if (item.showBar && menuBarsFg[i]) {
                    // Update progress bar
                    let barWidth = (114 - boxLeftMargin) * (item.value / 100);

                    // Always use highlight color for progress bars
                    menuBarsFg[i].strokeColor(colour.highlight);
                }
            } else if (item.id === "temperature") {

                if (item.showBar && menuBarsFg[i]) {
                    // Update progress bar
                    let range = item.max - item.min;
                    let position = item.value - item.min;
                    let barWidth = (114 - boxLeftMargin) * (position / range);
                    menuBarsFg[i].position2(new Vector(20 + boxLeftMargin + barWidth, item.y + 22));

                    // Always use highlight color for progress bars
                    menuBarsFg[i].strokeColor(colour.highlight);
                }
            }
        }

        // Update instructions based on mode
        if (mode === "select") {
            instructionsText.text("SELECT: Choose | BACK: Return");

            // Hide all boxes
            for (let i = 0; i < menuBoxes.length; i++) {
                lightControlWindow.remove(menuBoxes[i]);
            }
        } else { // edit mode
            instructionsText.text("UP/DOWN: Adjust | SELECT: Done");

            // Show box for selected item only
            lightControlWindow.add(menuBoxes[selectedIndex]);
        }

        // Update pointer color
        updatePointerPosition();

        // Update light icon based on current state
        if (enableIcons && lightIcon) {
            // Remove the current icon
            lightControlWindow.remove(lightIcon);

            // Create and add a new icon with the appropriate image
            lightIcon = new UI.Image({
                position: Feature.round(new Vector(nameWidth + 5, titleY + 5), new Vector(nameWidth + 5, titleY + 5)),
                size: new Vector(25, 25),
                compositing: "set",
                backgroundColor: 'transparent',
                image: is_on ? "IMAGE_ICON_BULB_ON" : "IMAGE_ICON_BULB"
            });

            lightControlWindow.add(lightIcon);
        }
    }

    // Function to update with entity state from HA
    function updateEntityState(newState) {
        if (!newState) return;

        log_message(`LIGHT WINDOW UPDATE ${newState.entity_id}: ${JSON.stringify(newState, null, 4)}`);
        light = newState;
        is_on = light.state === "on";

        // Update brightness
        if (is_on && light.attributes.hasOwnProperty("brightness")) {
            brightnessPerc = Math.round((100 / 255) * parseInt(light.attributes.brightness));

            // Find brightness menu item and update its value
            for (let i = 0; i < menuItems.length; i++) {
                if (menuItems[i].id === "brightness") {
                    menuItems[i].value = brightnessPerc;
                    break;
                }
            }
        }

        // Update temperature
        if (is_on && supportsTemperature && light.attributes.color_temp) {
            // Find temperature menu item and update its value
            for (let i = 0; i < menuItems.length; i++) {
                if (menuItems[i].id === "temperature") {
                    menuItems[i].value = light.attributes.color_temp;
                    menuItems[i].kelvin = Math.round(1000000 / light.attributes.color_temp);
                    break;
                }
            }
        }

        // Update menu item for toggle
        for (let i = 0; i < menuItems.length; i++) {
            if (menuItems[i].id === "toggle") {
                menuItems[i].subtitle = is_on ? "On" : "Off";
                break;
            }
        }

        // Update UI
        updateUI();
    }

    // Set up button handlers
    lightControlWindow.on('show', function() {
        subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            updateEntityState(data.event.variables.trigger.to_state);
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        // Initial UI update
        updateUI();
    });

    lightControlWindow.on('hide', function() {
        if (subscription_msg_id) {
            haws.unsubscribe(subscription_msg_id);
        }
    });

    // Handle button clicks
    lightControlWindow.on('click', 'select', function() {
        if (mode === "select") {
            // If on the "More" option, go to entity menu
            if (menuItems[selectedIndex].id === "more") {
                menuItems[selectedIndex].action();
                return;
            }

            // If on the "Toggle" option, toggle the light
            if (menuItems[selectedIndex].id === "toggle") {
                menuItems[selectedIndex].action();
                return;
            }

            // For other options, enter edit mode
            mode = "edit";
            updateUI();
        } else {
            // Exit edit mode
            mode = "select";
            updateUI();
        }
    });

    lightControlWindow.on('click', 'up', function() {
        if (mode === "select") {
            // Move selection up
            if (selectedIndex > 0) {
                selectedIndex--;
                updatePointerPosition();
            }
            // Edit the value (up)
            menuItems[selectedIndex].action("up");
        }
    });

    lightControlWindow.on('click', 'down', function() {
        if (mode === "select") {
            // Move selection down
            if (selectedIndex < menuItems.length - 1) {
                selectedIndex++;
                updatePointerPosition();
            }
        } else {
            // Edit the value (down)
            menuItems[selectedIndex].action("down");
        }
    });

    lightControlWindow.on('longClick', 'select', function() {
        // Alternative toggle method (always available)
        if (menuItems[0].id === "toggle") {
            menuItems[0].action();
        }
    });

    lightControlWindow.show();
}

function showEntityMenu(entity_id) {
    let entity = ha_state_dict[entity_id];
    if(!entity){
        throw new Error(`Entity ${entity_id} not found in ha_state_dict`);
    }

    // Set Menu colors
    let showEntityMenu = new UI.Menu({
        backgroundColor: 'white',
        textColor: 'black',
        highlightBackgroundColor: 'black',
        highlightTextColor: 'white',
        sections: [
            {
                title: 'Attributes'
            },
            {
                title: 'Services'
            },
            {
                title: 'Extra'
            }
        ]
    });

    let msg_id = null;
    showEntityMenu.on('show', function(){
        //Object.getOwnPropertyNames(entity);
        //Object.getOwnPropertyNames(entity.attributes);
        var arr = Object.getOwnPropertyNames(entity.attributes);
        //var arr = Object.getOwnPropertyNames(device_status.attributes);
        var i = 0;
        log_message(`Showing entity ${entity.entity_id}: ${JSON.stringify(entity, null, 4)}`)
        for (i = 0; i < arr.length; i++) {
            showEntityMenu.item(0, i, {
                title: arr[i],
                subtitle: entity.attributes[arr[i]]
            });
        }
        showEntityMenu.item(0, i++, {
            title: 'Entity ID',
            subtitle: entity.entity_id
        });
        showEntityMenu.item(0, i++, {
            title: 'Last Changed',
            subtitle: entity.last_changed
        });
        showEntityMenu.item(0, i++, {
            title: 'Last Updated',
            subtitle: entity.last_updated
        });
        showEntityMenu.item(0, i++, {
            title: 'State',
            subtitle: entity.state + (entity.attributes.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : '')
        });

        //entity: {"attributes":{"friendly_name":"Family Room","icon":"mdi:lightbulb"},"entity_id":"switch.family_room","last_changed":"2016-10-12T02:03:26.849071+00:00","last_updated":"2016-10-12T02:03:26.849071+00:00","state":"off"}
        log_message("This Device entity_id: " + entity.entity_id);
        var device = entity.entity_id.split('.'),
            domain = device[0];

        let servicesCount = 0;

        if(
            domain === "button" ||
            domain === "input_button"
        ) {
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Press',
                on_click: function(){
                    haws.callService(
                        domain,
                        'press',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            // Success!
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            // Failure!
                            log_message('no response');
                        });
                }
            });
        }

        if (
            domain === "switch" ||
            domain === "input_boolean" ||
            domain === "automation" ||
            domain === "script"
        )
        {
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Toggle',
                on_click: function(){
                    haws.callService(
                        domain,
                        'toggle',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                            // Success!
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            // Failure!
                            log_message('no response');
                        });
                }
            });
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Turn On',
                on_click: function(){
                    haws.callService(
                        domain,
                        'turn_on',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                            // Success!
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            // Failure!
                            log_message('no response');
                        });
                }
            });
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Turn Off',
                on_click: function(){
                    haws.callService(
                        domain,
                        'turn_off',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            log_message('no response');
                        });
                }
            });
        }

        if(domain === "scene") {
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Turn On',
                on_click: function(){
                    haws.callService(
                        domain,
                        'turn_on',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                            // Success!
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            // Failure!
                            log_message('no response');
                        });
                }
            });
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Apply',
                on_click: function(){
                    haws.callService(
                        domain,
                        'apply',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                            // Success!
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            // Failure!
                            log_message('no response');
                        });
                }
            });
        }

        if(
            domain === "input_number" ||
            domain === "counter"
        ) {
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Increment',
                on_click: function(){
                    haws.callService(
                        domain,
                        'increment',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            log_message('no response');
                        });
                }
            });
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Decrement',
                on_click: function(){
                    haws.callService(
                        domain,
                        'decrement',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            // Failure!
                            log_message('no response');
                        });
                }
            });
        }

        if(domain === "counter") {
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Reset',
                on_click: function(){
                    haws.callService(
                        domain,
                        'reset',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            // Failure!
                            log_message('no response');
                        });
                }
            });
        }

        if(
            domain === "automation"
        ) {
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Trigger',
                on_click: function(){
                    haws.callService(
                        domain,
                        'trigger',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                            // Success!
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            // Failure!
                            log_message('no response');
                        });
                }
            });
        }

        if(
            domain === "automation" ||
            domain === "script" ||
            domain === "button" ||
            domain === "input_boolean"
        ) {
            showEntityMenu.item(1, servicesCount++, { //menuIndex
                title: 'Reload',
                on_click: function(){
                    haws.callService(
                        domain,
                        'reload',
                        {},
                        {entity_id: entity.entity_id},
                        function(data) {
                            // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                            // Success!
                            log_message(JSON.stringify(data));
                        },
                        function(error) {
                            // Failure!
                            log_message('no response');
                        });
                }
            });
        }

        function _renderFavoriteBtn() {
            showEntityMenu.item(2, 0, {
                title: (favoriteEntityStore.has(entity.entity_id) ? 'Remove' : 'Add') + ' Favorite',
                on_click: function(e) {
                    if(!favoriteEntityStore.has(entity.entity_id)) {
                        log_message(`Adding ${entity.entity_id} to favorites`);
                        favoriteEntityStore.add(entity.entity_id);
                    } else {
                        log_message(`Removing ${entity.entity_id} from favorites`);
                        favoriteEntityStore.remove(entity.entity_id);
                    }
                    _renderFavoriteBtn();
                }
            });
        }
        _renderFavoriteBtn();

        msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity.entity_id,
            },
        }, function(data) {
            // log_message(`Entity update for ${entity.entity_id}`);

            showEntityMenu.item(0, stateIndex, {
                title: 'State',
                subtitle: `${data.event.variables.trigger.to_state.state}` + (entity.attributes.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : '')
            });
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity.entity_id}]: ` + JSON.stringify(error));
        });

        showEntityMenu.on('select', function(e) {
            if(typeof e.item.on_click == 'function') {
                e.item.on_click(e);
                return;
            }

            // log_message(JSON.stringify(e.item));
            if(e.sectionIndex !== 1) return; // only care about clicks on service stuff

            // ajax(
            //     {
            //         url: baseurl + '/services/'+ domain +'/' + e.item.title,
            //         method: 'post',
            //         headers: baseheaders,
            //         type: 'json',
            //         data: requestData
            //     },
            //     function(data) {
            //         let entity = data;
            //         // Success!
            //         showEntityMenu.item(0, stateIndex, {
            //             title: 'State',
            //             subtitle: entity.state
            //         });
            //         log_message(JSON.stringify(data));
            //     },
            //     function(error) {
            //         // Failure!
            //         log_message('no response');
            //     }
            // );
        });
    });
    showEntityMenu.on('close', function(){
        if(msg_id) {
            haws.unsubscribe(msg_id);
        }
    });

    showEntityMenu.show();
}

function showEntityDomainsFromList(entity_id_list, title) {
    // setup entityListMenu if it hasn't been
    let domainListMenu = new UI.Menu({
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: title ? title : "Home Assistant"
        }]
    });

    domainListMenu.on('show', function(){
        // loop over entity id list and index them by their domain
        // we got this during boot
        let domainEntities = {};
        for(let entity_id of entity_id_list) {
            let entity = ha_state_dict[entity_id];
            if(!entity) {
                // throw new Error(`${entity_id} does not exist in ha_state_dict`);
                continue;
            }

            let [domain] = entity_id.split('.');

            // Skip domains that should be ignored
            if (ignore_domains && ignore_domains.indexOf(domain) !== -1) {
                continue;
            }

            if(domain in domainEntities) {
                domainEntities[domain].push(entity_id);
            } else {
                domainEntities[domain] = [entity_id];
            }
        }

        // sort domain list
        domainEntities = sortObjectByKeys(domainEntities);

        // add domain entries into menu
        let i = 0;
        for(let domain in domainEntities) {
            let entities = domainEntities[domain],
                display_name = ucwords(domain.replace('_', ' '));

            domainListMenu.item(0, i++, {
                title: display_name,
                subtitle: `${entities.length} ${entities.length > 1 ? 'entities' : 'entity'}`,
                on_click: function(e) {
                    showEntityList(display_name, entities);
                }
            });
        }
    });

    domainListMenu.on('select', function(e) {
        log_message(`Domain list item ${e.item.title} was short pressed!`);
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    domainListMenu.show();
}

let entityListMenu = null;
function showEntityList(title, entity_id_list = false, ignoreEntityCache = true, sortItems = true, skipIgnoredDomains = false) {
    // setup entityListMenu if it hasn't been
    entityListMenu = new UI.Menu({
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: title ? title : "Home Assistant"
        }]
    });

    entityListMenu.subscription_id = null;
    entityListMenu.on('longSelect', function(e) {
        log_message(`Entity ${e.item.entity_id} was long pressed!`);
        let [domain] = e.item.entity_id.split('.');
        if (
            domain === "switch" ||
            domain === "light" ||
            domain === "input_boolean" ||
            domain === "automation" ||
            domain === "script"
        ) {
            haws.callService(
                domain,
                'toggle',
                {},
                {entity_id: e.item.entity_id},
                function (data) {
                    // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                    // Success!
                    log_message(JSON.stringify(data));
                },
                function (error) {
                    // Failure!
                    log_message('no response');
                });
        }
    });

    entityListMenu.on('hide', function(e) {
        if(entityListMenu.subscription_id) {
            haws.unsubscribe(entityListMenu.subscription_id);
        }
    });

    // Add an action for SELECT
    entityListMenu.on('select', function(e) {
        let entity_id = e.item.entity_id;
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
            return;
        }
        log_message(`Entity ${entity_id} was short pressed!`);

        let [entity_domain] = entity_id.split('.');
        switch(entity_domain) {
            case 'media_player':
                showMediaPlayerEntity(entity_id);
                break;
            case 'light':
                showLightEntity(entity_id);
                break;
            case 'climate':
                showClimateEntity(entity_id);
                break;
            default:
                showEntityMenu(entity_id);
                break;
        }
        /*showEntityMenu.item(0, 0, { //menuIndex
                  title: 'test',
                  subtitle: 'test2'
                });*/
        // showEntityMenu.show();
    });

    function updateStates(pageNumber) {
        let maxPageItems = 20,
            paginated = false,
            paginateMore = false,
            paginateMoreIndex = null;
        if(!pageNumber) {
            pageNumber = 1;
        }

        let prev_title = entityListMenu.section(0).title;
        entityListMenu.section(0).title = 'updating ...';
        getStates(
            function(data) {
                entityListMenu.section(0).title = prev_title;
                entityListMenu.items(0, []); // clear items

                // Filter out ignored domains if skipIgnoredDomains is true
                if (skipIgnoredDomains && ignore_domains && ignore_domains.length > 0) {
                    data = data.filter(function(element) {
                        const [domain] = element.entity_id.split('.');
                        return ignore_domains.indexOf(domain) === -1;
                    });
                }

                if(entity_id_list) {
                    data = data.filter(function(element, index) {
                        return entity_id_list.indexOf(element.entity_id) > -1;
                    });
                }

                if(sortItems) {
                    // sort items by an entity attribute
                    data = sortJSON(data, ha_order_by, ha_order_dir);
                } else {
                    // sort items in same order as they appear in entity_id_list
                    data.sort(function(a, b){
                        return entity_id_list.indexOf(a.entity_id) - entity_id_list.indexOf(b.entity_id);
                    });
                }
                let data_length = data.length;
                device_status = data;
                let menuIndex = 0;
                function paginate(array, pageSize, pageNumber) {
                    return array.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
                }
                if(data.length > maxPageItems) {
                    data = paginate(data, maxPageItems, pageNumber);
                    paginated = true;
                    paginateMore = (maxPageItems * pageNumber) < data_length;
                    log_message(`maxPageItems:${maxPageItems} pageNumber:${pageNumber} data_length:${data_length} paginateMore:${paginateMore?1:0}`)
                }

                if(pageNumber > 1) {
                    entityListMenu.item(0, menuIndex, {
                        title: "Prev Page",
                        on_click: function(e) {
                            updateStates(pageNumber - 1);
                        }
                    });
                    menuIndex++;
                }

                let renderedEntityIds = {};
                for (let i = 0; i < data.length; i++) {
                    if(entity_id_list && entity_id_list.indexOf(data[i].entity_id) === -1) {
                        continue;
                    }

                    if(data[i].attributes.hidden){
                        continue;
                    }

                    let menuId = menuIndex++;
                    entityListMenu.item(0, menuId, {
                        title: data[i].attributes.friendly_name ? data[i].attributes.friendly_name : data[i].entity_id,
                        subtitle: data[i].state + (data[i].attributes.unit_of_measurement ? ` ${data[i].attributes.unit_of_measurement}` : '') + ' ' + humanDiff(new Date(), new Date(data[i].last_changed)),
                        entity_id: data[i].entity_id
                    });
                    renderedEntityIds[data[i].entity_id] = menuId;
                }

                if(entityListMenu.subscription_id) {
                    haws.unsubscribe(entityListMenu.subscription_id);
                }

                if(Object.keys(renderedEntityIds).length) {
                    entityListMenu.subscription_id = haws.subscribe({
                        "type": "subscribe_trigger",
                        "trigger": {
                            "platform": "state",
                            "entity_id": Object.keys(renderedEntityIds),
                        },
                    }, function(data) {
                        // log_message(`ENTITY UPDATE [${data.event.variables.trigger.to_state.entity_id}]: ` + JSON.stringify(data));
                        entity_registry_cache[data.event.variables.trigger.to_state.entity_id] = data.event.variables.trigger.to_state;
                        let entity = entity_registry_cache[data.event.variables.trigger.to_state.entity_id];
                        log_message("ENTITY GETTING UPDATE:" + JSON.stringify(entity));
                        if(!entity) {
                            log_message('FAILED TO FIND ENTITY ' + data.event.variables.trigger.to_state.entity_id);
                            return;
                        }
                        entityListMenu.item(0, renderedEntityIds[entity.entity_id], {
                            title: data.event.variables.trigger.to_state.attributes.friendly_name ? data.event.variables.trigger.to_state.attributes.friendly_name : entity.entity_id,
                            subtitle: data.event.variables.trigger.to_state.state + (data.event.variables.trigger.to_state.attributes.unit_of_measurement ? ` ${data.event.variables.trigger.to_state.attributes.unit_of_measurement}` : '') + ' ' + humanDiff(new Date(), new Date(data.event.variables.trigger.to_state.last_changed)),
                            entity_id: entity.entity_id
                        });
                    }, function(error) {
                        log_message(`ENTITY UPDATE ERROR ${JSON.stringify(Object.keys(renderedEntityIds))}: ` + JSON.stringify(error));
                    });
                }

                if(paginateMore) {
                    entityListMenu.item(0, menuIndex, {
                        title: "Next Page",
                        on_click: function(e) {
                            updateStates(pageNumber + 1);
                        }
                    });
                    paginateMoreIndex = menuIndex;
                    menuIndex++;
                }

                //Vibe.vibrate('short');
            },
            function() {
                entityListMenu.section(0).title = 'HAWS - failed updating';
            },
            true
        );
    }

    entityListMenu.on('show', function(e) {
        updateStates(1);
    });

    entityListMenu.show();
}

// gets HA device states
function getStates(successCallback, errorCallback, ignoreCache = false) {
    if(!ignoreCache){
        // check if last fetch is old and needs update
        if(
            ha_state_cache
            && ha_state_cache_updated
        ) {
            let secondsAgo = (((new Date()).getTime() - ha_state_cache_updated.getTime()) / 1000);
            if(secondsAgo <= ha_refresh_interval) {
                log_message(`HA states loaded from cache (age ${secondsAgo} <= interval ${ha_refresh_interval})`);
                if(typeof successCallback == 'function') {
                    successCallback(ha_state_cache);
                }
                return;
            }
        }
    }

    haws.getStates(
        function(data) {
            ha_state_cache = data.result;
            let new_state_map = {};
            for(let entity of ha_state_cache) {
                new_state_map[entity.entity_id] = entity;
            }
            ha_state_dict = new_state_map;

            ha_state_cache_updated = new Date();
            if(typeof successCallback == "function") {
                successCallback(data.result);
            }
        },
        function(error, status, request) {
            log_message('HA States failed: ' + error + ' status: ' + status);
            if(typeof successCallback == "function") {
                errorCallback(error, status, request);
            }
        }
    );
}

/**
 * Get list of entities from the entity cache that are part of an area
 * @returns {{}|boolean}
 */
function getEntitiesForArea(area_id) {
    if(!area_registry_cache || !device_registry_cache || !entity_registry_cache) {
        return false;
    }

    if(!area_id) {
        return getEntitiesWithoutArea();
    }

    const areaDevices = new Set();
    // Find all devices linked to this area
    for (const device_id in device_registry_cache) {
        if (device_registry_cache[device_id].area_id === area_id) {
            areaDevices.add(device_id);
        }
    }

    const results = {};
    // Find all entities directly linked to this area
    // or linked to a device linked to this area.
    for (const entity_id in entity_registry_cache) {
        let entity = entity_registry_cache[entity_id];
        if (
            entity.area_id
                ? entity.area_id === (area_id ? area_id : null)
                : areaDevices.has(entity.device_id)
        ) {
            results[entity_id] = entity;
        }
    }

    return results;
}

/**
 * Get list of entities from the entity cache that don't have an area
 * @returns {{}|boolean}
 */
function getEntitiesWithoutArea() {
    if(!area_registry_cache || !device_registry_cache || !entity_registry_cache) {
        return false;
    }

    const noAreaDevices = new Set();
    // Find all devices linked to this area
    for (const device_id in device_registry_cache) {
        if (!device_registry_cache[device_id].area_id) {
            noAreaDevices.add(device_id);
        }
    }

    const results = {};
    // Find all entities directly linked to this area
    // or linked to a device linked to this area.
    for (const entity_id in entity_registry_cache) {
        let entity = entity_registry_cache[entity_id];
        if(!entity.area_id || noAreaDevices.has(entity.device_id)) {
            results[entity_id] = entity;
        }
    }

    return results;
}

/**
 * auth_ok event callback
 * we use this to fetch whatever data we need and display the first menu in the app
 * @param evt
 */
function on_auth_ok(evt) {
    loadingCard.subtitle("Fetching states");
    log_message("Fetching states, config areas, config devices, config entities, and config labels...");
    let pipelines_loaded = false;

    // Set connection status to true
    ha_connected = true;
    Settings.option('ha_connected', ha_connected);

    let done_fetching = function(){
        // basically just a wrapper to check that all the things have finished fetching
        if(area_registry_cache && device_registry_cache && entity_registry_cache &&
           ha_state_cache && label_registry_cache && pipelines_loaded) {
            log_message("Finished fetching data, showing main menu");

            // try to resume previous WindowStack state if it's saved
            if(saved_windows) {
                WindowStack._items = [...saved_windows];
                saved_windows = null;
                loadingCard.hide();
            } else {
                showMainMenu();
                loadingCard.hide();
            }
        }
    };

    // Don't think getting an error here is possible (it should just disconnect)
    // but we may need to add logic to handle it in the future
    getStates(function(){
        log_message("States loaded.");
        done_fetching();
    }, function(){
        loadingCard.subtitle("Fetching states failed");
    });

    haws.getConfigAreas(function(data) {
        // log_message('config/area_registry/list response: ' + JSON.stringify(data));

        area_registry_cache = {};
        for(let result of data.result) {
            area_registry_cache[result.area_id] = result.name;                            // {
            //     "id":1,
            //     "type":"result",
            //     "success":true,
            //     "result":[
            //     {
            //         "area_id":"9f55b85d123043cb8dfc01088302d2c7",
            //         "name":"",
            //         "picture":null
            //     },
        }
        log_message("Config areas loaded.");
        done_fetching();
    }, function(){
        loadingCard.subtitle("Fetching areas failed");
    });

    haws.getConfigDevices(function(data) {
        // log_message('config/device_registry/list response: ' + JSON.stringify(data));
        device_registry_cache = {};
        for(let result of data.result) {
            // {
            //     "area_id":"afb218164821434386244a956d47f2eb",
            //     "configuration_url":null,
            //     "config_entries":[
            //     "d1d5c0dd075844ca9146790b8647adeb"
            // ],
            //     "connections":[
            //     [
            //         "mac",
            //         "00:17:88:01:00:de:6a:52"
            //     ]
            // ],
            //     "disabled_by":null,
            //     "entry_type":null,
            //     "id":"d05562381cd94559a3f99f6983746bb7",
            //     "identifiers":[
            //     [
            //         "hue",
            //         "ce4a484b-76d9-4e82-989a-08874ecb7d00"
            //     ]
            // ],
            //     "manufacturer":"Signify Netherlands B.V.",
            //     "model":"Hue white lamp (LWB004)",
            //     "name_by_user":null,
            //     "name":"Garage Back Door Light",
            //     "sw_version":"130.1.30000",
            //     "hw_version":null,
            //     "via_device_id":"a02e79078d1c4b2e87252bf3c7d560f9"
            // }
            device_registry_cache[result.id] = result;
        }
        log_message("Config devices loaded.");
        done_fetching();
    }, function(){
        loadingCard.subtitle("Fetching devices failed");
    });

    haws.getConfigEntities( function(data) {
        // log_message('config/entity_registry/list response: ' + JSON.stringify(data));
        entity_registry_cache = {};
        for(let result of data.result) {
            // {
            //     "area_id":null,
            //     "config_entry_id":"d1d5c0dd075844ca9146790b8647adeb",
            //     "device_id":"858419a35f354fbba83cb2350cad7835",
            //     "disabled_by":null,
            //     "entity_category":null,
            //     "entity_id":"light.garage_door_light_right",
            //     "hidden_by":null,
            //     "icon":null,
            //     "name":null,
            //     "platform":"hue"
            // }
            entity_registry_cache[result.entity_id] = result;
        }

        log_message("Config entities loaded.");
        done_fetching();
    }, function(){
        loadingCard.subtitle("Fetching entities failed");
    });

    haws.getConfigLabels(function(data) {
        label_registry_cache = {};
        for(let result of data.result) {
            label_registry_cache[result.label_id] = result;
        }
        log_message("Config labels loaded.");
        done_fetching();
    }, function(){
        loadingCard.subtitle("Fetching labels failed");
    });

    loadAssistPipelines(function(){
        pipelines_loaded = true;
        done_fetching();
    });
}

function main() {
    load_settings();

    // if config not complete display message
    if( !hawsFaker && ( !ha_url || !ha_password ) ) {
        loadingCard.subtitle('Setup required');
        loadingCard.body("Configure from the Pebble app");
        return;
    }

    // baseurl and baseheaders are used for REST requests
    baseurl = ha_url + '/api';
    baseheaders = {
        'Authorization': 'Bearer ' + ha_password,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };

    loadingCard.subtitle('Connecting');
    log_message('Connecting');
    haws = new HAWS(ha_url, ha_password, debugHAWS);

    haws.on('open', function(evt){
        loadingCard.subtitle('Authenticating');
    });

    haws.on('close', function(evt){
        loadingCard.subtitle('Reconnecting...');
        loadingCard.show();

        // require X back button presses to exit app
        let backButtonPresses = 0;
        let pressesRequiredToExit = 3;
        loadingCard.on('click', 'back', function(e){
            backButtonPresses++;
            if(backButtonPresses >= pressesRequiredToExit) {
                loadingCard.subtitle('Press again to exit');
                return false;
            }

            // loadingCard.hide();
            return true; // ???
        });

        // save cache of current windows and then remove them
        saved_windows = [...WindowStack._items];
        for(let window of WindowStack._items) {
            if(window._id() !== loadingCard._id()) {
                window.hide();
            }
        }
    });

    haws.on('error', function(evt){
        loadingCard.subtitle('Error');
    });

    haws.on('auth_ok', function(evt){
        log_message("ws auth_ok: " + JSON.stringify(evt));
        on_auth_ok(evt);
    });

    haws.connect();

    // the following is an example of how to fetch states via REST
    // ajax({
    //         url: baseurl + '/',
    //         type: 'json',
    //         headers: baseheaders
    //     },
    //     function(data) {
    //         log_message('HA Status: ' + data);
    //         loadingCard.subtitle(data.message);
    //         // Successfully called API
    //         getstates();
    //     },
    //     function(error, status, request) {
    //         log_message('HA Status failed: ' + error + ' status: ' + status + ' at ' + baseurl + '/');
    //         loadingCard.subtitle('Error!');
    //         loadingCard.body(error + ' status: ' + status);
    //     });
}

/*
Expiremental reload
*/
if (ha_refresh_interval < 1 || typeof ha_refresh_interval == "undefined") {
    ha_refresh_interval = 15;
}
let timerID = setInterval(function() {
    if(haws.isConnected()) {
        log_message('Reloading Home Assistant states');
        getStates();
    }
}, 60000 * ha_refresh_interval);


/**
 * Helper function to determine if we should show domain menu based on settings
 * @param {Array} entities - Array of entity IDs
 * @param {String} menuSetting - 'yes', 'no', or 'conditional'
 * @returns {Boolean} - Whether to show domain menu
 */
function shouldShowDomainMenu(entities, menuSetting) {
    // If setting is explicitly yes or no, respect that
    if (menuSetting === 'yes') return true;
    if (menuSetting === 'no') return false;

    // For conditional, check the conditions
    if (menuSetting === 'conditional') {
        // Get unique domains from entities
        const domains = {};
        for (let entity_id of entities) {
            const domain = entity_id.split('.')[0];
            domains[domain] = true;
        }
        const domainCount = Object.keys(domains).length;

        // Check if we meet the minimum entity count condition
        const meetsEntityCountCondition = entities.length >= domain_menu_min_entities;

        // Check if we meet the minimum domain count condition
        const meetsDomainCountCondition = domainCount >= domain_menu_min_domains;

        // Return true if both conditions are met
        return meetsEntityCountCondition && meetsDomainCountCondition;
    }

    // Default to false for any other value
    return false;
}

function humanDiff(newestDate, oldestDate) {
    let prettyDate = {
        diffDate: newestDate - oldestDate,
        diffUnit: "ms"
    };

    if(oldestDate > newestDate) {
        return '> now';
    }

    function reduceNumbers(inPrettyDate, interval, unit) {
        if (inPrettyDate.diffDate > interval) {
            inPrettyDate.diffDate = inPrettyDate.diffDate / interval;
            inPrettyDate.diffUnit = unit;
        }
        return inPrettyDate;
    }

    prettyDate = reduceNumbers(prettyDate, 1000, 's');
    prettyDate = reduceNumbers(prettyDate, 60, 'm');
    prettyDate = reduceNumbers(prettyDate, 60, 'h');
    prettyDate = reduceNumbers(prettyDate, 24, 'd');
    return '> ' + Math.round(prettyDate.diffDate, 0) + ' ' + prettyDate.diffUnit;
}

// the below method is just here for reference on the REST API
// function getServices(){
//     // get API events
//     ajax({
//             url: baseurl + '/services',
//             type: 'json',
//             headers: baseheaders
//         },
//         function(data) {
//             log_message('HA Services: ' + data);
//             loadingCard.subtitle(data.message);
//             //on success call states?
//             //getstates();
//
//         },
//         function(error, status, request) {
//             log_message('HA Services failed: ' + error + ' status: ' + status);
//             loadingCard.subtitle('Error!');
//             loadingCard.body(error + ' status: ' + status);
//         }
//     );
// }

// show main screen
loadingCard.show();
//getEvents();

main();