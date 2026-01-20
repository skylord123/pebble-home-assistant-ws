/**
 * SettingsMenuPage - Settings menus and submenus
 */
var UI = require('ui');
var Settings = require('settings');
var Feature = require('platform/feature');
var Vibe = require('ui/vibe');
var BasePage = require('app/pages/BasePage');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');

class SettingsMenuPage extends BasePage {
    constructor() {
        super();
    }

    createMenu() {
        return new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Settings',
                backgroundColor: Constants.colour.highlight,
                textColor: Constants.colour.highlight_text
            }]
        });
    }

    onShow() {
        var self = this;
        var appState = this.appState;
        this.menu.items(0, []);

        var i = 0;

        // Only show Assistant settings if we have microphone support
        if (Feature.microphone(true, false)) {
            this.menu.item(0, i++, {
                title: "Assistant",
                on_click: function(e) {
                    showVoiceAssistantSettings();
                }
            });
        }

        this.menu.item(0, i++, {
            title: "Entity Settings",
            on_click: function(e) {
                showEntitySettings();
            }
        });

        this.menu.item(0, i++, {
            title: "Domain Filters",
            on_click: function(e) {
                showDomainFilterSettings();
            }
        });

        this.menu.item(0, i++, {
            title: "Quick Launch",
            on_click: function(e) {
                showQuickLaunchSettings();
            }
        });
    }

    onSelect(e) {
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    }
}

/**
 * Show domain filter settings menu
 */
