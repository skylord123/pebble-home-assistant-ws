/**
 * Stores alarm panel codes the user has chosen to remember, keyed by
 * entity_id. An entry with code === null means "never ask": the service
 * is called without a code (for panels whose code lives server-side via
 * Home Assistant's default code entity option).
 *
 * Deliberately NOT persisted through Settings.option: the whole options
 * object is serialized into the config page URL every time settings are
 * opened, which would hand the codes to the remote page and leave them
 * in browser history. A dedicated localStorage key keeps them on the
 * phone only.
 */
const STORAGE_KEY = 'alarm_codes';

class AlarmCodeStore {
    constructor() {
        this.entries = [];
        this.load();
    }

    load() {
        this.entries = [];
        try {
            let stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
            if (Array.isArray(stored)) {
                this.entries = stored;
            }
        } catch (e) {
            // Corrupt entry; start fresh
        }
    }

    save() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    }

    /**
     * Get the stored entry for an entity
     * @param {string} id - The entity_id
     * @returns {{entity_id: string, code: string|null}|undefined}
     */
    get(id) {
        let index = this._findIndex(id);
        return index > -1 ? this.entries[index] : undefined;
    }

    /**
     * Remember a code (or null for "never ask") for an entity
     * @param {string} id - The entity_id
     * @param {string|null} code
     */
    setCode(id, code) {
        let index = this._findIndex(id);
        if (index > -1) {
            this.entries[index].code = code;
        } else {
            this.entries.push({ entity_id: id, code: code });
        }
        this.save();
    }

    /**
     * Remove the stored entry for an entity
     * @param {string} id - The entity_id
     */
    remove(id) {
        let index = this._findIndex(id);
        if (index > -1) {
            this.entries.splice(index, 1);
        }
        this.save();
    }

    /**
     * Find the index of an entry by entity_id
     * @private
     * @param {string} id - The entity_id to find
     * @returns {number} Index or -1 if not found
     */
    _findIndex(id) {
        for (let i = 0; i < this.entries.length; i++) {
            if (this.entries[i].entity_id === id) {
                return i;
            }
        }
        return -1;
    }
}

module.exports = AlarmCodeStore;
