/**
 * Initial Home Assistant interface for Pebble.
 *
 * By texnofobix (Dustin S.)
 * Updated by Skylord123 (https://skylar.tech)
 */

const appVersion = '0.6.3',
    confVersion = '0.3.0',
    debugMode = true,
    debugHAWS = true,
    UI = require('ui'),
    WindowStack = require('ui/windowstack'),
    ajax = require('ajax'),
    Settings = require('settings'),
    Voice = require('ui/voice'),
    HAWS = require('vendor/haws'),
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
        highlight: Feature.color("#00AAFF", "#000000")
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
    domain_menu_enabled = null;

function load_settings() {
    // Set some variables for quicker access
    ha_url = Settings.option('ha_url');
    ha_password = Settings.option('token');
    ha_refresh_interval = Settings.option('refreshTime') ? Settings.option('refreshTime') : 15;
    ha_filter = Settings.option('filter');
    ha_order_by = Settings.option('order_by');
    ha_order_dir = Settings.option('order_dir');
    voice_enabled = Settings.option('voice_enabled');
    voice_confirm = Settings.option('voice_confirm');
    voice_agent = Settings.option('voice_agent') ? Settings.option('voice_agent') : null;
    domain_menu_enabled = true;
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
                title: 'Home Assistant'
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
            title: 'Settings'
        }]
    });

    settingsMenu.on('show', function() {
        // Clear the menu
        settingsMenu.items(0, []);

        settingsMenu.item(0, 0, {
            title: "Assistant",
            on_click: function(e) {
                showVoiceAssistantSettings();
            }
        });

        settingsMenu.item(0, 1, {
            title: "Entity Settings",
            on_click: function(e) {
                showEntitySettings();
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

let conversation_id = null;
function showDictationMenu() {
    // Create a window with a clean layout
    var dictationWindow = new UI.Window({
        backgroundColor: Feature.color('white', 'black')
    });

    // Combined conversation display - add this FIRST so it's behind other elements
    var conversationText = new UI.Text({
        position: new Vector(5, 25), // Start position below title bar
        size: new Vector(Feature.resolution().x - 10, 300), // Make this much taller for scrolling
        text: 'Tap to speak',
        font: 'gothic-18',
        color: Feature.color('black', 'white'),
        textAlign: 'left'
    });
    dictationWindow.add(conversationText);

    // Add a title bar AFTER the conversation text so it stays on top
    var titleBar = new UI.Text({
        position: new Vector(0, 0),
        size: new Vector(Feature.resolution().x, 24),
        text: 'Assistant',
        font: 'gothic-18-bold',
        color: Feature.color('black', 'white'),
        textAlign: 'center',
        backgroundColor: colour.highlight
    });
    dictationWindow.add(titleBar);

    // Status indicator (shows listening/processing state)
    var statusIndicator = new UI.Circle({
        position: new Vector(Feature.resolution().x / 2, Feature.resolution().y / 2),
        radius: 8,
        backgroundColor: Feature.color('#FF0000', 'white')
    });

    // Scrolling variables
    var scrollPosition = 0;
    var scrollStep = 25; // Roughly one line height
    var maxScroll = 0;
    var titleHeight = 24; // Height of the title bar

    // Function to update scroll position while keeping text below title bar
    function updateScroll() {
        // Start at titleHeight when scrollPosition is 0
        conversationText.position(new Vector(5, titleHeight - scrollPosition));
    }

    // Animation for the status indicator
    var animationTimer = null;
    function startAnimation(color) {
        var radius = 8;
        var growing = true;

        // Clear any existing animation
        stopAnimation();

        // Set the indicator color
        statusIndicator.backgroundColor(color);
        dictationWindow.add(statusIndicator);

        // Start pulsing animation
        animationTimer = setInterval(function() {
            if (growing) {
                radius += 1;
                if (radius >= 12) growing = false;
            } else {
                radius -= 1;
                if (radius <= 8) growing = true;
            }
            statusIndicator.radius(radius);
        }, 300);
    }

    function stopAnimation() {
        if (animationTimer) {
            clearInterval(animationTimer);
            animationTimer = null;
        }
        dictationWindow.remove(statusIndicator);
    }

    // Function to start a new dictation session
    function startDictation() {
        // Clear previous conversation
        scrollPosition = 0;
        updateScroll();

        // Start voice recognition
        Voice.dictate('start', voice_confirm, function(e) {
            if (e.err) {
                log_message('Transcription error: ' + e.err);

                stopAnimation();

                // Check if the user aborted the dictation
                if (e.err === "systemAborted") {
                    return;
                }

                // Handle other errors
                conversationText.text('Transcription error - Tap to retry');
                return;
            }

            // Display the user's query
            log_message('User said: ' + e.transcription);
            conversationText.text('Me: ' + e.transcription);

            // Update animation for processing
            startAnimation(Feature.color('#0000FF', '#6666FF')); // Blue for processing

            // Send request to Home Assistant
            var body = {
                "type": "conversation/process",
                "text": e.transcription,
                "agent_id": voice_agent  // Use the full entity_id directly
            };
            if (conversation_id) {
                body.conversation_id = conversation_id;
            }

            haws.send(body, function(data) {
                if (!data.success) {
                    log_message('Conversation error: ' + JSON.stringify(data));
                    conversationText.text('Me: ' + e.transcription + '\nHA: Sorry, could not process your request.');
                    // Calculate max scroll based on text length
                    var lines = 2; // Basic count: 1 for user text, 1 for response
                    maxScroll = Math.max(0, (lines * scrollStep) - 100); // 100 is approximate visible height
                    stopAnimation();
                    return;
                }

                // Display response
                log_message('Received: ' + JSON.stringify(data));

                // Store the conversation ID for future responses
                if (data.result.conversation_id) {
                    conversation_id = data.result.conversation_id;
                }

                // Get the response type
                var responseType = data.result.response.response_type;
                var reply = "";

                // Get the speech reply if available
                if (data.result.response.speech &&
                    (data.result.response.speech.plain || data.result.response.speech.ssml)) {
                    reply = data.result.response.speech.plain ?
                        data.result.response.speech.plain.speech :
                        data.result.response.speech.ssml.speech;
                }

                // Check for errors and add error information
                if (responseType === "error" && data.result.response.data && data.result.response.data.code) {
                    var errorCode = data.result.response.data.code;
                    var errorDesc = getErrorDescription(errorCode);

                    // Add error description in parentheses if we have both a reply and error info
                    if (reply) {
                        reply += " (" + errorDesc + ")";
                    } else {
                        reply = "Error: " + errorDesc;
                    }
                }

                // Default message if no reply is available
                if (!reply) {
                    reply = "Request processed, but no response was provided.";
                }

                // Set the conversation text
                conversationText.text('Me: ' + e.transcription + '\nHA: ' + reply);

                // Estimate number of lines based on text length and display width
                var totalText = ('Me: ' + e.transcription + '\nHA: ' + reply);
                var estCharsPerLine = 30; // Approximate
                var estLines = Math.ceil(totalText.length / estCharsPerLine);

                // Calculate max scroll
                maxScroll = Math.max(0, (estLines * scrollStep) - 100); // 100 is approximate visible height

                stopAnimation();
            }, function(error) {
                // Network or other error
                conversationText.text('Me: ' + e.transcription + '\nHA: Sorry, could not process your request (connection error).');
                // Calculate max scroll based on text length
                var lines = 2; // Basic count: 1 for user text, 1 for response
                maxScroll = Math.max(0, (lines * scrollStep) - 100); // 100 is approximate visible height
                stopAnimation();
            });
        });
    }

    // Helper function to get a user-friendly description for error codes
    function getErrorDescription(errorCode) {
        switch(errorCode) {
            case "no_intent_match":
                return "The input text did not match any intents";
            case "no_valid_targets":
                return "The targeted area, device, or entity does not exist";
            case "failed_to_handle":
                return "An unexpected error occurred while handling the intent";
            case "unknown":
                return "An error occurred outside the scope of intent processing";
            default:
                return "Unknown error: " + errorCode;
        }
    }

    // When the window is shown, start dictation
    dictationWindow.on('show', function() {
        Light.on('long');
        startDictation();
    });

    // If the window is hidden, clean up
    dictationWindow.on('hide', function() {
        Light.on('auto');
        stopAnimation();
    });

    // Handle button clicks
    dictationWindow.on('click', 'select', function() {
        startDictation();
    });

    // Add long-press handler for agent selection
    dictationWindow.on('longClick', 'select', function() {
        showVoiceAgentMenu();
    });

    // Implement scrolling
    dictationWindow.on('click', 'up', function() {
        scrollPosition = Math.max(0, scrollPosition - scrollStep);
        updateScroll();
    });

    dictationWindow.on('click', 'down', function() {
        scrollPosition = Math.min(maxScroll, scrollPosition + scrollStep);
        updateScroll();
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
            // add items to menu
            let i = 0;
            for(let area_id in area_registry_cache) {
                let area_name = area_registry_cache[area_id];
                let areaObjects = getEntitiesForArea(area_name ? area_id : null);
                let areaObjectCount = Object.keys(areaObjects).length;
                let display_name = area_name ? area_name : 'Unassigned'
                areaMenu.item(0, i++, {
                    title: display_name,
                    subtitle: `${areaObjectCount} ${(areaObjectCount > 1 || areaObjectCount === 0) ? 'entities' : 'entity'}`,
                    on_click: function(e) {
                        // log_message(JSON.stringify(getEntitiesForArea(area_id)));
                        if(domain_menu_enabled) {
                            showEntityDomainsFromList(Object.keys(areaObjects), display_name);
                        } else {
                            showEntityList(display_name, Object.keys(areaObjects));
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
        Light.on('long');
        subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
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
        Light.on('auto');
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
    let brightnessPerc = Math.ceil((100 / 255) * parseInt(light.attributes.brightness));

    // Calculate mired step sizes for temperature if supported
    let miredJumpSmall = 0;
    let miredJumpLarge = 0;
    if (supportsTemperature) {
        let miredRange = light.attributes.max_mireds - light.attributes.min_mireds;
        miredJumpSmall = Math.floor((miredRange / 100) * 10);
        miredJumpLarge = Math.floor((miredRange / 100) * 30);
    }

    // Set initial active mode (0 = brightness, 1 = temperature)
    let activeMode = 0;

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

    // Create UI elements
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
        lightIcon = new UI.Image({
            position: Feature.round(new Vector(nameWidth + 5, titleY + 5), new Vector(nameWidth + 5, titleY + 5)),
            size: new Vector(25, 25),
            compositing: "set",
            backgroundColor: 'transparent',
            image: "IMAGE_ICON_BULB"
        });
    }

    let stateLabel = new UI.Text({
        text: is_on ? "On" : "Off",
        color: "black",
        font: "gothic_24_bold",
        position: Feature.round(new Vector(10, 40), new Vector(5, 40)),
        size: new Vector(availableWidth, 30),
        textAlign: "left"
    });

    // Position values for controls
    let brightY = 65;
    let tempY = 110;
    let indicatorOffset = 15; // Move labels to the right to avoid overlap with indicators

    // Brightness control elements
    let brightnessLabel = new UI.Text({
        text: "Brightness:",
        color: "black",
        font: "gothic_18",
        position: Feature.round(new Vector(10 + indicatorOffset, brightY), new Vector(5 + indicatorOffset, brightY)),
        size: new Vector(availableWidth - indicatorOffset, 25),
        textAlign: "left"
    });

    let brightnessValue = new UI.Text({
        text: is_on ? `${brightnessPerc}%` : "Off",
        color: "black",
        font: "gothic_18",
        position: Feature.round(new Vector(100, brightY), new Vector(95, brightY)),
        size: new Vector(40, 25),
        textAlign: "right"
    });

    // Brightness indicator triangle (initially shown since activeMode = 0)
    let activeIndicator = {
        line1: new UI.Line({
            position: new Vector(5, brightY + 8),
            position2: new Vector(12, brightY + 12),
            strokeColor: colour.highlight,
            strokeWidth: 2
        }),
        line2: new UI.Line({
            position: new Vector(12, brightY + 12),
            position2: new Vector(5, brightY + 16),
            strokeColor: colour.highlight,
            strokeWidth: 2
        }),
        line3: new UI.Line({
            position: new Vector(5, brightY + 8),
            position2: new Vector(5, brightY + 16),
            strokeColor: colour.highlight,
            strokeWidth: 2
        }),
        y: brightY // Store current y position
    };

    // Brightness progress bar - positioned right below the text
    let brightness_bg = new UI.Line({
        position: new Vector(10, brightY + 25),
        position2: new Vector(134, brightY + 25),
        strokeColor: 'black',
        strokeWidth: 5,
    });

    let brightness_bg_inner = new UI.Line({
        position: new Vector(10, brightY + 25),
        position2: new Vector(134, brightY + 25),
        strokeColor: 'white',
        strokeWidth: 3,
    });

    let brightness_fg = new UI.Line({
        position: new Vector(10, brightY + 25),
        position2: new Vector(10, brightY + 25),
        strokeColor: colour.highlight,
        strokeWidth: 3,
    });

    // Calculate brightness bar fill
    let brightness_max_width = 124; // 134 - 10
    let brightness_fill_width = brightness_max_width * (brightnessPerc / 100);
    brightness_fg.position2(new Vector(10 + brightness_fill_width, brightY + 25));

    // Temperature control elements
    let temperatureLabel = null;
    let temperatureValue = null;
    let temp_bg = null;
    let temp_bg_inner = null;
    let temp_fg = null;

    if (supportsTemperature) {
        temperatureLabel = new UI.Text({
            text: "Color Temp:",
            color: "black",
            font: "gothic_18",
            position: Feature.round(new Vector(10 + indicatorOffset, tempY), new Vector(5 + indicatorOffset, tempY)),
            size: new Vector(availableWidth - indicatorOffset - 10, 25), // Leave more room for Kelvin values
            textAlign: "left"
        });

        // Calculate Kelvin from mireds
        let kelvinTemp = Math.round(1000000 / light.attributes.color_temp);

        temperatureValue = new UI.Text({
            text: is_on ? (light.attributes.color_temp ? `${kelvinTemp}K` : "NA") : "Off",
            color: "black",
            font: "gothic_18",
            position: Feature.round(new Vector(100, tempY), new Vector(95, tempY)),
            size: new Vector(40, 25),
            textAlign: "right"
        });

        // Temperature progress bar - positioned right below the text
        temp_bg = new UI.Line({
            position: new Vector(10, tempY + 25),
            position2: new Vector(134, tempY + 25),
            strokeColor: 'black',
            strokeWidth: 5,
        });

        temp_bg_inner = new UI.Line({
            position: new Vector(10, tempY + 25),
            position2: new Vector(134, tempY + 25),
            strokeColor: 'white',
            strokeWidth: 3,
        });

        temp_fg = new UI.Line({
            position: new Vector(10, tempY + 25),
            position2: new Vector(10, tempY + 25),
            strokeColor: 'black', // Start with black, will change if activeMode = 1
            strokeWidth: 3,
        });

        // Calculate temperature bar fill based on current value
        if (light.attributes.color_temp) {
            let temp_range = light.attributes.max_mireds - light.attributes.min_mireds;
            let current_temp_pos = light.attributes.color_temp - light.attributes.min_mireds;
            let temp_percentage = current_temp_pos / temp_range;
            let temp_fill_width = brightness_max_width * temp_percentage;
            temp_fg.position2(new Vector(10 + temp_fill_width, tempY + 25));
        }
    }

    // Instructions at the bottom
    let instructionsText = new UI.Text({
        text: supportsTemperature ? "SELECT: Switch Mode | HOLD: Toggle" : "HOLD SELECT: Toggle",
        color: "black",
        font: "gothic_14",
        position: new Vector(0, 150),
        size: new Vector(Feature.resolution().x, 20),
        textAlign: "center"
    });

    // Add elements to window
    lightControlWindow.add(lightName);
    if (enableIcons) {
        lightControlWindow.add(lightIcon);
    }
    lightControlWindow.add(stateLabel);

    // Add brightness elements
    lightControlWindow.add(brightnessLabel);
    lightControlWindow.add(brightnessValue);
    lightControlWindow.add(activeIndicator.line1);
    lightControlWindow.add(activeIndicator.line2);
    lightControlWindow.add(activeIndicator.line3);
    lightControlWindow.add(brightness_bg);
    lightControlWindow.add(brightness_bg_inner);
    lightControlWindow.add(brightness_fg);

    // Add temperature elements if supported
    if (supportsTemperature) {
        lightControlWindow.add(temperatureLabel);
        lightControlWindow.add(temperatureValue);
        lightControlWindow.add(temp_bg);
        lightControlWindow.add(temp_bg_inner);
        lightControlWindow.add(temp_fg);
    }

    lightControlWindow.add(instructionsText);

    // Function to update the UI with new entity state
    function updateLightUI(newState) {
        if (!newState) return;

        log_message(`LIGHT WINDOW UPDATE ${newState.entity_id}: ${JSON.stringify(newState, null, 4)}`);
        light = newState;
        is_on = light.state === "on";

        // Update brightness if available
        if (is_on && light.attributes.hasOwnProperty("brightness")) {
            brightnessPerc = Math.ceil((100 / 255) * parseInt(light.attributes.brightness));
            brightness_fill_width = brightness_max_width * (brightnessPerc / 100);
            brightness_fg.position2(new Vector(10 + brightness_fill_width, brightY + 25));
            brightnessValue.text(`${brightnessPerc}%`);
        } else {
            brightnessValue.text(is_on ? "0%" : "Off");
            brightness_fg.position2(new Vector(10, brightY + 25));
        }

        // Update temperature if supported
        if (is_on && supportsTemperature && light.attributes.color_temp) {
            let temp_range = light.attributes.max_mireds - light.attributes.min_mireds;
            let current_temp_pos = light.attributes.color_temp - light.attributes.min_mireds;
            let temp_percentage = current_temp_pos / temp_range;
            let temp_fill_width = brightness_max_width * temp_percentage;
            temp_fg.position2(new Vector(10 + temp_fill_width, tempY + 25));

            // Calculate and display temperature in Kelvin
            let kelvinTemp = Math.round(1000000 / light.attributes.color_temp);
            temperatureValue.text(`${kelvinTemp}K`);
        } else if (supportsTemperature) {
            temperatureValue.text(is_on ? "NA" : "Off");
            temp_fg.position2(new Vector(10, tempY + 25));
        }

        // Update state label
        stateLabel.text(is_on ? "On" : "Off");
    }

    // Function to update active mode indicators
    function updateModeIndicators() {
        // Remove current indicator
        lightControlWindow.remove(activeIndicator.line1);
        lightControlWindow.remove(activeIndicator.line2);
        lightControlWindow.remove(activeIndicator.line3);

        // Update the Y position based on active mode
        let newY = activeMode === 0 ? brightY : tempY;

        // Create new indicator at the correct position
        activeIndicator = {
            line1: new UI.Line({
                position: new Vector(5, newY + 8),
                position2: new Vector(12, newY + 12),
                strokeColor: colour.highlight,
                strokeWidth: 2
            }),
            line2: new UI.Line({
                position: new Vector(12, newY + 12),
                position2: new Vector(5, newY + 16),
                strokeColor: colour.highlight,
                strokeWidth: 2
            }),
            line3: new UI.Line({
                position: new Vector(5, newY + 8),
                position2: new Vector(5, newY + 16),
                strokeColor: colour.highlight,
                strokeWidth: 2
            }),
            y: newY
        };

        // Add new indicator to window
        lightControlWindow.add(activeIndicator.line1);
        lightControlWindow.add(activeIndicator.line2);
        lightControlWindow.add(activeIndicator.line3);

        // Update progress bar colors
        brightness_fg.strokeColor(activeMode === 0 ? colour.highlight : 'black');
        if (supportsTemperature) {
            temp_fg.strokeColor(activeMode === 1 ? colour.highlight : 'black');
        }
    }

    // Function to update brightness
    function updateBrightness(brightness) {
        if (brightness < 0) brightness = 0;
        if (brightness > 100) brightness = 100;

        // Convert percentage to 0-255 value
        let brightnessValue = Math.round((brightness / 100) * 255);

        haws.callService(
            "light",
            "turn_on",
            { brightness: brightnessValue },
            { entity_id: light.entity_id },
            function(data) {
                log_message(`Updated brightness: ${brightness}%`);
                // Not updating UI here since the subscription will handle it
            },
            function(error) {
                log_message(`Error updating brightness: ${error}`);
            }
        );
    }

    // Function to update color temperature
    function updateTemperature(temp) {
        if (!supportsTemperature) return;

        if (temp < light.attributes.min_mireds) temp = light.attributes.min_mireds;
        if (temp > light.attributes.max_mireds) temp = light.attributes.max_mireds;

        haws.callService(
            "light",
            "turn_on",
            { color_temp: temp },
            { entity_id: light.entity_id },
            function(data) {
                log_message(`Updated color temp: ${temp} mireds (${Math.round(1000000/temp)}K)`);
                // Not updating UI here since the subscription will handle it
            },
            function(error) {
                log_message(`Error updating color temp: ${error}`);
            }
        );
    }

    // Set up button handlers
    lightControlWindow.on('show', function() {
        Light.on('long');
        subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            updateLightUI(data.event.variables.trigger.to_state);
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });
    });

    lightControlWindow.on('hide', function() {
        Light.on('auto');
        if (subscription_msg_id) {
            haws.unsubscribe(subscription_msg_id);
        }
    });

    // Handle button clicks
    lightControlWindow.on('click', 'select', function() {
        if (supportsTemperature) {
            // Toggle between brightness and temperature modes
            activeMode = activeMode === 0 ? 1 : 0;
            updateModeIndicators();
        }
    });

    lightControlWindow.on('longClick', 'select', function() {
        // Toggle light on/off
        haws.callService(
            "light",
            "toggle",
            {},
            { entity_id: light.entity_id },
            function(data) {
                log_message(`Toggled light: ${light.entity_id}`);
                // Not updating UI here since the subscription will handle it
            },
            function(error) {
                log_message(`Error toggling light: ${error}`);
            }
        );
    });

    lightControlWindow.on('click', 'up', function() {
        if (!is_on) return;

        if (activeMode === 0) {
            // Increase brightness by 10%
            updateBrightness(brightnessPerc + 10);
        } else if (activeMode === 1 && supportsTemperature) {
            // Increase color temperature by small increment
            updateTemperature(light.attributes.color_temp + miredJumpSmall);
        }
    });

    lightControlWindow.on('longClick', 'up', function() {
        if (!is_on) return;

        if (activeMode === 0) {
            // Increase brightness by 25%
            updateBrightness(brightnessPerc + 25);
        } else if (activeMode === 1 && supportsTemperature) {
            // Increase color temperature by large increment
            updateTemperature(light.attributes.color_temp + miredJumpLarge);
        }
    });

    lightControlWindow.on('click', 'down', function() {
        if (!is_on) return;

        if (activeMode === 0) {
            // Decrease brightness by 10%
            updateBrightness(brightnessPerc - 10);
        } else if (activeMode === 1 && supportsTemperature) {
            // Decrease color temperature by small increment
            updateTemperature(light.attributes.color_temp - miredJumpSmall);
        }
    });

    lightControlWindow.on('longClick', 'down', function() {
        if (!is_on) return;

        if (activeMode === 0) {
            // Decrease brightness by 25%
            updateBrightness(brightnessPerc - 25);
        } else if (activeMode === 1 && supportsTemperature) {
            // Decrease color temperature by large increment
            updateTemperature(light.attributes.color_temp - miredJumpLarge);
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
        var stateIndex = i - 1;

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

        if (
            domain === "switch" ||
            domain === "light" ||
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

    // @todo update main function to use this instead of showEntityList (but make it configurable)
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
                // data = sortJSON(data, 'last_changed', 'desc');
                if(entity_id_list) {
                    data = data.filter(function(element, index) {
                        return entity_id_list.indexOf(element.entity_id) > -1;
                    })
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
                            log_message('FALED TO FIND ENTITY ' + data.event.variables.trigger.to_state.entity_id);
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
    if(!ha_url || !ha_password) {
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