/**
 * AssistPage - Voice Assistant interface
 *
 * Handles:
 * - Voice dictation and conversation management
 * - Scrollable message history display
 * - Custom fonts and layout for round/rectangular displays
 * - Loading animations
 * - Pipeline selection and management
 */
var UI = require('ui');
var Vector = require('vector2');
var Feature = require('platform/feature');
var Voice = require('ui/voice');
var Light = require('ui/light');
var Settings = require('settings');

var BasePage = require('app/pages/BasePage');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
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

class AssistPage extends BasePage {
    constructor() {
        super();
        this.assistWindow = null;
        this.conversationElements = [];
        this.currentY = 24;
        this.currentErrorMessage = null;
        this.errorMessageHeight = 0;
        this.loadingDots = [];
        this.maxRect = null;
    }

    /**
     * Show the voice assistant interface
     */
    show() {
        var self = this;
        var appState = this.appState;

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

        this.assistWindow = new UI.Window({
            backgroundColor: Feature.color('white', 'black'),
            scrollable: true,
            paging: false // paging is by default enabled for round but we have our own custom scrolling
        });

        // Calculate the maximum rectangle that can fit inside a round display
        this.maxRect = this.getMaxRectInRound();
        helpers.log_message("Max rect: " + JSON.stringify(this.maxRect));
        helpers.log_message("Screen resolution: " + JSON.stringify(Feature.resolution()));

        // Configuration for message spacing
        this.MESSAGE_PADDING = 0;
        this.SCROLL_PADDING = 0;

        // Message keys for scrolling
        this.MESSAGE_KEY_SCROLL_Y = 1000;
        this.MESSAGE_KEY_ANIMATED = 1001;

        this.currentY = 24; // Start position below title bar
        this.conversationElements = [];
        this.currentErrorMessage = null;
        this.errorMessageHeight = 0;

        // Add a title bar
        var titleBar = new UI.Text({
            position: new Vector(0, 0),
            size: new Vector(Feature.resolution().x, 24),
            text: 'Assistant',
            font: 'gothic-18-bold',
            color: Feature.color('black', 'white'),
            textAlign: 'center',
            backgroundColor: Constants.colour.highlight
        });
        this.assistWindow.add(titleBar);

        // Loading animation dots
        this.loadingDots = [];
        var DOT_SIZE = 8;
        var DOT_COLOR = Feature.color('#0000FF', '#FFFFFF');

        // Create three dots for the animation
        for (var i = 0; i < 3; i++) {
            this.loadingDots.push(new UI.Circle({
                position: new Vector(0, 0),
                radius: DOT_SIZE / 2,
                backgroundColor: DOT_COLOR
            }));
        }

        // Get configured font size or default to 18
        this.FONT_SIZE = Settings.option('voice_font_size') || 18;
        this.SPEAKER_FONT = 'gothic-' + this.FONT_SIZE + '-bold';
        this.MESSAGE_FONT = 'gothic-' + this.FONT_SIZE;
        this.SPEAKER_HEIGHT = this.FONT_SIZE + 2;

        // Store constants for animation
        this.DOT_SIZE = DOT_SIZE;
        this.DOT_SPACING = 12;

        // Set up event handlers
        this.assistWindow.on('click', 'select', function(e) {
            helpers.log_message("Assist button pressed");
            self.startAssist();
        });

        this.assistWindow.on('longClick', 'select', function() {
            // Import inline to avoid circular dependency
            var SettingsMenuPage = require('app/pages/SettingsMenuPage');
            SettingsMenuPage.showVoicePipelineMenu();
        });

        this.assistWindow.on('show', function() {
            self.startAssist();
        });

        this.assistWindow.on('hide', function() {
            conversation_id = null;
        });

        this.assistWindow.show();
    }

    /**
     * Calculate the maximum rectangle that fits inside a round display
     */
    getMaxRectInRound() {
        var resolution = Feature.resolution();
        var isRound = Feature.round(true, false);

        if (!isRound) {
            return {
                width: resolution.x,
                height: resolution.y,
                left: 0,
                top: 0
            };
        }

        // For round displays, use the inscribed square
        var radius = resolution.x / 2;
        var squareSide = Math.floor(radius * Math.sqrt(2));

        return {
            width: squareSide,
            height: squareSide,
            left: Math.floor((resolution.x - squareSide) / 2),
            top: Math.floor((resolution.y - squareSide) / 2)
        };
    }

