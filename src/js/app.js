/**
 * Initial Home Assistant interface for Pebble.
 *
 * By texnofobix (Dustin S.)
 * Updated by Skylord123 (https://skylar.tech)
 */

const appVersion = '0.6.3',
    confVersion = '0.3.0',
    debugMode = true,
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
    timeline_token = null,
    ignore_domains = null;

function load_settings() {
    // Set some variables for quicker access
    ha_url = Settings.option('ha_url');
    ha_password = Settings.option('token');
    ha_refresh_interval = Settings.option('refreshTime') ? Settings.option('refreshTime') : 15;
    ha_filter = Settings.option('filter');
    ha_order_by = Settings.option('order_by');
    ha_order_dir = Settings.option('order_dir');
    voice_enabled = Feature.microphone(true, false) ? Settings.option('voice_enabled') : false;
    voice_confirm = Settings.option('voice_confirm');
    voice_agent = Settings.option('voice_agent') ? Settings.option('voice_agent') : null;
    domain_menu_enabled = true;

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
    favoriteEntityStore = new FavoriteEntityStore();


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
                        showDictationMenu();
                    }
                });
            }
            let favoriteEntities = favoriteEntityStore.all();
            if(favoriteEntities && favoriteEntities.length) {
                mainMenu.item(0, i++, {
                    title: "Favorites",
                    // subtitle: thisDevice.attributes[arr[i]],
                    on_click: function(e) {
                        // showEntityList();
                        if(domain_menu_enabled && favoriteEntities > 10) {
                            // only show domain list in favorites if there are more than 10 entities
                            showEntityDomainsFromList(favoriteEntities, "Favorites");
                        } else {
                            showEntityList("Favorites", favoriteEntities, true, false);
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
                title: "All Entities",
                // subtitle: thisDevice.attributes[arr[i]],
                on_click: function(e) {
                    if(domain_menu_enabled) {
                        showEntityDomainsFromList(Object.keys(ha_state_dict), "All Entities");
                    } else {
                        showEntityList("All Entities");
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
    let voiceSettingsMenu = new UI.Menu({
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

        // Enabled setting
        voiceSettingsMenu.item(0, 0, {
            title: "Enabled",
            subtitle: voice_enabled ? "True" : "False",
            on_click: function(e) {
                // Toggle voice_enabled setting
                voice_enabled = !voice_enabled;
                // Save to settings
                Settings.option('voice_enabled', voice_enabled);
                // Update menu
                updateMenuItems();
            }
        });

        // Agent setting
        let agentName = "Home Assistant"; // Default
        if (voice_agent) {
            // Extract the agent name from voice_agent (which is an entity_id)
            const agent_id = voice_agent.split('.')[1];
            agentName = agent_id
                .split('_')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
        }

        voiceSettingsMenu.item(0, 1, {
            title: "Agent",
            subtitle: agentName,
            on_click: function(e) {
                showVoiceAgentMenu();
            }
        });

        // Confirm Dictation setting
        voiceSettingsMenu.item(0, 2, {
            title: "Confirm Dictation",
            subtitle: voice_confirm ? "True" : "False",
            on_click: function(e) {
                // Toggle voice_confirm setting
                voice_confirm = !voice_confirm;
                // Save to settings
                Settings.option('voice_confirm', voice_confirm);
                // Update menu
                updateMenuItems();
            }
        });
    }

    voiceSettingsMenu.on('show', function() {
        updateMenuItems();
    });

    voiceSettingsMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
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

function showVoiceAgentMenu() {
    // Create a menu for selecting voice agents
    let voiceAgentMenu = new UI.Menu({
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Voice Agent'
        }]
    });

    voiceAgentMenu.on('show', function() {
        // Clear the menu
        voiceAgentMenu.items(0, []);

        // Get available agents from ha_state_dict
        const agents = [];

        // Iterate through ha_state_dict to find conversation entities
        for (const entity_id in ha_state_dict) {
            if (entity_id.startsWith('conversation.')) {
                // Extract the agent ID (part after "conversation.")
                const agent_id = entity_id.split('.')[1];

                // Create a friendly display name (capitalize and replace underscores)
                const name = agent_id
                    .split('_')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ');

                log_message("Found conversation agent " + entity_id);
                agents.push({
                    id: entity_id, // Store the FULL entity_id, not just the part after the dot
                    name: name,
                    entity_id: entity_id
                });
            }
        }

        // Sort agents alphabetically by name
        agents.sort((a, b) => a.name.localeCompare(b.name));

        // If no agents found, add a default
        if (agents.length === 0) {
            agents.push({
                id: 'conversation.home_assistant',
                name: 'Home Assistant',
                entity_id: 'conversation.home_assistant'
            });
        }

        // Add each agent to the menu
        for (let i = 0; i < agents.length; i++) {
            const agent = agents[i];
            voiceAgentMenu.item(0, i, {
                title: agent.name,
                subtitle: (voice_agent === agent.id) ? 'Current' : '',
                agent_id: agent.id
            });
        }
    });

    voiceAgentMenu.on('select', function(e) {
        // Save the selected agent
        voice_agent = e.item.agent_id;

        // Save to settings
        Settings.option('voice_agent', voice_agent);

        // Update the menu to show the currently selected agent
        for (let i = 0; i < voiceAgentMenu.items(0).length; i++) {
            const item = voiceAgentMenu.item(0, i);
            voiceAgentMenu.item(0, i, {
                title: item.title,
                subtitle: (voice_agent === item.agent_id) ? 'Current' : '',
                agent_id: item.agent_id
            });
        }

        // Close the menu after a brief delay to show the selection
        setTimeout(function() {
            voiceAgentMenu.hide();
        }, 500);
    });

    voiceAgentMenu.show();
}


// Add this new function to check for conversation agents
function checkConversationAgents() {
    // Get available agents from ha_state_dict
    const agents = [];
    let foundCurrentAgent = false;

    // Iterate through ha_state_dict to find conversation entities
    for (const entity_id in ha_state_dict) {
        if (entity_id.startsWith('conversation.')) {
            // Add to agents list
            agents.push(entity_id);

            // Check if the currently set agent is available
            if (entity_id === voice_agent) {
                foundCurrentAgent = true;
            }
        }
    }

    // If no agents found or current agent not available, reset to default or first available
    if (agents.length === 0) {
        // No conversation entities at all - disable voice functionality
        voice_agent = null;
        Settings.option('voice_agent', null);
        log_message("No conversation entities found - voice assistant disabled");
    } else if (!foundCurrentAgent || !voice_agent) {
        // Try to use home_assistant as default
        if (agents.includes('conversation.home_assistant')) {
            voice_agent = 'conversation.home_assistant';
        } else {
            // Use the first available agent
            voice_agent = agents[0];
        }

        // Save the selected agent
        Settings.option('voice_agent', voice_agent);
        log_message("Set default voice agent to: " + voice_agent);
    }

    return agents.length > 0;
}

let conversation_id = null;
function showDictationMenu() {
    if (!checkConversationAgents()) {
        let errorCard = new UI.Card({
            title: 'Assistant Error',
            body: 'No conversation entities found on this Home Assistant instance.',
            scrollable: true
        });

        errorCard.on('click', 'back', function() {
            errorCard.hide();
        });

        errorCard.show();
        return;
    }

    let dictationWindow = new UI.Window({
        backgroundColor: Feature.color('white', 'black'),
        scrollable: true
    });

    // Configuration for message spacing
    const MESSAGE_PADDING = 0; // Padding between messages
    const SCROLL_PADDING = 0; // Padding at the bottom when scrolling

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
    dictationWindow.add(titleBar);

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
            dictationWindow.remove(currentErrorMessage.title);
            dictationWindow.remove(currentErrorMessage.message);
        }

        // Add error title
        let errorTitle = new UI.Text({
            position: new Vector(5, currentY + 5),
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

        dictationWindow.add(errorTitle);
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
            dictationWindow.add(errorMessage);
            conversationElements.push(errorMessage);

            currentErrorMessage = {
                title: errorTitle,
                message: errorMessage
            };

            // Update position for next message with configurable padding
            currentY += 20 + height + MESSAGE_PADDING; // title (20) + message height + padding
            log_message("New currentY position for error: " + currentY);

            // Update the window's content size to ensure proper scrolling
            // Add more padding at the bottom to ensure content isn't cut off
            const contentHeight = currentY + 20; // Add 20px padding at the bottom
            dictationWindow.size(new Vector(Feature.resolution().x, contentHeight));
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
                    scrollWindowTo(dictationWindow, scrollTarget, true);
                    log_message("Scrolling error to target: " + scrollTarget);
                }, 100);
            }

            log_message("Error message added, content height: " + currentY);
        });
    }

    function addMessage(speaker, message, callback) {
        log_message("Adding message from " + speaker + ": " + message);

        // Remove error message if exists
        if (currentErrorMessage) {
            dictationWindow.remove(currentErrorMessage.title);
            dictationWindow.remove(currentErrorMessage.message);
            currentErrorMessage = null;
        }

        try {
            // Generate unique IDs for our elements
            const speakerId = Math.floor(Math.random() * 100000);
            const messageId = Math.floor(Math.random() * 100000);

            // Add speaker label
            let speakerLabel = new UI.Text({
                id: speakerId,
                position: new Vector(5, currentY + 5),
                size: new Vector(Feature.resolution().x - 10, 20),
                text: speaker + ':',
                font: 'gothic-18-bold',
                color: Feature.color('black', 'white'),
                textAlign: 'left'
            });
            dictationWindow.add(speakerLabel);
            conversationElements.push(speakerLabel);

            // Add message text
            let messageText = new UI.Text({
                id: messageId,
                position: new Vector(5, currentY + 20),
                size: new Vector(Feature.resolution().x - 10, 2000),
                text: message,
                font: 'gothic-18',
                color: Feature.color('black', 'white'),
                textAlign: 'left',
                textOverflow: 'wrap'
            });

            log_message("Getting height of new text..");
            // Get the actual height of the message text
            messageText.getHeight(function(height) {
                log_message("Text height callback received with height: " + height);

                // Ensure we have a reasonable height (minimum 20px)
                height = Math.max(height, 20);

                // Log the calculated height for debugging
                log_message("Text height calculation for message: " + height + "px for text: " + message.substring(0, 30) + "...");

                // Update the message text element size with the actual height
                // Add extra padding to ensure text isn't cut off
                messageText.size(new Vector(Feature.resolution().x - 10, height + 10));

                // Add the message text to the window
                dictationWindow.add(messageText);
                conversationElements.push(messageText);

                // Update position for next message with configurable padding
                // Similar to Bobby's approach: speaker label + message height + padding
                currentY += 20 + height + MESSAGE_PADDING;
                log_message("New currentY position: " + currentY);

                // Update the window's content size to ensure proper scrolling
                // Add more padding at the bottom to ensure content isn't cut off
                const contentHeight = currentY + 20; // Add 20px padding at the bottom
                dictationWindow.size(new Vector(Feature.resolution().x, contentHeight));
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
                        scrollWindowTo(dictationWindow, scrollTarget, true);
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

        // Position dots below the last message
        const centerX = Feature.resolution().x / 2;
        const startY = currentY;

        // Calculate the starting X position for the first dot
        // Center the three dots with spacing
        const startX = centerX - DOT_SPACING - DOT_SIZE/2;

        // Position and add each dot
        for (let i = 0; i < loadingDots.length; i++) {
            const dotX = startX + (i * DOT_SPACING);
            loadingDots[i].position(new Vector(dotX, startY));
            dictationWindow.add(loadingDots[i]);
        }

        // Calculate the bottom position of the animation
        const loadingBottom = startY + DOT_SIZE + 10; // Dots position + size + padding

        // Make sure the window is tall enough to show the full animation
        // Add significant extra padding to ensure the animation is fully visible
        dictationWindow.size(new Vector(Feature.resolution().x, loadingBottom + 50)); // 50px extra padding
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
            scrollWindowTo(dictationWindow, scrollTarget, true);
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
            // Hide all dots first
            for (let i = 0; i < loadingDots.length; i++) {
                loadingDots[i].radius(0);
            }

            // Show dots based on current animation state
            switch (animationState) {
                case 0: // First dot only
                    loadingDots[0].radius(DOT_SIZE / 2);
                    break;
                case 1: // First and second dots
                    loadingDots[0].radius(DOT_SIZE / 2);
                    loadingDots[1].radius(DOT_SIZE / 2);
                    break;
                case 2: // All three dots
                    loadingDots[0].radius(DOT_SIZE / 2);
                    loadingDots[1].radius(DOT_SIZE / 2);
                    loadingDots[2].radius(DOT_SIZE / 2);
                    break;
                case 3: // Second and third dots
                    loadingDots[1].radius(DOT_SIZE / 2);
                    loadingDots[2].radius(DOT_SIZE / 2);
                    break;
                case 4: // Third dot only
                    loadingDots[2].radius(DOT_SIZE / 2);
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
            dictationWindow.remove(loadingDots[i]);
        }
    }

    function startDictation() {
        log_message("startDictation");
        Voice.dictate('start', true, function(e) {
            if (e.err) {
                if (e.err === "systemAborted") {
                    log_message("dictation cancelled by user");
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

                let body = {
                    "type": "conversation/process",
                    "text": e.transcription,
                    "agent_id": voice_agent
                };
                if (conversation_id) {
                    body.conversation_id = conversation_id;
                }

                log_message("Sending conversation/process request");
                haws.send(body,
                    function(data) {
                        log_message("conversation/process response received: " + JSON.stringify(data));
                        stopLoadingAnimation(animationTimer);

                        if (!data.success) {
                            showError('Request failed');
                            return;
                        }

                        try {
                            let reply = data.result?.response?.speech.plain.speech;
                            if (!reply) {
                                throw new Error('Invalid response format');
                            }
                            addMessage('Home Assistant', reply, null);
                            conversation_id = data.conversation_id;
                        } catch (err) {
                            showError('Invalid response format from Home Assistant');
                            log_message("Response format error: " + err.toString());
                        }
                    },
                    function(error) {
                        log_message("conversation/process error: " + error.toString());
                        stopLoadingAnimation(animationTimer);
                        showError('Connection error');
                    }
                );
            });
        });
    }

    dictationWindow.on('click', 'select', function(e) {
        log_message("Dictation button pressed", e);
        startDictation();
    });

    dictationWindow.on('longClick', 'select', showVoiceAgentMenu);

    dictationWindow.on('show', function() {
        startDictation();
    });

    dictationWindow.on('hide', function() {
        conversation_id = null;
    });

    dictationWindow.show();
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

                        if(domain_menu_enabled) {
                            showEntityDomainsFromList(Object.keys(areaObjects), entry.display_name);
                        } else {
                            showEntityList(entry.display_name, Object.keys(areaObjects));
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
                strokeColor: pointerColor,
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
                    menuBarsFg[i].position2(new Vector(20 + boxLeftMargin + barWidth, item.y + 22));

                    // Always use highlight color for progress bars
                    menuBarsFg[i].strokeColor(colour.highlight);
                }
            } else if (item.id === "temperature") {
                menuSubtexts[i].text(is_on ? `${item.kelvin}K` : "NA");

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
function showEntityList(title, entity_id_list = false, ignoreEntityCache = true, sortItems = true) {
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

                // Filter out ignored domains
                if (ignore_domains && ignore_domains.length > 0) {
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
    log_message("Fetching states, config areas, config devices, and config entities...");
    let done_fetching = function(){
        // basically just a wrapper to check that all the things have finished fetching
        if(area_registry_cache && device_registry_cache && entity_registry_cache && ha_state_cache) {
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







