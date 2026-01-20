/**
 * MediaPlayerPage - Media player entity control page
 *
 * Features:
 * - Playback state display
 * - Play/Pause/Stop controls
 * - Volume control with slider
 * - Track navigation (prev/next)
 * - Source selection
 * - Media info display (title, artist, album)
 * - Real-time state subscription
 */
var UI = require('ui');
var Vector = require('vector2');
var Feature = require('platform/feature');

var BaseEntityPage = require('app/pages/entity/BaseEntityPage');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

// Feature constants
var PAUSE = 'Pause';
var SEEK = "Seek";
var VOLUME_SET = "Volume Set";
var VOLUME_MUTE = "Volume Mute";
var PREVIOUS_TRACK = "Previous Track";
var NEXT_TRACK = "Next Track";
var TURN_ON = "Turn On";
var TURN_OFF = "Turn Off";
var PLAY_MEDIA = "Play Media";
var VOLUME_STEP = "Volume Step";
var SELECT_SOURCE = "Select Source";
var STOP = "Stop";
var CLEAR_PLAYLIST = "Clear Playlist";
var PLAY = "Play";
var SHUFFLE_SET = "Shuffle Set";
var SELECT_SOUND_MODE = "Select Sound Mode";
var BROWSE_MEDIA = "Browse Media";
var REPEAT_SET = "Repeat Set";
var GROUPING = "Grouping";

/**
 * Get supported features for a media player entity
 */
function supported_features(entity) {
    var features = {
        1: PAUSE,
        2: SEEK,
        4: VOLUME_SET,
        8: VOLUME_MUTE,
        16: PREVIOUS_TRACK,
        32: NEXT_TRACK,
        128: TURN_ON,
        256: TURN_OFF,
        512: PLAY_MEDIA,
        1024: VOLUME_STEP,
        2048: SELECT_SOURCE,
        4096: STOP,
        8192: CLEAR_PLAYLIST,
        16384: PLAY,
        32768: SHUFFLE_SET,
        65536: SELECT_SOUND_MODE,
        131072: BROWSE_MEDIA,
        262144: REPEAT_SET,
        524288: GROUPING,
    };
    var supported = [];
    for (var key in features) {
        if (!!(entity.attributes.supported_features & key)) {
            supported.push(features[key]);
        }
    }
    return supported;
}

/**
 * Convert seconds to time string
 */
function secToTime(seconds, separator) {
    return [
        parseInt(seconds / 60 / 60),
        parseInt(seconds / 60 % 60),
        parseInt(seconds % 60)
    ].join(separator ? separator : ':')
        .replace(/\b(\d)\b/g, "0$1").replace(/^00\:/, '');
}

class MediaPlayerPage extends BaseEntityPage {
    constructor(entityId, options) {
        super(entityId, options);
        this.subscription_msg_id = null;
        this.is_muted = false;
        this.mediaControlWindow = null;
    }

