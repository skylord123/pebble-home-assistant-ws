/**
 * LockPage - lock entity control page
 *
 * Features:
 * - Lock, Unlock and Open (LockEntityFeature.OPEN), offered the way the HA
 *   frontend does: each hidden while the lock is already there or busy
 *   getting somewhere, unless its state is only assumed
 * - Code entry through CodeEntry whenever code_format is set and HA holds
 *   no default code, with remembered and "never ask" codes (AlarmCodeStore)
 * - Open, and unlocking from a long press, behind a confirmation card
 * - Real-time state subscription
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var Settings = require('settings');

var AppState = require('app/AppState');
var CodeEntry = require('app/CodeEntry');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// LockEntityFeature bitfield values from Home Assistant
var LockEntityFeature = {
    OPEN: 1
};

var STATE_LABELS = {
    locked: 'Locked',
    unlocked: 'Unlocked',
    locking: 'Locking...',
    unlocking: 'Unlocking...',
    opening: 'Opening...',
    open: 'Open',
    jammed: 'Jammed'
};

var SERVICE_LABELS = {
    lock: 'Lock',
    unlock: 'Unlock',
    open: 'Open'
};

function stateLabel(state) {
    return STATE_LABELS[state] || state;
}

function isWaiting(state) {
    return state === 'locking' || state === 'unlocking' || state === 'opening';
}

// Lock code_format is a regex. The usual digit-only ones (^\d{4}$,
// ^\d{4,6}$, [0-9]*) get the PIN pad; anything else is taken as text.
function isNumericFormat(format) {
    return /^\^?(\\d|\[0-9\])(\{\d+(,\d*)?\}|[*+])?\$?$/.test(format);
}

/**
 * Call a lock service, prompting for a code when the lock has a
 * code_format (Home Assistant rejects a missing or non-matching code
 * unless a default code is set on the entity)
 */
function performAction(entity_id, service) {
    var entity = AppState.getInstance().getEntity(entity_id);
    if (!entity) {
        helpers.log_message('performAction: entity ' + entity_id + ' not found in state dict');
        return;
    }
    var format = entity.attributes.code_format;
    CodeEntry.run({
        entity_id: entity_id,
        domain: 'lock',
        service: service,
        title: SERVICE_LABELS[service] || service,
        needsCode: !!format,
        textCode: !!format && !isNumericFormat(format)
    });
}

function confirmAction(entity_id, service, title, body) {
    var card = new UI.Card({
        title: title,
        body: body
    });
    card.on('click', 'select', function() {
        card.hide();
        performAction(entity_id, service);
    });
    card.show();
}

/**
 * Long-press quick action: lock straight away, but unlocking asks first,
 * since a stray long press in a list should never open a door
 */
function quickAction(entity_id) {
    var entity = AppState.getInstance().getEntity(entity_id);
    if (!entity) {
        helpers.log_message('quickAction: entity ' + entity_id + ' not found in state dict');
        return;
    }
    var state = entity.state;
    if (state === 'unavailable' || isWaiting(state)) {
        helpers.log_message('Lock ' + entity_id + ' in state ' + state + ' - no action taken');
        return;
    }
    if (state === 'locked') {
        confirmAction(entity_id, 'unlock', 'Unlock?',
            (entity.attributes.friendly_name || entity_id) + '\n\nPress SELECT to unlock.');
        return;
    }
    performAction(entity_id, 'lock');
}

