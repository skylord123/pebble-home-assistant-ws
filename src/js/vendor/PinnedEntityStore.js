const Settings = require('settings');

/**
 * Store for managing entities pinned to the Main Menu
 * Similar to FavoriteEntityStore but for pinned entities
 */
class PinnedEntityStore {
    constructor() {
        this.pinnedEntities = [];
        this.load();
    }

    load() {
        let stored = Settings.option('pinned_entities');
        if (!stored) {
            this.pinnedEntities = [];
            return;
        }

        // Normalize: convert old string format to new object format
        this.pinnedEntities = stored.map(pinned => {
            if (typeof pinned === 'string') {
                // Old format: just entity_id string
                return { entity_id: pinned };
            }
            // New format: object with entity_id and optional name
            return pinned;
        });
    }

    save() {
        Settings.option('pinned_entities', this.pinnedEntities);
    }

    /**
     * Add a pinned entity
     * @param {string} id - The entity_id
     * @param {string} [name] - Optional friendly name
     */
    add(id, name) {
        if (!this.has(id)) {
            let entry = { entity_id: id };
            if (name) {
                entry.name = name;
            }
            this.pinnedEntities.push(entry);
        }
        this.save();
    }

    /**
     * Remove a pinned entity by entity_id
     * @param {string} id - The entity_id to remove
     */
    remove(id) {
        let index = this._findIndex(id);
        if (index > -1) {
            this.pinnedEntities.splice(index, 1);
        }
        this.save();
    }

    /**
     * Check if an entity_id is pinned
     * @param {string} id - The entity_id to check
     * @returns {boolean}
     */
    has(id) {
        return this._findIndex(id) > -1;
    }

    /**
     * Get all pinned entity_ids
     * @returns {string[]} Array of entity_id strings
     */
    all() {
        return this.pinnedEntities.map(pinned => pinned.entity_id);
    }

    /**
     * Get all pinned entities with full data (entity_id and name)
     * @returns {Array<{entity_id: string, name?: string}>}
     */
    allWithNames() {
        return this.pinnedEntities;
    }

    /**
     * Update friendly names for pinned entities based on current entity states
     * @param {Object} stateDict - Dictionary of entity states keyed by entity_id
     */
    updateFriendlyNames(stateDict) {
        let updated = false;
        for (let pinned of this.pinnedEntities) {
            let entity = stateDict[pinned.entity_id];
            if (entity && entity.attributes && entity.attributes.friendly_name) {
                let newName = entity.attributes.friendly_name;
                if (pinned.name !== newName) {
                    pinned.name = newName;
                    updated = true;
                }
            }
        }
        if (updated) {
            this.save();
        }
    }

    /**
     * Find the index of a pinned entity by entity_id
     * @private
     * @param {string} id - The entity_id to find
     * @returns {number} Index or -1 if not found
     */
    _findIndex(id) {
        for (let i = 0; i < this.pinnedEntities.length; i++) {
            if (this.pinnedEntities[i].entity_id === id) {
                return i;
            }
        }
        return -1;
    }
}

module.exports = PinnedEntityStore;

