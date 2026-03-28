/**
 * SettingsMenuPage - Settings menus and submenus
 */
var simply = require('ui/simply');
var Settings = require('settings');
var Feature = require('platform/feature');
var Vibe = require('ui/vibe');
var BasePage = require('app/pages/BasePage');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');

// Screen ID range for SettingsMenuPage: 5000-5099
var _settingsScreenId = 5000;
function nextSettingsScreenId() { return _settingsScreenId++; }

class SettingsMenuPage extends BasePage {
    constructor() {
        super();
    }

    /**
     * Override show() to use native bridge instead of UI.Menu
     */
    show() {
        var self = this;
        var appState = this.appState;

        var screenId = nextSettingsScreenId();
        var callbacks = {};
        var i = 0;

        // Only show Assistant settings if we have microphone support
        if (Feature.microphone(true, false)) {
            callbacks['0_' + i] = function() {
                showVoiceAssistantSettings();
            };
            simply.impl.nativeMenuUpdate(screenId, 0, i, "Assistant", '', null);
            i++;
        }

        callbacks['0_' + i] = function() {
            showEntitySettings();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, i, "Entity Settings", '', null);
        i++;

        callbacks['0_' + i] = function() {
            showDomainFilterSettings();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, i, "Domain Filters", '', null);
        i++;

        callbacks['0_' + i] = function() {
            showQuickLaunchSettings();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, i, "Quick Launch", '', null);
        i++;

        simply.impl.nativeMenuPush(screenId, 'Settings', 1, {
            onSelect: function(section, index) {
                var key = section + '_' + index;
                if (callbacks[key]) {
                    callbacks[key]();
                }
            },
            onBack: function() {
                // Nothing to clean up
            }
        });
        simply.impl.nativeMenuSectionTitle(screenId, 0, 'Settings');

        // Re-populate items after push (push clears them)
        var j = 0;
        if (Feature.microphone(true, false)) {
            simply.impl.nativeMenuUpdate(screenId, 0, j, "Assistant", '', null);
            j++;
        }
        simply.impl.nativeMenuUpdate(screenId, 0, j, "Entity Settings", '', null);
        j++;
        simply.impl.nativeMenuUpdate(screenId, 0, j, "Domain Filters", '', null);
        j++;
        simply.impl.nativeMenuUpdate(screenId, 0, j, "Quick Launch", '', null);
        j++;
    }
}

/**
 * Show domain filter settings menu
 */
