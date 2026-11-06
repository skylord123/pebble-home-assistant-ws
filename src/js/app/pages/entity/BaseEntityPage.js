/**
 * BaseEntityPage - Base class for entity detail pages
 * Extends BasePage with entity-specific functionality
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var BasePage = require('app/pages/BasePage');
var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');

class BaseEntityPage extends BasePage {
    /**
     * @param {string} entityId - The entity ID to display
     * @param {Object} options - Page options
     */
    constructor(entityId, options) {
        super(options);
        this.entityId = entityId;
        this.entity = null;
        this.domain = entityId ? entityId.split('.')[0] : null;
    }

    /**
     * Get the current entity from state
     * @returns {Object|null} The entity object
     */
    getEntity() {
        return this.appState.getEntity(this.entityId);
    }

    /**
     * Refresh entity from state
     */
    refreshEntity() {
        this.entity = this.getEntity();
    }

    /**
     * Get entity display title
     * @returns {string}
     */
    getTitle() {
        var entity = this.getEntity();
        return EntityService.getTitle(entity);
    }

    /**
     * Get entity display subtitle
     * @param {boolean} includeRelativeTime
     * @returns {string}
     */
    getSubtitle(includeRelativeTime) {
        var entity = this.getEntity();
        return EntityService.getSubtitle(entity, includeRelativeTime);
    }

    /**
     * Call a Home Assistant service on this entity
     * @param {string} service - Service name (e.g., 'turn_on', 'toggle')
     * @param {Object} data - Additional service data
     * @param {Function} successCallback - Called on success
     * @param {Function} errorCallback - Called on error
     */
    callService(service, data, successCallback, errorCallback) {
        var self = this;
        var serviceData = data || {};
        serviceData.entity_id = this.entityId;

        this.appState.haws.callService(
            this.domain,
            service,
            {},
            serviceData,
            function(result) {
                Vibe.vibrate('short');
                if (typeof successCallback === 'function') {
                    successCallback(result);
                }
            },
            function(error) {
                Vibe.vibrate('double');
                helpers.log_message('Service call failed: ' + JSON.stringify(error));
                if (typeof errorCallback === 'function') {
                    errorCallback(error);
                }
            }
        );
    }

    /**
     * Toggle the entity (for domains that support it)
     */
    toggle() {
        this.callService('toggle', {});
    }

    /**
     * Turn on the entity
     * @param {Object} data - Additional service data
     */
    turnOn(data) {
        this.callService('turn_on', data);
    }

    /**
     * Turn off the entity
     */
    turnOff() {
        this.callService('turn_off', {});
    }

    /**
     * Subscribe to entity state updates
     * @param {Function} updateCallback - Called when entity state changes
     */
    subscribeToEntity(updateCallback) {
        var self = this;

        this.subscribe([this.entityId], function(data) {
            var updated = EntityService.applyCompressedEvent(self.entityId, data, self.entity);
            if (updated) {
                self.entity = updated;

                if (typeof updateCallback === 'function') {
                    updateCallback(updated);
                }
            }
        });
    }

    /**
     * Handle favorite toggle button
     * @param {number} sectionIndex - Menu section index for the button
     * @param {number} itemIndex - Menu item index for the button
     */
    setupFavoriteButton(sectionIndex, itemIndex) {
        var self = this;

        function render() {
            var isFavorite = self.appState.favoriteEntityStore.has(self.entityId);
            self.menu.item(sectionIndex, itemIndex, {
                title: (isFavorite ? 'Remove from' : 'Add to') + ' Favorites',
                on_click: function(e) {
                    // Read on press: built from the startup cache the entity can
                    // still be missing, and toggleFavorite drops a falsy one on
                    // the floor, so the button would do nothing with no sign why
                    EntityService.toggleFavorite(self.getEntity());
                    render();
                }
            });
        }

        render();
    }

    /**
     * Handle pinned toggle button
     * @param {number} sectionIndex - Menu section index for the button
     * @param {number} itemIndex - Menu item index for the button
     */
    setupPinnedButton(sectionIndex, itemIndex) {
        var self = this;

        function render() {
            var isPinned = self.appState.pinnedEntityStore.has(self.entityId);
            self.menu.item(sectionIndex, itemIndex, {
                title: (isPinned ? 'Unpin from' : 'Pin to') + ' Main Menu',
                on_click: function(e) {
                    EntityService.togglePinned(self.getEntity());
                    render();
                }
            });
        }

        render();
    }

    /**
     * Share with other apps through the plugin. Weather is always shared, so
     * it only says so.
     * @param {number} sectionIndex - Menu section index for the button
     * @param {number} itemIndex - Menu item index for the button
     */
    setupPluginButton(sectionIndex, itemIndex) {
        var self = this;

        function render() {
            if (EntityService.isAlwaysPluginExposed(self.entityId)) {
                self.menu.item(sectionIndex, itemIndex, {
                    title: 'Plugin Exposed',
                    subtitle: 'Weather is always'
                });
                return;
            }
            var exposed = EntityService.isPluginExposed(self.entityId);
            self.menu.item(sectionIndex, itemIndex, {
                title: exposed ? 'Hide from Plugins' : 'Expose to Plugins',
                subtitle: exposed ? 'Shared with other apps' : '',
                on_click: function(e) {
                    EntityService.togglePluginExposed(self.getEntity());
                    render();
                }
            });
        }

        render();
    }

    /**
     * Add common entity menu items (attributes, favorite, pinned, plugin)
     * @param {number} sectionIndex - Menu section index
     * @param {number} startIndex - Starting item index
     * @returns {number} Next available item index
     */
    addCommonMenuItems(sectionIndex, startIndex) {
        var self = this;
        var index = startIndex;

        // Attributes button
        this.menu.item(sectionIndex, index++, {
            title: 'Attributes',
            on_click: function(e) {
                // Import inline to avoid circular dependency
                var GenericEntityPage = require('app/pages/entity/GenericEntityPage');
                GenericEntityPage.showEntityAttributesMenu(self.entityId);
            }
        });

        // Favorite button
        this.setupFavoriteButton(sectionIndex, index++);

        // Pinned button
        this.setupPinnedButton(sectionIndex, index++);

        // Shared with other apps through the plugin
        this.setupPluginButton(sectionIndex, index++);

        return index;
    }
}

module.exports = BaseEntityPage;
