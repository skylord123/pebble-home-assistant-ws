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
var Vibe = require('ui/vibe');

var BaseEntityPage = require('app/pages/entity/BaseEntityPage');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');

// MediaPlayerEntityFeature bits, for gating rather than logging
var FEATURE = {
    PAUSE: 1,
    SEEK: 2,
    VOLUME_SET: 4,
    VOLUME_MUTE: 8,
    PREVIOUS_TRACK: 16,
    NEXT_TRACK: 32,
    TURN_ON: 128,
    TURN_OFF: 256,
    VOLUME_STEP: 1024,
    SELECT_SOURCE: 2048,
    STOP: 4096,
    PLAY: 16384,
    SHUFFLE_SET: 32768,
    SELECT_SOUND_MODE: 65536,
    PLAY_MEDIA: 512,
    CLEAR_PLAYLIST: 8192,
    BROWSE_MEDIA: 131072,
    REPEAT_SET: 262144,
    GROUPING: 524288,
    MEDIA_ANNOUNCE: 1048576,
    MEDIA_ENQUEUE: 2097152,
    SEARCH_MEDIA: 4194304
};

/**
 * Feature names for logging, read from the one table above so the two
 * cannot drift apart
 */
function supported_features(entity) {
    var bits = (entity && entity.attributes && entity.attributes.supported_features) || 0;
    return Object.keys(FEATURE).filter(function(name) {
        return !!(bits & FEATURE[name]);
    });
}

/**
 * Whether an entity advertises a given feature
 */
function supports(entity, bit) {
    return !!(((entity && entity.attributes && entity.attributes.supported_features) || 0) & bit);
}

/**
 * The players sharing playback with this one. Home Assistant only says
 * group_members is the group and that a leader, where the concept exists,
 * should come first: it does not promise the entity appears in its own list,
 * and platforms differ (Sonos puts the leader first, Squeezebox puts it
 * last). Filtering self out is therefore the only safe way to count peers.
 */