function showDomainFilterSettings() {
    var appState = AppState.getInstance();

    var domainFilterMenu = new UI.Menu({
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
        domainFilterMenu.items(0, []);

        // Add heading with instruction
        domainFilterMenu.item(0, 0, {
            title: "Long press to remove",
            subtitle: "Settings > Configure"
        });

        // Add each ignored domain to the menu
        var index = 1;
        if (appState.ignore_domains && appState.ignore_domains.length > 0) {
            for (var i = 0; i < appState.ignore_domains.length; i++) {
                domainFilterMenu.item(0, index++, {
                    title: appState.ignore_domains[i],
                    domain: appState.ignore_domains[i],
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
                appState.ignore_domains = Constants.DEFAULT_IGNORE_DOMAINS.slice();
                Settings.option('ignore_domains', appState.ignore_domains);
                domainFilterMenu.hide();
                showDomainFilterSettings();
            }
        });
    });

    domainFilterMenu.on('longSelect', function(e) {
        Vibe.vibrate('short');
        if (e.item.is_domain) {
            var domain = e.item.domain;
            var index = appState.ignore_domains.indexOf(domain);
            if (index !== -1) {
                appState.ignore_domains.splice(index, 1);
                Settings.option('ignore_domains', appState.ignore_domains);
                domainFilterMenu.hide();
                showDomainFilterSettings();
            }
        }
    });

    domainFilterMenu.on('select', function(e) {
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    domainFilterMenu.show();
}

/**
 * Show voice assistant settings menu
 */
function showVoiceAssistantSettings() {
    var appState = AppState.getInstance();

    var voiceSettingsMenu = new UI.Menu({
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
        voiceSettingsMenu.items(0, []);
        var menuIndex = 0;

        // Enabled setting
        voiceSettingsMenu.item(0, menuIndex++, {
            title: "Enabled",
            subtitle: appState.voice_enabled ? "True" : "False",
            on_click: function(e) {
                appState.voice_enabled = !appState.voice_enabled;
                Settings.option('voice_enabled', appState.voice_enabled);
                updateMenuItems();
            }
        });

        // Font Size setting
        var initialFontSize = Settings.option('voice_font_size') || 18;
        voiceSettingsMenu.item(0, menuIndex++, {
            title: "Font Size",
            subtitle: initialFontSize + "px",
            on_click: function(e) {
                var currentFontSize = Settings.option('voice_font_size') || 18;
                var availableSizes = [14, 18, 24, 28];
                var currentIndex = availableSizes.indexOf(currentFontSize);
                var nextSize = availableSizes[(currentIndex + 1) % availableSizes.length];
                Settings.option('voice_font_size', nextSize);

                voiceSettingsMenu.item(0, e.itemIndex, {
                    title: "Font Size",
                    subtitle: nextSize + "px",
                    on_click: e.item.on_click
                });
            }
        });

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
            subtitle: appState.voice_confirm ? "True" : "False",
            on_click: function(e) {
                appState.voice_confirm = !appState.voice_confirm;
                Settings.option('voice_confirm', appState.voice_confirm);
                updateMenuItems();
            }
        });
    }

    voiceSettingsMenu.on('show', updateMenuItems);
    voiceSettingsMenu.on('select', function(e) {
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    voiceSettingsMenu.show();
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

    var entitySettingsMenu = new UI.Menu({
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
        entitySettingsMenu.items(0, []);

        // Order By setting
        var orderByText = "Name";
        if (appState.ha_order_by === "entity_id") {
            orderByText = "Entity ID";
        } else if (appState.ha_order_by === "attributes.last_updated") {
            orderByText = "Last Updated";
        }

        entitySettingsMenu.item(0, 0, {
            title: "Order By",
            subtitle: orderByText,
            on_click: function(e) {
                showOrderByMenu();
            }
        });

        // Order Direction setting
        entitySettingsMenu.item(0, 1, {
            title: "Order Direction",
            subtitle: appState.ha_order_dir === "desc" ? "Descending" : "Ascending",
            on_click: function(e) {
                appState.ha_order_dir = appState.ha_order_dir === "desc" ? "asc" : "desc";
                Settings.option('order_dir', appState.ha_order_dir);

                entitySettingsMenu.item(0, 1, {
                    title: "Order Direction",
                    subtitle: appState.ha_order_dir === "desc" ? "Descending" : "Ascending",
                    on_click: e.item.on_click
                });
            }
        });

        // Unavailable Entities setting
        entitySettingsMenu.item(0, 2, {
            title: "Unavailable Entities",
            subtitle: getEntityHandlingText(appState.unavailable_entity_handling),
            on_click: function(e) {
                showUnavailableEntitiesMenu();
            }
        });

        // Unknown Entities setting
        entitySettingsMenu.item(0, 3, {
            title: "Unknown Entities",
            subtitle: getEntityHandlingText(appState.unknown_entity_handling),
            on_click: function(e) {
                showUnknownEntitiesMenu();
            }
        });

        // Automation Long-Press setting
        entitySettingsMenu.item(0, 4, {
            title: "Automation Long-Press",
            subtitle: getAutomationLongpressText(appState.automation_longpress_action),
            on_click: function(e) {
                showAutomationLongpressMenu();
            }
        });
    });

    entitySettingsMenu.on('select', function(e) {
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    entitySettingsMenu.show();
}

function showOrderByMenu() {
    var appState = AppState.getInstance();

    var orderByMenu = new UI.Menu({
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
        orderByMenu.items(0, []);

        orderByMenu.item(0, 0, {
            title: "Name",
            subtitle: appState.ha_order_by === "attributes.friendly_name" ? "Current" : "",
            value: "attributes.friendly_name"
        });

        orderByMenu.item(0, 1, {
            title: "Entity ID",
            subtitle: appState.ha_order_by === "entity_id" ? "Current" : "",
            value: "entity_id"
        });

        orderByMenu.item(0, 2, {
            title: "Last Updated",
            subtitle: appState.ha_order_by === "attributes.last_updated" ? "Current" : "",
            value: "attributes.last_updated"
        });
    });

    orderByMenu.on('select', function(e) {
        appState.ha_order_by = e.item.value;
        Settings.option('order_by', appState.ha_order_by);
        setTimeout(function() {
            orderByMenu.hide();
        }, 500);
    });

    orderByMenu.show();
}

function showUnavailableEntitiesMenu() {
    var appState = AppState.getInstance();

    var unavailableMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Unavailable Entities'
        }]
    });

    unavailableMenu.on('show', function() {
        unavailableMenu.items(0, []);

        unavailableMenu.item(0, 0, {
            title: "Sort to end",
            subtitle: appState.unavailable_entity_handling === "sort_to_end" ? "Current" : "",
            value: "sort_to_end"
        });

        unavailableMenu.item(0, 1, {
            title: "Sort normally",
            subtitle: appState.unavailable_entity_handling === "sort_normally" ? "Current" : "",
            value: "sort_normally"
        });

        unavailableMenu.item(0, 2, {
            title: "Hide",
            subtitle: appState.unavailable_entity_handling === "hide" ? "Current" : "",
            value: "hide"
        });
    });

    unavailableMenu.on('select', function(e) {
        appState.unavailable_entity_handling = e.item.value;
        Settings.option('unavailable_entity_handling', appState.unavailable_entity_handling);
        setTimeout(function() {
            unavailableMenu.hide();
        }, 500);
    });

    unavailableMenu.show();
}

function showUnknownEntitiesMenu() {
    var appState = AppState.getInstance();

    var unknownMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Unknown Entities'
        }]
    });

    unknownMenu.on('show', function() {
        unknownMenu.items(0, []);

        unknownMenu.item(0, 0, {
            title: "Sort to end",
            subtitle: appState.unknown_entity_handling === "sort_to_end" ? "Current" : "",
            value: "sort_to_end"
        });

        unknownMenu.item(0, 1, {
            title: "Sort normally",
            subtitle: appState.unknown_entity_handling === "sort_normally" ? "Current" : "",
            value: "sort_normally"
        });

        unknownMenu.item(0, 2, {
            title: "Hide",
            subtitle: appState.unknown_entity_handling === "hide" ? "Current" : "",
            value: "hide"
        });
    });

    unknownMenu.on('select', function(e) {
        appState.unknown_entity_handling = e.item.value;
        Settings.option('unknown_entity_handling', appState.unknown_entity_handling);
        setTimeout(function() {
            unknownMenu.hide();
        }, 500);
    });

    unknownMenu.show();
}

