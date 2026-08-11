var Emitter = require('emitter');

var Touch = new Emitter();

module.exports = Touch;

// Required after the export on purpose: ui/window requires ui/touch back, and
// this is how ui/accel breaks the same cycle.
var Vector2 = require('vector2');
var Platform = require('platform');
var WindowStack = require('ui/windowstack');
var Window = require('ui/window');
var simply = require('ui/simply');

// Platforms with a digitizer. Everything else has the whole subsystem compiled
// out of the C runtime, so we never send it a config packet.
var touchPlatforms = ['emery', 'flint', 'gabbro'];

// A finger that moves less than this between touchdown and liftoff is a tap.
var TAP_SLOP = 10;

// ...and one that moves at least this far is a swipe. The gap between the two
// is deliberately dead: an ambiguous smear should do nothing rather than guess,
// because guessing wrong fires a real action on someone's house.
var SWIPE_MIN = 30;

// A finger held down longer than this is not a gesture any more. Without this a
// touchdown whose liftoff got dropped would pair with the NEXT liftoff and
// synthesize a swipe across the whole screen.
var GESTURE_MAX_MS = 2000;

var state;

Touch.init = function() {
  if (state) {
    Touch.off();
  }

  state = Touch.state = {
    subscribed: false,
    subscribeMode: 'auto',
    wantsMoves: false,
    down: null,
  };
};

Touch.supported = function() {
  return touchPlatforms.indexOf(Platform.version()) !== -1;
};

var touchListenerCount = function() {
  var count = Touch.listenerCount('tap') +
              Touch.listenerCount('swipe') +
              Touch.listenerCount('touch');
  var wind = WindowStack.top();
  if (wind) {
    count += wind.listenerCount('tap') +
             wind.listenerCount('swipe') +
             wind.listenerCount('touch');
  }
  return count;
};

Touch.autoSubscribe = function() {
  if (state.subscribeMode !== 'auto') { return; }
  var subscribe = (touchListenerCount() > 0);
  if (subscribe !== state.subscribed) {
    return Touch.config(subscribe, true);
  }
};

/**
 * The touch configuration parameter for {@link simply.touchConfig}.
 * The touch digitizer is powered while subscribed, so Pebble.js subscribes and
 * unsubscribes automatically based on how many tap/swipe/touch handlers the
 * visible window has registered.
 * @typedef {object} simply.touchConf
 * @property {boolean} [subscribed] - Whether to receive touch events.
 * @property {boolean} [wantsMoves] - Whether to also receive continuous 'move'
 *   events while a finger is down. Off by default because they fire fast enough
 *   to saturate the AppMessage link; taps and swipes do not need them.
 */
Touch.config = function(opt, auto) {
  if (arguments.length === 0) {
    return {
      subscribed: state.subscribed,
      wantsMoves: state.wantsMoves,
    };
  } else if (typeof opt === 'boolean') {
    opt = { subscribed: opt };
  }
  for (var k in opt) {
    if (k === 'subscribed') {
      state.subscribeMode = opt[k] && !auto ? 'manual' : 'auto';
    }
    state[k] = opt[k];
  }
  if (!Touch.supported()) {
    return;
  }
  return simply.impl.touchConfig(Touch.config());
};

/**
 * Pebble.js tap event, emitted when a finger lands and lifts in the same place.
 * Use the event type 'tap' to subscribe to these events.
 * @typedef simply.tapEvent
 * @property {Vector2} position - Where the tap landed, in window coordinates.
 */

/**
 * Pebble.js swipe event.
 * Use the event type 'swipe' to subscribe to these events. The direction
 * ('up', 'down', 'left' or 'right') is also the event subtype.
 * @typedef simply.swipeEvent
 * @property {string} direction - The direction the finger travelled.
 * @property {Vector2} position - Where the finger lifted off.
 */

Touch.emitTouchData = function(type, x, y) {
  var position = new Vector2(x, y);
  var e = {
    type: type,
    position: position,
  };

  // Raw events first, so a window that wants to do its own gesture work can
  // consume them and return false to suppress the derived tap/swipe.
  if (Window.emit('touch', type, e) === false) {
    return false;
  }
  Touch.emit('touch', type, e);

  if (type === 'down') {
    state.down = { x: x, y: y, time: new Date().getTime() };
    return;
  }
  if (type !== 'up') {
    return;
  }

  var down = state.down;
  state.down = null;
  if (!down) { return; }
  if (new Date().getTime() - down.time > GESTURE_MAX_MS) { return; }

  var dx = x - down.x;
  var dy = y - down.y;
  var adx = Math.abs(dx);
  var ady = Math.abs(dy);

  if (adx < TAP_SLOP && ady < TAP_SLOP) {
    return Touch.emitTap(position);
  }
  if (Math.max(adx, ady) < SWIPE_MIN) { return; }

  var direction = (adx > ady) ? (dx > 0 ? 'right' : 'left')
                              : (dy > 0 ? 'down' : 'up');
  return Touch.emitSwipe(direction, position);
};

Touch.emitTap = function(position) {
  var e = {
    position: position,
  };
  if (Window.emit('tap', null, e) === false) {
    return false;
  }
  Touch.emit('tap', e);
};

Touch.emitSwipe = function(direction, position) {
  var e = {
    direction: direction,
    position: position,
  };
  if (Window.emit('swipe', direction, e) === false) {
    return false;
  }
  Touch.emit('swipe', direction, e);
};

Touch.init();
