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

// How long the finger must hold still before the dragged volume goes out.
// Matches the native number selector so a light and a speaker settle alike.
var VOLUME_SETTLE_MS = 500;

// The speaker icon that heads the volume row
var VOLUME_ICON_W = 20;
var VOLUME_ICON_H = 13;

/**
 * Work out where this screen's furniture goes on the watch it is running on.
 *
 * Two things matter here and both were got wrong before. Every offset is
 * derived rather than written down, because the original numbers were measured
 * for a 144 point wide screen and left the bars stopping two thirds of the way
 * across an emery. And all of it is in *content* coordinates: the runtime
 * already moves the window's layer below the status bar and shortens it to
 * match, so measuring against the full screen height ran the bottom row off the
 * end of the display.
 */
function computeLayout() {
    var res = Feature.resolution();
    var isRound = Feature.round(true, false);

    // The native status bar can only ever draw the clock: Pebble's
    // StatusBarLayer has colour and separator setters and nothing for text. To
    // put the player's name up there instead, the window goes without one and
    // this draws its own header, the way the menus do. With no status bar the
    // runtime stops offsetting and shortening the content layer, so the whole
    // screen is ours and nothing has to be adjusted for it.
    var statusH = 0;
    var contentH = res.y;
    var pad = Math.max(5, Math.round(res.x * 0.045));

    var left, right, safeTop, bottom;
    if (isRound) {
        // The largest square that fits the circle. A flat margin looks right
        // across the middle, where the display is widest, and then clips the
        // top and bottom rows.
        var side = Math.floor((res.x / 2) * Math.SQRT2);
        var inset = Math.ceil((res.x - side) / 2);
        left = inset;
        right = Math.min(res.x - inset, res.x - Feature.actionBarWidth() - pad);
        safeTop = inset;
        bottom = res.y - inset;
    } else {
        left = pad;
        right = res.x - Feature.actionBarWidth() - pad;
        safeTop = 0;
        bottom = contentH - pad;
    }

    // Keyed on the height actually available rather than the width, so chalk
    // does not get emery's type in two thirds of the room
    var big = contentH >= 200;
    var barH = big ? 10 : 7;

    var L = {
        isRound: isRound,
        statusH: statusH,
        contentH: contentH,
        left: left,
        width: Math.max(20, right - left),
        bottom: bottom,
        align: isRound ? 'center' : 'left',
        // Line boxes are the system font's line height plus a little; sizing
        // them any tighter clips descenders on the watch
        titleFont: big ? 'gothic_24_bold' : 'gothic_18_bold',
        titleLine: big ? 30 : 23,
        bodyFont: big ? 'gothic_18' : 'gothic_14',
        bodyLine: big ? 23 : 18,
        smallFont: 'gothic_14',
        smallLine: 18,
        barH: barH,
        barRadius: Math.floor(barH / 2),
        // A finger is far wider than a seven point bar, so touches count from
        // a band around it rather than the drawn rectangle
        touchSlop: big ? 14 : 10,
        gap: big ? 10 : 6
    };

    // The header runs flush across the top on a rectangle, and sits inside the
    // safe square on a round display where the very top is barely there
    L.headerH = L.smallLine + 4;
    L.headerTop = safeTop;
    L.headerX = isRound ? left : 0;
    L.headerW = isRound ? L.width : res.x - Feature.actionBarWidth();
    L.headerAlign = isRound ? 'center' : 'left';
    L.headerTextX = L.headerX + (isRound ? 0 : pad);
    L.headerTextW = Math.max(20, L.headerW - (isRound ? 0 : pad));

    // Everything else begins below it
    L.top = L.headerTop + L.headerH + (isRound ? L.gap : pad);
    return L;
}

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
 * Where playback has reached right now, in seconds.
 *
 * media_position is a snapshot taken at media_position_updated_at, not a live
 * value: Home Assistant only republishes it when playback jumps, so between
 * updates the elapsed time has to be added here or the bar sits still through
 * an entire track. Only a playing player advances; paused and buffering hold
 * where they are. Without the timestamp there is nothing to measure from, so
 * the snapshot is used as-is rather than producing NaN.
 */
