const Settings = require('settings');

// The entities other apps may read and control through this app's plugin
// (plugin/js). Kept in the settings options, which the plugin reads from the
// localStorage it shares with this JS; only this side ever writes it. Weather
// entities are shared without being listed here.

class PluginExposedStore {
    constructor() {
        this.exposedEntities = [];
        this.load();
    }

    load() {
        let stored = Settings.option('plugin_exposed_entities');
        if (!stored) {
            this.exposedEntities = [];
            return;
        }

        // Normalize: convert old string format to new object format
        this.exposedEntities = stored.map(entry => {
            if (typeof entry === 'string') {
                // Old format: just entity_id string
                return { entity_id: entry };
            }
            // New format: object with entity_id and optional name
            return entry;
        });
    }

    save() {
        Settings.option('plugin_exposed_entities', this.exposedEntities);
    }

    /**
     * Add a exposed entity
     * @param {string} id - The entity_id
     * @param {string} [name] - Optional friendly name
     */
    add(id, name) {
        if (!this.has(id)) {
            let entry = { entity_id: id };
            if (name) {
                entry.name = name;
            }
            this.exposedEntities.push(entry);
        }
        this.save();
    }

    /**
     * Remove a exposed entity by entity_id
     * @param {string} id - The entity_id to remove
     */
    remove(id) {
        let index = this._findIndex(id);
        if (index > -1) {
            this.exposedEntities.splice(index, 1);
        }
        this.save();
    }

    /**
     * Check if an entity_id is shared
     * @param {string} id - The entity_id to check
     * @returns {boolean}
     */
    has(id) {
        return this._findIndex(id) > -1;
    }

    /**
     * Get all exposed entity_ids (for backwards compatibility)
     * @returns {string[]} Array of entity_id strings
     */
    all() {
        return this.exposedEntities.map(entry => entry.entity_id);
    }

    /**
     * All shared entities with their names
     * @returns {Array<{entity_id: string, name?: string}>}
     */
    allWithNames() {
        return this.exposedEntities;
    }

    /**
     * Keep the stored names in step with Home Assistant
     * @param {Object} stateDict - Dictionary of entity states keyed by entity_id
     */
    updateFriendlyNames(stateDict) {
        let updated = false;
        for (let entry of this.exposedEntities) {
            let entity = stateDict[entry.entity_id];
            if (entity && entity.attributes && entity.attributes.friendly_name) {
                let newName = entity.attributes.friendly_name;
                if (entry.name !== newName) {
                    entry.name = newName;
                    updated = true;
                }
            }
        }
        if (updated) {
            this.save();
        }
    }

    /**
     * Where an entity_id is in the list
     * @private
     * @param {string} id - The entity_id to find
     * @returns {number} Index or -1 if not found
     */
    _findIndex(id) {
        for (let i = 0; i < this.exposedEntities.length; i++) {
            if (this.exposedEntities[i].entity_id === id) {
                return i;
            }
        }
        return -1;
    }
}

module.exports = PluginExposedStore;