    /**
     * Show the media player control page
     */
    show() {
        var self = this;
        var appState = this.appState;

        var mediaPlayer = appState.ha_state_dict[this.entityId];
        if (!mediaPlayer) {
            throw new Error("Media player entity " + this.entityId + " not found in ha_state_dict");
        }

        helpers.log_message("Showing entity " + mediaPlayer.entity_id + ": " + JSON.stringify(mediaPlayer, null, 4));
        helpers.log_message("Supported features: " + supported_features(mediaPlayer));

        this.is_muted = mediaPlayer.attributes.is_volume_muted;

        this.mediaControlWindow = new UI.Window({
            status: {
                color: 'black',
                backgroundColor: 'white',
                seperator: "dotted"
            },
            backgroundColor: "white",
            action: {
                up: "IMAGE_ICON_VOLUME_UP",
                select: "IMAGE_ICON_PLAYPAUSE",
                down: "IMAGE_ICON_VOLUME_DOWN",
            }
        });

        // Calculate available width
        var availableWidth = Feature.resolution().x - Feature.actionBarWidth() - 10;
        var titleFont = "gothic_24_bold";
        var titleY = 3;
        if (mediaPlayer.attributes.friendly_name.length > 17) {
            titleFont = "gothic_14_bold";
            titleY = 6;
        }

        this.mediaName = new UI.Text({
            text: mediaPlayer.attributes.friendly_name,
            color: Feature.color(appState.colour.highlight, "black"),
            font: titleFont,
            position: Feature.round(new Vector(10, titleY), new Vector(5, titleY)),
            size: new Vector(availableWidth, 30),
            textAlign: "left"
        });

        var position_y = 30;
        if (appState.enableIcons) {
            this.muteIcon = new UI.Image({
                position: new Vector(9, 82 + position_y),
                size: new Vector(20, 13),
                compositing: "set",
                backgroundColor: 'transparent',
                image: "IMAGE_ICON_UNMUTED"
            });
            if (mediaPlayer.attributes.is_volume_muted) {
                this.muteIcon.image("IMAGE_ICON_MUTED");
            }
        }

        this.volume_label = new UI.Text({
            text: "%",
            color: "black",
            font: "gothic_14",
            position: new Vector(Feature.resolution().x - Feature.actionBarWidth() - 30, 80 + position_y),
            size: new Vector(30, 30),
            textAlign: "center"
        });

        this.volume_progress_bg = new UI.Line({
            position: new Vector(10, 105 + position_y),
            position2: new Vector(134 - Feature.actionBarWidth(), 105 + position_y),
            strokeColor: 'black',
            strokeWidth: 5,
        });

        this.volume_progress_bg_inner = new UI.Line({
            position: new Vector(10, 105 + position_y),
            position2: new Vector(134 - Feature.actionBarWidth(), 105 + position_y),
            strokeColor: 'white',
            strokeWidth: 3,
        });

        this.volume_progress_fg = new UI.Line({
            position: new Vector(10, 105 + position_y),
            position2: new Vector(10, 105 + position_y),
            strokeColor: 'black',
            strokeWidth: 3,
        });
        this.volume_progress_fg.maxWidth = this.volume_progress_bg_inner.position2().x - this.volume_progress_bg_inner.position().x;

        position_y = -10;
        this.position_label = new UI.Text({
            text: "-:-- / -:--",
            color: "black",
            font: "gothic_14",
            position: new Vector(Feature.resolution().x - Feature.actionBarWidth() - 80, 80 + position_y),
            size: new Vector(80, 30),
            textAlign: "center"
        });

        this.position_progress_bg = new UI.Line({
            position: new Vector(10, 105 + position_y),
            position2: new Vector(134 - Feature.actionBarWidth(), 105 + position_y),
            strokeColor: 'black',
            strokeWidth: 5,
        });

        this.position_progress_bg_inner = new UI.Line({
            position: new Vector(10, 105 + position_y),
            position2: new Vector(134 - Feature.actionBarWidth(), 105 + position_y),
            strokeColor: 'white',
            strokeWidth: 3,
        });

        this.position_progress_fg = new UI.Line({
            position: new Vector(10, 105 + position_y),
            position2: new Vector(10, 105 + position_y),
            strokeColor: 'black',
            strokeWidth: 3,
        });
        this.position_progress_fg.maxWidth = this.position_progress_bg_inner.position2().x - this.position_progress_bg_inner.position().x;

        this.mediaControlWindow.on('show', function() {
            self.subscription_msg_id = appState.haws.subscribeTrigger({
                "type": "subscribe_trigger",
                "trigger": {
                    "platform": "state",
                    "entity_id": self.entityId,
                },
            }, function(data) {
                self.updateMediaWindow(data.event.variables.trigger.to_state);
            }, function(error) {
                helpers.log_message("ENTITY UPDATE ERROR [" + self.entityId + "]: " + JSON.stringify(error));
            });

            self.mediaControlWindow.on('click', 'select', function(e) {
                appState.haws.mediaPlayerPlayPause(self.entityId);
            });

            self.mediaControlWindow.on('longClick', 'select', function(e) {
                // Import inline to avoid circular dependency
                var GenericEntityPage = require('app/pages/entity/GenericEntityPage');
                GenericEntityPage.showEntityMenu(self.entityId);
            });

            self.mediaControlWindow.on('click', 'up', function(e) {
                appState.haws.mediaPlayerVolumeUp(self.entityId, function(d) {});
            });

            self.mediaControlWindow.on('longClick', 'up', function(e) {
                appState.haws.mediaPlayerNextTrack(self.entityId);
            });

            self.mediaControlWindow.on('click', 'down', function(e) {
                appState.haws.mediaPlayerVolumeDown(self.entityId, function(d) {});
            });

            self.mediaControlWindow.on('longClick', 'down', function(e) {
                if (self.is_muted) {
                    appState.haws.mediaPlayerMute(self.entityId, false, function(d) {
                        self.is_muted = false;
                    });
                } else {
                    appState.haws.mediaPlayerMute(self.entityId, true, function(d) {
                        self.is_muted = true;
                    });
                }
            });

            self.updateMediaWindow(mediaPlayer);
        });

        this.mediaControlWindow.on('close', function() {
            if (self.subscription_msg_id) {
                appState.haws.unsubscribe(self.subscription_msg_id);
            }
        });

        this.mediaControlWindow.show();
    }

