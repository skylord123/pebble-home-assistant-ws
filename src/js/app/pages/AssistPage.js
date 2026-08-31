/**
 * AssistPage - Voice Assistant
 *
 * The conversation screen is drawn natively on the watch (simply_assist.c):
 * it opens the microphone, shows the transcript the moment dictation returns,
 * animates while it waits, and owns its own scrolling and paging. This module
 * keeps the half that has to live on the phone: loading the available assist
 * pipelines, running the transcript through assist_pipeline/run over the
 * websocket, and sending the answer back down as text.
 */
var UI = require('ui');
var Assist = require('ui/assist');
var Settings = require('settings');

var AppState = require('app/AppState');
var helpers = require('app/helpers');

// Track conversation ID across the session
var conversation_id = null;

/**
 * Load available assist pipelines from Home Assistant
 * @param {Function} callback - Called with (success: boolean)
 */
function loadAssistPipelines(callback) {
    var appState = AppState.getInstance();

    appState.haws.getPipelines(
        function(data) {
            if (!data.success) {
                helpers.log_message("Failed to get pipelines");
                callback(false);
                return;
            }

            appState.ha_pipelines = data.result.pipelines;
            appState.preferred_pipeline = data.result.preferred_pipeline;

            // Save pipelines to settings for config page
            var pipelineOptions = appState.ha_pipelines.map(function(p) {
                return {
                    id: p.id,
                    name: p.name,
                    preferred: p.id === appState.preferred_pipeline
                };
            });
            Settings.option('available_pipelines', pipelineOptions);

            // If we have a previous voice_agent setting, try to match it to a pipeline
            if (appState.voice_agent && !appState.selected_pipeline) {
                var matchingPipeline = null;
                for (var i = 0; i < appState.ha_pipelines.length; i++) {
                    if (appState.ha_pipelines[i].conversation_engine === appState.voice_agent) {
                        matchingPipeline = appState.ha_pipelines[i];
                        break;
                    }
                }
                if (matchingPipeline) {
                    appState.selected_pipeline = matchingPipeline.id;
                }
            }

            // If no pipeline selected, use preferred
            if (!appState.selected_pipeline && appState.preferred_pipeline) {
                appState.selected_pipeline = appState.preferred_pipeline;
            }

            // Save selected pipeline
            if (appState.selected_pipeline) {
                Settings.option('selected_pipeline', appState.selected_pipeline);
            }

            callback(true);
        },
        function(error) {
            helpers.log_message("Error getting pipelines: " + error);
            callback(false);
        }
    );
}

/**
 * Turn a pipeline error into something readable on a watch
 */
function describeError(error) {
    if (!error) {
        return 'Connection error';
    }

    switch (error.code) {
        case 'wake-engine-missing': return 'No wake word engine installed';
        case 'wake-provider-missing': return 'Wake word provider not available';
        case 'wake-stream-failed': return 'Wake word detection failed';
        case 'wake-word-timeout': return 'Wake word detection timed out';
        case 'stt-provider-missing': return 'Speech-to-text provider not available';
        case 'stt-provider-unsupported-metadata': return 'Unsupported audio format';
        case 'stt-stream-failed': return 'Speech-to-text failed';
        case 'stt-no-text-recognized': return 'No speech detected';
        case 'intent-not-supported': return 'Conversation agent not available';
        case 'intent-failed': return 'Intent recognition failed';
        case 'tts-not-supported': return 'Text-to-speech not available';
        case 'tts-failed': return 'Text-to-speech failed';
        default: return error.error || 'Connection error';
    }
}

/**
 * Run one turn of the conversation through Home Assistant
 */
function runPipeline(transcription) {
    var appState = AppState.getInstance();


    var body = {
        start_stage: "intent",
        end_stage: "intent",
        input: {
            text: transcription
        },
        pipeline: appState.selected_pipeline,
        conversation_id: conversation_id,
        timeout: 30
    };

    helpers.log_message("Sending assist_pipeline/run request");
    appState.haws.runPipeline(body,
        function(data) {
            if (!data.success) {
                Assist.error('Request failed');
                return;
            }

            try {
                Assist.reply(data.response.speech.plain.speech);
                if (data.conversation_id) {
                    conversation_id = data.conversation_id;
                }
            } catch (err) {
                helpers.log_message("Response format error: " + err.toString());
                Assist.error('Invalid response from Home Assistant');
            }
        },
        function(error) {
            helpers.log_message("assist_pipeline/run error: " + JSON.stringify(error));
            Assist.error(describeError(error));
        }
    );
}

/**
 * Show the voice assistant
 */
function showAssistMenu() {
    var appState = AppState.getInstance();

    if (!appState.selected_pipeline) {
        var errorCard = new UI.Card({
            title: 'Assistant Error',
            body: 'No assist pipeline available. Please configure Home Assistant Assist.',
            scrollable: true
        });

        errorCard.on('click', 'back', function() {
            errorCard.hide();
        });

        errorCard.show();
        return;
    }

    // Each visit to the screen is a fresh conversation, the same as it has
    // always been; the watch throws its own transcript away at the same time
    conversation_id = null;

    Assist.show({
        fontSize: Settings.option('voice_font_size') || 18,
        confirm: appState.voice_confirm,
        backlight: appState.voice_backlight_trigger,
        // Every menu in the app is white on black, so the conversation is too
        dark: true,
        onTranscript: runPipeline,
        onPipeline: function() {
            // Imported inline to avoid a circular dependency
            var SettingsMenuPage = require('app/pages/SettingsMenuPage');
            SettingsMenuPage.showVoicePipelineMenu();
        }
    });
}

module.exports.showAssistMenu = showAssistMenu;
module.exports.loadAssistPipelines = loadAssistPipelines;