    /**
     * Custom scrolling function for the window
     */
    scrollWindowTo(y, animated) {
        var self = this;
        animated = animated || false;

        if (!this.assistWindow || !this.assistWindow.state || !this.assistWindow.state.scrollable) {
            helpers.log_message('Cannot scroll a non-scrollable window');
            return;
        }

        var scrollY = -y;
        var payload = {};
        payload[this.MESSAGE_KEY_SCROLL_Y] = scrollY;
        payload[this.MESSAGE_KEY_ANIMATED] = animated ? 1 : 0;

        Pebble.sendAppMessage(payload, function() {
            helpers.log_message('Scroll message sent successfully to ' + scrollY);
        }, function(e) {
            helpers.log_message('Error sending scroll message: ' + e.error);
        });
    }

    /**
     * Get display name for speaker
     */
    getDisplayName(speaker) {
        if (speaker === "Home Assistant" && this.FONT_SIZE > 18) {
            return "HA";
        }
        return speaker;
    }

    /**
     * Show an error message
     */
    showError(message) {
        var self = this;
        var appState = this.appState;

        if (this.currentErrorMessage) {
            this.assistWindow.remove(this.currentErrorMessage.title);
            this.assistWindow.remove(this.currentErrorMessage.message);
            this.errorMessageHeight = 0;
        }

        var ERROR_TITLE_HEIGHT = this.FONT_SIZE + 2;
        var isRound = Feature.round(true, false);
        var leftMargin = this.maxRect.left + Feature.round(0, 5);
        var textWidth = this.maxRect.width - Feature.round(0, 10);

        var errorTitle = new UI.Text({
            position: new Vector(leftMargin, this.currentY),
            size: new Vector(textWidth, ERROR_TITLE_HEIGHT),
            text: 'Error:',
            font: this.SPEAKER_FONT,
            color: Feature.color('red', 'white'),
            textAlign: isRound ? 'center' : 'left'
        });

        var errorMessage = new UI.Text({
            position: new Vector(leftMargin, this.currentY + ERROR_TITLE_HEIGHT),
            size: new Vector(textWidth, 1000),
            text: message,
            font: this.MESSAGE_FONT,
            color: Feature.color('red', 'white'),
            textAlign: isRound ? 'center' : 'left',
            textOverflow: 'wrap'
        });

        this.assistWindow.add(errorTitle);
        this.conversationElements.push(errorTitle);

        errorMessage.getHeight(function(height) {
            height = Math.max(height, 20);
            helpers.log_message("Text height calculation for error: " + height + "px for text: " + message.substring(0, 30) + "...");

            errorMessage.size(new Vector(textWidth, height + ERROR_TITLE_HEIGHT));
            self.assistWindow.add(errorMessage);
            self.conversationElements.push(errorMessage);

            self.currentErrorMessage = {
                title: errorTitle,
                message: errorMessage
            };

            var heightAdded = height + self.MESSAGE_PADDING;
            self.currentY += heightAdded;
            helpers.log_message("New currentY position for error: " + self.currentY);

            self.errorMessageHeight = heightAdded;
            helpers.log_message("Stored error message height: " + self.errorMessageHeight);

            var contentHeight = self.currentY + 20;
            self.assistWindow.size(new Vector(Feature.resolution().x, contentHeight));
            helpers.log_message("Updated error window size to: " + contentHeight);

            var messageHeight = height + ERROR_TITLE_HEIGHT;
            var errorTitleY = self.currentY - heightAdded;
            var messageTop = errorTitleY;
            var messageBottom = messageTop + messageHeight;
            var screenHeight = Feature.resolution().y;

            helpers.log_message("Error message position: top=" + messageTop + ", bottom=" + messageBottom);

            var scrollTarget;
            if (messageHeight > screenHeight * 0.8) {
                scrollTarget = messageTop - 5;
                helpers.log_message("Long error message detected, scrolling to title at position: " + scrollTarget);
            } else {
                scrollTarget = Math.max(0, messageBottom - screenHeight + 10);
                helpers.log_message("Normal error message, scrolling to position: " + scrollTarget);
            }

            if (scrollTarget > 0) {
                setTimeout(function() {
                    self.scrollWindowTo(scrollTarget, true);
                    helpers.log_message("Scrolling error to target: " + scrollTarget);
                }, 100);
            }

            helpers.log_message("Error message added, content height: " + self.currentY);

            if (appState.voice_backlight_trigger) {
                Light.trigger();
            }
        });
    }