function showAutomationLongpressMenu() {
    var appState = AppState.getInstance();

    var automationMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Automation Long-Press'
        }]
    });

    automationMenu.on('show', function() {
        automationMenu.items(0, []);

        automationMenu.item(0, 0, {
            title: "Toggle",
            subtitle: appState.automation_longpress_action === "toggle" ? "Current" : "",
            value: "toggle"
        });

        automationMenu.item(0, 1, {
            title: "Trigger",
            subtitle: appState.automation_longpress_action === "trigger" ? "Current" : "",
            value: "trigger"
        });
    });

    automationMenu.on('select', function(e) {
        appState.automation_longpress_action = e.item.value;
        Settings.option('automation_longpress_action', appState.automation_longpress_action);
        setTimeout(function() {
            automationMenu.hide();
        }, 500);
    });

    automationMenu.show();
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

    var quickLaunchMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Quick Launch'
        }]
    });

    function updateMenuItems() {
        quickLaunchMenu.items(0, []);

        quickLaunchMenu.item(0, 0, {
            title: "Action",
            subtitle: getActionDisplayName(appState.quick_launch_behavior),
            action: 'select_action'
        });

        quickLaunchMenu.item(0, 1, {
            title: "Exit on Back",
            subtitle: appState.quick_launch_exit_on_back ? "Enabled" : "Disabled",
            action: 'toggle_exit_on_back'
        });
    }

    quickLaunchMenu.on('show', updateMenuItems);

    quickLaunchMenu.on('select', function(e) {
        if (e.item.action === 'select_action') {
            showQuickLaunchActionMenu(function() {
                quickLaunchMenu.item(0, 0, {
                    title: "Action",
                    subtitle: getActionDisplayName(appState.quick_launch_behavior),
                    action: 'select_action'
                });
            });
        } else if (e.item.action === 'toggle_exit_on_back') {
            appState.quick_launch_exit_on_back = !appState.quick_launch_exit_on_back;
            Settings.option('quick_launch_exit_on_back', appState.quick_launch_exit_on_back);
            quickLaunchMenu.item(0, 1, {
                title: "Exit on Back",
                subtitle: appState.quick_launch_exit_on_back ? "Enabled" : "Disabled",
                action: 'toggle_exit_on_back'
            });
        }
    });

    quickLaunchMenu.show();
}