function currentPosition(entity) {
    var attrs = (entity && entity.attributes) || {};
    var position = attrs.media_position;
    if (entity.state !== 'playing' || !attrs.media_position_updated_at) {
        return position;
    }
    var updatedAt = new Date(attrs.media_position_updated_at).getTime();
    if (isNaN(updatedAt)) { return position; }

    // Clocks on the phone and the server drift, and a timestamp slightly in
    // the future would otherwise wind the counter backwards
    var elapsed = (Date.now() - updatedAt) / 1000;
    var current = position + elapsed;
    if (current < 0) { current = 0; }
    if (typeof attrs.media_duration === 'number' && current > attrs.media_duration) {
        current = attrs.media_duration;
    }
    return current;
}

/**
 * Whether the thing currently playing has a place in it worth showing.
 *
 * Home Assistant only publishes media_position and media_duration when the
 * item actually has them, so a live stream, a radio station or an idle player
 * simply carries neither. A duration of zero means the same thing. Note this
 * is deliberately not the SEEK feature bit: that says the player is able to
 * jump around, which is neither necessary nor sufficient for there being a
 * position to draw.
 */
function hasPlaybackPosition(entity) {
    var attrs = (entity && entity.attributes) || {};
    return typeof attrs.media_position === 'number' &&
           typeof attrs.media_duration === 'number' &&
           attrs.media_duration > 0;
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
        this.position_ticker = null;
        this.layout_key = null;
        this.dragging = null;
        this.dragRatio = 0;
        this.volume_settle = null;
        this.volume_sent = null;
        this.volume_hit_top = null;
        this.seek_hit_top = null;
    }

    /** The unfilled groove of a bar. */
    makeTrack() {
        var L = this.layout;
        return new UI.Rect({
            position: new Vector(L.left, L.top),
            size: new Vector(L.width, L.barH),
            backgroundColor: 'white',
            borderColor: 'black',
            borderWidth: 1,
            radius: L.barRadius
        });
    }

    /** The filled part of a bar, drawn over the groove. */
    makeFill(colour) {
        var L = this.layout;
        return new UI.Rect({
            position: new Vector(L.left, L.top),
            size: new Vector(0, L.barH),
            backgroundColor: colour,
            borderColor: 'clear',
            borderWidth: 0,
            radius: L.barRadius
        });
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
            // No native status bar: it can only draw the clock, and this page
            // would rather say which player you are looking at
            status: false,
            backgroundColor: "white",
            action: {
                up: "IMAGE_ICON_VOLUME_UP",
                select: "IMAGE_ICON_PLAYPAUSE",
                down: "IMAGE_ICON_VOLUME_DOWN",
            }
        });

        var L = this.layout = computeLayout();
        var accent = Feature.color(Constants.colour.highlight, "black");

        this.trackTitle = new UI.Text({
            text: "",
            color: accent,
            font: L.titleFont,
            position: new Vector(L.left, L.top),
            size: new Vector(L.width, L.titleLine),
            textAlign: L.align,
            textOverflow: 'ellipsis'
        });

        this.trackArtist = new UI.Text({
            text: "",
            color: "black",
            font: L.bodyFont,
            position: new Vector(L.left, L.top),
            size: new Vector(L.width, L.bodyLine),
            textAlign: L.align,
            textOverflow: 'ellipsis'
        });

        // Both bars are a rounded track with a fill, rather than the three
        // overlapping lines that used to fake one at a fixed three points thick
        this.position_bar_bg = this.makeTrack();
        this.position_bar_fg = this.makeFill(accent);

        this.time_elapsed = new UI.Text({
            text: "",
            color: "black",
            font: L.smallFont,
            position: new Vector(L.left, L.top),
            size: new Vector(Math.floor(L.width / 2), L.smallLine),
            textAlign: "left",
            textOverflow: 'ellipsis'
        });

        this.time_total = new UI.Text({
            text: "",
            color: "black",
            font: L.smallFont,
            position: new Vector(L.left + Math.ceil(L.width / 2), L.top),
            size: new Vector(Math.floor(L.width / 2), L.smallLine),
            textAlign: "right",
            textOverflow: 'ellipsis'
        });

        this.volume_bar_bg = this.makeTrack();
        this.volume_bar_fg = this.makeFill(accent);

        // Sits at the head of the volume row, directly above the left end of
        // the volume bar, so the lower of the two bars says what it is rather
        // than leaving the reader to work it out from which one moves.
        //
        // Read from Constants, not appState: enableIcons only ever existed on
        // Constants and is never copied onto the state, so the old check was
        // undefined every time and this icon has never once been drawn.
        if (Constants.enableIcons) {
            this.muteIcon = new UI.Image({
                position: new Vector(L.left, L.top),
                size: new Vector(VOLUME_ICON_W, VOLUME_ICON_H),
                compositing: "set",
                backgroundColor: 'transparent',
                image: mediaPlayer.attributes.is_volume_muted
                    ? "IMAGE_ICON_MUTED" : "IMAGE_ICON_UNMUTED"
            });
        }

        this.volume_label = new UI.Text({
            text: "",
            color: "black",
            font: L.smallFont,
            position: new Vector(L.left, L.top),
            size: new Vector(L.width, L.smallLine),
            textAlign: "right",
            textOverflow: 'ellipsis'
        });

        // The page header: which player this is, in the same colours the menus
        // give their section headers so the two read as the same furniture
        this.headerBar = new UI.Rect({
            position: new Vector(L.headerX, L.headerTop),
            size: new Vector(L.headerW, L.headerH),
            backgroundColor: Constants.colour.highlight,
            borderColor: 'clear',
            borderWidth: 0
        });

        this.entityLabel = new UI.Text({
            text: "",
            color: Constants.colour.highlight_text,
            font: L.smallFont,
            position: new Vector(L.headerTextX, L.headerTop + 2),
            size: new Vector(L.headerTextW, L.smallLine),
            textAlign: L.headerAlign,
            // A header is one line by definition. Left to wrap, a name like
            // "home-assistant-voice-0930d1 Media Player" put its tail on a
            // second line that reads as though it belongs to something else.
            textOverflow: 'ellipsis'
        });

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

        // Added once. These used to be re-added on every state update, and
        // since adding an element that is already on the window removes and
        // re-appends it, every position tick resent the whole screen.
        this.mediaControlWindow.add(this.headerBar);
        this.mediaControlWindow.add(this.trackTitle);
        this.mediaControlWindow.add(this.volume_bar_bg);
        this.mediaControlWindow.add(this.volume_bar_fg);
        this.mediaControlWindow.add(this.volume_label);
        this.mediaControlWindow.add(this.entityLabel);
        if (this.muteIcon) {
            this.mediaControlWindow.add(this.muteIcon);
        }

        // Dragging a bar with a finger, on the watches that have a digitizer.
        // The raw touch stream is used rather than tap, because a tap only
        // arrives on liftoff and the fill should follow the finger. Returning
        // false consumes the event so it cannot also become a swipe: letting it
        // through would have a drag along the volume bar read as a back
        // gesture and close the page.
        this.mediaControlWindow.on('touch', 'down', function(e) {
            var which = self.hitTestBars(e.position.x, e.position.y);
            if (!which) { return; }
            return self.beginDrag(which, e.position.x) ? false : undefined;
        });

        this.mediaControlWindow.on('touch', 'move', function(e) {
            if (!self.dragging) { return; }
            self.dragRatio = self.ratioAt(e.position.x);
            self.previewDrag();
            return false;
        });

        this.mediaControlWindow.on('touch', 'up', function(e) {
            if (!self.dragging) { return; }
            self.dragRatio = self.ratioAt(e.position.x);
            self.previewDrag();
            self.commitDrag();
            return false;
        });
        // The artist line and the progress row are added by applyLayout once
        // the state says there is something to put in them. Left unset so the
        // first call always places the stack, whatever it decides to show.
        this.layout_key = null;

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
            self.stopPositionTicker();
            // A finger still down when the window goes away must not leave the
            // next visit thinking it is mid drag, nor a settle timer firing a
            // volume change at a page that is gone
            self.cancelVolumeSettle();
            self.dragging = null;
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
     * Place the stack for what this player currently has to show.
     *
     * The title, the artist and the progress row each come and go depending on
     * the item, so the block is measured and then centred in the space above
     * the footer rather than pinned to fixed offsets. That keeps a bare player
     * from hugging the top of a tall screen and stops a hole appearing where
     * the progress used to be.
     */
    applyLayout(hasArtist, hasPosition) {
        var key = (hasArtist ? 'a' : '-') + (hasPosition ? 'p' : '-');
        if (this.layout_key === key) { return; }
        this.layout_key = key;

        var L = this.layout;
        var win = this.mediaControlWindow;

        // The volume row is pinned to the bottom of the safe area so it stays
        // where the finger expects it, whatever else the player is showing
        var volBarTop = L.bottom - L.barH;
        var volLabelTop = volBarTop - L.smallLine;
        this.volume_bar_bg.position(new Vector(L.left, volBarTop));
        this.volume_bar_fg.position(new Vector(L.left, volBarTop));
        this.volume_label.position(new Vector(L.left, volLabelTop));
        if (this.muteIcon) {
            // Centred against the row's text so it reads as part of the line
            this.muteIcon.position(new Vector(L.left,
                volLabelTop + Math.max(0, Math.round((L.smallLine - VOLUME_ICON_H) / 2))));
        }
        this.volume_hit_top = volBarTop;

        // Everything above it is measured and then centred in what is left, so
        // a player with nothing to say does not hug the top of a tall screen
        var upperTop = L.top;
        var upperBottom = volLabelTop - L.gap;
        var room = upperBottom - upperTop;

        function blockHeight(titleLines, artist, times) {
            var h = L.titleLine * titleLines;
            if (artist) { h += L.bodyLine; }
            if (hasPosition) { h += L.gap + L.barH + (times ? L.smallLine : 0); }
            return h;
        }

        // Shed content until it fits rather than letting it run off the bottom,
        // giving up the least useful thing first. A chalk showing a track with
        // an artist genuinely does not have the room for all of it.
        var titleLines = 2, showArtist = hasArtist, showTimes = hasPosition;
        function fits() { return blockHeight(titleLines, showArtist, showTimes) <= room; }
        if (!fits()) { titleLines = 1; }
        if (!fits() && showArtist) { showArtist = false; }
        if (!fits() && showTimes) { showTimes = false; }

        var titleH = L.titleLine * titleLines;
        var y = upperTop + Math.max(0,
            Math.floor((room - blockHeight(titleLines, showArtist, showTimes)) / 2));

        this.trackTitle.size(new Vector(L.width, titleH));
        this.trackTitle.position(new Vector(L.left, y));
        y += titleH;

        if (showArtist) {
            win.add(this.trackArtist);
            this.trackArtist.position(new Vector(L.left, y));
            y += L.bodyLine;
        } else {
            win.remove(this.trackArtist);
        }

        var bars = [this.position_bar_bg, this.position_bar_fg];
        var times = [this.time_elapsed, this.time_total];
        if (hasPosition) {
            y += L.gap;
            this.position_bar_bg.position(new Vector(L.left, y));
            this.position_bar_fg.position(new Vector(L.left, y));
            this.seek_hit_top = y;
            y += L.barH;
            for (var i = 0; i < bars.length; i++) { win.add(bars[i]); }
            // The bar carries the meaning; the two timestamps are the first
            // thing to go when the screen cannot hold everything
            for (var t = 0; t < times.length; t++) {
                if (showTimes) {
                    times[t].position(new Vector(
                        L.left + (t === 0 ? 0 : Math.ceil(L.width / 2)), y));
                    win.add(times[t]);
                } else {
                    win.remove(times[t]);
                }
            }
        } else {
            this.seek_hit_top = null;
            for (var j = 0; j < bars.length; j++) { win.remove(bars[j]); }
            for (var k = 0; k < times.length; k++) { win.remove(times[k]); }
        }
    }

    /**
     * Which bar, if either, a touch at this point belongs to.
     *
     * Touch arrives in screen coordinates while elements live in the content
     * layer below the status bar, so the two have to be brought into the same
     * space before anything is compared. The band is grown by a slop either
     * side because a fingertip is far wider than the bar it is aiming at.
     */
    hitTestBars(x, y) {
        var L = this.layout;
        var cy = y - L.statusH;
        if (x < L.left - L.touchSlop || x > L.left + L.width + L.touchSlop) { return null; }

        function within(top) {
            return top !== null && top !== undefined &&
                   cy >= top - L.touchSlop && cy <= top + L.barH + L.touchSlop;
        }
        if (within(this.volume_hit_top)) { return 'volume'; }
        if (within(this.seek_hit_top)) { return 'seek'; }
        return null;
    }

    /** Where along a bar a touch fell, as a fraction from 0 to 1. */
    ratioAt(x) {
        var L = this.layout;
        var ratio = (x - L.left) / L.width;
        if (ratio < 0) { ratio = 0; }
        if (ratio > 1) { ratio = 1; }
        return ratio;
    }

    /**
     * Drive a bar from a finger.
     *
     * The fill follows the finger immediately so the bar feels attached to it.
     * Volume also goes out while the finger is still down, once it has held
     * still long enough to mean it, so the room follows the drag instead of
     * waiting for release; sending one per move event would put a burst of
     * volume_set calls through a Bluetooth link that can barely keep up with
     * one. Seeking stays on release, since a scrub that fires mid drag makes
     * the player chase every position it passes.
     */
    beginDrag(which, x) {
        var current = this.appState.ha_state_dict[this.entityId];
        if (which === 'volume' && !supports(current, FEATURE.VOLUME_SET)) { return false; }
        if (which === 'seek') {
            if (!supports(current, FEATURE.SEEK) || !hasPlaybackPosition(current)) { return false; }
        }
        this.dragging = which;
        this.dragRatio = this.ratioAt(x);
        if (which === 'volume') {
            var level = current && current.attributes && current.attributes.volume_level;
            this.volume_sent = typeof level === 'number' ? level : null;
        }
        this.previewDrag();
        return true;
    }

    /**
     * Send the volume once the finger has stopped moving. Restarted on every
     * move, so a drag across the bar sends where it landed rather than every
     * point it crossed.
     */
    scheduleVolume() {
        var self = this;
        if (this.volume_settle) { clearTimeout(this.volume_settle); }
        this.volume_settle = setTimeout(function() {
            self.volume_settle = null;
            self.sendVolume();
        }, VOLUME_SETTLE_MS);
    }

    /** Push the dragged volume, unless the player is already there. */
    sendVolume() {
        var level = Math.round(this.dragRatio * 100) / 100;
        if (this.volume_sent !== null && Math.abs(this.volume_sent - level) < 0.005) { return; }
        this.volume_sent = level;
        this.appState.haws.mediaPlayerVolumeSet(this.entityId, level);
    }

    cancelVolumeSettle() {
        if (this.volume_settle) {
            clearTimeout(this.volume_settle);
            this.volume_settle = null;
        }
    }

    previewDrag() {
        var L = this.layout;
        var fill = this.dragging === 'volume' ? this.volume_bar_fg : this.position_bar_fg;
        fill.size(new Vector(Math.round(L.width * this.dragRatio), L.barH));

        if (this.dragging === 'volume') {
            this.volume_label.text(Math.round(this.dragRatio * 100) + "%");
            this.scheduleVolume();
        } else {
            var entity = this.appState.ha_state_dict[this.entityId];
            var duration = entity && entity.attributes && entity.attributes.media_duration;
            if (duration) { this.time_elapsed.text(secToTime(duration * this.dragRatio)); }
        }
    }

    commitDrag() {
        var which = this.dragging;
        if (!which) { return; }
        this.dragging = null;

        var appState = this.appState;
        var entity = appState.ha_state_dict[this.entityId];
        if (which === 'volume') {
            // Release is the final word on where the finger left the bar, so
            // it goes out now rather than waiting on the settle timer
            this.cancelVolumeSettle();
            this.sendVolume();
        } else {
            var duration = entity && entity.attributes && entity.attributes.media_duration;
            if (!duration) { return; }
            appState.haws.mediaPlayerSeek(this.entityId, Math.round(duration * this.dragRatio));
        }
        Vibe.vibrate('short');
    }

    /**
     * Update the media window with current state
     */
    updateMediaWindow(mediaPlayer) {
        if (!mediaPlayer) { return; }
        var L = this.layout;
        var attrs = mediaPlayer.attributes || {};

        // Media players push frequent position updates and log_message is a
        // no-op without debug, so do not stringify the entity every time
        if (Constants.debugMode) {
            helpers.log_message("MEDIA PLAYER WINDOW UPDATE " + mediaPlayer.entity_id + ": " + JSON.stringify(mediaPlayer, null, 4));
        }

        // What is playing, falling back to the player itself when it is idle
        // or the integration reports no title
        var name = attrs.friendly_name || mediaPlayer.entity_id;
        // The player is named in the header, so an untitled one says what it is
        // doing rather than repeating that name back
        var title = attrs.media_title ||
                    helpers.ucwords(String(mediaPlayer.state || '').replace(/_/g, ' '));
        // Music has an artist, television has a series, and either is the right
        // second line for what it is
        var subtitle = attrs.media_artist || attrs.media_series_title ||
                       attrs.media_album_name || "";

        this.trackTitle.text(title);
        this.trackArtist.text(subtitle);
        this.entityLabel.text(name);

        var hasPosition = hasPlaybackPosition(mediaPlayer);
        this.applyLayout(!!subtitle, hasPosition);

        if (this.muteIcon) {
            this.muteIcon.image(attrs.is_volume_muted ? "IMAGE_ICON_MUTED" : "IMAGE_ICON_UNMUTED");
        }

        // A finger already on the bar wins over the state coming back, or the
        // fill would jump about underneath it mid drag
        if (this.dragging !== 'volume') {
            var level = typeof attrs.volume_level === 'number' ? attrs.volume_level : 0;
            this.volume_bar_fg.size(new Vector(Math.round(L.width * level), L.barH));
            this.volume_label.text(attrs.is_volume_muted ? "Muted" : Math.round(level * 100) + "%");
        }

        this.drawPosition(mediaPlayer);

        // Only a playing track moves on its own; anything else stays where the
        // last update left it and needs no ticking
        if (hasPosition && mediaPlayer.state === 'playing') {
            this.startPositionTicker(mediaPlayer);
        } else {
            this.stopPositionTicker();
        }
    }

    /**
     * Paint the progress bar and its labels from the position as of right now.
     */
    drawPosition(mediaPlayer) {
        if (!hasPlaybackPosition(mediaPlayer)) { return; }
        if (this.dragging === 'seek') { return; }

        var L = this.layout;
        var duration = mediaPlayer.attributes.media_duration;
        var position = currentPosition(mediaPlayer);

        var positionRatio = position / duration;
        if (positionRatio < 0) { positionRatio = 0; }
        if (positionRatio > 1) { positionRatio = 1; }
        this.position_bar_fg.size(new Vector(Math.round(L.width * positionRatio), L.barH));

        this.time_elapsed.text(secToTime(position));
        this.time_total.text(secToTime(duration));
    }

    startPositionTicker(mediaPlayer) {
        var self = this;
        this.stopPositionTicker();
        this.position_ticker = setInterval(function() {
            // Read the entity fresh each tick so a track change that has not
            // reached us yet cannot keep an old duration on screen
            var current = self.appState.ha_state_dict[self.entityId] || mediaPlayer;
            self.drawPosition(current);
        }, 1000);
    }

    stopPositionTicker() {
        if (this.position_ticker) {
            clearInterval(this.position_ticker);
            this.position_ticker = null;
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