    /**
     * Add a message to the conversation
     */
    addMessage(speaker, message, callback) {
        var self = this;
        var appState = this.appState;

        helpers.log_message("Adding message from " + speaker + ": " + message);

        if (this.currentErrorMessage) {
            this.assistWindow.remove(this.currentErrorMessage.title);
            this.assistWindow.remove(this.currentErrorMessage.message);

            if (this.errorMessageHeight > 0) {
                this.currentY -= this.errorMessageHeight;
                helpers.log_message("Adjusted currentY after removing error: " + this.currentY);
                this.errorMessageHeight = 0;
            }

            this.currentErrorMessage = null;
        }

        try {
            var speakerId = Math.floor(Math.random() * 100000);
            var messageId = Math.floor(Math.random() * 100000);

            var isRound = Feature.round(true, false);
            var leftMargin = this.maxRect.left + Feature.round(0, 5);
            var textWidth = this.maxRect.width - Feature.round(0, 10);

            var speakerLabel = new UI.Text({
                id: speakerId,
                position: new Vector(leftMargin, this.currentY),
                size: new Vector(textWidth, this.SPEAKER_HEIGHT),
                text: this.getDisplayName(speaker) + ':',
                font: this.SPEAKER_FONT,
                color: Feature.color('black', 'white'),
                textAlign: isRound ? 'center' : 'left'
            });
            this.assistWindow.add(speakerLabel);
            this.conversationElements.push(speakerLabel);

            var messageText = new UI.Text({
                id: messageId,
                position: new Vector(leftMargin, this.currentY + this.SPEAKER_HEIGHT),
                size: new Vector(textWidth, 2000),
                text: message,
                font: this.MESSAGE_FONT,
                color: Feature.color('black', 'white'),
                textAlign: isRound ? 'center' : 'left'
            });
            helpers.log_message("Message position: ( " + leftMargin + ", " + (this.currentY + this.SPEAKER_HEIGHT) + " )");
            helpers.log_message("Message size: ( " + textWidth + ", 2000 )");

            messageText.getHeight(function(height) {
                height = Math.max(height, self.FONT_SIZE);
                messageText.size(new Vector(textWidth, height + 10 + Feature.round(26, 0)));
                self.assistWindow.add(messageText);
                self.conversationElements.push(messageText);

                self.currentY += self.SPEAKER_HEIGHT + height + self.MESSAGE_PADDING;

                var contentHeight = self.currentY + 20 + Feature.round(26, 0);
                self.assistWindow.size(new Vector(Feature.resolution().x, contentHeight));
                helpers.log_message("Updated window size to: " + contentHeight);

                var heightAdded = self.SPEAKER_HEIGHT + height + self.MESSAGE_PADDING;
                var messageHeight = self.SPEAKER_HEIGHT + height;
                var speakerLabelY = self.currentY - heightAdded;
                var messageTop = speakerLabelY;
                var messageBottom = messageTop + messageHeight;
                var screenHeight = Feature.resolution().y;

                helpers.log_message("Message position: top=" + messageTop + ", bottom=" + messageBottom);

                var scrollTarget;
                if (messageHeight > screenHeight * 0.8) {
                    scrollTarget = (messageTop + Feature.round(26, 0)) - 5;
                    helpers.log_message("Long message detected, scrolling to title at position: " + scrollTarget);
                } else {
                    scrollTarget = Math.max(0, messageBottom - screenHeight + Feature.round(26, 10));
                    helpers.log_message("Normal message, scrolling to position: " + scrollTarget);
                }

                if (scrollTarget > 0) {
                    setTimeout(function() {
                        self.scrollWindowTo(scrollTarget, true);
                        helpers.log_message("Scrolling to target: " + scrollTarget);
                    }, 100);
                }

                helpers.log_message("Message added successfully, content height: " + self.currentY);

                if (appState.voice_backlight_trigger && speaker !== 'Me') {
                    Light.trigger();
                }

                if (callback) {
                    helpers.log_message("Executing callback");
                    callback();
                }
            });
        } catch (err) {
            helpers.log_message("Error in addMessage: " + err.toString());
            this.showError('Failed to add message');
        }
    }

    /**
     * Start the loading animation
     */
    startLoadingAnimation() {
        var self = this;

        var centerX = Feature.resolution().x / 2;
        var startY = this.currentY + 5;
        var startX = centerX - this.DOT_SPACING - this.DOT_SIZE / 2;

        var dotPositions = [];
        for (var i = 0; i < this.loadingDots.length; i++) {
            var dotX = startX + (i * this.DOT_SPACING);
            dotPositions.push(new Vector(dotX, startY));
            this.loadingDots[i].position(dotPositions[i]);
            this.loadingDots[i].radius(this.DOT_SIZE / 2);
        }

        var loadingBottom = startY + this.DOT_SIZE + 10;
        this.assistWindow.size(new Vector(Feature.resolution().x, loadingBottom + 50));
        helpers.log_message("Set window size for animation: " + (loadingBottom + 50));

        var screenHeight = Feature.resolution().y;
        var animationHeight = this.DOT_SIZE + 20;
        var scrollTarget = loadingBottom - screenHeight + animationHeight;

        setTimeout(function() {
            self.scrollWindowTo(scrollTarget, true);
            helpers.log_message("Scrolling loading indicator to target: " + scrollTarget);
        }, 100);

        var animationState = 0;
        var loadingDots = this.loadingDots;
        var assistWindow = this.assistWindow;

        return setInterval(function() {
            for (var i = 0; i < loadingDots.length; i++) {
                assistWindow.remove(loadingDots[i]);
            }

            switch (animationState) {
                case 0:
                    assistWindow.add(loadingDots[0]);
                    break;
                case 1:
                    assistWindow.add(loadingDots[0]);
                    assistWindow.add(loadingDots[1]);
                    break;
                case 2:
                    assistWindow.add(loadingDots[0]);
                    assistWindow.add(loadingDots[1]);
                    assistWindow.add(loadingDots[2]);
                    break;
                case 3:
                    assistWindow.add(loadingDots[1]);
                    assistWindow.add(loadingDots[2]);
                    break;
                case 4:
                    assistWindow.add(loadingDots[2]);
                    break;
            }

            animationState = (animationState + 1) % 5;
        }, 300);
    }

