/**
 * BasePage - Abstract base class for all page types
 * Provides common patterns for menu creation, event handling, and subscriptions
 */
var UI = require('ui');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');

class BasePage {
    /**
     * @param {Object} options - Page options
     */
    constructor(options) {
        this.appState = AppState.getInstance();
        this.options = options || {};
        this.menu = null;
        this.subscriptionId = null;
        this.relativeTimeUpdater = null;
    }

    /**
     * Create the menu/window - must be implemented by subclass
     * @returns {UI.Menu|UI.Card|UI.Window}
     */
    createMenu() {
        throw new Error('createMenu must be implemented by subclass');
    }

    /**
     * Build menu items - override in subclass
     * Called after menu is created and before it's shown
     */
    buildMenuItems() {
        // Override in subclass
    }

    /**
     * Show the page
     */
    show() {
        var self = this;

        if (!this.menu) {
            this.menu = this.createMenu();
            this.setupEventHandlers();
        }

        this.menu.show();
    }

    /**
     * Hide the page
     */
    hide() {
        if (this.menu) {
            this.menu.hide();
        }
    }

    /**
     * Setup event handlers
     */
    setupEventHandlers() {
        var self = this;

        this.menu.on('show', function() {
            self.onShow();
        });

        this.menu.on('hide', function() {
            self.onHide();
        });

        if (typeof this.menu.on === 'function') {
            this.menu.on('select', function(e) {
                self.onSelect(e);
            });

            this.menu.on('longSelect', function(e) {
                self.onLongSelect(e);
            });
        }
    }

    /**
     * Called when menu is shown - override in subclass
     */
    onShow() {
        this.buildMenuItems();

        // Resume relative time updater if paused
        if (this.relativeTimeUpdater) {
            this.relativeTimeUpdater.resume();
        }
    }

    /**
     * Called when menu is hidden - override in subclass
     */
    onHide() {
        this.unsubscribe();

        if (this.relativeTimeUpdater) {
            this.relativeTimeUpdater.pause();
        }
    }

    /**
     * Called when item is selected - override in subclass
     * @param {Object} e - Event object with item, itemIndex, sectionIndex
     */
    onSelect(e) {
        if (e.item && typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    }

    /**
     * Called on long press - override in subclass
     * @param {Object} e - Event object
     */
    onLongSelect(e) {
        // Override in subclass
    }

    /**
     * Subscribe to HAWS entity updates
     * @param {Array} entityIds - Array of entity IDs to subscribe to
     * @param {Function} callback - Callback for updates
     */
    subscribe(entityIds, callback) {
        if (this.subscriptionId) {
            this.unsubscribe();
        }

        var self = this;
        this.subscriptionId = this.appState.haws.subscribeEntities(
            entityIds,
            callback,
            function(error) {
                helpers.log_message('Subscription error: ' + JSON.stringify(error));
            }
        );
    }

    /**
     * Subscribe to HAWS trigger events for a single entity
     * @param {string} entityId - Entity ID to subscribe to
     * @param {Function} callback - Callback for updates
     */
    subscribeTrigger(entityId, callback) {
        if (this.subscriptionId) {
            this.unsubscribe();
        }

        var self = this;
        this.subscriptionId = this.appState.haws.subscribeTrigger(
            {
                "type": "subscribe_trigger",
                "trigger": {
                    "platform": "state",
                    "entity_id": entityId
                }
            },
            callback,
            function(error) {
                helpers.log_message('Subscribe trigger error: ' + JSON.stringify(error));
            }
        );
    }

    /**
     * Unsubscribe from HAWS updates
     */
    unsubscribe() {
        if (this.subscriptionId && this.appState.haws) {
            this.appState.haws.unsubscribe(this.subscriptionId);
            this.subscriptionId = null;
        }
    }

    /**
     * Get default menu options
     * @returns {Object} Default menu configuration
     */
    getDefaultMenuOptions() {
        return {
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black'
        };
    }

    /**
     * Get default menu options with header styling
     * @param {string} title - Menu section title
     * @returns {Object} Menu configuration with styled header
     */
    getMenuWithHeader(title) {
        var options = this.getDefaultMenuOptions();
        options.sections = [{
            title: title,
            backgroundColor: Constants.colour.highlight,
            textColor: Constants.colour.highlight_text
        }];
        return options;
    }

    /**
     * Create a RelativeTimeUpdater for this page
     * @param {Function} updateCallback - Called when time display needs updating
     */
    createRelativeTimeUpdater(updateCallback) {
        var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

        if (this.relativeTimeUpdater) {
            this.relativeTimeUpdater.destroy();
        }

        this.relativeTimeUpdater = new RelativeTimeUpdater(updateCallback);
        return this.relativeTimeUpdater;
    }

    /**
     * Clean up resources
     */
    destroy() {
        this.unsubscribe();

        if (this.relativeTimeUpdater) {
            this.relativeTimeUpdater.destroy();
            this.relativeTimeUpdater = null;
        }

        if (this.menu) {
            this.menu = null;
        }
    }
}

module.exports = BasePage;