function groupPeers(entity) {
    var members = (entity && entity.attributes && entity.attributes.group_members) || [];
    if (!Array.isArray(members)) return [];
    return members.filter(function(id) { return id !== entity.entity_id; });
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
            color: Feature.color(Constants.colour.highlight, "black"),
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

        // Registered once. Handlers must not go inside the show handler:
        // popping a child window re-fires show on whatever it covered, and
        // the emitter appends rather than replaces, so every return from a
        // sub-menu would add another copy and one press would fire twice.
        this.mediaControlWindow.on('click', 'select', function(e) {
            self.playPause();
        });

        this.mediaControlWindow.on('longClick', 'select', function(e) {
            self.showOptionsMenu();
        });

        this.mediaControlWindow.on('click', 'up', function(e) {
            appState.haws.mediaPlayerVolumeUp(self.entityId, function(d) {});
        });

        this.mediaControlWindow.on('longClick', 'up', function(e) {
            var current = appState.ha_state_dict[self.entityId];
            if (!supports(current, FEATURE.NEXT_TRACK)) {
                // Saying nothing at all reads as a frozen watch
                Vibe.vibrate('double');
                helpers.log_message('Media player ' + self.entityId + ' has no next track');
                return;
            }
            appState.haws.mediaPlayerNextTrack(self.entityId);
        });

        this.mediaControlWindow.on('click', 'down', function(e) {
            appState.haws.mediaPlayerVolumeDown(self.entityId, function(d) {});
        });

        this.mediaControlWindow.on('longClick', 'down', function(e) {
            var current = appState.ha_state_dict[self.entityId];
            if (!supports(current, FEATURE.VOLUME_MUTE)) {
                Vibe.vibrate('double');
                helpers.log_message('Media player ' + self.entityId + ' cannot mute');
                return;
            }
            // Read the live state rather than a flag of our own: muting from
            // anywhere else would otherwise invert this toggle
            var muted = !!(current.attributes && current.attributes.is_volume_muted);
            appState.haws.mediaPlayerMute(self.entityId, !muted);
        });

        this.mediaControlWindow.on('show', function() {
            // Re-entered whenever a sub-menu closes, so never stack a second
            // subscription on top of a live one
            self.unsubscribeMedia();
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

            self.updateMediaWindow(appState.ha_state_dict[self.entityId] || mediaPlayer);
        });

        // 'close' is not an event this runtime emits, so the old handler here
        // never ran and every visit leaked its subscription
        this.mediaControlWindow.on('hide', function() {
            self.unsubscribeMedia();
        });

        this.mediaControlWindow.show();
    }

    /**
     * Keep a menu's rows in step with the entity while it is open. Returns
     * the subscription so the caller can release it on hide.
     */
    subscribeRebuild(rebuild, existing) {
        var self = this;
        if (existing) { this.appState.haws.unsubscribe(existing); }
        return this.appState.haws.subscribeEntities([this.entityId], function(data) {
            var EntityService = require('app/EntityService');
            if (EntityService.applyCompressedEvent(self.entityId, data)) {
                rebuild();
            }
        }, function(error) {
            helpers.log_message('ENTITY UPDATE ERROR [' + self.entityId + ']: ' + JSON.stringify(error));
        });
    }

    unsubscribeMenu(sub) {
        if (sub) { this.appState.haws.unsubscribe(sub); }
        return null;
    }

    unsubscribeMedia() {
        if (this.subscription_msg_id) {
            this.appState.haws.unsubscribe(this.subscription_msg_id);
            this.subscription_msg_id = null;
        }
    }

    /**
     * Home Assistant registers media_play_pause behind PLAY and PAUSE as a
     * single combined requirement, so a player that only advertises one of
     * them refuses it outright. Pick the specific service in that case.
     */
    playPause() {
        var entity = this.appState.ha_state_dict[this.entityId];
        var haws = this.appState.haws;
        if (supports(entity, FEATURE.PLAY) && supports(entity, FEATURE.PAUSE)) {
            haws.mediaPlayerPlayPause(this.entityId);
            return;
        }
        var playing = entity && entity.state === 'playing';
        if (playing && supports(entity, FEATURE.PAUSE)) {
            haws.mediaPlayerPause(this.entityId);
        } else if (!playing && supports(entity, FEATURE.PLAY)) {
            haws.mediaPlayerPlay(this.entityId);
        } else {
            Vibe.vibrate('double');
            helpers.log_message('Media player ' + this.entityId + ' cannot play or pause');
        }
    }

    /**
     * Call a media_player service and report the way every other page does
     */
    callMedia(service, data) {
        var self = this;
        this.appState.haws.callService(
            'media_player', service, data || {}, { entity_id: this.entityId },
            function() {
                Vibe.vibrate('short');
                helpers.log_message('media_player.' + service + ' called for ' + self.entityId);
            },
            function(error) {
                Vibe.vibrate('double');
                helpers.log_message('Error calling media_player.' + service + ': ' + JSON.stringify(error));
            }
        );
    }

    /**
     * A list picker that marks whichever entry is currently selected
     */
    showChoiceMenu(title, listAttr, currentAttr, service, field) {
        var self = this;
        var menu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{ title: title }]
        });

        function build() {
            var entity = self.appState.ha_state_dict[self.entityId];
            if (!entity) { return; }
            var list = entity.attributes[listAttr] || [];
            var current = entity.attributes[currentAttr];
            menu.items(0, list.map(function(option) {
                var payload = {};
                payload[field] = option;
                return {
                    title: option,
                    subtitle: option === current ? 'Current' : '',
                    on_click: function() { self.callMedia(service, payload); }
                };
            }));
        }

        var sub = null;
        menu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') { e.item.on_click(e); }
        });
        menu.on('show', function() {
            build();
            // Without this the Current marker never moves after a pick
            sub = self.subscribeRebuild(build, sub);
        });
        menu.on('hide', function() { sub = self.unsubscribeMenu(sub); });
        menu.show();
    }

    /**
     * Pick another player to play in sync with this one. The service targets
     * the master and names the members, so this entity becomes the master
     * and the chosen player joins it. Existing members are carried over so
     * each pick adds rather than replaces.
     */
    showGroupingMenu() {
        var self = this;
        var menu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{ title: 'Play In Sync' }]
        });

        function build() {
            var entity = self.appState.ha_state_dict[self.entityId];
            if (!entity) { return; }
            var peers = groupPeers(entity);
            var items = [];

            var dict = self.appState.ha_state_dict || {};
            Object.keys(dict).forEach(function(id) {
                if (id.indexOf('media_player.') !== 0 || id === self.entityId) { return; }
                var other = dict[id];
                if (!supports(other, FEATURE.GROUPING)) { return; }
                // Offering an offline player only produces a failed join
                if (other.state === 'unavailable' || other.state === 'unknown') { return; }
                var joined = peers.indexOf(id) > -1;
                items.push({
                    title: (other.attributes && other.attributes.friendly_name) || id,
                    subtitle: joined ? 'In group' : '',
                    on_click: function() {
                        // Re-read rather than trusting the row: after joining,
                        // a stale flag would join the same player again
                        var live = self.appState.ha_state_dict[self.entityId];
                        var livePeers = groupPeers(live || entity);
                        if (livePeers.indexOf(id) > -1) {
                            // Leaving is done by the member, not the master
                            self.appState.haws.callService(
                                'media_player', 'unjoin', {}, { entity_id: id },
                                function() { Vibe.vibrate('short'); },
                                function(error) {
                                    Vibe.vibrate('double');
                                    helpers.log_message('Error unjoining ' + id + ': ' + JSON.stringify(error));
                                }
                            );
                        } else {
                            self.callMedia('join', { group_members: livePeers.concat([id]) });
                        }
                    }
                });
            });

            if (!items.length) {
                items.push({ title: 'No Other Players', subtitle: 'Nothing here supports grouping' });
            }
            menu.items(0, items);
        }

        var sub = null;
        menu.on('select', function(e) {
            if (typeof e.item.on_click === 'function') { e.item.on_click(e); }
        });
        menu.on('show', function() {
            build();
            // Rebuild as the group changes, so a player just added can be
            // removed again instead of being joined twice
            sub = self.subscribeRebuild(build, sub);
        });
        menu.on('hide', function() { sub = self.unsubscribeMenu(sub); });
        menu.show();
    }

    /**
     * Everything the player supports that does not fit on three buttons.
     * Reached by holding select, which also still leads to the generic page.
     */
    showOptionsMenu() {
        var self = this;
        var selectedIndex = 0;
        var menu = new UI.Menu({
            status: false,
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{ title: 'Options' }]
        });

        function build() {
            var entity = self.appState.ha_state_dict[self.entityId];
            if (!entity) { return; }
            var attrs = entity.attributes || {};
            var items = [];

            if (supports(entity, FEATURE.SELECT_SOURCE) && (attrs.source_list || []).length) {
                items.push({
                    title: 'Source',
                    subtitle: attrs.source || 'None',
                    on_click: function() {
                        self.showChoiceMenu('Select Source', 'source_list', 'source',
                            'select_source', 'source');
                    }
                });
            }

            if (supports(entity, FEATURE.SELECT_SOUND_MODE) && (attrs.sound_mode_list || []).length) {
                items.push({
                    title: 'Sound Mode',
                    subtitle: attrs.sound_mode || 'None',
                    on_click: function() {
                        self.showChoiceMenu('Sound Mode', 'sound_mode_list', 'sound_mode',
                            'select_sound_mode', 'sound_mode');
                    }
                });
            }

            if (supports(entity, FEATURE.PREVIOUS_TRACK)) {
                items.push({
                    title: 'Previous Track',
                    on_click: function() { self.callMedia('media_previous_track'); }
                });
            }
            if (supports(entity, FEATURE.NEXT_TRACK)) {
                items.push({
                    title: 'Next Track',
                    subtitle: 'Also hold UP',
                    on_click: function() { self.callMedia('media_next_track'); }
                });
            }
            if (supports(entity, FEATURE.STOP)) {
                items.push({
                    title: 'Stop',
                    on_click: function() { self.callMedia('media_stop'); }
                });
            }
            if (supports(entity, FEATURE.CLEAR_PLAYLIST)) {
                items.push({
                    title: 'Clear Queue',
                    on_click: function() { self.callMedia('clear_playlist'); }
                });
            }

            if (supports(entity, FEATURE.SHUFFLE_SET)) {
                items.push({
                    title: 'Shuffle',
                    subtitle: attrs.shuffle ? 'On' : 'Off',
                    on_click: function() {
                        // Read at press time: a snapshot taken when the row
                        // was built can only ever send the same value, so
                        // shuffle could be turned on but never off
                        var live = self.appState.ha_state_dict[self.entityId];
                        var on = !!(live && live.attributes && live.attributes.shuffle);
                        self.callMedia('shuffle_set', { shuffle: !on });
                    }
                });
            }
            if (supports(entity, FEATURE.REPEAT_SET)) {
                // Home Assistant allows exactly off, all and one
                var order = ['off', 'all', 'one'];
                var labels = { off: 'Off', all: 'All', one: 'This Track' };
                var shown = order.indexOf(attrs.repeat) > -1 ? attrs.repeat : 'off';
                items.push({
                    title: 'Repeat',
                    subtitle: labels[shown],
                    on_click: function() {
                        // Same reason as shuffle: cycling from a frozen value
                        // meant "one" could never be reached
                        var live = self.appState.ha_state_dict[self.entityId];
                        var now = (live && live.attributes && live.attributes.repeat) || 'off';
                        var index = order.indexOf(now);
                        if (index === -1) { index = 0; }
                        self.callMedia('repeat_set', { repeat: order[(index + 1) % order.length] });
                    }
                });
            }

            if (supports(entity, FEATURE.GROUPING)) {
                var peers = groupPeers(entity);
                items.push({
                    title: 'Play In Sync',
                    subtitle: peers.length ? peers.length + ' other player' + (peers.length > 1 ? 's' : '') : 'Not grouped',
                    on_click: function() { self.showGroupingMenu(); }
                });
                if (peers.length) {
                    items.push({
                        title: 'Leave Group',
                        on_click: function() { self.callMedia('unjoin'); }
                    });
                }
            }

            // Home Assistant counts standby as off, and an unavailable player
            // is worth neither row
            var reachable = entity.state !== 'unavailable' && entity.state !== 'unknown';
            var isOff = entity.state === 'off' || entity.state === 'standby';
            if (reachable && supports(entity, FEATURE.TURN_OFF) && !isOff) {
                items.push({
                    title: 'Turn Off',
                    on_click: function() { self.callMedia('turn_off'); }
                });
            }
            if (reachable && supports(entity, FEATURE.TURN_ON) && isOff) {
                items.push({
                    title: 'Turn On',
                    on_click: function() { self.callMedia('turn_on'); }
                });
            }

            // The generic page used to be what holding select opened, so it
            // stays reachable from here
            items.push({
                title: 'More',
                on_click: function() {
                    require('app/pages/entity/GenericEntityPage').showEntityMenu(self.entityId);
                }
            });

            menu.items(0, items);
        }

        var sub = null;
        menu.on('select', function(e) {
            selectedIndex = e.itemIndex;
            if (typeof e.item.on_click === 'function') { e.item.on_click(e); }
        });
        menu.on('show', function() {
            build();
            sub = self.subscribeRebuild(build, sub);
            setTimeout(function() {
                if (selectedIndex > 0 && selectedIndex < menu.items(0).length) {
                    menu.selection(0, selectedIndex);
                }
            }, 100);
        });
        menu.on('hide', function() { sub = self.unsubscribeMenu(sub); });
        menu.show();
    }

    /**
     * Update the media window with current state
     */
    updateMediaWindow(mediaPlayer) {
        if (!mediaPlayer) { return; }
        var appState = this.appState;

        // Media players push frequent position updates and log_message is a
        // no-op without debug, so do not stringify the entity every time
        if (Constants.debugMode) {
            helpers.log_message("MEDIA PLAYER WINDOW UPDATE " + mediaPlayer.entity_id + ": " + JSON.stringify(mediaPlayer, null, 4));
        }

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