function showQuickLaunchActionMenu(onSelect) {
    var appState = AppState.getInstance();

    var actionMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Select Action'
        }]
    });

    function updateMenuItems() {
        actionMenu.items(0, []);
        var itemIndex = 0;

        actionMenu.item(0, itemIndex++, {
            title: "Main Menu",
            subtitle: appState.quick_launch_behavior === 'main_menu' ? "Current" : "",
            value: 'main_menu'
        });

        if (appState.voice_enabled) {
            actionMenu.item(0, itemIndex++, {
                title: "Assistant",
                subtitle: appState.quick_launch_behavior === 'assistant' ? "Current" : "",
                value: 'assistant'
            });
        }

        actionMenu.item(0, itemIndex++, {
            title: "Favorites",
            subtitle: appState.quick_launch_behavior === 'favorites' ? "Current" : "",
            value: 'favorites'
        });

        var favoriteEntities = appState.favoriteEntityStore.all();
        if (favoriteEntities && favoriteEntities.length > 0) {
            actionMenu.item(0, itemIndex++, {
                title: "Favorite Entity",
                subtitle: appState.quick_launch_behavior === 'favorite_entity' ? "Current" : "",
                value: 'favorite_entity',
                action: 'select_favorite_entity'
            });
        }

        actionMenu.item(0, itemIndex++, {
            title: "Areas",
            subtitle: appState.quick_launch_behavior === 'areas' ? "Current" : "",
            value: 'areas'
        });

        actionMenu.item(0, itemIndex++, {
            title: "Labels",
            subtitle: appState.quick_launch_behavior === 'labels' ? "Current" : "",
            value: 'labels'
        });

        actionMenu.item(0, itemIndex++, {
            title: "To-Do Lists",
            subtitle: appState.quick_launch_behavior === 'todo_lists' ? "Current" : "",
            value: 'todo_lists'
        });

        actionMenu.item(0, itemIndex++, {
            title: "People",
            subtitle: appState.quick_launch_behavior === 'people' ? "Current" : "",
            value: 'people'
        });
    }

    actionMenu.on('show', updateMenuItems);

    actionMenu.on('select', function(e) {
        if (e.item.value) {
            if (e.item.action === 'select_favorite_entity') {
                showFavoriteEntitySelectionMenu(function(selectedEntityId) {
                    if (selectedEntityId) {
                        appState.quick_launch_behavior = 'favorite_entity';
                        appState.quick_launch_favorite_entity = selectedEntityId;
                        Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
                        Settings.option('quick_launch_favorite_entity', appState.quick_launch_favorite_entity);
                        actionMenu.hide();
                        if (typeof onSelect === 'function') {
                            onSelect();
                        }
                    }
                });
            } else {
                appState.quick_launch_behavior = e.item.value;
                if (e.item.value !== 'favorite_entity') {
                    appState.quick_launch_favorite_entity = null;
                    Settings.option('quick_launch_favorite_entity', null);
                }
                Settings.option('quick_launch_behavior', appState.quick_launch_behavior);
                actionMenu.hide();
                if (typeof onSelect === 'function') {
                    onSelect();
                }
            }
        }
    });

    actionMenu.show();
}

function showFavoriteEntitySelectionMenu(onSelect) {
    var appState = AppState.getInstance();

    var favoriteMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Select Favorite'
        }]
    });

    function updateMenuItems() {
        favoriteMenu.items(0, []);
        var favorites = appState.favoriteEntityStore.allWithNames();
        var itemIndex = 0;

        for (var i = 0; i < favorites.length; i++) {
            var fav = favorites[i];
            var displayName = fav.name || fav.entity_id;
            var isCurrent = appState.quick_launch_favorite_entity === fav.entity_id;

            favoriteMenu.item(0, itemIndex++, {
                title: displayName,
                subtitle: isCurrent ? "Current" : "",
                entity_id: fav.entity_id
            });
        }
    }

    favoriteMenu.on('show', updateMenuItems);

    favoriteMenu.on('select', function(e) {
        if (e.item.entity_id) {
            favoriteMenu.hide();
            if (typeof onSelect === 'function') {
                onSelect(e.item.entity_id);
            }
        }
    });

    favoriteMenu.show();
}

function showVoicePipelineMenu() {
    var appState = AppState.getInstance();

    var voicePipelineMenu = new UI.Menu({
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
        voicePipelineMenu.items(0, []);

        if (!appState.ha_pipelines) {
            voicePipelineMenu.item(0, 0, {
                title: "No pipelines",
                subtitle: "Loading..."
            });
            return;
        }

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

            voicePipelineMenu.item(0, i, {
                title: pipeline.name,
                subtitle: subtitle,
                pipeline_id: pipeline.id
            });
        }
    });

    voicePipelineMenu.on('select', function(e) {
        appState.selected_pipeline = e.item.pipeline_id;
        Settings.option('selected_pipeline', appState.selected_pipeline);

        // Update menu items
        for (var i = 0; i < voicePipelineMenu.items(0).length; i++) {
            var item = voicePipelineMenu.item(0, i);
            var subtitle = '';

            if (appState.selected_pipeline === item.pipeline_id && appState.preferred_pipeline === item.pipeline_id) {
                subtitle = 'Current - Preferred';
            } else if (appState.selected_pipeline === item.pipeline_id) {
                subtitle = 'Current';
            } else if (appState.preferred_pipeline === item.pipeline_id) {
                subtitle = 'Preferred';
            }

            voicePipelineMenu.item(0, i, {
                title: item.title,
                subtitle: subtitle,
                pipeline_id: item.pipeline_id
            });
        }

        setTimeout(function() {
            voicePipelineMenu.hide();
        }, 500);
    });

    voicePipelineMenu.show();
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
