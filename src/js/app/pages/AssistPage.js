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
var Theme = require('app/ui/Theme');

// Track conversation ID across the session
var conversation_id = null;

// A conversation open when the sun goes down turns dark around the words
// already in it. Nothing happens unless the screen is up.
Theme.onChange(function() {
    Assist.setDark(Theme.assistIsDark());
});

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

    // Two shapes reach here. A pipeline error event is already flattened to
    // {error, code}. A failed result carries Home Assistant's own
    // {code, message} nested under .error, and that is the shape every
    // validation failure takes: websocket_run reports those before the run
    // starts, so a renamed pipeline or an unloaded agent arrives this way.
    // Reading the outer object alone yielded the nested one, which the watch
    // then drew as "[object Object]".
    var detail = (error.error && typeof error.error === 'object') ? error.error : error;
    var code = detail.code || error.code;
    var message = (typeof detail.message === 'string' && detail.message) ||
        (typeof error.error === 'string' && error.error) || '';

    switch (code) {
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
        // These are the ones a watch actually meets, since it asks for the
        // intent stage alone and the wake, speech and voice codes above can
        // never fire
        case 'timeout': return 'Home Assistant took too long';
        case 'pipeline-not-found': return 'That assistant is no longer set up';
        case 'intent-agent-not-found': return 'Conversation agent not found';
        default: return message || 'Connection error';
    }
}

/**
 * Home Assistant reports its version when the socket authenticates. Streaming
 * answers as the agent writes them arrived in core 2025.3; an older instance
 * never sends the events at all, so nothing would break either way, but asking
 * for something a version cannot do is worth not doing.
 */
var STREAMING_SINCE = [2025, 3];

function supportsStreaming(version) {
    var parts = /^(\d+)\.(\d+)/.exec(String(version || ''));
    if (!parts) {
        return false;
    }
    var year = parseInt(parts[1], 10);
    var month = parseInt(parts[2], 10);
    return year > STREAMING_SINCE[0] ||
        (year === STREAMING_SINCE[0] && month >= STREAMING_SINCE[1]);
}

// An agent can write faster than Bluetooth wants to be spoken to, and a local
// model can emit a word at a time. Pieces that land together inside this many
// milliseconds go down as one, which is short enough to read as live and long
// enough that a fast writer cannot flood the link.
var STREAM_COALESCE_MS = 120;

var streamTimer = null;
var streamText = '';

function cancelStream() {
    if (streamTimer) {
        clearTimeout(streamTimer);
        streamTimer = null;
    }
    streamText = '';
}

function flushStream() {
    streamTimer = null;
    if (streamText) {
        Assist.streamReply(streamText);
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
        // Home Assistant's own default is 300 seconds. The watch gives up
        // after 45 of silence, but it restarts that clock on every streamed
        // piece, so it will happily wait out a long answer that is still
        // arriving. The server's cap has to sit above the watch's, not below
        // it: at 30 an agent working through a few tool calls was being cut
        // off mid-answer.
        timeout: 120
    };

    cancelStream();
    Assist.beginReply();

    var streaming = appState.assist_stream_reply !== false &&
        supportsStreaming(appState.ha_version);
    var onProgress = streaming ? function(piece, opensMessage) {
        // An agent that stops to call a tool writes twice in one turn: a line
        // about what it is going off to look up, then the answer once it has.
        // Home Assistant reports those as separate messages, so they are kept
        // apart here rather than run together. It also puts the second message
        // back at the start of a line, which is where the markdown converter
        // has to see a list or a heading to recognise it as one.
        if (opensMessage && streamText) {
            streamText += '\n\n';
        }
        streamText += piece;
        if (!streamTimer) {
            streamTimer = setTimeout(flushStream, STREAM_COALESCE_MS);
        }
    } : null;

    helpers.log_message("Sending assist_pipeline/run request" +
        (streaming ? " (streaming)" : ""));
    appState.haws.runPipeline(body,
        function(data) {
            if (streamTimer) {
                clearTimeout(streamTimer);
                streamTimer = null;
            }

            if (!data.success) {
                cancelStream();
                Assist.error('Request failed');
                return;
            }

            try {
                if (data.conversation_id) {
                    conversation_id = data.conversation_id;
                }

                // Home Assistant always sends a speech key but leaves it empty
                // when no agent set one, so this is read a piece at a time
                // rather than assumed all the way down
                var response = data.response || {};
                var plain = (response.speech && response.speech.plain) || {};
                var speech = typeof plain.speech === 'string' ? plain.speech : '';

                if (response.response_type === 'error') {
                    // A successful run whose response is an error, which is how
                    // the agent's own failures arrive: an expired key or a rate
                    // limit from the model. Drawn as an answer it is
                    // indistinguishable from one.
                    cancelStream();
                    Assist.error(speech || 'The assistant could not answer');
                    return;
                }

                // Whatever was streamed came from this same answer, so ending
                // on it settles any last piece and stops the dots. Nothing
                // streamed and it goes down whole, exactly as it used to.
                Assist.endReply(speech);
                cancelStream();
            } catch (err) {
                helpers.log_message("Response format error: " + err.toString());
                cancelStream();
                Assist.error('Invalid response from Home Assistant');
            }
        },
        function(error) {
            helpers.log_message("assist_pipeline/run error: " + JSON.stringify(error));
            cancelStream();
            Assist.error(describeError(error));
        },
        onProgress
    );
}

/**
 * Put the conversation on screen with the settings as they stand.
 *
 * `listen` opens the microphone, which is what starting a conversation means.
 * Coming back from the settings menu leaves it off: the watch still holds
 * everything that was said, and shows it again with whatever was changed.
 */
function openAssist(listen, reset) {
    var appState = AppState.getInstance();

    Assist.show({
        fontSize: Settings.option('voice_font_size') || 18,
        confirm: appState.voice_confirm,
        backlight: appState.voice_backlight_trigger,
        dark: Theme.assistIsDark(),
        listen: listen,
        reset: reset,
        onTranscript: runPipeline,
        onSettings: function() {
            // Imported inline to avoid a circular dependency
            var SettingsMenuPage = require('app/pages/SettingsMenuPage');
            var pipelineBefore = appState.selected_pipeline;
            SettingsMenuPage.showVoiceAssistantSettings(function() {
                // A conversation belongs to the pipeline it was started on:
                // Home Assistant keys it to the agent that answered, and it
                // cannot be carried over to a different one. Switching
                // pipelines therefore starts again, transcript and all, which
                // is what the Home Assistant frontend does too. Changing
                // anything else leaves the conversation where it was.
                var switched = appState.selected_pipeline !== pipelineBefore;
                if (switched) {
                    conversation_id = null;
                    cancelStream();
                }
                openAssist(false, switched);
            });
        }
    });
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
    cancelStream();
    openAssist(true);
}

module.exports.showAssistMenu = showAssistMenu;
module.exports.loadAssistPipelines = loadAssistPipelines;
