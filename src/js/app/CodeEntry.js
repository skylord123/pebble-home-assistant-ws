/**
 * CodeEntry - the code flow shared by alarm panels and locks
 *
 * Runs a service that may need a code: no prompt when the entity has a
 * default code in its Home Assistant entity options (HA fills it in, as
 * the frontend relies on), remembered and "never ask" codes from
 * AlarmCodeStore, and otherwise a prompt. Numeric codes go through
 * PinEntryPage (with retry on a wrong code); text codes are dictated on
 * watches with a microphone.
 *
 * run({ entity_id, domain, service, title, needsCode, textCode })
 *   needsCode - whether this call wants a code at all
 *   textCode  - the code is free text rather than digits
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var Voice = require('ui/voice');
var Feature = require('platform/feature');

var AppState = require('app/AppState');
var helpers = require('app/helpers');
var PinEntryPage = require('app/pages/PinEntryPage');

// haws fails a command with one of these when the socket is down or drops
function isConnectionError(error) {
    var code = error && error.error ? error.error.code : null;
    return code === 'not_connected' || code === 'connection_lost';
}

function errorMessage(error) {
    if (error && error.error && error.error.message) {
        return error.error.message;
    }
    return 'Action failed';
}

/**
 * Whether Home Assistant holds a default code for this entity
 * (options.<domain>.default_code in the entity registry)
 */
function hasDefaultCode(entity_id, domain) {
    var registry = AppState.getInstance().entity_registry_cache || {};
    var entry = registry[entity_id];
    var options = entry && entry.options ? entry.options[domain] : null;
    return !!(options && options.default_code);
}

// Dictation tends to add a full stop, and to space out a string of digits
function cleanDictatedCode(text) {
    var code = String(text || '').trim().replace(/[.!?]+$/, '');
    if (/^[\d\s]+$/.test(code)) {
        code = code.replace(/\s+/g, '');
    }
    return code;
}

function run(opts) {
    var appState = AppState.getInstance();
    var entity_id = opts.entity_id;
    var entity = appState.getEntity(entity_id);
    if (!entity) {
        helpers.log_message('CodeEntry: entity ' + entity_id + ' not found in state dict');
        return;
    }
    var store = appState.alarmCodeStore;
    var name = entity.attributes.friendly_name || entity_id;

    function send(code, successCallback, errorCallback) {
        var service_data = (code !== null && code !== undefined) ? { code: String(code) } : {};
        appState.haws.callService(
            opts.domain,
            opts.service,
            service_data,
            { entity_id: entity_id },
            function(data) {
                helpers.log_message(opts.domain + '.' + opts.service + ' called for ' + entity_id);
                successCallback(data);
            },
            function(error) {
                helpers.log_message('Error calling ' + opts.domain + '.' + opts.service + ': ' + JSON.stringify(error));
                errorCallback(error);
            }
        );
    }

    function remember(code) {
        if (store && appState.alarm_code_remember !== false) {
            store.setCode(entity_id, code);
        }
    }

    // A failed attempt shows why first, and SELECT on that card retries
    function dictateCode(errorText) {
        if (errorText) {
            var card = new UI.Card({
                title: opts.title,
                body: errorText + '\n\nSELECT to say the code again.',
                scrollable: true
            });
            card.on('click', 'select', function() {
                card.hide();
                dictateCode(null);
            });
            card.show();
            return;
        }
        Voice.dictate('start', appState.voice_confirm, function(e) {
            if (e.err) {
                if (e.err !== 'systemAborted') {
                    helpers.log_message('Code dictation error: ' + e.err);
                    Vibe.vibrate('double');
                }
                return;
            }
            var code = cleanDictatedCode(e.transcription);
            if (!code) {
                Vibe.vibrate('double');
                return;
            }
            send(code, function() {
                Vibe.vibrate('short');
                remember(code);
            }, function(error) {
                Vibe.vibrate('double');
                dictateCode(errorMessage(error));
            });
        });
    }

    function promptForCode(initialError) {
        if (opts.textCode && Feature.microphone(true, false)) {
            dictateCode(initialError);
            return;
        }
        PinEntryPage.show({
            title: opts.title,
            subtitle: name,
            error: initialError,
            onSubmit: function(code, done) {
                send(code, function() {
                    Vibe.vibrate('short');
                    remember(code);
                    done(null);
                }, function(error) {
                    Vibe.vibrate('double');
                    done(errorMessage(error));
                });
            }
        });
    }

    if (!opts.needsCode || hasDefaultCode(entity_id, opts.domain)) {
        send(null,
            function() { Vibe.vibrate('short'); },
            function() { Vibe.vibrate('double'); });
        return;
    }

    var saved = store ? store.get(entity_id) : undefined;
    if (saved) {
        send(saved.code, function() {
            Vibe.vibrate('short');
        }, function(error) {
            Vibe.vibrate('double');
            // A connection failure says nothing about the code, but a
            // server rejection gets a prompt showing why (both for a
            // stale remembered code and a "never ask" entity that turned
            // out to need one). The stored entry is left alone: transient
            // server errors shouldn't wipe a good code, and a successful
            // retry overwrites a stale one anyway.
            if (!isConnectionError(error)) {
                promptForCode(errorMessage(error));
            }
        });
        return;
    }

    promptForCode(null);
}

module.exports.run = run;
module.exports.hasDefaultCode = hasDefaultCode;
