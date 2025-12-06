const Settings = require('settings');

class FavoriteEntityStore {
    constructor() {
        this.favoriteEntities = [];
        this.load();
    }

    load() {
        let stored = Settings.option('favorite_entities');
        if (!stored) {
            this.favoriteEntities = [];
            return;
        }

        // Normalize: convert old string format to new object format
        this.favoriteEntities = stored.map(fav => {
            if (typeof fav === 'string') {
                // Old format: just entity_id string
                return { entity_id: fav };
            }
            // New format: object with entity_id and optional name
            return fav;
        });
    }

    save() {
        Settings.option('favorite_entities', this.favoriteEntities);
    }

    /**
     * Add a favorite entity
     * @param {string} id - The entity_id
     * @param {string} [name] - Optional friendly name
     */
    add(id, name) {
        if (!this.has(id)) {
            let entry = { entity_id: id };
            if (name) {
                entry.name = name;
            }
            this.favoriteEntities.push(entry);
        }
        this.save();
    }

    /**
     * Remove a favorite entity by entity_id
     * @param {string} id - The entity_id to remove
     */
    remove(id) {
        let index = this._findIndex(id);
        if (index > -1) {
            this.favoriteEntities.splice(index, 1);
        }
        this.save();
    }

    /**
     * Check if an entity_id is in favorites
     * @param {string} id - The entity_id to check
     * @returns {boolean}
     */
    has(id) {
        return this._findIndex(id) > -1;
    }

    /**
     * Get all favorite entity_ids (for backwards compatibility)
     * @returns {string[]} Array of entity_id strings
     */
    all() {
        return this.favoriteEntities.map(fav => fav.entity_id);
    }

    /**
     * Get all favorites with full data (entity_id and name)
     * @returns {Array<{entity_id: string, name?: string}>}
     */
    allWithNames() {
        return this.favoriteEntities;
    }

    /**
     * Update friendly names for favorites based on current entity states
     * @param {Object} stateDict - Dictionary of entity states keyed by entity_id
     */
    updateFriendlyNames(stateDict) {
        let updated = false;
        for (let fav of this.favoriteEntities) {
            let entity = stateDict[fav.entity_id];
            if (entity && entity.attributes && entity.attributes.friendly_name) {
                let newName = entity.attributes.friendly_name;
                if (fav.name !== newName) {
                    fav.name = newName;
                    updated = true;
                }
            }
        }
        if (updated) {
            this.save();
        }
    }

    /**
     * Find the index of a favorite by entity_id
     * @private
     * @param {string} id - The entity_id to find
     * @returns {number} Index or -1 if not found
     */
    _findIndex(id) {
        for (let i = 0; i < this.favoriteEntities.length; i++) {
            if (this.favoriteEntities[i].entity_id === id) {
                return i;
            }
        }
        return -1;
    }
}

module.exports = FavoriteEntityStore;