    /**
     * Stop the loading animation
     */
    stopLoadingAnimation(animationTimer) {
        if (animationTimer) {
            clearInterval(animationTimer);
        }
        for (var i = 0; i < this.loadingDots.length; i++) {
            this.assistWindow.remove(this.loadingDots[i]);
        }
    }

    /**
     * Start the voice assistant interaction
     */
    startAssist() {
        var self = this;
        var appState = this.appState;

        helpers.log_message("startAssist");
        Voice.dictate('start', appState.voice_confirm, function(e) {
            if (e.err) {
                if (e.err === "systemAborted") {
                    helpers.log_message("assist cancelled by user");
                    if (!self.conversationElements.length) {
                        self.assistWindow.hide();
                    }
                    return;
                }
                helpers.log_message("Transcription error: " + e.err);
                self.showError('Transcription error - ' + e.err);
                return;
            }

            helpers.log_message("Transcription received: " + e.transcription);

            self.addMessage('Me', e.transcription, function() {
                helpers.log_message("Starting API call");
                var animationTimer = self.startLoadingAnimation();

                var body = {
                    start_stage: "intent",
                    end_stage: "intent",
                    input: {
                        text: e.transcription
                    },
                    pipeline: appState.selected_pipeline,
                    conversation_id: conversation_id,
                    timeout: 30
                };

                helpers.log_message("Sending assist_pipeline/run request");
                appState.haws.runPipeline(body,
                    function(data) {
                        helpers.log_message("assist_pipeline/run response: " + JSON.stringify(data));
                        self.stopLoadingAnimation(animationTimer);

                        if (!data.success) {
                            self.showError('Request failed');
                            return;
                        }

                        try {
                            var reply = data.response.speech.plain.speech;
                            var conversationId = data.conversation_id;

                            self.addMessage('Assistant', reply, null);
                            if (conversationId) {
                                conversation_id = conversationId;
                            }
                        } catch (err) {
                            self.showError('Invalid response format from Home Assistant');
                            helpers.log_message("Response format error: " + err.toString());
                        }
                    },
                    function(error) {
                        helpers.log_message("assist_pipeline/run error: " + JSON.stringify(error));
                        self.stopLoadingAnimation(animationTimer);

                        if (error && error.code) {
                            switch (error.code) {
                                case 'wake-engine-missing':
                                    self.showError('No wake word engine installed');
                                    break;
                                case 'wake-provider-missing':
                                    self.showError('Wake word provider not available');
                                    break;
                                case 'wake-stream-failed':
                                    self.showError('Wake word detection failed');
                                    break;
                                case 'wake-word-timeout':
                                    self.showError('Wake word detection timed out');
                                    break;
                                case 'stt-provider-missing':
                                    self.showError('Speech-to-text provider not available');
                                    break;
                                case 'stt-provider-unsupported-metadata':
                                    self.showError('Unsupported audio format');
                                    break;
                                case 'stt-stream-failed':
                                    self.showError('Speech-to-text failed');
                                    break;
                                case 'stt-no-text-recognized':
                                    self.showError('No speech detected');
                                    break;
                                case 'intent-not-supported':
                                    self.showError('Conversation agent not available');
                                    break;
                                case 'intent-failed':
                                    self.showError('Intent recognition failed');
                                    break;
                                case 'tts-not-supported':
                                    self.showError('Text-to-speech not available');
                                    break;
                                case 'tts-failed':
                                    self.showError('Text-to-speech failed');
                                    break;
                                default:
                                    self.showError(error.error || 'Connection error');
                            }
                        } else {
                            self.showError(error.error || 'Connection error');
                        }
                    }
                );
            });
        });
    }
}

/**
 * Show the voice assistant (convenience function)
 */
function showAssistMenu() {
    var page = new AssistPage();
    page.show();
}

module.exports = AssistPage;
module.exports.showAssistMenu = showAssistMenu;
module.exports.loadAssistPipelines = loadAssistPipelines;
