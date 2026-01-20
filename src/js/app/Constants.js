/**
 * Constants - Application constants and configuration values
 */
const Feature = require('platform/feature');

const Constants = {
    // App versioning
    appVersion: '1.2',
    confVersion: '1.2',
    configPageUrl: 'https://skylord123.github.io/pebble-home-assistant-ws/config/v1.2.html',

    // Debug settings
    debugMode: true,
    debugHAWS: false,

    // Default domains to ignore
    DEFAULT_IGNORE_DOMAINS: [
        'assist_satellite',
        'conversation',
        'tts',
        'stt',
        'wake_word',
        'tag',
        'todo',
        'update',
        'zone'
    ],

    // Feature flags
    enableIcons: true,
    coalesce_messages_enabled: true,
    startup_cache_enabled: true,

    // Colors
    colour: {
        highlight: Feature.color("#00AAFF", "#000000"),
        highlight_text: Feature.color("black", "white")
    },

    // Cache keys for localStorage
    CACHE_KEYS: {
        STATES: 'ha_startup_cache_states',
        AREAS: 'ha_startup_cache_areas',
        FLOORS: 'ha_startup_cache_floors',
        DEVICES: 'ha_startup_cache_devices',
        ENTITIES: 'ha_startup_cache_entities',
        LABELS: 'ha_startup_cache_labels',
        PIPELINES: 'ha_startup_cache_pipelines',
        TIMESTAMP: 'ha_startup_cache_timestamp'
    },

    // Default main menu order
    DEFAULT_MAIN_MENU_ORDER: [
        'assistant',
        'favorites',
        'areas',
        'labels',
        'todo_lists',
        'people',
        'all_entities',
        'settings'
    ]
};

module.exports = Constants;
