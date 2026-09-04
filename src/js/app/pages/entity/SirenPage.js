/**
 * SirenPage - siren entity control page
 *
 * Every action is gated on its own feature bit: Home Assistant registers
 * turn_on and turn_off only for the sirens that advertise them, and
 * toggle only when a siren has both, so a fire-and-forget siren that
 * cannot be silenced remotely still gets its panic action.
 *
 * Tone, duration and volume are picked first and applied when the siren
 * is turned on, which matches how the service takes them. They are held
 * for as long as the page is open and are not remembered afterwards.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var NumberField = require('ui/numberfield');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// SirenEntityFeature bitfield values from Home Assistant
var SirenEntityFeature = {
    TURN_ON: 1,
    TURN_OFF: 2,
    TONES: 4,
    VOLUME_SET: 8,
    DURATION: 16
};

// Longest duration the picker offers
var MAX_DURATION_SECONDS = 3600;

function getSirenData(entity) {
    var attrs = entity.attributes || {};
    var features = attrs.supported_features || 0;
    return {
        friendly_name: attrs.friendly_name || entity.entity_id,
        state: entity.state,
        is_on: entity.state === 'on',
        unavailable: entity.state === 'unavailable' || entity.state === 'unknown',
        can_turn_on: !!(features & SirenEntityFeature.TURN_ON),
        can_turn_off: !!(features & SirenEntityFeature.TURN_OFF),
        has_tones: !!(features & SirenEntityFeature.TONES),
        has_volume: !!(features & SirenEntityFeature.VOLUME_SET),
        has_duration: !!(features & SirenEntityFeature.DURATION),
        tones: toneOptions(attrs)
    };
}

/**
 * available_tones is a list of names, a list of numeric ids, or a mapping
 * of id to name. Home Assistant accepts either side of a mapping and
 * converts a name back to its id, so the name is sent in every case: it
 * is what the user picked and it survives the JSON round trip, where a
 * mapping's integer keys arrive as strings.
 * @returns {Array<{label: string, value: string|number}>}
 */
function toneOptions(attrs) {
    var tones = attrs.available_tones;
    var options = [];
    if (Array.isArray(tones)) {
        tones.forEach(function(tone) {
            options.push({ label: String(tone), value: tone });
        });
    } else if (tones && typeof tones === 'object') {
        Object.keys(tones).forEach(function(key) {
            options.push({ label: String(tones[key]), value: tones[key] });
        });
    }
    return options;
}

function toneLabel(tone) {
    return helpers.ucwords(String(tone).replace(/_/g, ' '));
}

function formatDuration(seconds) {
    if (!seconds) return 'Default';
    if (seconds < 60) return seconds + 's';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return s ? m + 'm ' + s + 's' : m + 'm';
}

function showSirenEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Siren entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing siren entity ${entity_id}`, JSON.stringify(entity, null, 4));

    // Options to apply on the next turn on. null means leave it out of the
    // call and let the siren use its own default.
    let pending = { tone: null, duration: 0, volume: null };

    let sirenMenu = new UI.Menu({
        status: false,
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    function callSirenService(service, data) {
        appState.haws.callService(
            'siren',
            service,
            data || {},
            { entity_id: entity_id },
            function(result) {
                Vibe.vibrate('short');
                helpers.log_message('siren.' + service + ' called for ' + entity_id +
                    ' with ' + JSON.stringify(data || {}));
            },
            function(error) {
                Vibe.vibrate('double');
                helpers.log_message('Error calling siren.' + service + ': ' + JSON.stringify(error));
            }
        );
    }

    // Only the options the siren actually supports are sent; Home Assistant
    // would drop the rest anyway, and an unsupported tone is an outright error
    function turnOn() {
        let data = getSirenData(appState.ha_state_dict[entity_id] || entity);
        let params = {};
        if (data.has_tones && pending.tone !== null) {
            params.tone = pending.tone;
        }
        if (data.has_duration && pending.duration > 0) {
            params.duration = pending.duration;
        }
        if (data.has_volume && pending.volume !== null) {
            params.volume_level = pending.volume / 100;
        }
        callSirenService('turn_on', params);
    }

    function showToneMenu() {
        let data = getSirenData(appState.ha_state_dict[entity_id] || entity);
        let toneMenu = new UI.Menu({
            status: false,
            sections: [{
                title: 'Select Tone'
            }]
        });

        let items = [{
            title: 'Default',
            subtitle: pending.tone === null ? 'Current' : '',
            on_click: function() {
                pending.tone = null;
                Vibe.vibrate('short');
                toneMenu.hide();
            }
        }];

        data.tones.forEach(function(option) {
            items.push({
                title: toneLabel(option.label),
                subtitle: pending.tone === option.value ? 'Current' : '',
                on_click: function() {
                    pending.tone = option.value;
                    Vibe.vibrate('short');
                    toneMenu.hide();
                }
            });
        });

        toneMenu.items(0, items);
        toneMenu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') {
                e.item.on_click(e);
            }
        });
        toneMenu.on('hide', function() {
            updateSirenMenuItems(appState.ha_state_dict[entity_id] || entity);
        });
        toneMenu.show();
    }

    function showDurationPicker() {
        NumberField.showDuration({
            title: 'Duration',
            value: pending.duration,
            min: 0,
            max: MAX_DURATION_SECONDS,
            onSet: function(seconds) {
                // The service takes a positive integer, so zero is the
                // natural way to say "leave it to the siren"
                pending.duration = seconds;
                NumberField.hide();
                updateSirenMenuItems(appState.ha_state_dict[entity_id] || entity);
            }
        });
    }

    function showVolumePicker() {
        NumberField.show({
            title: 'Volume',
            unit: '%',
            value: pending.volume !== null ? pending.volume : 100,
            min: 0,
            max: 100,
            step: 1,
            decimals: 0,
            showBar: true,
            onSet: function(value) {
                pending.volume = value;
                NumberField.hide();
                updateSirenMenuItems(appState.ha_state_dict[entity_id] || entity);
            }
        });
    }

    function buildStatusItem(updatedEntity) {
        let data = getSirenData(updatedEntity);
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedEntity.last_changed));
        return {
            title: data.friendly_name,
            subtitle: `${updatedEntity.state} > ${timeStr}`,
            icon: data.is_on ? 'images/icon_switch_on.png' : 'images/icon_switch_off.png',
            on_click: function() {
                if (data.can_turn_on && data.can_turn_off) {
                    callSirenService('toggle');
                } else if (data.is_on && data.can_turn_off) {
                    callSirenService('turn_off');
                } else if (!data.is_on && data.can_turn_on) {
                    turnOn();
                }
            }
        };
    }

    let renderedSignature = null;

    function updateSirenMenuItems(updatedEntity) {
        let data = getSirenData(updatedEntity);
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!data.unavailable) {
            if (data.can_turn_on) {
                let parts = [];
                if (data.has_tones && pending.tone !== null) parts.push(toneLabel(pending.tone));
                if (data.has_duration && pending.duration > 0) parts.push(formatDuration(pending.duration));
                if (data.has_volume && pending.volume !== null) parts.push(pending.volume + '%');
                menuItems.push({
                    title: 'Turn On',
                    subtitle: parts.length ? parts.join(', ') : '',
                    on_click: turnOn
                });
            }
            if (data.can_turn_off) {
                menuItems.push({
                    title: 'Turn Off',
                    on_click: function() { callSirenService('turn_off'); }
                });
            }
            if (data.has_tones && data.tones.length) {
                menuItems.push({
                    title: 'Tone',
                    subtitle: pending.tone !== null ? toneLabel(pending.tone) : 'Default',
                    on_click: showToneMenu
                });
            }
            if (data.has_duration) {
                menuItems.push({
                    title: 'Duration',
                    subtitle: formatDuration(pending.duration),
                    on_click: showDurationPicker
                });
            }
            if (data.has_volume) {
                menuItems.push({
                    title: 'Volume',
                    subtitle: pending.volume !== null ? pending.volume + '%' : 'Default',
                    on_click: showVolumePicker
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

        sirenMenu.items(0, menuItems);

        // Rows only appear or disappear when the siren becomes unavailable,
        // so the highlight is left alone otherwise
        let signature = data.unavailable ? 'off' : 'on';
        if (renderedSignature !== null && renderedSignature !== signature) {
            selectedIndex = 0;
            sirenMenu.selection(0, 0);
        }
        renderedSignature = signature;
    }

    let selectedIndex = 0;

    sirenMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Siren menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    sirenMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateSirenMenuItems(entity);

        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.ha_state_dict[entity_id];
            if (current) {
                sirenMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Siren entity update for ${entity_id}: ${updatedEntity.state}`);
                updateSirenMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < sirenMenu.items(0).length) {
                sirenMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    sirenMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    sirenMenu.show();
}

module.exports.showSirenEntity = showSirenEntity;
module.exports.toneOptions = toneOptions;
