/**
 * LawnMowerPage - lawn_mower entity control page
 *
 * Close to the vacuum handling but not the same domain: a mower has only
 * three services, each gated on its own feature bit, and no toggle. Its
 * state is the activity it is performing, one of mowing, paused, docked,
 * returning or error.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// LawnMowerEntityFeature bitfield values from Home Assistant
var LawnMowerEntityFeature = {
    START_MOWING: 1,
    PAUSE: 2,
    DOCK: 4
};

// LawnMowerActivity values
var ACTIVITY = {
    MOWING: 'mowing',
    PAUSED: 'paused',
    DOCKED: 'docked',
    RETURNING: 'returning',
    ERROR: 'error'
};

function getMowerData(entity) {
    var attrs = entity.attributes || {};
    var features = attrs.supported_features || 0;
    // Not part of the lawn mower entity, and no core integration sets it;
    // shown only for custom integrations that happen to report one
    var battery = (typeof attrs.battery_level === 'number') ? Math.round(attrs.battery_level) : null;
    return {
        friendly_name: attrs.friendly_name || entity.entity_id,
        activity: entity.state,
        unavailable: entity.state === 'unavailable',
        // A mower's activity is optional in Home Assistant, so unknown is a
        // normal state rather than a fault: it is what an integration
        // reports before its first poll, or for an explicit none. The
        // services still work, so the controls have to stay
        unknown: entity.state === 'unknown',
        battery: battery,
        can_start: !!(features & LawnMowerEntityFeature.START_MOWING),
        can_pause: !!(features & LawnMowerEntityFeature.PAUSE),
        can_dock: !!(features & LawnMowerEntityFeature.DOCK)
    };
}

/**
 * What it is doing, plus battery where an integration reports one
 */
function statusText(entity) {
    var data = getMowerData(entity);
    if (data.unavailable || data.unknown) return entity.state;
    var text = helpers.ucwords(String(data.activity).replace(/_/g, ' '));
    if (data.battery !== null) {
        text += ' ' + data.battery + '%';
    }
    return text;
}

function callMowerService(entity_id, service) {
    var appState = AppState.getInstance();
    appState.haws.callService(
        'lawn_mower',
        service,
        {},
        { entity_id: entity_id },
        function(result) {
            Vibe.vibrate('short');
            helpers.log_message('lawn_mower.' + service + ' called for ' + entity_id);
        },
        function(error) {
            Vibe.vibrate('double');
            helpers.log_message('Error calling lawn_mower.' + service + ': ' + JSON.stringify(error));
        }
    );
}

/**
 * The one action that makes sense right now: stop a mower that is moving,
 * and set a stopped one going. Falls back to docking when the mower cannot
 * do the first choice, so there is always something useful on a long press.
 * @returns {string|null} the service to call, or null when nothing applies
 */
function quickActionService(data) {
    if (data.unavailable) return null;

    if (!data.unknown &&
        (data.activity === ACTIVITY.MOWING || data.activity === ACTIVITY.RETURNING)) {
        if (data.can_pause) return 'pause';
        if (data.can_dock && data.activity !== ACTIVITY.RETURNING) return 'dock';
        // Nothing here can stop it, so fall through rather than doing
        // nothing while the menu below plainly offers an action
    }

    // Docked, paused, in error, or a state we do not recognise: get it
    // going again, or failing that send it home
    if (data.can_start && data.activity !== ACTIVITY.MOWING) return 'start_mowing';
    if (data.can_dock &&
        data.activity !== ACTIVITY.DOCKED && data.activity !== ACTIVITY.RETURNING) return 'dock';
    return null;
}

function quickAction(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('quickAction: entity ' + entity_id + ' not found in state dict');
        return;
    }
    var service = quickActionService(getMowerData(entity));
    if (!service) {
        helpers.log_message('Lawn mower ' + entity_id + ' in state ' + entity.state + ' - no action taken');
        return;
    }
    callMowerService(entity_id, service);
}

function showLawnMowerEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Lawn mower entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing lawn mower entity ${entity_id}`, JSON.stringify(entity, null, 4));

    let mowerMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    function buildStatusItem(updatedEntity) {
        let data = getMowerData(updatedEntity);
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedEntity.last_changed));
        return {
            title: data.friendly_name,
            subtitle: `${statusText(updatedEntity)} > ${timeStr}`,
            icon: EntityService.getIcon(updatedEntity),
            on_click: function() {
                quickAction(entity_id);
            }
        };
    }

    let renderedState = null;

    function updateMowerMenuItems(updatedEntity) {
        let data = getMowerData(updatedEntity);
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!data.unavailable) {
            // Each row needs the feature bit, and is left out where it would
            // ask the mower to do what it is already doing. When the activity
            // is unknown there is nothing to reason from, so everything the
            // mower supports is offered.
            if (data.can_start && (data.unknown || data.activity !== ACTIVITY.MOWING)) {
                menuItems.push({
                    title: data.activity === ACTIVITY.PAUSED ? 'Resume Mowing' : 'Start Mowing',
                    on_click: function() { callMowerService(entity_id, 'start_mowing'); }
                });
            }
            if (data.can_pause && (data.unknown ||
                data.activity === ACTIVITY.MOWING || data.activity === ACTIVITY.RETURNING)) {
                menuItems.push({
                    title: 'Pause',
                    on_click: function() { callMowerService(entity_id, 'pause'); }
                });
            }
            // Returning is docking already under way, so it counts as
            // being there for the purpose of not repeating the command
            if (data.can_dock && (data.unknown ||
                (data.activity !== ACTIVITY.DOCKED && data.activity !== ACTIVITY.RETURNING))) {
                menuItems.push({
                    title: 'Dock',
                    subtitle: 'Send it home',
                    on_click: function() { callMowerService(entity_id, 'dock'); }
                });
            }
        }

        if (require('app/pages/HistoryPage').isSupported()) {
            menuItems.push({
                title: 'History',
                on_click: function() {
                    require('app/pages/HistoryPage').show(entity_id);
                }
            });
        }

        menuItems.push({
            title: 'More',
            on_click: function() {
                GenericEntityPage.showEntityMenu(entity_id);
            }
        });

        mowerMenu.items(0, menuItems);

        // The rows change with the activity, so a highlight held over from
        // the previous state would sit on a different action than intended
        if (renderedState !== null && renderedState !== data.activity) {
            selectedIndex = 0;
            mowerMenu.selection(0, 0);
        }
        renderedState = data.activity;
    }

    let selectedIndex = 0;

    mowerMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Lawn mower menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    mowerMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateMowerMenuItems(entity);

        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.ha_state_dict[entity_id];
            if (current) {
                mowerMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Lawn mower entity update for ${entity_id}: ${updatedEntity.state}`);
                updateMowerMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < mowerMenu.items(0).length) {
                mowerMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    mowerMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    mowerMenu.show();
}

module.exports.showLawnMowerEntity = showLawnMowerEntity;
module.exports.quickAction = quickAction;
module.exports.quickActionService = quickActionService;
module.exports.statusText = statusText;
module.exports.getMowerData = getMowerData;