    /**
     * Update the media window with current state
     */
    updateMediaWindow(mediaPlayer) {
        if (!mediaPlayer) { return; }
        var appState = this.appState;

        helpers.log_message("MEDIA PLAYER WINDOW UPDATE " + mediaPlayer.entity_id + ": " + JSON.stringify(mediaPlayer, null, 4));

        // Update volume progress
        var newVolumeWidth = this.volume_progress_fg.maxWidth * mediaPlayer.attributes.volume_level;
        var volume_x2 = this.volume_progress_fg.position().x + Math.round(newVolumeWidth);
        this.volume_progress_fg.position2(new Vector(volume_x2, this.volume_progress_fg.position2().y));

        // Update volume label
        if (mediaPlayer.attributes.is_volume_muted) {
            if (appState.enableIcons && this.muteIcon) {
                this.muteIcon.image("IMAGE_ICON_MUTED");
            }
            this.volume_label.text("");
        } else {
            if (appState.enableIcons && this.muteIcon) {
                this.muteIcon.image("IMAGE_ICON_UNMUTED");
            }
            if (mediaPlayer.attributes.volume_level) {
                var percentage = Math.round(mediaPlayer.attributes.volume_level * 100);
                this.volume_label.text(percentage === 100 ? 'MAX' : percentage + "%");
            } else {
                this.volume_label.text("0%");
            }
        }

        // Update media position progress
        var positionRatio = (mediaPlayer.attributes.media_position && mediaPlayer.attributes.media_duration)
            ? mediaPlayer.attributes.media_position / mediaPlayer.attributes.media_duration
            : 0;
        var newPositionWidth = this.position_progress_fg.maxWidth * positionRatio;
        var position_x2 = this.position_progress_fg.position().x + Math.round(newPositionWidth);
        this.position_progress_fg.position2(new Vector(position_x2, this.position_progress_fg.position2().y));

        // Update position label
        if (mediaPlayer.attributes.media_position && mediaPlayer.attributes.media_duration) {
            this.position_label.text(secToTime(mediaPlayer.attributes.media_position) + " / " + secToTime(mediaPlayer.attributes.media_duration));
        } else {
            this.position_label.text("-:-- / -:--");
        }

        // Add UI elements to the window
        this.mediaControlWindow.add(this.volume_progress_bg);
        this.mediaControlWindow.add(this.volume_progress_bg_inner);
        this.mediaControlWindow.add(this.volume_progress_fg);
        this.mediaControlWindow.add(this.volume_label);
        this.mediaControlWindow.add(this.position_progress_bg);
        this.mediaControlWindow.add(this.position_progress_bg_inner);
        this.mediaControlWindow.add(this.position_progress_fg);
        this.mediaControlWindow.add(this.position_label);
        this.mediaControlWindow.add(this.mediaName);
        if (appState.enableIcons && Feature.rectangle() && this.muteIcon) {
            this.mediaControlWindow.add(this.muteIcon);
        }
    }
}

/**
 * Show the media player page (convenience function)
 */
function showMediaPlayerEntity(entity_id) {
    var page = new MediaPlayerPage(entity_id);
    page.show();
}

module.exports = MediaPlayerPage;
module.exports.showMediaPlayerEntity = showMediaPlayerEntity;
