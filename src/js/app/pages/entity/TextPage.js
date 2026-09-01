/**
 * TextPage - text / input_text entity page
 *
 * There is no keyboard on a Pebble, so the value is set by dictation on
 * the watches that have a microphone. Length limits are checked here
 * because they are unambiguous, while the entity's pattern is left to
 * Home Assistant: getting regular expression semantics subtly wrong on
 * this side would reject values the server would have accepted.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var Voice = require('ui/voice');
var Feature = require('platform/feature');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// Home Assistant's own ceiling on a state string
var MAX_STATE_LENGTH = 255;

function getTextData(entity) {
    var attrs = entity.attributes || {};
    return {
        friendly_name: attrs.friendly_name || entity.entity_id,
        value: typeof entity.state === 'string' ? entity.state : '',
        unavailable: entity.state === 'unavailable' || entity.state === 'unknown',
        min: attrs.min !== undefined && attrs.min !== null ? attrs.min : 0,
        max: attrs.max !== undefined && attrs.max !== null ? attrs.max : MAX_STATE_LENGTH,
        pattern: attrs.pattern || null,
        is_password: attrs.mode === 'password'
    };
}

/**
 * What to show for a value: password entities never render their contents,
 * and an empty value needs saying out loud rather than showing a blank
 */
function displayValue(entity) {
    var data = getTextData(entity);
    if (data.unavailable) return entity.state;
    if (!data.value.length) return '(empty)';
    if (data.is_password) return new Array(data.value.length + 1).join('*');
    return data.value;
}

function errorCard(title, body) {
    var card = new UI.Card({
        title: title,
        body: body,
        scrollable: true
    });
    card.show();
    return card;
}

function setValue(entity_id, value, onDone) {
    var appState = AppState.getInstance();
    var domain = entity_id.split('.')[0];
    appState.haws.callService(
        domain,
        'set_value',
        { value: value },
        { entity_id: entity_id },
        function(result) {
            Vibe.vibrate('short');
            helpers.log_message(domain + '.set_value called for ' + entity_id);
            if (onDone) { onDone(true); }
        },
        function(error) {
            Vibe.vibrate('double');
            helpers.log_message('Error calling ' + domain + '.set_value: ' + JSON.stringify(error));
            // Home Assistant explains exactly which rule was broken, which is
            // worth surfacing since the pattern is only checked server side
            var message = (error && error.error && error.error.message)
                ? error.error.message
                : 'Home Assistant rejected the value';
            errorCard('Not Set', message);
            if (onDone) { onDone(false); }
        }
    );
}

/**
 * Dictate a new value and send it. Length is checked first so an obvious
 * mismatch is explained here instead of bouncing off the server.
 */
function dictateValue(entity_id, onDone) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('dictateValue: entity ' + entity_id + ' not found in state dict');
        return;
    }
    if (!Feature.microphone(true, false)) {
        helpers.log_message('dictateValue: no microphone on this watch');
        return;
    }
    var data = getTextData(entity);

    Voice.dictate('start', appState.voice_confirm, function(e) {
        if (e.err) {
            if (e.err !== 'systemAborted') {
                helpers.log_message('Dictation error: ' + e.err);
                Vibe.vibrate('double');
            }
            return;
        }

        var value = e.transcription || '';
        if (value.length < data.min) {
            Vibe.vibrate('double');
            errorCard('Too Short', 'Needs at least ' + data.min +
                ' characters, got ' + value.length + '.');
            return;
        }
        if (value.length > data.max) {
            Vibe.vibrate('double');
            errorCard('Too Long', 'Allows at most ' + data.max +
                ' characters, got ' + value.length + '.');
            return;
        }

        setValue(entity_id, value, onDone);
    });
}

function showTextEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Text entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing text entity ${entity_id}`);

    let hasMicrophone = Feature.microphone(true, false);

    let textMenu = new UI.Menu({
        status: false,
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    function buildStatusItem(updatedEntity) {
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedEntity.last_changed));
        return {
            title: updatedEntity.attributes.friendly_name || entity_id,
            subtitle: `${displayValue(updatedEntity)} > ${timeStr}`,
            on_click: function() {
                if (hasMicrophone) {
                    dictateValue(entity_id);
                }
            }
        };
    }

    let renderedSignature = null;

    function updateTextMenuItems(updatedEntity) {
        let data = getTextData(updatedEntity);
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!data.unavailable) {
            if (hasMicrophone) {
                menuItems.push({
                    title: 'Dictate',
                    subtitle: 'Speak a new value',
                    on_click: function() { dictateValue(entity_id); }
                });
            } else {
                // Saying why is better than leaving the page looking broken
                menuItems.push({
                    title: 'No Microphone',
                    subtitle: 'This watch cannot dictate'
                });
            }

            // Clearing is only valid when the entity allows an empty value
            if (data.min === 0 && data.value.length) {
                menuItems.push({
                    title: 'Clear',
                    on_click: function() {
                        setValue(entity_id, '');
                    }
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

        textMenu.items(0, menuItems);

        // The Clear row comes and goes with the value, so the highlight is
        // reset whenever the row layout changes underneath it
        let signature = data.unavailable + ':' + (data.min === 0 && data.value.length > 0);
        if (renderedSignature !== null && renderedSignature !== signature) {
            selectedIndex = 0;
            textMenu.selection(0, 0);
        }
        renderedSignature = signature;
    }

    let selectedIndex = 0;

    textMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Text menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    textMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateTextMenuItems(entity);

        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.ha_state_dict[entity_id];
            if (current) {
                textMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Text entity update for ${entity_id}`);
                updateTextMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < textMenu.items(0).length) {
                textMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    textMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    textMenu.show();
}

module.exports.showTextEntity = showTextEntity;
module.exports.dictateValue = dictateValue;
module.exports.displayValue = displayValue;
