/**
 * AppState - Singleton for managing global application state
 * Centralizes all global variables that were scattered throughout app.js
 */
class AppState {
    constructor() {
        if (AppState._instance) {
            return AppState._instance;
        }
        AppState._instance = this;

        // Connection state
        this.haws = null;
        this.baseurl = null;
        this.baseheaders = null;
        this.ha_connected = false;

        // Settings (populated by SettingsManager.load())
        this.ha_url = null;
        this.ha_password = null;
        this.ha_refresh_interval = 15;
        this.ha_order_by = 'attributes.friendly_name';
        this.ha_order_dir = 'asc';
        // Reported by Home Assistant when the socket authenticates, and used
        // to decide which of its newer conversation features are there to use
        this.ha_version = null;
        this.voice_enabled = null;
        this.voice_confirm = null;
        this.voice_backlight_trigger = true;
        // Show the assistant's reply building up as it is written, rather
        // than waiting for the whole of it
        this.assist_stream_reply = true;
        this.voice_agent = null;
        // 'black', 'white' or 'sun'. Menus and the assistant conversation are
        // set separately, so the conversation can stay dark in a white app
        this.menu_background_mode = 'black';
        this.assist_background_mode = 'black';
        this.quick_launch_behavior = 'main_menu';
        this.quick_launch_favorite_entity = null;
        this.quick_launch_exit_on_back = false;
        this.inactivity_timeout = 0;
        this.calendar_order = null;
        this.hidden_calendars = [];
        this.domain_menu_enabled = 'conditional';
        this.domain_menu_all_entities = 'conditional';
        this.domain_menu_areas = 'conditional';
        this.domain_menu_labels = 'conditional';
        this.domain_menu_favorites = 'conditional';
        this.domain_menu_min_entities = 10;
        this.domain_menu_min_domains = 2;
        this.ignore_domains = [];
        this.unavailable_entity_handling = 'sort_to_end';
        this.unknown_entity_handling = 'sort_normally';
        this.automation_longpress_action = 'toggle';
        this.main_menu_custom_order_enabled = false;
        this.main_menu_order = null;
        this.timeline_token = null;

        // State caches
        this.ha_state_cache = null;
        this.ha_state_dict = null;
        this.ha_state_cache_updated = null;

        // Registry caches
        this.area_registry_cache = null;
        this.floor_registry_cache = null;
        this.device_registry_cache = null;
        this.entity_registry_cache = null;
        this.label_registry_cache = null;

        // Voice/Assist state
        this.ha_pipelines = [];
        this.preferred_pipeline = null;
        this.selected_pipeline = null;

        // Stores (will be initialized by app.js)
        this.favoriteEntityStore = null;
        this.pinnedEntityStore = null;
        this.alarmCodeStore = null;

        // UI state
        this.saved_windows = null;
        this.is_restarting = false;
        this.device_status = null;

        // Menu references
        this.mainMenu = null;
        this.areaMenu = null;
        this.areaMenuUsingFloors = null;
        this.entityListMenu = null;

        // Menu selection tracking
        this.menuSelections = {
            mainMenu: 0,
            entityListMenu: 0
        };

        // Main menu state for live updates
        this.mainMenuSubscriptionId = null;
        this.mainMenuPinnedEntityIndexes = {};
        this.mainMenuRelativeTimeUpdater = null;
        this.mainMenuEntityStates = {};
    }

    static getInstance() {
        if (!AppState._instance) {
            new AppState();
        }
        return AppState._instance;
    }

    /**
     * Get an entity from the state dictionary
     * @param {string} entity_id
     * @returns {Object|null}
     */
    getEntity(entity_id) {
        return this.ha_state_dict ? this.ha_state_dict[entity_id] : null;
    }

    /**
     * Set an entity in the state dictionary
     * @param {string} entity_id
     * @param {Object} entity
     */
    setEntity(entity_id, entity) {
        if (this.ha_state_dict) {
            this.ha_state_dict[entity_id] = entity;
        }
    }

    /**
     * Reset state for app restart
     */
    resetState() {
        this.ha_state_cache = null;
        this.ha_state_dict = null;
        this.ha_state_cache_updated = null;
        this.area_registry_cache = null;
        this.floor_registry_cache = null;
        this.device_registry_cache = null;
        this.entity_registry_cache = null;
        this.label_registry_cache = null;
        this.ha_pipelines = [];
        this.preferred_pipeline = null;
        this.selected_pipeline = null;
        this.ha_connected = false;
        this.saved_windows = null;
        this.mainMenu = null;
        this.areaMenu = null;
        this.areaMenuUsingFloors = null;
        this.mainMenuSubscriptionId = null;
        this.mainMenuPinnedEntityIndexes = {};
        this.mainMenuEntityStates = {};
    }
}

AppState._instance = null;

module.exports = AppState;
