/**
 * RegistryService - Handles area, floor, device, entity, and label registry operations
 */
var AppState = require('app/AppState');
var helpers = require('app/helpers');

var RegistryService = {
    /**
     * Get list of entities that belong to a specific area
     * @param {string|null} area_id - The area ID, or null to get entities without an area
     * @returns {Object|boolean} Object mapping entity_id to entity, or false if registries not loaded
     */
    getEntitiesForArea: function(area_id) {
        var appState = AppState.getInstance();

        if (!appState.area_registry_cache ||
            !appState.device_registry_cache ||
            !appState.entity_registry_cache) {
            return false;
        }

        if (!area_id) {
            return this.getEntitiesWithoutArea();
        }

        var areaDevices = new Set();
        // Find all devices linked to this area
        for (var device_id in appState.device_registry_cache) {
            if (appState.device_registry_cache[device_id].area_id === area_id) {
                areaDevices.add(device_id);
            }
        }

        var results = {};
        // Find all entities directly linked to this area
        // or linked to a device linked to this area
        for (var entity_id in appState.entity_registry_cache) {
            var entity = appState.entity_registry_cache[entity_id];
            if (
                entity.area_id
                    ? entity.area_id === (area_id ? area_id : null)
                    : areaDevices.has(entity.device_id)
            ) {
                results[entity_id] = entity;
            }
        }

        return results;
    },

    /**
     * Get list of entities that don't have an area assigned
     * @returns {Object|boolean} Object mapping entity_id to entity, or false if registries not loaded
     */
    getEntitiesWithoutArea: function() {
        var appState = AppState.getInstance();

        if (!appState.area_registry_cache ||
            !appState.device_registry_cache ||
            !appState.entity_registry_cache) {
            return false;
        }

        var noAreaDevices = new Set();
        // Find all devices without an area
        for (var device_id in appState.device_registry_cache) {
            if (!appState.device_registry_cache[device_id].area_id) {
                noAreaDevices.add(device_id);
            }
        }

        var results = {};
        // Find all entities directly without an area
        // or linked to a device without an area
        for (var entity_id in appState.entity_registry_cache) {
            var entity = appState.entity_registry_cache[entity_id];
            if (!entity.area_id || noAreaDevices.has(entity.device_id)) {
                results[entity_id] = entity;
            }
        }

        return results;
    },

    /**
     * Get list of areas that belong to a specific floor
     * @param {string|null} floor_id - The floor ID, or null for unassigned areas
     * @returns {Object} Object mapping area_id to area object
     */
    getAreasForFloor: function(floor_id) {
        var appState = AppState.getInstance();

        if (!appState.area_registry_cache) {
            return {};
        }

        var results = {};
        for (var area_id in appState.area_registry_cache) {
            var area = appState.area_registry_cache[area_id];
            // Match areas with the specified floor_id (null matches unassigned areas)
            if (area.floor_id === floor_id) {
                results[area_id] = area;
            }
        }
        return results;
    },

    /**
     * Get list of entities that have a specific label
     * @param {string} label_id - The label ID
     * @returns {Object} Object mapping entity_id to entity object
     */
    getEntitiesForLabel: function(label_id) {
        var appState = AppState.getInstance();

        if (!appState.entity_registry_cache) {
            return {};
        }

        var results = {};
        for (var entity_id in appState.entity_registry_cache) {
            var entity = appState.entity_registry_cache[entity_id];
            if (entity.labels && entity.labels.indexOf(label_id) !== -1) {
                results[entity_id] = entity;
            }
        }
        return results;
    },

    /**
     * Get all areas sorted by name or custom order
     * @returns {Array} Array of area objects
     */
    getAllAreas: function() {
        var appState = AppState.getInstance();

        if (!appState.area_registry_cache) {
            return [];
        }

        var areas = [];
        for (var area_id in appState.area_registry_cache) {
            areas.push(appState.area_registry_cache[area_id]);
        }

        // Sort by sortOrder if available, otherwise by name
        areas.sort(function(a, b) {
            if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
                return a.sortOrder - b.sortOrder;
            }
            var nameA = (a.name || a.area_id || '').toLowerCase();
            var nameB = (b.name || b.area_id || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });

        return areas;
    },

    /**
     * Get all floors sorted by level or name
     * @returns {Array} Array of floor objects
     */
    getAllFloors: function() {
        var appState = AppState.getInstance();

        if (!appState.floor_registry_cache) {
            return [];
        }

        var floors = [];
        for (var floor_id in appState.floor_registry_cache) {
            floors.push(appState.floor_registry_cache[floor_id]);
        }

        // Sort by level if available, otherwise by name
        floors.sort(function(a, b) {
            if (a.level !== undefined && b.level !== undefined) {
                return a.level - b.level;
            }
            if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
                return a.sortOrder - b.sortOrder;
            }
            var nameA = (a.name || a.floor_id || '').toLowerCase();
            var nameB = (b.name || b.floor_id || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });

        return floors;
    },

    /**
     * Get all labels sorted by name
     * @returns {Array} Array of label objects
     */
    getAllLabels: function() {
        var appState = AppState.getInstance();

        if (!appState.label_registry_cache) {
            return [];
        }

        var labels = [];
        for (var label_id in appState.label_registry_cache) {
            labels.push(appState.label_registry_cache[label_id]);
        }

        // Sort by name
        labels.sort(function(a, b) {
            var nameA = (a.name || a.label_id || '').toLowerCase();
            var nameB = (b.name || b.label_id || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });

        return labels;
    },

    /**
     * Check if floors feature is available (HA 2025.12+)
     * @returns {boolean} True if floors are available
     */
    hasFloors: function() {
        var appState = AppState.getInstance();
        return appState.floor_registry_cache && Object.keys(appState.floor_registry_cache).length > 0;
    },

    /**
     * Check if any areas are assigned to floors
     * @returns {boolean} True if any areas have floor assignments
     */
    hasAreasWithFloors: function() {
        var appState = AppState.getInstance();

        if (!appState.area_registry_cache) {
            return false;
        }

        for (var area_id in appState.area_registry_cache) {
            if (appState.area_registry_cache[area_id].floor_id) {
                return true;
            }
        }
        return false;
    }
};

module.exports = RegistryService;
