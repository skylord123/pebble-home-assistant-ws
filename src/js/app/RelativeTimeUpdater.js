/**
 * RelativeTimeUpdater - Manages timers for updating relative time displays.
 * This class handles scheduling updates based on when humanDiff output will change.
 *
 * Usage:
 *   var updater = new RelativeTimeUpdater(function(id, lastChanged) {
 *       // Update the display for the item with this id
 *   });
 *
 *   // Register items to track
 *   updater.register('entity_id_1', entity.last_changed);
 *
 *   // Update when an item's timestamp changes
 *   updater.update('entity_id_1', newLastChanged);
 *
 *   // Remove an item
 *   updater.unregister('entity_id_1');
 *
 *   // Pause all timers (e.g., when menu is hidden)
 *   updater.pause();
 *
 *   // Resume all timers (e.g., when menu is shown)
 *   updater.resume();
 *
 *   // Clean up all timers
 *   updater.destroy();
 */

var helpers = require('app/helpers');

class RelativeTimeUpdater {
    /**
     * @param {function} updateCallback - Called when an item needs updating: function(id, lastChanged)
     * @param {object} options - Optional configuration
     * @param {number} options.minInterval - Minimum interval between updates in ms (default: 500)
     * @param {number} options.maxInterval - Maximum interval for updates in ms (default: 24 hours)
     */
    constructor(updateCallback, options) {
        options = options || {};
        this.updateCallback = updateCallback;
        this.timers = new Map(); // Map of id -> { timerId, lastChanged }
        this.paused = false;
        this.minInterval = options.minInterval || 500;
        this.maxInterval = options.maxInterval || 24 * 60 * 60 * 1000; // 24 hours
    }

    /**
     * Register an item to track for relative time updates
     * @param {string} id - Unique identifier for the item
     * @param {Date|string|number} lastChanged - The timestamp to track
     */
    register(id, lastChanged) {
        // Clear any existing timer for this id
        this._clearTimer(id);

        // Store the lastChanged and schedule the update
        this.timers.set(id, {
            timerId: null,
            lastChanged: lastChanged
        });

        if (!this.paused) {
            this._scheduleUpdate(id);
        }
    }

    /**
     * Update an item's timestamp (e.g., when entity state changes)
     * @param {string} id - Unique identifier for the item
     * @param {Date|string|number} lastChanged - The new timestamp
     */
    update(id, lastChanged) {
        var entry = this.timers.get(id);
        if (entry) {
            this._clearTimer(id);
            entry.lastChanged = lastChanged;
            if (!this.paused) {
                this._scheduleUpdate(id);
            }
        } else {
            // If not registered, register it
            this.register(id, lastChanged);
        }
    }

    /**
     * Unregister an item and clear its timer
     * @param {string} id - Unique identifier for the item
     */
    unregister(id) {
        this._clearTimer(id);
        this.timers.delete(id);
    }

    /**
     * Pause all timers (e.g., when menu is hidden)
     */
    pause() {
        this.paused = true;
        // Clear all active timers
        var self = this;
        this.timers.forEach(function(value, id) {
            self._clearTimer(id);
        });
    }

    /**
     * Resume all timers (e.g., when menu is shown)
     */
    resume() {
        this.paused = false;
        // Reschedule all timers
        var self = this;
        this.timers.forEach(function(value, id) {
            self._scheduleUpdate(id);
        });
    }

    /**
     * Clear all items and timers
     */
    clear() {
        var self = this;
        this.timers.forEach(function(value, id) {
            self._clearTimer(id);
        });
        this.timers.clear();
    }

    /**
     * Destroy the updater and clean up all resources
     */
    destroy() {
        this.clear();
        this.updateCallback = null;
    }

    /**
     * Get the number of registered items
     * @returns {number}
     */
    size() {
        return this.timers.size;
    }

    /**
     * Clear a specific timer
     * @private
     */
    _clearTimer(id) {
        var entry = this.timers.get(id);
        if (entry && entry.timerId !== null) {
            clearTimeout(entry.timerId);
            entry.timerId = null;
        }
    }

    /**
     * Schedule the next update for an item
     * @private
     */
    _scheduleUpdate(id) {
        var entry = this.timers.get(id);
        if (!entry || this.paused) {
            return;
        }

        // Calculate when the next update should occur
        var intervalMs = helpers.getNextHumanDiffChangeMs(entry.lastChanged);

        // Clamp to min/max intervals
        intervalMs = Math.max(this.minInterval, Math.min(intervalMs, this.maxInterval));

        // Add a small buffer (50ms) to ensure we're past the threshold
        intervalMs += 50;

        var self = this;
        entry.timerId = setTimeout(function() {
            if (self.paused || !self.timers.has(id)) {
                return;
            }

            // Call the update callback
            if (self.updateCallback) {
                self.updateCallback(id, entry.lastChanged);
            }

            // Schedule the next update
            self._scheduleUpdate(id);
        }, intervalMs);
    }
}

module.exports = RelativeTimeUpdater;