function showDomainFilterSettings() {
    var appState = AppState.getInstance();
    var screenId = nextSettingsScreenId();
    var callbacks = {};

    function buildItems() {
        var index = 0;

        // Add heading with instruction
        simply.impl.nativeMenuUpdate(screenId, 0, index,
            "Long press to remove", "Settings > Configure", null);
        index++;

        // Add each ignored domain to the menu
        if (appState.ignore_domains && appState.ignore_domains.length > 0) {
            for (var i = 0; i < appState.ignore_domains.length; i++) {
                (function(domainIdx) {
                    var domain = appState.ignore_domains[domainIdx];
                    simply.impl.nativeMenuUpdate(screenId, 0, index,
                        domain, '', null);
                    // No on_click for domain items (longSelect removes them)
                    index++;
                })(i);
            }
        } else {
            simply.impl.nativeMenuUpdate(screenId, 0, index,
                "No domains ignored", "Using all domains", null);
            index++;
        }

        // Add reset option
        callbacks['0_' + index] = function() {
            appState.ignore_domains = Constants.DEFAULT_IGNORE_DOMAINS.slice();
            Settings.option('ignore_domains', appState.ignore_domains);
            simply.impl.nativeMenuPop();
            showDomainFilterSettings();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, index,
            "Reset to defaults", '', null);
    }

    simply.impl.nativeMenuPush(screenId, 'Ignored Domains', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onLongSelect: function(section, index) {
            // Check if this is a domain item (index > 0, and within domain range)
            if (index > 0 && appState.ignore_domains && index <= appState.ignore_domains.length) {
                Vibe.vibrate('short');
                var domainIndex = index - 1;
                var domain = appState.ignore_domains[domainIndex];
                if (domain) {
                    var idx = appState.ignore_domains.indexOf(domain);
                    if (idx !== -1) {
                        appState.ignore_domains.splice(idx, 1);
                        Settings.option('ignore_domains', appState.ignore_domains);
                        simply.impl.nativeMenuPop();
                        showDomainFilterSettings();
                    }
                }
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Ignored Domains');

    buildItems();
}

/**
 * Show voice assistant settings menu
 */
function showVoiceAssistantSettings() {
    var appState = AppState.getInstance();
    var screenId = nextSettingsScreenId();
    var callbacks = {};

    function updateMenuItems() {
        var menuIndex = 0;

        // Enabled setting
        callbacks['0_' + menuIndex] = function() {
            appState.voice_enabled = !appState.voice_enabled;
            Settings.option('voice_enabled', appState.voice_enabled);
            updateMenuItems();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, menuIndex,
            "Enabled", appState.voice_enabled ? "True" : "False", null);
        menuIndex++;

        // Font Size setting
        var currentFontSize = Settings.option('voice_font_size') || 18;
        callbacks['0_' + menuIndex] = function() {
            var currentFontSize = Settings.option('voice_font_size') || 18;
            var availableSizes = [14, 18, 24, 28];
            var currentIndex = availableSizes.indexOf(currentFontSize);
            var nextSize = availableSizes[(currentIndex + 1) % availableSizes.length];
            Settings.option('voice_font_size', nextSize);
            updateMenuItems();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, menuIndex,
            "Font Size", currentFontSize + "px", null);
        menuIndex++;

        // Pipeline setting
        var currentAgentName = "Home Assistant";
        if (appState.selected_pipeline && appState.ha_pipelines) {
            for (var i = 0; i < appState.ha_pipelines.length; i++) {
                if (appState.ha_pipelines[i].id === appState.selected_pipeline) {
                    currentAgentName = appState.ha_pipelines[i].name;
                    break;
                }
            }
        }

        callbacks['0_' + menuIndex] = function() {
            showVoicePipelineMenu();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, menuIndex,
            "Pipeline", currentAgentName, null);
        menuIndex++;

        // Confirm Dictate setting
        callbacks['0_' + menuIndex] = function() {
            appState.voice_confirm = !appState.voice_confirm;
            Settings.option('voice_confirm', appState.voice_confirm);
            updateMenuItems();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, menuIndex,
            "Confirm Dictation", appState.voice_confirm ? "True" : "False", null);
        menuIndex++;
    }

    simply.impl.nativeMenuPush(screenId, 'Assistant Settings', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Assistant Settings');

    updateMenuItems();
}

/**
 * Show entity settings menu
 */
function showEntitySettings() {
    var appState = AppState.getInstance();

    function getEntityHandlingText(value) {
        switch (value) {
            case 'sort_to_end': return 'Sort to end';
            case 'sort_normally': return 'Sort normally';
            case 'hide': return 'Hide';
            default: return 'Sort to end';
        }
    }

    function getAutomationLongpressText(value) {
        switch (value) {
            case 'toggle': return 'Toggle';
            case 'trigger': return 'Trigger';
            default: return 'Toggle';
        }
    }

    var screenId = nextSettingsScreenId();
    var callbacks = {};

    function buildItems() {
        // Order By setting
        var orderByText = "Name";
        if (appState.ha_order_by === "entity_id") {
            orderByText = "Entity ID";
        } else if (appState.ha_order_by === "attributes.last_updated") {
            orderByText = "Last Updated";
        }

        callbacks['0_0'] = function() {
            showOrderByMenu();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, 0,
            "Order By", orderByText, null);

        // Order Direction setting
        callbacks['0_1'] = function() {
            appState.ha_order_dir = appState.ha_order_dir === "desc" ? "asc" : "desc";
            Settings.option('order_dir', appState.ha_order_dir);
            simply.impl.nativeMenuUpdate(screenId, 0, 1,
                "Order Direction",
                appState.ha_order_dir === "desc" ? "Descending" : "Ascending",
                null);
        };
        simply.impl.nativeMenuUpdate(screenId, 0, 1,
            "Order Direction",
            appState.ha_order_dir === "desc" ? "Descending" : "Ascending",
            null);

        // Unavailable Entities setting
        callbacks['0_2'] = function() {
            showUnavailableEntitiesMenu();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, 2,
            "Unavailable Entities",
            getEntityHandlingText(appState.unavailable_entity_handling),
            null);

        // Unknown Entities setting
        callbacks['0_3'] = function() {
            showUnknownEntitiesMenu();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, 3,
            "Unknown Entities",
            getEntityHandlingText(appState.unknown_entity_handling),
            null);

        // Automation Long-Press setting
        callbacks['0_4'] = function() {
            showAutomationLongpressMenu();
        };
        simply.impl.nativeMenuUpdate(screenId, 0, 4,
            "Automation Long-Press",
            getAutomationLongpressText(appState.automation_longpress_action),
            null);
    }

    simply.impl.nativeMenuPush(screenId, 'Entity Settings', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Entity Settings');

    buildItems();
}

function showOrderByMenu() {
    var appState = AppState.getInstance();
    var screenId = nextSettingsScreenId();
    var callbacks = {};

    var options = [
        { title: "Name", value: "attributes.friendly_name" },
        { title: "Entity ID", value: "entity_id" },
        { title: "Last Updated", value: "attributes.last_updated" }
    ];

    for (var i = 0; i < options.length; i++) {
        (function(idx) {
            callbacks['0_' + idx] = function() {
                appState.ha_order_by = options[idx].value;
                Settings.option('order_by', appState.ha_order_by);
                simply.impl.nativeMenuPop();
            };
        })(i);
    }

    simply.impl.nativeMenuPush(screenId, 'Order By', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Order By');

    for (var i = 0; i < options.length; i++) {
        simply.impl.nativeMenuUpdate(screenId, 0, i,
            options[i].title,
            appState.ha_order_by === options[i].value ? "Current" : "",
            null);
    }
}

function showUnavailableEntitiesMenu() {
    var appState = AppState.getInstance();
    var screenId = nextSettingsScreenId();
    var callbacks = {};

    var options = [
        { title: "Sort to end", value: "sort_to_end" },
        { title: "Sort normally", value: "sort_normally" },
        { title: "Hide", value: "hide" }
    ];

    for (var i = 0; i < options.length; i++) {
        (function(idx) {
            callbacks['0_' + idx] = function() {
                appState.unavailable_entity_handling = options[idx].value;
                Settings.option('unavailable_entity_handling', appState.unavailable_entity_handling);
                simply.impl.nativeMenuPop();
            };
        })(i);
    }

    simply.impl.nativeMenuPush(screenId, 'Unavailable Entities', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Unavailable Entities');

    for (var i = 0; i < options.length; i++) {
        simply.impl.nativeMenuUpdate(screenId, 0, i,
            options[i].title,
            appState.unavailable_entity_handling === options[i].value ? "Current" : "",
            null);
    }
}

function showUnknownEntitiesMenu() {
    var appState = AppState.getInstance();
    var screenId = nextSettingsScreenId();
    var callbacks = {};

    var options = [
        { title: "Sort to end", value: "sort_to_end" },
        { title: "Sort normally", value: "sort_normally" },
        { title: "Hide", value: "hide" }
    ];

    for (var i = 0; i < options.length; i++) {
        (function(idx) {
            callbacks['0_' + idx] = function() {
                appState.unknown_entity_handling = options[idx].value;
                Settings.option('unknown_entity_handling', appState.unknown_entity_handling);
                simply.impl.nativeMenuPop();
            };
        })(i);
    }

    simply.impl.nativeMenuPush(screenId, 'Unknown Entities', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Unknown Entities');

    for (var i = 0; i < options.length; i++) {
        simply.impl.nativeMenuUpdate(screenId, 0, i,
            options[i].title,
            appState.unknown_entity_handling === options[i].value ? "Current" : "",
            null);
    }
}

function showAutomationLongpressMenu() {
    var appState = AppState.getInstance();
    var screenId = nextSettingsScreenId();
    var callbacks = {};

    var options = [
        { title: "Toggle", value: "toggle" },
        { title: "Trigger", value: "trigger" }
    ];

    for (var i = 0; i < options.length; i++) {
        (function(idx) {
            callbacks['0_' + idx] = function() {
                appState.automation_longpress_action = options[idx].value;
                Settings.option('automation_longpress_action', appState.automation_longpress_action);
                simply.impl.nativeMenuPop();
            };
        })(i);
    }

    simply.impl.nativeMenuPush(screenId, 'Automation Long-Press', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Automation Long-Press');

    for (var i = 0; i < options.length; i++) {
        simply.impl.nativeMenuUpdate(screenId, 0, i,
            options[i].title,
            appState.automation_longpress_action === options[i].value ? "Current" : "",
            null);
    }
}

/**
 * Show quick launch settings menu
 */
function showQuickLaunchSettings() {
    var appState = AppState.getInstance();

    function getActionDisplayName(behavior) {
        switch (behavior) {
            case 'main_menu': return 'Main Menu';
            case 'assistant': return 'Assistant';
            case 'favorites': return 'Favorites';
            case 'favorite_entity':
                if (appState.quick_launch_favorite_entity) {
                    var favorites = appState.favoriteEntityStore.allWithNames();
                    for (var i = 0; i < favorites.length; i++) {
                        if (favorites[i].entity_id === appState.quick_launch_favorite_entity) {
                            return favorites[i].name || appState.quick_launch_favorite_entity;
                        }
                    }
                }
                return 'Favorite Entity';
            case 'areas': return 'Areas';
            case 'labels': return 'Labels';
            case 'todo_lists': return 'To-Do Lists';
            default: return 'Main Menu';
        }
    }

    var screenId = nextSettingsScreenId();
    var callbacks = {};

    function updateMenuItems() {
        callbacks['0_0'] = function() {
            showQuickLaunchActionMenu(function() {
                // Update the action display after returning from submenu
                simply.impl.nativeMenuUpdate(screenId, 0, 0,
                    "Action",
                    getActionDisplayName(appState.quick_launch_behavior),
                    null);
            });
        };
        simply.impl.nativeMenuUpdate(screenId, 0, 0,
            "Action",
            getActionDisplayName(appState.quick_launch_behavior),
            null);

        callbacks['0_1'] = function() {
            appState.quick_launch_exit_on_back = !appState.quick_launch_exit_on_back;
            Settings.option('quick_launch_exit_on_back', appState.quick_launch_exit_on_back);
            simply.impl.nativeMenuUpdate(screenId, 0, 1,
                "Exit on Back",
                appState.quick_launch_exit_on_back ? "Enabled" : "Disabled",
                null);
        };
        simply.impl.nativeMenuUpdate(screenId, 0, 1,
            "Exit on Back",
            appState.quick_launch_exit_on_back ? "Enabled" : "Disabled",
            null);
    }

    simply.impl.nativeMenuPush(screenId, 'Quick Launch', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Quick Launch');

    updateMenuItems();
}

function showQuickLaunchActionMenu(onSelectCb) {
    var appState = AppState.getInstance();
    var screenId = nextSettingsScreenId();
    var callbacks = {};

    function buildItems() {
        var itemIndex = 0;

        callbacks['0_' + itemIndex] = function() {
            appState.quick_launch_behavior = 'main_menu';
            appState.quick_launch_favorite_entity = null;
            Settings.option('quick_launch_favorite_entity', null);
            Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
            simply.impl.nativeMenuPop();
            if (typeof onSelectCb === 'function') { onSelectCb(); }
        };
        simply.impl.nativeMenuUpdate(screenId, 0, itemIndex,
            "Main Menu",
            appState.quick_launch_behavior === 'main_menu' ? "Current" : "",
            null);
        itemIndex++;

        if (appState.voice_enabled) {
            callbacks['0_' + itemIndex] = function() {
                appState.quick_launch_behavior = 'assistant';
                appState.quick_launch_favorite_entity = null;
                Settings.option('quick_launch_favorite_entity', null);
                Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
                simply.impl.nativeMenuPop();
                if (typeof onSelectCb === 'function') { onSelectCb(); }
            };
            simply.impl.nativeMenuUpdate(screenId, 0, itemIndex,
                "Assistant",
                appState.quick_launch_behavior === 'assistant' ? "Current" : "",
                null);
            itemIndex++;
        }

        callbacks['0_' + itemIndex] = function() {
            appState.quick_launch_behavior = 'favorites';
            appState.quick_launch_favorite_entity = null;
            Settings.option('quick_launch_favorite_entity', null);
            Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
            simply.impl.nativeMenuPop();
            if (typeof onSelectCb === 'function') { onSelectCb(); }
        };
        simply.impl.nativeMenuUpdate(screenId, 0, itemIndex,
            "Favorites",
            appState.quick_launch_behavior === 'favorites' ? "Current" : "",
            null);
        itemIndex++;

        var favoriteEntities = appState.favoriteEntityStore.all();
        if (favoriteEntities && favoriteEntities.length > 0) {
            callbacks['0_' + itemIndex] = function() {
                showFavoriteEntitySelectionMenu(function(selectedEntityId) {
                    if (selectedEntityId) {
                        appState.quick_launch_behavior = 'favorite_entity';
                        appState.quick_launch_favorite_entity = selectedEntityId;
                        Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
                        Settings.option('quick_launch_favorite_entity', appState.quick_launch_favorite_entity);
                        simply.impl.nativeMenuPop();
                        if (typeof onSelectCb === 'function') { onSelectCb(); }
                    }
                });
            };
            simply.impl.nativeMenuUpdate(screenId, 0, itemIndex,
                "Favorite Entity",
                appState.quick_launch_behavior === 'favorite_entity' ? "Current" : "",
                null);
            itemIndex++;
        }

        callbacks['0_' + itemIndex] = function() {
            appState.quick_launch_behavior = 'areas';
            appState.quick_launch_favorite_entity = null;
            Settings.option('quick_launch_favorite_entity', null);
            Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
            simply.impl.nativeMenuPop();
            if (typeof onSelectCb === 'function') { onSelectCb(); }
        };
        simply.impl.nativeMenuUpdate(screenId, 0, itemIndex,
            "Areas",
            appState.quick_launch_behavior === 'areas' ? "Current" : "",
            null);
        itemIndex++;

        callbacks['0_' + itemIndex] = function() {
            appState.quick_launch_behavior = 'labels';
            appState.quick_launch_favorite_entity = null;
            Settings.option('quick_launch_favorite_entity', null);
            Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
            simply.impl.nativeMenuPop();
            if (typeof onSelectCb === 'function') { onSelectCb(); }
        };
        simply.impl.nativeMenuUpdate(screenId, 0, itemIndex,
            "Labels",
            appState.quick_launch_behavior === 'labels' ? "Current" : "",
            null);
        itemIndex++;

        callbacks['0_' + itemIndex] = function() {
            appState.quick_launch_behavior = 'todo_lists';
            appState.quick_launch_favorite_entity = null;
            Settings.option('quick_launch_favorite_entity', null);
            Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
            simply.impl.nativeMenuPop();
            if (typeof onSelectCb === 'function') { onSelectCb(); }
        };
        simply.impl.nativeMenuUpdate(screenId, 0, itemIndex,
            "To-Do Lists",
            appState.quick_launch_behavior === 'todo_lists' ? "Current" : "",
            null);
        itemIndex++;

        callbacks['0_' + itemIndex] = function() {
            appState.quick_launch_behavior = 'people';
            appState.quick_launch_favorite_entity = null;
            Settings.option('quick_launch_favorite_entity', null);
            Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
            simply.impl.nativeMenuPop();
            if (typeof onSelectCb === 'function') { onSelectCb(); }
        };
        simply.impl.nativeMenuUpdate(screenId, 0, itemIndex,
            "People",
            appState.quick_launch_behavior === 'people' ? "Current" : "",
            null);
        itemIndex++;
    }

    simply.impl.nativeMenuPush(screenId, 'Select Action', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Select Action');

    buildItems();
}

function showFavoriteEntitySelectionMenu(onSelectCb) {
    var appState = AppState.getInstance();
    var screenId = nextSettingsScreenId();
    var callbacks = {};

    var favorites = appState.favoriteEntityStore.allWithNames();

    for (var i = 0; i < favorites.length; i++) {
        (function(idx) {
            var fav = favorites[idx];
            callbacks['0_' + idx] = function() {
                simply.impl.nativeMenuPop();
                if (typeof onSelectCb === 'function') {
                    onSelectCb(fav.entity_id);
                }
            };
        })(i);
    }

    simply.impl.nativeMenuPush(screenId, 'Select Favorite', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Select Favorite');

    for (var i = 0; i < favorites.length; i++) {
        var fav = favorites[i];
        var displayName = fav.name || fav.entity_id;
        var isCurrent = appState.quick_launch_favorite_entity === fav.entity_id;
        simply.impl.nativeMenuUpdate(screenId, 0, i,
            displayName,
            isCurrent ? "Current" : "",
            null);
    }
}

function showVoicePipelineMenu() {
    var appState = AppState.getInstance();
    var screenId = nextSettingsScreenId();
    var callbacks = {};

    if (!appState.ha_pipelines) {
        simply.impl.nativeMenuPush(screenId, 'Assist Pipeline', 1, {
            onSelect: function() {},
            onBack: function() {}
        });
        simply.impl.nativeMenuSectionTitle(screenId, 0, 'Assist Pipeline');
        simply.impl.nativeMenuUpdate(screenId, 0, 0,
            "No pipelines", "Loading...", null);
        return;
    }

    for (var i = 0; i < appState.ha_pipelines.length; i++) {
        (function(idx) {
            var pipeline = appState.ha_pipelines[idx];
            callbacks['0_' + idx] = function() {
                appState.selected_pipeline = pipeline.id;
                Settings.option('selected_pipeline', appState.selected_pipeline);

                // Update menu items to reflect new selection
                for (var j = 0; j < appState.ha_pipelines.length; j++) {
                    var p = appState.ha_pipelines[j];
                    var subtitle = '';
                    if (appState.selected_pipeline === p.id && appState.preferred_pipeline === p.id) {
                        subtitle = 'Current - Preferred';
                    } else if (appState.selected_pipeline === p.id) {
                        subtitle = 'Current';
                    } else if (appState.preferred_pipeline === p.id) {
                        subtitle = 'Preferred';
                    }
                    simply.impl.nativeMenuUpdate(screenId, 0, j,
                        p.name, subtitle, null);
                }

                simply.impl.nativeMenuPop();
            };
        })(i);
    }

    simply.impl.nativeMenuPush(screenId, 'Assist Pipeline', 1, {
        onSelect: function(section, index) {
            var key = section + '_' + index;
            if (callbacks[key]) {
                callbacks[key]();
            }
        },
        onBack: function() {
            // Nothing to clean up
        }
    });
    simply.impl.nativeMenuSectionTitle(screenId, 0, 'Assist Pipeline');

    // Populate items
    for (var i = 0; i < appState.ha_pipelines.length; i++) {
        var pipeline = appState.ha_pipelines[i];
        var subtitle = '';
        if (appState.selected_pipeline === pipeline.id && appState.preferred_pipeline === pipeline.id) {
            subtitle = 'Current - Preferred';
        } else if (appState.selected_pipeline === pipeline.id) {
            subtitle = 'Current';
        } else if (appState.preferred_pipeline === pipeline.id) {
            subtitle = 'Preferred';
        }
        simply.impl.nativeMenuUpdate(screenId, 0, i,
            pipeline.name, subtitle, null);
    }
}

/**
 * Show the settings menu (convenience function)
 */
function showSettingsMenu() {
    var page = new SettingsMenuPage();
    page.show();
}

module.exports = SettingsMenuPage;
module.exports.showSettingsMenu = showSettingsMenu;
module.exports.showVoiceAssistantSettings = showVoiceAssistantSettings;
module.exports.showEntitySettings = showEntitySettings;
module.exports.showDomainFilterSettings = showDomainFilterSettings;
module.exports.showQuickLaunchSettings = showQuickLaunchSettings;
module.exports.showVoicePipelineMenu = showVoicePipelineMenu;
