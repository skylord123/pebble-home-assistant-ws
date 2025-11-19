/**
 * pebble-home-assistant-ws
 *
 * Created by Skylord123 (https://skylar.tech)
 */

const Vibe = require('ui/vibe'); //needed for vibration to work
const isEmulator = Pebble.platform === 'pypkjs'; // we are in an emulator

const appVersion = '0.9', // displays in loading screen
    confVersion = '0.9', // version of config page
    debugMode = false,
    debugHAWS = false,
    hawsFaker = isEmulator
        && !( typeof window.EventTarget == 'function' || typeof window.WebSocket == 'function'); // we do not support websockets so use mock
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
    simply = require('ui/simply'),
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
const Platform = require("./platform");
const colour = {
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
    ha_connected = false,
    quick_launch_behavior = null;



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
    quick_launch_behavior = Settings.option('quick_launch_behavior') || 'main_menu';

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
        log_message('Error getting timeline token: ' + error);
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
            status: false,
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
                title: "To-Do Lists",
                // subtitle: thisDevice.attributes[arr[i]],
                on_click: function(e) {
                    showToDoLists();
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

            // Restore the previously selected index after items are populated
            if (menuSelections.mainMenu > 0 && menuSelections.mainMenu < mainMenu.items(0).length) {
                mainMenu.selection(0, menuSelections.mainMenu);
            }
        });

        // menu item pressed, if it has an event fn call it
        mainMenu.on('select', function(e) {
            // Store the current selection index
            menuSelections.mainMenu = e.itemIndex;

            log_message("Main menu click: " + e.item.title + " Index: " + e.itemIndex);
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
        status: false,
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

        settingsMenu.item(0, i++, {
            title: "Quick Launch",
            on_click: function(e) {
                showQuickLaunchSettings();
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
        status: false,
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
        Vibe.vibrate('short');
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
        status: false,
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
            status: false,
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
            status: false,
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

function showQuickLaunchSettings() {
    // Create a menu for quick launch settings
    let quickLaunchMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Quick Launch Action'
        }]
    });

    quickLaunchMenu.on('show', function() {
        // Clear the menu
        quickLaunchMenu.items(0, []);

        let itemIndex = 0;

        // Add options
        quickLaunchMenu.item(0, itemIndex++, {
            title: "Main Menu",
            subtitle: quick_launch_behavior === 'main_menu' ? "Current" : "",
            value: 'main_menu'
        });

        if ( voice_enabled ) {
            quickLaunchMenu.item(0, itemIndex++, {
                title: "Assistant",
                subtitle: quick_launch_behavior === 'assistant' ? "Current" : "",
                value: 'assistant'
            });
        }

        quickLaunchMenu.item(0, itemIndex++, {
            title: "Favorites",
            subtitle: quick_launch_behavior === 'favorites' ? "Current" : "",
            value: 'favorites'
        });

        quickLaunchMenu.item(0, itemIndex++, {
            title: "Areas",
            subtitle: quick_launch_behavior === 'areas' ? "Current" : "",
            value: 'areas'
        });

        quickLaunchMenu.item(0, itemIndex++, {
            title: "Labels",
            subtitle: quick_launch_behavior === 'labels' ? "Current" : "",
            value: 'labels'
        });

        quickLaunchMenu.item(0, itemIndex++, {
            title: "To-Do Lists",
            subtitle: quick_launch_behavior === 'todo_lists' ? "Current" : "",
            value: 'todo_lists'
        });
    });

    quickLaunchMenu.on('select', function(e) {
        // Set the quick launch behavior
        quick_launch_behavior = e.item.value;

        // Save to settings
        Settings.option('quick_launch_behavior', quick_launch_behavior);

        // Update menu items to show current selection
        const items = quickLaunchMenu.items(0);
        for (let i = 0; i < items.length; i++) {
            const item = quickLaunchMenu.item(0, i);
            quickLaunchMenu.item(0, i, {
                title: item.title,
                subtitle: item.value === quick_launch_behavior ? "Current" : "",
                value: item.value
            });
        }
    });

    quickLaunchMenu.show();
}

function showVoicePipelineMenu() {
    // Create a menu for selecting Voice Pipelines
    let voicePipelineMenu = new UI.Menu({
        status: false,
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
        scrollable: true,
        paging: false // paging is by default enabled for round but we have our own custom scrolling
    });

    // Calculate the maximum rectangle that can fit inside a round display
    function getMaxRectInRound() {
        const resolution = Feature.resolution();
        const isRound = Feature.round(true, false);

        if (!isRound) {
            // For rectangular displays, use the full resolution
            return {
                width: resolution.x,
                height: resolution.y,
                left: 0,
                top: 0
            };
        }

        // For round displays, use the inscribed square
        // The maximum square that fits in a circle has sides of length r*sqrt(2)
        const radius = resolution.x / 2; // 90px for chalk
        const squareSide = Math.floor(radius * Math.sqrt(2));

        return {
            width: squareSide,
            height: squareSide,
            left: Math.floor((resolution.x - squareSide) / 2),
            top: Math.floor((resolution.y - squareSide) / 2)
        };
    }

    // Get the maximum rectangle dimensions
    const maxRect = getMaxRectInRound();
    log_message("Max rect: " + JSON.stringify(maxRect));
    log_message("Screen resolution: " + JSON.stringify(Feature.resolution()));

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

    function showError(message) {
        if (currentErrorMessage) {
            assistWindow.remove(currentErrorMessage.title);
            assistWindow.remove(currentErrorMessage.message);
            // Reset error message height
            errorMessageHeight = 0;
        }

        // Calculate the error title height based on font size
        const ERROR_TITLE_HEIGHT = FONT_SIZE + 2; // Similar to SPEAKER_HEIGHT

        // Adjust position and size for round displays
        const isRound = Feature.round(true, false);
        const leftMargin = maxRect.left + Feature.round(0, 5);
        const textWidth = maxRect.width - Feature.round(0, 10);

        // Add error title using the user's font size preference
        let errorTitle = new UI.Text({
            position: new Vector(leftMargin, currentY),
            size: new Vector(textWidth, ERROR_TITLE_HEIGHT),
            text: 'Error:',
            font: SPEAKER_FONT, // Use the same font as speaker labels
            color: Feature.color('red', 'white'),
            textAlign: isRound ? 'center' : 'left'
        });

        // Add error message using the user's font size preference
        let errorMessage = new UI.Text({
            position: new Vector(leftMargin, currentY + ERROR_TITLE_HEIGHT),
            size: new Vector(textWidth, 1000),
            text: message,
            font: MESSAGE_FONT, // Use the same font as messages
            color: Feature.color('red', 'white'),
            textAlign: isRound ? 'center' : 'left',
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
            errorMessage.size(new Vector(textWidth, height + ERROR_TITLE_HEIGHT));

            // Add the error message to the window
            assistWindow.add(errorMessage);
            conversationElements.push(errorMessage);

            currentErrorMessage = {
                title: errorTitle,
                message: errorMessage
            };

            // Calculate the actual height added to currentY
            // This should include only what we're adding to currentY
            const heightAdded = height + MESSAGE_PADDING;

            // Update position for next message with configurable padding
            currentY += heightAdded; // message height + padding
            log_message("New currentY position for error: " + currentY);

            // Store the exact amount we added to currentY for later adjustment
            errorMessageHeight = heightAdded;
            log_message("Stored error message height: " + errorMessageHeight + " (actual height added to currentY)");

            // Update the window's content size to ensure proper scrolling
            // Add more padding at the bottom to ensure content isn't cut off
            const contentHeight = currentY + 20; // Add 20px padding at the bottom
            assistWindow.size(new Vector(Feature.resolution().x, contentHeight));
            log_message("Updated error window size to: " + contentHeight + " for currentY: " + currentY);

            // Store positions for scrolling reference
            const messageHeight = height + ERROR_TITLE_HEIGHT; // Text height + error title height

            // Calculate the actual top and bottom positions of the error message
            // The error title starts at the position before we updated currentY
            const errorTitleY = currentY - heightAdded;
            const messageTop = errorTitleY;
            const messageBottom = messageTop + messageHeight;
            const screenHeight = Feature.resolution().y;

            log_message("Error message position: top=" + messageTop + ", bottom=" + messageBottom + ", height=" + messageHeight);

            // Determine how to scroll based on message size
            let scrollTarget;

            // If the message is taller than the display, scroll to show the title at the top
            if (messageHeight > screenHeight * 0.8) { // If message takes up more than 80% of screen
                // Scroll to the title position (error title)
                scrollTarget = messageTop - 5; // 5px padding above title
                log_message("Long error message detected (" + messageHeight + "px), scrolling to title at position: " + scrollTarget);
            } else {
                // For shorter messages, scroll to show the entire message
                // Calculate how much we need to scroll to show the bottom of the message
                // with some padding at the bottom
                scrollTarget = Math.max(0, messageBottom - screenHeight + 10); // 10px padding
                log_message("Normal error message, scrolling to position: " + scrollTarget + " to show bottom at: " + messageBottom);
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

    function addMessage(speaker, message, callback) {
        log_message("Adding message from " + speaker + ": " + message);

        // Remove error message if exists
        if (currentErrorMessage) {
            assistWindow.remove(currentErrorMessage.title);
            assistWindow.remove(currentErrorMessage.message);

            // Adjust currentY to remove the gap left by the error message
            // errorMessageHeight now stores exactly how much was added to currentY
            if (errorMessageHeight > 0) {
                currentY -= errorMessageHeight;
                log_message("Adjusted currentY after removing error: " + currentY + " (subtracted " + errorMessageHeight + "px)");
                errorMessageHeight = 0;
            }

            currentErrorMessage = null;
        }

        try {
            const speakerId = Math.floor(Math.random() * 100000);
            const messageId = Math.floor(Math.random() * 100000);

            // Adjust position and size for round displays
            const isRound = Feature.round(true, false);
            const leftMargin = maxRect.left + Feature.round(0, 5);
            const textWidth = maxRect.width - Feature.round(0, 10);

            // Add speaker label with display name
            let speakerLabel = new UI.Text({
                id: speakerId,
                position: new Vector(leftMargin, currentY),
                size: new Vector(textWidth, SPEAKER_HEIGHT),
                text: getDisplayName(speaker) + ':',
                font: SPEAKER_FONT,
                color: Feature.color('black', 'white'),
                textAlign: isRound ? 'center' : 'left'
            });
            assistWindow.add(speakerLabel);
            conversationElements.push(speakerLabel);

            // Add message text
            let messageText = new UI.Text({
                id: messageId,
                position: new Vector(leftMargin, currentY + SPEAKER_HEIGHT),
                size: new Vector(textWidth, 2000),
                text: message,
                font: MESSAGE_FONT,
                color: Feature.color('black', 'white'),
                textAlign: isRound ? 'center' : 'left',
                // textOverflow: 'wrap'
            });
            log_message(`Message position: ( ${leftMargin}, ${currentY + SPEAKER_HEIGHT} ) ` );
            log_message(`Message size: ( ${textWidth}, 2000 ) ` );

            messageText.getHeight(function(height) {
                height = Math.max(height, FONT_SIZE); // Changed from fontSize to FONT_SIZE
                messageText.size(new Vector(textWidth, height + 10 + Feature.round(26, 0)));
                assistWindow.add(messageText);
                conversationElements.push(messageText);

                // Update position with adjusted padding
                currentY += SPEAKER_HEIGHT + height + MESSAGE_PADDING;

                // Update window content size
                const contentHeight = currentY + 20 + Feature.round(26, 0);
                assistWindow.size(new Vector(Feature.resolution().x, contentHeight));
                log_message("Updated window size to: " + contentHeight + " for currentY: " + currentY);

                // Calculate the height added to currentY for this message
                const heightAdded = SPEAKER_HEIGHT + height + MESSAGE_PADDING;

                // Store positions for scrolling reference
                const messageHeight = SPEAKER_HEIGHT + height; // Speaker label + text height

                // Calculate the actual top and bottom positions of the message
                // The speaker label starts at the position before we updated currentY
                const speakerLabelY = currentY - heightAdded;
                const messageTop = speakerLabelY;
                const messageBottom = messageTop + messageHeight;
                const screenHeight = Feature.resolution().y;

                log_message("Message position: top=" + messageTop + ", bottom=" + messageBottom + ", height=" + messageHeight);

                // Determine how to scroll based on message size
                let scrollTarget;

                // If the message is taller than the display, scroll to show the title at the top
                if (messageHeight > screenHeight * 0.8) { // If message takes up more than 80% of screen
                    // Scroll to the title position (speaker label)
                    scrollTarget = (messageTop + Feature.round(26, 0)) - 5; // 5px padding above title
                    log_message("Long message detected (" + messageHeight + "px), scrolling to title at position: " + scrollTarget);
                } else {
                    // For shorter messages, scroll to show the entire message
                    // Calculate how much we need to scroll to show the bottom of the message
                    // with some padding at the bottom
                    scrollTarget = Math.max(0, messageBottom - screenHeight + Feature.round(26, 10));
                    log_message("Normal message, scrolling to position: " + scrollTarget + " to show bottom at: " + messageBottom);
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
        if(hawsFaker) {
            const testMessageDelay = 2000; // 2 seconds delay between messages, adjust as needed

            addMessage('Me', "Hello!", function() {
                setTimeout(function() {
                    addMessage('HA', "Hi! How are you?", function() {
                        setTimeout(function() {
                            addMessage('Me', "I am actually doing really good. Yourself?", function() {
                                setTimeout(function() {
                                    addMessage('HA', "Yeah I guess things are going pretty alright. I can't complain too much.", function() {
                                        setTimeout(function(){
                                            addMessage('HA', "Test!\n - list test\n- list item two", function() {
                                            });
                                        }, testMessageDelay)
                                    });
                                }, testMessageDelay);
                            });
                        }, testMessageDelay);
                    });
                }, testMessageDelay);
            });

            return;
        }

        log_message("startAssist");
        Voice.dictate('start', voice_confirm, function(e) {
            if (e.err) {
                if (e.err === "systemAborted") {
                    log_message("assist cancelled by user");
                    if(!conversationElements.length) {
                        // if assist dictation is cancelled and there has been no conversation, hide the window
                        assistWindow.hide();
                    }
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
                        log_message("assist_pipeline/run error: " + JSON.stringify(error));
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
            status: false,
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
                if (a.display_name < b.display_name) return -1;
                if (a.display_name > b.display_name) return 1;
                return 0;
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
        status: false,
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
            .sort((a, b) => {
                if (a.name < b.name) return -1;
                if (a.name > b.name) return 1;
                return 0;
            });

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
            // console.log("received media_player subscription event", JSON.stringify(data) );
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
        climate = ha_state_dict[entity_id];
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
                let latestClimate = ha_state_dict[entity_id];
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

                            // Update menu items directly
                            updateTempRangeMenuItems(updatedClimate);
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
                    showTemperatureMenu(entity_id, 'single', latestData.target_temp, latestData.min_temp, latestData.max_temp, latestData.temp_step);
                }
            }
        });

        // Add HVAC Mode item
        climateMenu.item(0, menuIndex++, {
            title: 'HVAC Mode',
            subtitle: climateData.hvac_mode ? ucwords(climateData.hvac_mode.replace('_', ' ')) : 'Unknown',
            on_click: function() {
                // Always get the latest climate data when clicked
                let latestClimate = ha_state_dict[entity_id];
                let latestData = getClimateData(latestClimate);
                showHvacModeMenu(entity_id, latestData.hvac_mode, latestData.hvac_modes);
            }
        });

        // Add Fan Mode item if supported
        if (supportedFeatures.fan_mode && climateData.fan_modes && climateData.fan_modes.length > 0) {
            climateMenu.item(0, menuIndex++, {
                title: 'Fan Mode',
                subtitle: climateData.fan_mode ? ucwords(climateData.fan_mode.replace('_', ' ')) : 'Unknown',
                on_click: function() {
                    // Always get the latest climate data when clicked
                    let latestClimate = ha_state_dict[entity_id];
                    let latestData = getClimateData(latestClimate);
                    showFanModeMenu(entity_id, latestData.fan_mode, latestData.fan_modes);
                }
            });
        }

        // Add Preset Mode item if supported
        if (supportedFeatures.preset_mode && climateData.preset_modes && climateData.preset_modes.length > 0) {
            climateMenu.item(0, menuIndex++, {
                title: 'Preset Mode',
                subtitle: climateData.preset_mode ? ucwords(climateData.preset_mode.replace('_', ' ')) : 'None',
                on_click: function() {
                    // Always get the latest climate data when clicked
                    let latestClimate = ha_state_dict[entity_id];
                    let latestData = getClimateData(latestClimate);
                    showPresetModeMenu(entity_id, latestData.preset_mode, latestData.preset_modes);
                }
            });
        }

        // Add Swing Mode item if supported
        if (supportedFeatures.swing_mode && climateData.swing_modes && climateData.swing_modes.length > 0) {
            climateMenu.item(0, menuIndex++, {
                title: 'Swing Mode',
                subtitle: climateData.swing_mode ? ucwords(climateData.swing_mode.replace('_', ' ')) : 'Unknown',
                on_click: function() {
                    // Always get the latest climate data when clicked
                    let latestClimate = ha_state_dict[entity_id];
                    let latestData = getClimateData(latestClimate);
                    showSwingModeMenu(entity_id, latestData.swing_mode, latestData.swing_modes);
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
                subtitle: updatedData.hvac_mode ? ucwords(updatedData.hvac_mode.replace('_', ' ')) : 'Unknown',
                on_click: climateMenu.items(0)[1].on_click
            });

            // Update other items based on supported features
            let supportedFeatures = getSupportedFeatures(updatedData.supported_features);

            // Fan Mode item
            if (supportedFeatures.fan_mode && updatedData.fan_modes && updatedData.fan_modes.length > 0) {
                climateMenu.item(0, menuIndex++, {
                    title: 'Fan Mode',
                    subtitle: updatedData.fan_mode ? ucwords(updatedData.fan_mode.replace('_', ' ')) : 'Unknown',
                    on_click: climateMenu.items(0)[menuIndex-1].on_click
                });
            }

            // Preset Mode item
            if (supportedFeatures.preset_mode && updatedData.preset_modes && updatedData.preset_modes.length > 0) {
                climateMenu.item(0, menuIndex++, {
                    title: 'Preset Mode',
                    subtitle: updatedData.preset_mode ? ucwords(updatedData.preset_mode.replace('_', ' ')) : 'None',
                    on_click: climateMenu.items(0)[menuIndex-1].on_click
                });
            }

            // Swing Mode item
            if (supportedFeatures.swing_mode && updatedData.swing_modes && updatedData.swing_modes.length > 0) {
                climateMenu.item(0, menuIndex++, {
                    title: 'Swing Mode',
                    subtitle: updatedData.swing_mode ? ucwords(updatedData.swing_mode.replace('_', ' ')) : 'Unknown',
                    on_click: climateMenu.items(0)[menuIndex-1].on_click
                });
            }
        }

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
                let updatedClimate = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedClimate;

                // Update the menu items directly without redrawing the entire menu
                updateClimateMenuItems(updatedClimate);
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
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

        log_message(`Climate menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
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
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = ha_state_dict[entity_id];
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

                // Update menu items directly
                updateTemperatureMenuItems(updatedClimate);
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

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        tempMenu.show();
    }

    // Helper function to show HVAC mode selection menu
    function showHvacModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = ha_state_dict[entity_id];
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

                // Get updated climate data
                let updatedData = getClimateData(updatedClimate);

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.hvac_mode;

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

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    // Helper function to show fan mode selection menu
    function showFanModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = ha_state_dict[entity_id];
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

                // Get updated climate data
                let updatedData = getClimateData(updatedClimate);

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.fan_mode;

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

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    // Helper function to show preset mode selection menu
    function showPresetModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = ha_state_dict[entity_id];
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

                // Get updated climate data
                let updatedData = getClimateData(updatedClimate);

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.preset_mode;

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

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        modeMenu.show();
    }

    // Helper function to show swing mode selection menu
    function showSwingModeMenu(entity_id, current_mode, available_modes) {
        // Get the latest climate data to ensure we have the most up-to-date values
        let climate = ha_state_dict[entity_id];
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

                // Get updated climate data
                let updatedData = getClimateData(updatedClimate);

                // Update menu items to reflect current state
                for (let i = 0; i < available_modes.length; i++) {
                    let mode = available_modes[i];
                    let isCurrentMode = mode === updatedData.swing_mode;

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

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
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

    log_message(`Showing light entity ${entity_id}`, JSON.stringify(light, null, 4));

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
                log_message(`Processed RGB color: ${JSON.stringify(rgbColor)}`);
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

        log_message(`Light ${entity.entity_id} supported features: ${JSON.stringify(result)}`);
        log_message(`Light supported_features value: ${supported_features_value}`);
        log_message(`Light supported_color_modes: ${JSON.stringify(supported_color_modes)}`);
        log_message('Light registry: ', JSON.stringify(entity_registry, null, 4));

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
                haws.callService(
                    "light",
                    "toggle",
                    {},
                    { entity_id: updatedData.entity_id },
                    function(data) {
                        Vibe.vibrate('short');
                        log_message(`Toggled light: ${updatedData.entity_id}`);
                    },
                    function(error) {
                        Vibe.vibrate('double');
                        log_message(`Error toggling light: ${error}`);
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
                log_message(`Color menu item updated with: ${colorText}`);
            }

            lightMenu.item(0, menuIndex++, {
                title: 'Color',
                subtitle: colorText,
                on_click: function() {
                    // Make sure we pass the RGB color array correctly
                    let rgbColor = updatedData.rgb_color || [255, 255, 255];
                    log_message(`Opening color menu with color: ${JSON.stringify(rgbColor)}`);
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
                showEntityMenu(updatedData.entity_id);
            }
        });
    }

    // Helper function to show brightness selection menu
    function showBrightnessMenu(entity_id, current_brightness) {
        // Get the latest light data
        let light = ha_state_dict[entity_id];
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
            haws.callService(
                "light",
                "turn_on",
                { brightness: brightness },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    log_message(`Set brightness to ${current_brightness}%`);
                    brightnessWindow.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    log_message(`Error setting brightness: ${error}`);
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
        let brightness_subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Light entity update for brightness menu ${entity_id}`);
            // Update the light entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedLight;

                // Get updated light data
                let updatedData = getLightData(updatedLight);

                // Update the brightness value
                if (updatedData.is_on) {
                    current_brightness = updatedData.brightnessPerc;
                    updateBrightnessUI();
                }
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        brightnessWindow.on('hide', function() {
            // Unsubscribe from entity updates
            if (brightness_subscription_msg_id) {
                haws.unsubscribe(brightness_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        brightnessWindow.show();
    }

    // Helper function to show color temperature selection menu
    function showColorTempMenu(entity_id, current_temp, min_temp, max_temp) {
        // Get the latest light data
        let light = ha_state_dict[entity_id];
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
            haws.callService(
                "light",
                "turn_on",
                { color_temp_kelvin: current_temp },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    log_message(`Set color temperature to ${current_temp}K`);
                    tempWindow.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    log_message(`Error setting color temperature: ${error}`);
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
        let temp_subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Light entity update for color temp menu ${entity_id}`);
            // Update the light entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedLight;

                // Get updated light data
                let updatedData = getLightData(updatedLight);

                // Update the color temperature value
                if (updatedData.is_on && updatedData.color_temp_kelvin) {
                    current_temp = updatedData.color_temp_kelvin;
                    updateTempUI();
                }
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        tempWindow.on('hide', function() {
            // Unsubscribe from entity updates
            if (temp_subscription_msg_id) {
                haws.unsubscribe(temp_subscription_msg_id);
            }

            // Restore the selection in the parent menu
            selectedIndex = returnToIndex;
        });

        tempWindow.show();
    }

    // Helper function to show color selection menu with a colorful slider
    function showColorMenu(entity_id, current_color) {
        // Get the latest light data
        let light = ha_state_dict[entity_id];
        let lightData = getLightData(light);

        // Remember which menu item we came from
        let returnToIndex = selectedIndex;

        // Default color if not provided
        current_color = current_color || [255, 0, 0];

        // Log the current color for debugging
        log_message(`Current color for ${entity_id}: ${JSON.stringify(current_color)}`);

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
                    haws.callService(
                        "light",
                        "turn_on",
                        { rgb_color: selectedColor },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            log_message(`Set color to ${colors[i].name}`);
                            colorMenu.hide();
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            log_message(`Error setting color: ${error}`);
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
            haws.callService(
                "light",
                "turn_on",
                { rgb_color: selectedColor },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    log_message(`Set color to ${colors[colorIndex].name}`);
                    colorWindow.hide();
                },
                function(error) {
                    Vibe.vibrate('double');
                    log_message(`Error setting color: ${error}`);
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
            log_message(`Updating color menu with RGB color: ${JSON.stringify(updatedData.rgb_color)}`);

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
                        log_message(`Current color matched: ${color.name}`);
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
        let color_subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Light entity update for color menu ${entity_id}`);
            // Update the light entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedLight;

                // Update menu items directly
                updateColorMenuItems(updatedLight);
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        colorMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (color_subscription_msg_id) {
                haws.unsubscribe(color_subscription_msg_id);
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
        let light = ha_state_dict[entity_id];
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
                haws.callService(
                    "light",
                    "turn_on",
                    { effect: "none" },
                    { entity_id: entity_id },
                    function(data) {
                        Vibe.vibrate('short');
                        log_message(`Effect set to none`);
                    },
                    function(error) {
                        Vibe.vibrate('double');
                        log_message(`Error setting effect: ${error}`);
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
                    haws.callService(
                        "light",
                        "turn_on",
                        { effect: effect },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            log_message(`Effect set to ${effect}`);
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            log_message(`Error setting effect: ${error}`);
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
        let effect_subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Light entity update for effect menu ${entity_id}`);
            // Update the light entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedLight;

                // Update menu items directly
                updateEffectMenuItems(updatedLight);
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        effectMenu.on('hide', function() {
            // Unsubscribe from entity updates
            if (effect_subscription_msg_id) {
                haws.unsubscribe(effect_subscription_msg_id);
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

        log_message(`Light menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if(typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    // Set up event handlers for the light menu
    lightMenu.on('show', function() {
        // Clear the menu
        lightMenu.items(0, []);

        // Get the latest light data
        light = ha_state_dict[entity_id];
        lightData = getLightData(light);
        features = supported_features(light);

        // Update menu items
        updateLightMenuItems(light);

        // Subscribe to entity updates
        subscription_msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            log_message(`Light entity update for ${entity_id}`);
            // Update the light entity in the cache
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedLight = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedLight;

                // Update the menu items directly without redrawing the entire menu
                updateLightMenuItems(updatedLight);
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
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
            haws.unsubscribe(subscription_msg_id);
        }
    });

    // Show the menu
    lightMenu.show();
}

// Track menu selections globally
let menuSelections = {
    mainMenu: 0,
    entityListMenu: 0,
    areaMenu: 0,
    labelMenu: 0,
    domainListMenu: 0,
    lightMenu: 0,
    climateMenu: 0
};

function showEntityMenu(entity_id) {
    let entity = ha_state_dict[entity_id];
    if(!entity){
        throw new Error(`Entity ${entity_id} not found in ha_state_dict`);
    }

    // Set Menu colors
    let showEntityMenu = new UI.Menu({
        status: false,
        backgroundColor: 'white',
        textColor: 'black',
        highlightBackgroundColor: 'black',
        highlightTextColor: 'white',
        sections: [
            {
                title: entity.attributes.friendly_name ? entity.attributes.friendly_name : entity.entity_id
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

    // Store selection when navigating to a submenu
    showEntityMenu.on('select', function(e) {
        // Handle on_click function if it exists
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
            return;
        }
    });

    //Object.getOwnPropertyNames(entity);
    //Object.getOwnPropertyNames(entity.attributes);
    var arr = Object.getOwnPropertyNames(entity.attributes);
    //var arr = Object.getOwnPropertyNames(device_status.attributes);
    var i = 0;
    log_message(`Showing entity ${entity.entity_id}: ${JSON.stringify(entity, null, 4)}`)

    showEntityMenu.item(0, i++, {
        title: 'Entity ID',
        subtitle: entity.entity_id
    });
    showEntityMenu.item(0, i++, {
        title: 'State',
        subtitle: entity.state + (entity.attributes.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : '')
    });
    let stateIndex = i;
    showEntityMenu.item(0, i++, {
        title: 'Last Changed',
        subtitle: entity.last_changed
    });
    showEntityMenu.item(0, i++, {
        title: 'Last Updated',
        subtitle: entity.last_updated
    });
    showEntityMenu.item(0, i++, {
        title: 'Attributes',
        subtitle: `${arr.length} attributes`,
        on_click: function() {
            showEntityAttributesMenu(entity_id);
        }
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
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
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
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
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
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
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
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        Vibe.vibrate('double');
                        log_message('no response');
                    });
            }
        });
    }

    if(domain === "lock") {
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Lock',
            on_click: function(){
                haws.callService(
                    domain,
                    'lock',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                        // Success!
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
                        log_message('no response');
                    });
            }
        });
        showEntityMenu.item(1, servicesCount++, { //menuIndex
            title: 'Unlock',
            on_click: function(){
                haws.callService(
                    domain,
                    'unlock',
                    {},
                    {entity_id: entity.entity_id},
                    function(data) {
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        Vibe.vibrate('double');
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
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
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
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
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
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        Vibe.vibrate('double');
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
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
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
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
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
                        Vibe.vibrate('short');
                        log_message(JSON.stringify(data));
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
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
                        Vibe.vibrate('short');
                    },
                    function(error) {
                        // Failure!
                        Vibe.vibrate('double');
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

    showEntityMenu.on('show', function(){
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
    });
    showEntityMenu.on('close', function(){
        if(msg_id) {
            haws.unsubscribe(msg_id);
        }
    });

    showEntityMenu.show();
}

function showEntityAttributesMenu(entity_id) {
    let entity = ha_state_dict[entity_id];
    if(!entity){
        throw new Error(`Entity ${entity_id} not found in ha_state_dict`);
    }

    // Create a menu for the attributes
    let attributesMenu = new UI.Menu({
        status: false,
        backgroundColor: 'white',
        textColor: 'black',
        highlightBackgroundColor: 'black',
        highlightTextColor: 'white',
        sections: [{
            title: 'Attributes'
        }]
    });

    // Handle select events
    attributesMenu.on('select', function(e) {
        // Handle on_click function if it exists
        if(e.item && typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    let msg_id = null;

    attributesMenu.on('show', function() {
        var arr = Object.getOwnPropertyNames(entity.attributes);
        log_message(`Showing attributes for ${entity.entity_id}: ${arr.length} attributes`);

        // Add each attribute to the menu
        for (let i = 0; i < arr.length; i++) {
            attributesMenu.item(0, i, {
                title: arr[i],
                subtitle: entity.attributes[arr[i]],
                attribute_name: arr[i] // Store attribute name for updates
            });
        }

        // Subscribe to entity updates
        msg_id = haws.subscribe({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                let updatedEntity = data.event.variables.trigger.to_state;
                ha_state_dict[entity_id] = updatedEntity;

                // Update all attribute values
                for (let i = 0; i < attributesMenu.items(0).length; i++) {
                    const item = attributesMenu.item(0, i);
                    if (item.attribute_name && updatedEntity.attributes[item.attribute_name] !== undefined) {
                        attributesMenu.item(0, i, {
                            title: item.attribute_name,
                            subtitle: updatedEntity.attributes[item.attribute_name],
                            attribute_name: item.attribute_name
                        });
                    }
                }
            }
        }, function(error) {
            log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });
    });

    attributesMenu.on('hide', function() {
        // Unsubscribe from entity updates when menu is closed
        if (msg_id) {
            haws.unsubscribe(msg_id);
        }
    });

    attributesMenu.show();
}

function showEntityDomainsFromList(entity_id_list, title) {
    // setup entityListMenu if it hasn't been
    let domainListMenu = new UI.Menu({
        status: false,
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

function getEntityIcon(entity) {
    if (!entity) return 'images/icon_unknown.png';

    const domain = entity.entity_id.split('.')[0];
    const state = entity.state;

    // Handle different domains
    switch (domain) {
        case 'light':
            return state === 'on' ? 'images/icon_bulb_on.png' : 'images/icon_bulb.png';

        case 'switch':
        case 'input_boolean':
            return state === 'on' ? 'images/icon_switch_on.png' : 'images/icon_switch_off.png';

        case 'cover':
            return state === 'open' ? 'images/icon_blinds_open.png' : 'images/icon_blinds_closed.png';

        case 'lock':
            return state === 'locked' ? 'images/icon_locked.png' : 'images/icon_unlocked.png';

        case 'sensor':
            // Check for temperature sensors
            if (entity.attributes.device_class === 'temperature') {
                return 'images/icon_temp.png';
            }
            return 'images/icon_sensor.png';

        case 'binary_sensor':
            // Check for door/window sensors
            if (entity.attributes.device_class === 'opening') {
                return state === 'on' ? 'images/icon_door_open.png' : 'images/icon_door_closed.png';
            }
            return 'images/icon_sensor.png';

        case 'automation':
            return state === 'on' ? 'images/icon_auto_on.png' : 'images/icon_auto_off.png';

        case 'media_player':
            return 'images/icon_media.png';

        case 'script':
            return 'images/icon_script.png';

        case 'scene':
            return 'images/icon_scene.png';

        case 'timer':
            return 'images/icon_timer.png';

        case 'vacuum':
            return 'images/icon_vacuum.png';

        default:
            return 'images/icon_unknown.png';
    }
}

// show the list of todo lists
function showToDoLists() {
    let toDoListsMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'To-Do Lists'
        }]
    });

    // Track subscription IDs for cleanup
    let subscriptionIds = {};

    // Function to get sorted todo lists
    function getSortedTodoLists() {
        let todoLists = [];
        for(let entity_id in ha_state_dict) {
            if(entity_id.split('.')[0] !== "todo") {
                continue;
            }

            if(ha_state_dict[entity_id].state === "unavailable" || ha_state_dict[entity_id].state === "unknown") {
                continue;
            }

            if(!ha_state_dict[entity_id].attributes || !ha_state_dict[entity_id].attributes.friendly_name) {
                continue;
            }

            todoLists.push(ha_state_dict[entity_id]);
        }

        // sort todoLists alphabetically by friendly_name
        todoLists.sort(function(a, b) {
            if (a.attributes.friendly_name < b.attributes.friendly_name) return -1;
            if (a.attributes.friendly_name > b.attributes.friendly_name) return 1;
            return 0;
        });

        return todoLists;
    }

    // Function to update menu items
    function updateMenuItems() {
        let todoLists = getSortedTodoLists();

        // Clear existing items
        toDoListsMenu.items(0, []);

        // Add menu items
        let items = [];
        todoLists.forEach(function(entity) {
            items.push({
                title: entity.attributes.friendly_name,
                subtitle: (entity.state || 0) + " item" + (entity.state > 1 ? 's' : ''),
                entity_id: entity.entity_id,
                on_click: function (e) {
                    showToDoList(e.item.entity_id);
                }
            });
        });

        toDoListsMenu.items(0, items);
    }

    toDoListsMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    // Subscribe to all todo lists when menu is shown
    toDoListsMenu.on('show', function() {
        let todoLists = getSortedTodoLists();

        todoLists.forEach(function(entity) {
            let entity_id = entity.entity_id;

            subscriptionIds[entity_id] = haws.subscribe({
                "type": "todo/item/subscribe",
                "entity_id": entity_id
            }, function(data) {
                // When items change, update the count in ha_state_dict
                if (data.event && data.event.items) {
                    let itemCount = data.event.items.length;
                    if (ha_state_dict[entity_id]) {
                        ha_state_dict[entity_id].state = itemCount;
                    }
                    // Update the menu to reflect the new count
                    updateMenuItems();
                }
            }, function(error) {
                log_message(`todo/item/subscribe ERROR for ${entity_id}: ${JSON.stringify(error)}`);
            });
        });
    });

    // Unsubscribe when menu is hidden
    toDoListsMenu.on('hide', function() {
        for(let entity_id in subscriptionIds) {
            if (subscriptionIds[entity_id]) {
                haws.unsubscribe(subscriptionIds[entity_id]);
            }
        }
        subscriptionIds = {};
    });

    // Initial menu population
    updateMenuItems();

    toDoListsMenu.show();
}

// show a specific todo list
function showToDoList(entity_id) {
    let todoList = ha_state_dict[entity_id];
    log_message(`showToDoList: ${entity_id}`);
    if(!todoList) {
        log_message(`showToDoList: ${entity_id} not found in ha_state_dict`);
        throw new Error(`ToDo list ${entity_id} not found in ha_state_dict`);
    }

    let todoListMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [
            {
                title: 'To Do'
            },
            {
                title: 'Completed'
            },
            {
                title: 'Actions'
            }
        ]
    });

    // Track the currently selected item by UID and section
    let selectedItemUid = null;
    let selectedSectionIndex = 0;
    let subscription_msg_id = null;
    let hasRenderedOnce = false;

    // Track the next item to select after toggling completion status
    let nextItemUidAfterToggle = null;

    /**
     * Helper function to determine the next item to select after toggling completion status
     * @param {Array} incompleteItems - Array of incomplete items
     * @param {Array} completedItems - Array of completed items
     * @param {string} currentUid - UID of the item being toggled
     * @param {number} currentSection - Section index of the item being toggled (0 or 1)
     * @param {string} currentStatus - Current status of the item ('needs_action' or 'completed')
     * @returns {string|null} - UID of the next item to select, or null if no suitable item
     */
    function getNextItemAfterToggle(incompleteItems, completedItems, currentUid, currentSection, currentStatus) {
        // Determine which section the item is currently in and where it will move to
        let isMarkingComplete = (currentStatus === 'needs_action'); // Will move from section 0 to section 1

        if (isMarkingComplete) {
            // Item is moving from incomplete (section 0) to completed (section 1)
            // Find the current item's index in the incomplete list
            let currentIndex = -1;
            for (let i = 0; i < incompleteItems.length; i++) {
                if (incompleteItems[i].uid === currentUid) {
                    currentIndex = i;
                    break;
                }
            }

            if (currentIndex === -1) {
                return null; // Item not found
            }

            // Try to select the next item in the incomplete section
            if (currentIndex + 1 < incompleteItems.length) {
                return incompleteItems[currentIndex + 1].uid;
            }

            // If there's no next incomplete item, try the item before the current one
            if (currentIndex > 0) {
                return incompleteItems[currentIndex - 1].uid;
            }

            // If no incomplete items remain, select the first completed item
            if (completedItems.length > 0) {
                return completedItems[0].uid;
            }

            // Otherwise, stay on the current item (it will be the only completed item)
            return currentUid;
        } else {
            // Item is moving from completed (section 1) to incomplete (section 0)
            // Find the current item's index in the completed list
            let currentIndex = -1;
            for (let i = 0; i < completedItems.length; i++) {
                if (completedItems[i].uid === currentUid) {
                    currentIndex = i;
                    break;
                }
            }

            if (currentIndex === -1) {
                return null; // Item not found
            }

            // Try to select the next item in the completed section
            if (currentIndex + 1 < completedItems.length) {
                return completedItems[currentIndex + 1].uid;
            }

            // If there's no next completed item, try the item before the current one
            if (currentIndex > 0) {
                return completedItems[currentIndex - 1].uid;
            }

            // If no completed items remain, select the first incomplete item
            if (incompleteItems.length > 0) {
                return incompleteItems[0].uid;
            }

            // Otherwise, stay on the current item (it will be the only incomplete item)
            return currentUid;
        }
    }

    // Function to update menu items based on subscription data
    function updateToDoListItems(items) {
        log_message(`updateToDoListItems: Updating ${items.length} items`);

        // Filter items into incomplete and completed
        let incompleteItems = [];
        let completedItems = [];

        items.forEach(function(item) {
            if (item.status === 'completed') {
                completedItems.push(item);
            } else {
                incompleteItems.push(item);
            }
        });

        // Clear existing items in all sections
        todoListMenu.items(0, []);
        todoListMenu.items(1, []);
        todoListMenu.items(2, []);

        // Add incomplete items to section 0
        incompleteItems.forEach(function(item, index) {
            let subtitle = '';

            // Priority: description > due date > empty
            if (item.description) {
                subtitle = item.description;
            } else if (item.due) {
                subtitle = `Due: ${item.due}`;
            }

            todoListMenu.item(0, index, {
                title: item.summary,
                subtitle: subtitle || '',
                uid: item.uid,
                status: item.status,
                description: item.description,
                due: item.due,
                on_click: function(e) {
                    log_message(`Todo item clicked: ${item.summary} (${item.uid})`);
                    // TODO: Show item details or actions menu
                    showToDoItemMenu(entity_id, item);
                }
            });
        });

        // Add completed items to section 1
        completedItems.forEach(function(item, index) {
            let subtitle = '';

            // Priority: description > due date > empty
            if (item.description) {
                subtitle = item.description;
            } else if (item.due) {
                subtitle = `Due: ${item.due}`;
            }

            todoListMenu.item(1, index, {
                title: item.summary,
                subtitle: subtitle || '',
                uid: item.uid,
                status: item.status,
                description: item.description,
                due: item.due,
                on_click: function(e) {
                    log_message(`Todo item clicked: ${item.summary} (${item.uid})`);
                    // TODO: Show item details or actions menu
                    showToDoItemMenu(entity_id, item);
                }
            });
        });

        // Add action items to section 2
        let actionIndex = 0;

        // Always show "Clear List" action
        todoListMenu.item(2, actionIndex++, {
            title: 'Clear List',
            on_click: function(e) {
                confirmAction(
                    'Clear all items from this list?',
                    function() {
                        // Success callback - clear all items in a single API call
                        log_message(`Clearing all items from ${entity_id}`);
                        let allItems = incompleteItems.concat(completedItems);
                        let allUids = allItems.map(function(item) { return item.uid; });

                        if (allUids.length > 0) {
                            haws.callService(
                                'todo',
                                'remove_item',
                                { item: allUids },
                                { entity_id: entity_id },
                                function(data) {
                                    Vibe.vibrate('short');
                                    log_message(`Successfully cleared ${allUids.length} items from list`);
                                },
                                function(error) {
                                    Vibe.vibrate('double');
                                    log_message(`Error clearing list: ${JSON.stringify(error)}`);
                                }
                            );
                        } else {
                            log_message('No items to clear');
                        }
                    },
                    function() {
                        // Failure/cancel callback
                        log_message('Clear list cancelled');
                    }
                );
            }
        });

        // Only show "Clear Completed" if there are completed items
        if (completedItems.length > 0) {
            todoListMenu.item(2, actionIndex++, {
                title: 'Clear Completed',
                on_click: function(e) {
                    confirmAction(
                        'Clear all completed items?',
                        function() {
                            // Success callback - use the built-in service
                            log_message(`Clearing completed items from ${entity_id}`);
                            haws.callService(
                                'todo',
                                'remove_completed_items',
                                {},
                                { entity_id: entity_id },
                                function(data) {
                                    Vibe.vibrate('short');
                                    log_message(`Cleared completed items successfully`);
                                },
                                function(error) {
                                    Vibe.vibrate('double');
                                    log_message(`Error clearing completed items: ${JSON.stringify(error)}`);
                                }
                            );
                        },
                        function() {
                            // Failure/cancel callback
                            log_message('Clear completed cancelled');
                        }
                    );
                }
            });
        }

        // Add "Add Item" action if microphone is available
        if (Feature.microphone(true, false)) {
            todoListMenu.item(2, actionIndex++, {
                title: 'Add Item',
                on_click: function(e) {
                    log_message('Starting voice dictation for new todo item');
                    Voice.dictate('start', true, function(voiceEvent) {
                        if (voiceEvent.err) {
                            if (voiceEvent.err === "systemAborted") {
                                log_message("Add item dictation cancelled by user");
                                return;
                            }
                            log_message(`Add item dictation error: ${voiceEvent.err}`);
                            return;
                        }

                        log_message(`Add item transcription received: ${voiceEvent.transcription}`);

                        // Add the new item to the todo list
                        haws.callService(
                            'todo',
                            'add_item',
                            {
                                item: voiceEvent.transcription
                            },
                            { entity_id: entity_id },
                            function(data) {
                                Vibe.vibrate('short');
                                log_message(`Successfully added new item: ${JSON.stringify(data)}`);
                                // The subscription will automatically update the list with the new item
                            },
                            function(error) {
                                Vibe.vibrate('double');
                                log_message(`Error adding new item: ${JSON.stringify(error)}`);
                            }
                        );
                    });
                }
            });
        }

        // Restore selection after updating items
        let newSectionIndex = 0;
        let newItemIndex = 0;
        let foundSelection = false;

        // Determine which UID to select
        let targetUid = selectedItemUid;

        // If we have a next item to select after toggling, use that instead
        if (nextItemUidAfterToggle !== null) {
            targetUid = nextItemUidAfterToggle;
            selectedItemUid = nextItemUidAfterToggle;
            nextItemUidAfterToggle = null; // Clear the flag
            log_message(`Selecting next item after toggle: ${targetUid}`);
        }

        // If we had a previously selected item, try to find it by UID across all sections
        if (targetUid !== null && hasRenderedOnce) {
            // Search in incomplete items (section 0)
            for (let i = 0; i < incompleteItems.length; i++) {
                if (incompleteItems[i].uid === targetUid) {
                    newSectionIndex = 0;
                    newItemIndex = i;
                    foundSelection = true;
                    log_message(`Restored selection to section 0, index ${i} (UID: ${targetUid})`);
                    break;
                }
            }

            // If not found, search in completed items (section 1)
            if (!foundSelection) {
                for (let i = 0; i < completedItems.length; i++) {
                    if (completedItems[i].uid === targetUid) {
                        newSectionIndex = 1;
                        newItemIndex = i;
                        foundSelection = true;
                        log_message(`Restored selection to section 1, index ${i} (UID: ${targetUid})`);
                        break;
                    }
                }
            }

            // If we didn't find the previously selected item, it was deleted
            if (!foundSelection) {
                log_message(`Previously selected item (UID: ${targetUid}) no longer exists, selecting first item`);
                if (incompleteItems.length > 0) {
                    selectedItemUid = incompleteItems[0].uid;
                    newSectionIndex = 0;
                    newItemIndex = 0;
                } else if (completedItems.length > 0) {
                    selectedItemUid = completedItems[0].uid;
                    newSectionIndex = 1;
                    newItemIndex = 0;
                }
            }
        } else {
            // First time rendering, select the first item
            if (incompleteItems.length > 0) {
                selectedItemUid = incompleteItems[0].uid;
                newSectionIndex = 0;
                newItemIndex = 0;
            } else if (completedItems.length > 0) {
                selectedItemUid = completedItems[0].uid;
                newSectionIndex = 1;
                newItemIndex = 0;
            }
        }

        // Apply the selection
        if (incompleteItems.length > 0 || completedItems.length > 0) {
            todoListMenu.selection(newSectionIndex, newItemIndex);
        }

        hasRenderedOnce = true;
    }

    // Configuration: Set to true to use long-press for details and tap for toggle
    // Set to false to use tap for details and long-press for toggle
    let useLongPressForDetails = true;

    // Track selection changes (when user navigates with up/down buttons)
    todoListMenu.on('selection', function(e) {
        // Update the currently selected item UID and section when navigating
        if (e.item && e.item.uid) {
            selectedItemUid = e.item.uid;
            selectedSectionIndex = e.sectionIndex;
            log_message(`Selection changed to: ${e.item.title} (UID: ${selectedItemUid}, Section: ${e.sectionIndex})`);
        }
    });

    // Handle item selection
    todoListMenu.on('select', function(e) {
        // Update the currently selected item UID and section
        if (e.item && e.item.uid) {
            selectedItemUid = e.item.uid;
            selectedSectionIndex = e.sectionIndex;
            log_message(`Selected todo item: ${e.item.title} (UID: ${selectedItemUid}, Section: ${e.sectionIndex})`);
        }

        // For action items (section 2), always call on_click
        if (e.sectionIndex === 2) {
            if(typeof e.item.on_click == 'function') {
                e.item.on_click(e);
            }
            return;
        }

        // items with a uid are todo list items otherwise they are actions
        if (e.item && e.item.uid) {
            // Tap toggles completion status
            let newStatus = e.item.status === 'completed' ? 'needs_action' : 'completed';
            log_message(`Tap: Toggling item ${e.item.title} from ${e.item.status} to ${newStatus}`);

            // Get all items from the menu to calculate next selection
            let incompleteItems = [];
            let completedItems = [];

            // Extract items from section 0 (incomplete)
            let section0Items = todoListMenu.items(0);
            for (let i = 0; i < section0Items.length; i++) {
                incompleteItems.push(section0Items[i]);
            }

            // Extract items from section 1 (completed)
            let section1Items = todoListMenu.items(1);
            for (let i = 0; i < section1Items.length; i++) {
                completedItems.push(section1Items[i]);
            }

            // Calculate the next item to select after toggling
            nextItemUidAfterToggle = getNextItemAfterToggle(
                incompleteItems,
                completedItems,
                e.item.uid,
                e.sectionIndex,
                e.item.status
            );

            log_message(`Next item after toggle will be: ${nextItemUidAfterToggle}`);

            haws.callService(
                'todo',
                'update_item',
                {
                    item: e.item.uid,
                    status: newStatus
                },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    log_message(`Successfully updated item status: ${JSON.stringify(data)}`);
                },
                function(error) {
                    Vibe.vibrate('double');
                    log_message(`Error updating item status: ${JSON.stringify(error)}`);
                }
            );
        }
    });

    // Handle long-press
    todoListMenu.on('longSelect', function(e) {
        // Only handle long-press for actual todo items (sections 0 and 1), not actions
        if (e.sectionIndex === 2 || !e.item || !e.item.uid) {
            return;
        }

        // Long-press opens item details
        log_message(`Long-press: Opening details for item ${e.item.title}`);
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    // Unsubscribe when menu is hidden
    todoListMenu.on('hide', function() {
        if (subscription_msg_id) {
            log_message(`Unsubscribing from todo/item/subscribe for ${entity_id}`);
            haws.unsubscribe(subscription_msg_id);
            subscription_msg_id = null;
        }
    });


    todoListMenu.on('show', function() {
        subscription_msg_id = haws.subscribe({
            "type": "todo/item/subscribe",
            "entity_id": entity_id
        }, function(data) {
            log_message(`todo/item/subscribe: ${JSON.stringify(data)}`);

            // Extract items from the event data
            if (data.event && data.event.items) {
                updateToDoListItems(data.event.items);
            }
        }, function(error) {
            log_message(`todo/item/subscribe ERROR: ${JSON.stringify(error)}`);
        });
    });

    todoListMenu.show();
}

// Helper function to show confirmation dialog
function confirmAction(message, successCallback, failureCallback) {
    log_message(`confirmAction: ${message}`);

    let confirmMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: message
        }]
    });

    // Add Confirm option
    confirmMenu.item(0, 0, {
        title: 'Confirm',
        on_click: function(e) {
            log_message('User confirmed action');
            confirmMenu.hide();
            if (typeof successCallback === 'function') {
                successCallback();
            }
        }
    });

    // Add Cancel option
    confirmMenu.item(0, 1, {
        title: 'Cancel',
        on_click: function(e) {
            log_message('User cancelled action');
            confirmMenu.hide();
            if (typeof failureCallback === 'function') {
                failureCallback();
            }
        }
    });

    // Handle selection
    confirmMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    // Handle back button as cancel
    confirmMenu.on('hide', function() {
        log_message('Confirmation dialog closed');
    });

    confirmMenu.show();
}

// Show detailed view of a single todo item with editing capabilities
function showToDoItemMenu(entity_id, item) {
    log_message(`showToDoItemMenu: ${item.summary} (${item.uid})`);

    let itemMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [
            {
                title: 'Item'
            },
            {
                title: 'Actions'
            }
        ]
    });

    let hasMicrophone = Feature.microphone(true, false);
    let subscription_msg_id = null;
    let currentItem = item; // Track the current item data

    // Function to update menu items based on subscription data
    function updateToDoItemMenu(items) {
        log_message(`updateToDoItemMenu: Searching for item ${currentItem.uid} in ${items.length} items`);

        // Find the current item by UID
        let updatedItem = null;
        for (let i = 0; i < items.length; i++) {
            if (items[i].uid === currentItem.uid) {
                updatedItem = items[i];
                break;
            }
        }

        // If item was deleted, close the menu
        if (!updatedItem) {
            log_message(`Item ${currentItem.uid} no longer exists, closing menu`);
            itemMenu.hide();
            return;
        }

        // Update current item reference
        currentItem = updatedItem;
        log_message(`Updating menu with latest item data: ${JSON.stringify(updatedItem)}`);

        // Update Section 0 - Item Fields
        let fieldIndex = 0;

        // 1. Update Name/Summary field
        itemMenu.item(0, fieldIndex++, {
            title: 'Name',
            subtitle: updatedItem.summary,
            on_click: hasMicrophone ? function(e) {
                log_message('Starting voice dictation for item name');
                Voice.dictate('start', true, function(voiceEvent) {
                    if (voiceEvent.err) {
                        if (voiceEvent.err === "systemAborted") {
                            log_message("Name dictation cancelled by user");
                            return;
                        }
                        log_message(`Name dictation error: ${voiceEvent.err}`);
                        return;
                    }

                    log_message(`Name transcription received: ${voiceEvent.transcription}`);

                    // Update the item name
                    haws.callService(
                        'todo',
                        'update_item',
                        {
                            item: currentItem.uid,
                            rename: voiceEvent.transcription
                        },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            log_message(`Successfully updated item name: ${JSON.stringify(data)}`);
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            log_message(`Error updating item name: ${JSON.stringify(error)}`);
                        }
                    );
                });
            } : undefined
        });

        // 2. Update Description field
        itemMenu.item(0, fieldIndex++, {
            title: 'Description',
            subtitle: updatedItem.description || '',
            on_click: hasMicrophone ? function(e) {
                // If description exists, show options menu
                if (currentItem.description) {
                    showToDoItemDescriptionOptionsMenu(entity_id, currentItem);
                } else {
                    // No description, go straight to voice dictation
                    startToDoItemDescriptionDictation(entity_id, currentItem);
                }
            } : undefined
        });

        // 3. Update Due Date field (read-only for now)
        itemMenu.item(0, fieldIndex++, {
            title: 'Due Date',
            subtitle: updatedItem.due || 'Not set'
        });

        // Update Section 1 - Actions
        // Clear actions section first
        itemMenu.items(1, []);
        let actionIndex = 0;

        // 1. Delete action (always present)
        itemMenu.item(1, actionIndex++, {
            title: 'Delete',
            on_click: function(e) {
                confirmAction(
                    'Delete this item?',
                    function() {
                        // Success callback - delete the item
                        log_message(`Deleting item: ${currentItem.summary} (${currentItem.uid})`);
                        haws.callService(
                            'todo',
                            'remove_item',
                            { item: currentItem.uid },
                            { entity_id: entity_id },
                            function(data) {
                                Vibe.vibrate('short');
                                log_message(`Successfully deleted item: ${JSON.stringify(data)}`);
                                // Hide the menu to return to the todo list
                                itemMenu.hide();
                            },
                            function(error) {
                                Vibe.vibrate('double');
                                log_message(`Error deleting item: ${JSON.stringify(error)}`);
                            }
                        );
                    },
                    function() {
                        // Failure/cancel callback
                        log_message('Delete item cancelled');
                    }
                );
            }
        });

        // 2. Toggle completion status action (conditional based on current status)
        if (updatedItem.status !== 'completed') {
            itemMenu.item(1, actionIndex++, {
                title: 'Mark Completed',
                on_click: function(e) {
                    log_message(`Marking item as completed: ${currentItem.summary} (${currentItem.uid})`);
                    haws.callService(
                        'todo',
                        'update_item',
                        {
                            item: currentItem.uid,
                            status: 'completed'
                        },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            log_message(`Successfully marked item as completed: ${JSON.stringify(data)}`);
                            // Menu remains open, subscription will update
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            log_message(`Error marking item as completed: ${JSON.stringify(error)}`);
                        }
                    );
                }
            });
        } else {
            itemMenu.item(1, actionIndex++, {
                title: 'Mark Incomplete',
                on_click: function(e) {
                    log_message(`Marking item as incomplete: ${currentItem.summary} (${currentItem.uid})`);
                    haws.callService(
                        'todo',
                        'update_item',
                        {
                            item: currentItem.uid,
                            status: 'needs_action'
                        },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            log_message(`Successfully marked item as incomplete: ${JSON.stringify(data)}`);
                            // Menu remains open, subscription will update
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            log_message(`Error marking item as incomplete: ${JSON.stringify(error)}`);
                        }
                    );
                }
            });
        }
    }

    // Handle selection
    itemMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    // Subscribe when menu is shown
    itemMenu.on('show', function() {
        log_message(`Subscribing to todo items for ${entity_id}`);
        subscription_msg_id = haws.subscribe({
            "type": "todo/item/subscribe",
            "entity_id": entity_id
        }, function(data) {
            log_message(`todo/item/subscribe (item menu): ${JSON.stringify(data)}`);

            // Extract items from the event data
            if (data.event && data.event.items) {
                updateToDoItemMenu(data.event.items);
            }
        }, function(error) {
            log_message(`todo/item/subscribe ERROR (item menu): ${JSON.stringify(error)}`);
        });
    });

    // Unsubscribe when menu is hidden
    itemMenu.on('hide', function() {
        if (subscription_msg_id) {
            log_message(`Unsubscribing from todo/item/subscribe for ${entity_id} (item menu)`);
            haws.unsubscribe(subscription_msg_id);
            subscription_msg_id = null;
        }
    });

    itemMenu.show();
}

// Helper function to show todo item description options menu
function showToDoItemDescriptionOptionsMenu(entity_id, item) {
    log_message('Showing todo item description options menu');

    let descOptionsMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Description'
        }]
    });

    // Update Description option
    descOptionsMenu.item(0, 0, {
        title: 'Update Desc',
        on_click: function(e) {
            descOptionsMenu.hide();
            startToDoItemDescriptionDictation(entity_id, item);
        }
    });

    // Remove Description option
    descOptionsMenu.item(0, 1, {
        title: 'Remove Desc',
        on_click: function(e) {
            log_message(`Removing description from item: ${item.summary} (${item.uid})`);
            descOptionsMenu.hide();

            haws.callService(
                'todo',
                'update_item',
                {
                    item: item.uid,
                    description: null
                },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    log_message(`Successfully removed description: ${JSON.stringify(data)}`);
                },
                function(error) {
                    Vibe.vibrate('double');
                    log_message(`Error removing description: ${JSON.stringify(error)}`);
                }
            );
        }
    });

    // Handle selection
    descOptionsMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    descOptionsMenu.show();
}

// Helper function to start todo item description dictation
function startToDoItemDescriptionDictation(entity_id, item) {
    log_message('Starting voice dictation for todo item description');

    Voice.dictate('start', true, function(voiceEvent) {
        if (voiceEvent.err) {
            if (voiceEvent.err === "systemAborted") {
                log_message("Description dictation cancelled by user");
                return;
            }
            log_message(`Description dictation error: ${voiceEvent.err}`);
            return;
        }

        log_message(`Description transcription received: ${voiceEvent.transcription}`);

        // Update the item description
        haws.callService(
            'todo',
            'update_item',
            {
                item: item.uid,
                description: voiceEvent.transcription
            },
            { entity_id: entity_id },
            function(data) {
                log_message(`Successfully updated item description: ${JSON.stringify(data)}`);
            },
            function(error) {
                log_message(`Error updating item description: ${JSON.stringify(error)}`);
            }
        );
    });
}

let entityListMenu = null;
function showEntityList(title, entity_id_list = false, ignoreEntityCache = true, sortItems = true, skipIgnoredDomains = false) {
    log_message(`showEntityList (title=${title}): called`);
    // setup entityListMenu if it hasn't been
    entityListMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: title ? title : "Home Assistant"
        }]
    });

    entityListMenu.subscription_id = null;
    entityListMenu.current_page = null;
    entityListMenu.on('longSelect', function(e) {
        log_message(`Entity ${e.item.entity_id} was long pressed!`);
        let [domain] = e.item.entity_id.split('.');
        if (
            domain === "switch" ||
            domain === "light" ||
            domain === "input_boolean" ||
            domain === "automation" ||
            domain === "script" ||
            domain === "cover"
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
                    Vibe.vibrate('short');
                },
                function (error) {
                    // Failure!
                    log_message('no response');
                    Vibe.vibrate('double');
                });
        }
        else if (domain === "lock") {
            let entity = ha_state_dict[e.item.entity_id];
            haws.callService(
                domain,
                entity.state === "locked" ? "unlock" : "lock",
                {},
                {entity_id: e.item.entity_id},
                function (data) {
                    // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                    // Success!
                    Vibe.vibrate('short');
                    log_message(JSON.stringify(data));
                },
                function (error) {
                    // Failure!
                    Vibe.vibrate('double');
                    log_message('no response');
                });
        }
        else if (domain === "scene") {
            haws.callService(
                domain,
                "apply",
                {},
                {entity_id: e.item.entity_id},
                function (data) {
                    // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                    // Success!
                    Vibe.vibrate('short');
                    log_message(JSON.stringify(data));
                },
                function (error) {
                    // Failure!
                    Vibe.vibrate('double');
                    log_message('no response');
                });
        }
    });

    entityListMenu.on('hide', function(e) {
        log_message(`showEntityList (title=${title}): hide event called`);
        if(entityListMenu.subscription_id) {
            haws.unsubscribe(entityListMenu.subscription_id);
        }
    });

    // Add an action for SELECT
    entityListMenu.on('select', function(e) {
        log_message(`showEntityList (title=${title}): select event called`);
        // Store the current selection index
        menuSelections.entityListMenu = e.itemIndex;

        let entity_id = e.item.entity_id;
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
            return;
        }
        log_message(`Entity ${entity_id} was short pressed! Index: ${e.itemIndex}`);

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

        // Check if we're staying on the same page
        let stayingOnSamePage = (entityListMenu.current_page === pageNumber);

        let prev_title = entityListMenu.section(0).title;
        entityListMenu.section(0).title = 'updating ...';
        getStates(
            function(data) {
                entityListMenu.section(0).title = prev_title;

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

                function paginate(array, pageSize, pageNumber) {
                    return array.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
                }
                if(data.length > maxPageItems) {
                    data = paginate(data, maxPageItems, pageNumber);
                    paginated = true;
                    paginateMore = (maxPageItems * pageNumber) < data_length;
                    log_message(`maxPageItems:${maxPageItems} pageNumber:${pageNumber} data_length:${data_length} paginateMore:${paginateMore?1:0}`)
                }

                // Prepare to set up subscription for entity updates
                let renderedEntityIds = {};

                // If we're not staying on the same page, clear all items and rebuild the menu
                if (!stayingOnSamePage) {
                    entityListMenu.items(0, []); // clear items
                    let menuIndex = 0;

                    if(pageNumber > 1) {
                        entityListMenu.item(0, menuIndex, {
                            title: "Prev Page",
                            on_click: function(e) {
                                updateStates(pageNumber - 1);
                            }
                        });
                        menuIndex++;
                    }

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
                            subtitle: data[i].state + (data[i].attributes.unit_of_measurement ? ` ${data[i].attributes.unit_of_measurement}` : '') + ' > ' + humanDiff(new Date(), new Date(data[i].last_changed)),
                            entity_id: data[i].entity_id,
                            icon: getEntityIcon(data[i])
                        });
                        renderedEntityIds[data[i].entity_id] = menuId;
                    }

                    if(paginateMore) {
                        entityListMenu.item(0, menuIndex, {
                            title: "Next Page",
                            on_click: function(e) {
                                updateStates(pageNumber + 1);
                            }
                        });
                        paginateMoreIndex = menuIndex;
                    }
                } else {
                    // We're staying on the same page, just update the existing items
                    log_message('Staying on same page, updating existing items');

                    // Get all current menu items
                    let currentItems = entityListMenu.items(0);
                    let entityMap = {};

                    // Create a map of entity_id to data for quick lookup
                    for (let i = 0; i < data.length; i++) {
                        entityMap[data[i].entity_id] = data[i];
                    }

                    // Update each menu item with new data if available
                    for (let i = 0; i < currentItems.length; i++) {
                        let item = currentItems[i];

                        // Skip navigation items (Prev/Next Page)
                        if (!item.entity_id) {
                            continue;
                        }

                        // If we have updated data for this entity, update the menu item
                        if (entityMap[item.entity_id]) {
                            let entity = entityMap[item.entity_id];
                            entityListMenu.item(0, i, {
                                title: entity.attributes.friendly_name ? entity.attributes.friendly_name : entity.entity_id,
                                subtitle: entity.state + (entity.attributes.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : '') + ' > ' + humanDiff(new Date(), new Date(entity.last_changed)),
                                entity_id: entity.entity_id,
                                icon: getEntityIcon(entity)
                            });

                            // Build the renderedEntityIds map for subscription
                            renderedEntityIds[entity.entity_id] = i;
                        }
                    }
                }

                // Always set up subscription for entity updates, regardless of whether we're staying on the same page
                if(entityListMenu.subscription_id) {
                    haws.unsubscribe(entityListMenu.subscription_id);
                    entityListMenu.subscription_id = null;
                }

                if(Object.keys(renderedEntityIds).length) {
                    log_message(`Setting up subscription for ${Object.keys(renderedEntityIds).length} entities`);
                    entityListMenu.subscription_id = haws.subscribe({
                        "type": "subscribe_trigger",
                        "trigger": {
                            "platform": "state",
                            "entity_id": Object.keys(renderedEntityIds),
                        },
                    }, function(data) {
                        ha_state_dict[data.event.variables.trigger.to_state.entity_id] = data.event.variables.trigger.to_state;
                        let entity = ha_state_dict[data.event.variables.trigger.to_state.entity_id];
                        log_message("ENTITY GETTING UPDATE:" + JSON.stringify(entity));
                        if(!entity) {
                            log_message('FAILED TO FIND ENTITY ' + data.event.variables.trigger.to_state.entity_id);
                            return;
                        }
                        entityListMenu.item(0, renderedEntityIds[entity.entity_id], {
                            title: data.event.variables.trigger.to_state.attributes.friendly_name ? data.event.variables.trigger.to_state.attributes.friendly_name : entity.entity_id,
                            subtitle: data.event.variables.trigger.to_state.state + (data.event.variables.trigger.to_state.attributes.unit_of_measurement ? ` ${data.event.variables.trigger.to_state.attributes.unit_of_measurement}` : '') + ' > ' + humanDiff(new Date(), new Date(data.event.variables.trigger.to_state.last_changed)),
                            entity_id: entity.entity_id,
                            icon: getEntityIcon(data.event.variables.trigger.to_state)
                        });
                    }, function(error) {
                        log_message(`ENTITY UPDATE ERROR ${JSON.stringify(Object.keys(renderedEntityIds))}: ` + JSON.stringify(error));
                    });
                }

                // Update the current page number
                entityListMenu.current_page = pageNumber;

                //Vibe.vibrate('short');
            },
            function() {
                entityListMenu.section(0).title = 'HAWS - failed updating';
            },
            true
        );
    }

    entityListMenu.on('show', function(e) {
        log_message(`showEntityList (title=${title}): show event called`);
        updateStates(entityListMenu.current_page);

        // Restore the previously selected index after a short delay
        // setTimeout(function() {
        //     if (menuSelections.entityListMenu > 0) {
        //         entityListMenu.selection(0, menuSelections.entityListMenu);
        //     }
        // }, 100);
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

                // Handle quick launch behavior after authentication is complete
                // Use a function to handle the quick launch behavior so we can retry if needed
                function handleQuickLaunch(retryCount) {
                    retryCount = retryCount || 0;
                    var retryDelay = 10; // Delay between retries in ms

                    var launchReason = simply.impl.state.launchReason;
                    log_message('Launch reason: ' + launchReason + ' (retry: ' + retryCount + ')');

                    // If launch reason is undefined and we haven't exceeded max retries, try again
                    if ( !launchReason ) {
                        log_message('Launch reason not available yet, retrying in ' + retryDelay + 'ms...');
                        setTimeout(function() {
                            handleQuickLaunch(retryCount + 1);
                        }, retryDelay);
                        return;
                    }

                    // If we have a quickLaunch reason or we've exhausted retries, proceed
                    if (launchReason === 'quickLaunch') {
                        log_message('App launched via quick launch, behavior: ' + quick_launch_behavior);

                        // Handle the quick launch behavior based on settings
                        switch (quick_launch_behavior) {
                            case 'assistant':
                                if (voice_enabled) {
                                    showAssistMenu();
                                }
                                break;
                            case 'favorites':
                                let favoriteEntities = favoriteEntityStore.all();
                                if(favoriteEntities && favoriteEntities.length) {
                                    const shouldShowDomains = shouldShowDomainMenu(favoriteEntities, domain_menu_favorites);
                                    if(shouldShowDomains) {
                                        showEntityDomainsFromList(favoriteEntities, "Favorites");
                                    } else {
                                        showEntityList("Favorites", favoriteEntities, true, false, true);
                                    }
                                }
                                break;
                            case 'areas':
                                showAreaMenu();
                                break;
                            case 'labels':
                                showLabelMenu();
                                break;
                            case 'todo_lists':
                                showToDoLists();
                                break;
                            case 'main_menu':
                            default:
                                // Default behavior is to show the main menu, which is already handled
                                break;
                        }
                    }
                }

                // Start the quick launch handling process
                handleQuickLaunch();
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
    const Platform = require('platform');
    // If setting is explicitly yes or no, respect that
    if (menuSetting === 'yes') return true;
    if (menuSetting === 'no') return false;

    // Get unique domains from entities
    const domains = new Set();
    const isAplite = Platform.version() === 'aplite';

    for (let entity_id of entities) {
        domains.add(entity_id.split('.')[0]);

        // OG Pebble (aplite) lacks memory to display more than 3 icons
        // so we force the domain menu if there are multiple domains
        // this way only 2 icons will ever display on the menu
        if (isAplite && domains.size > 1) {
            return true;
        }
    }

    // For conditional, check the conditions
    if (menuSetting === 'conditional') {
        const domainCount = domains.size;

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
    // Check if dates are valid Date objects, if not convert them
    newestDate = newestDate instanceof Date ? newestDate : new Date(newestDate);
    oldestDate = oldestDate instanceof Date ? oldestDate : new Date(oldestDate);

    // Reverse the check - if oldestDate is after newestDate, they're in wrong order
    if(oldestDate > newestDate) {
        return 'now';
    }

    let prettyDate = {
        diffDate: newestDate - oldestDate,
        diffUnit: "ms"
    };

    function reduceNumbers(inPrettyDate, interval, unit) {
        // Only convert if the difference is greater than or equal to the interval
        if (inPrettyDate.diffDate >= interval) {
            // Use integer division to prevent accumulating floating point errors
            inPrettyDate.diffDate = Math.floor(inPrettyDate.diffDate / interval);
            inPrettyDate.diffUnit = unit;
            return true;
        }
        return false;
    }

    // Use a chain of if-statements rather than sequential operations to avoid
    // continually dividing small values
    if (reduceNumbers(prettyDate, 1000, 's')) {
        if (reduceNumbers(prettyDate, 60, 'm')) {
            if (reduceNumbers(prettyDate, 60, 'h')) {
                reduceNumbers(prettyDate, 24, 'd');
            }
        }
    }

    // Round properly and return a formatted string
    return prettyDate.diffDate + ' ' + prettyDate.diffUnit;
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