function showLockEntity(entity_id) {
    var appState = AppState.getInstance();
    let lock = appState.getEntity(entity_id),
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!lock) {
        throw new Error(`Lock entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing lock entity ${entity_id}`);

    let lockMenu = new UI.Menu({
        status: false,
        sections: [{
            title: lock.attributes.friendly_name || entity_id
        }]
    });

    // Small menu for managing the stored code for this lock
    function showCodeOptionsMenu() {
        let store = appState.alarmCodeStore;
        let codeMenu = new UI.Menu({
            status: false,
            sections: [{
                title: 'Lock Code'
            }]
        });

        function buildCodeMenuItems() {
            let saved = store ? store.get(entity_id) : undefined;
            let neverAsk = !!(saved && saved.code === null);
            let hasCode = !!(saved && saved.code !== null);
            let items = [];

            if (hasCode) {
                items.push({
                    title: 'Forget Code',
                    subtitle: 'Ask again next time',
                    on_click: function() {
                        store.remove(entity_id);
                        Vibe.vibrate('short');
                        buildCodeMenuItems();
                    }
                });
            }

            items.push({
                title: 'Never Ask',
                subtitle: neverAsk ? 'On - no code is sent' : 'Off',
                on_click: function() {
                    if (neverAsk) {
                        store.remove(entity_id);
                    } else {
                        store.setCode(entity_id, null);
                    }
                    Vibe.vibrate('short');
                    buildCodeMenuItems();
                }
            });

            // Global setting, shared with alarm panels
            items.push({
                title: 'Remember Codes',
                subtitle: appState.alarm_code_remember !== false ? 'On' : 'Off',
                on_click: function() {
                    appState.alarm_code_remember = appState.alarm_code_remember === false;
                    Settings.option('alarm_code_remember', appState.alarm_code_remember);
                    Vibe.vibrate('short');
                    buildCodeMenuItems();
                }
            });

            codeMenu.items(0, items);
        }

        codeMenu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });

        codeMenu.on('show', function() {
            buildCodeMenuItems();
        });

        codeMenu.show();
    }

    let renderedState = null;

    function buildStatusItem(updatedLock) {
        let subtitle = stateLabel(updatedLock.state);
        if (updatedLock.attributes.changed_by) {
            subtitle += ' by ' + updatedLock.attributes.changed_by;
        }
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedLock.last_changed));
        return {
            title: updatedLock.attributes.friendly_name || entity_id,
            subtitle: `${subtitle} > ${timeStr}`,
            icon: EntityService.getIcon(updatedLock)
        };
    }

    function updateLockMenuItems(updatedLock) {
        let state = updatedLock.state;
        let supported = updatedLock.attributes.supported_features || 0;
        let assumed = updatedLock.attributes.assumed_state === true;
        let available = state !== 'unavailable';
        let menuItems = [buildStatusItem(updatedLock)];

        if (available && (assumed || (state !== 'locked' && !isWaiting(state)))) {
            menuItems.push({
                title: 'Lock',
                on_click: function() { performAction(entity_id, 'lock'); }
            });
        }
        if (available && (assumed || (state !== 'unlocked' && !isWaiting(state)))) {
            menuItems.push({
                title: 'Unlock',
                on_click: function() { performAction(entity_id, 'unlock'); }
            });
        }
        if (available && (supported & LockEntityFeature.OPEN) &&
            (assumed || (state !== 'open' && !isWaiting(state)))) {
            menuItems.push({
                title: 'Open',
                subtitle: 'Unlatch the door',
                on_click: function() {
                    confirmAction(entity_id, 'open', 'Open Door?', 'Press SELECT to open.');
                }
            });
        }

        if (updatedLock.attributes.code_format && !CodeEntry.hasDefaultCode(entity_id, 'lock')) {
            let saved = appState.alarmCodeStore ? appState.alarmCodeStore.get(entity_id) : undefined;
            menuItems.push({
                title: 'Code',
                subtitle: saved
                    ? (saved.code === null ? 'Never ask' : 'Remembered')
                    : 'Ask when needed',
                on_click: showCodeOptionsMenu
            });
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

        lockMenu.items(0, menuItems);

        // The action rows change with the state, so a highlight held over
        // from before would sit on a different action
        if (renderedState !== null && renderedState !== state) {
            selectedIndex = 0;
            lockMenu.selection(0, 0);
        }
        renderedState = state;
    }

    let selectedIndex = 0;

    lockMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Lock menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    // Releases the subscription and the timer; 'show' runs it first too, as a
    // second 'show' can arrive without a 'hide' in between
    function releaseUpdates() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
            subscription_msg_id = null;
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    }

    lockMenu.on('show', function() {
        releaseUpdates();
        lock = appState.getEntity(entity_id) || lock;
        updateLockMenuItems(lock);

        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.getEntity(entity_id);
            if (current) {
                lockMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, lock.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedLock = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedLock) {
                helpers.log_message(`Lock entity update for ${entity_id}: ${updatedLock.state}`);
                updateLockMenuItems(updatedLock);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedLock.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < lockMenu.items(0).length) {
                lockMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    lockMenu.on('hide', releaseUpdates);

    lockMenu.show();
}

module.exports.showLockEntity = showLockEntity;
module.exports.performAction = performAction;
module.exports.quickAction = quickAction;
