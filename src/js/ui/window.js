var util2 = require('util2');
var myutil = require('myutil');
var safe = require('safe');
var Emitter = require('emitter');
var Vector2 = require('vector2');
var Feature = require('platform/feature');
var Accel = require('ui/accel');
var WindowStack = require('ui/windowstack');
var Propable = require('ui/propable');
var Stage = require('ui/stage');
var simply = require('ui/simply');

var buttons = [
  'back',
  'up',
  'select',
  'down',
];

var configProps = [
  'fullscreen',
  'style',
  'scrollable',
  'paging',
  'backgroundColor',
];

var statusProps = [
  'status',
  'separator',
  'color',
  'backgroundColor',
];

var actionProps = [
  'action',
  'up',
  'select',
  'back',
  'backgroundColor',
];

var accessorProps = configProps;

var nestedProps = [
  'action',
  'status',
];

var defaults = {
  status: false,
  backgroundColor: 'black',
  scrollable: false,
  paging: Feature.round(true, false),
};

var nextId = 1;

var checkProps = function(def) {
  if (!def) return;
  if ('fullscreen' in def && safe.warnFullscreen !== false) {
    safe.warn('`fullscreen` has been deprecated by `status` which allows settings\n\t' +
              'its color and separator in a similar manner to the `action` property.\n\t' +
              'Remove usages of `fullscreen` to enable usage of `status`.', 2);
    safe.warnFullscreen = false;
  }
};

var Window = function(windowDef) {
  checkProps(windowDef);
  this.state = myutil.shadow(defaults, windowDef || {});
  this.state.id = nextId++;
  this._buttonInit();
  this._items = [];
  this._dynamic = true;
  this._size = new Vector2();
  this.size(); // calculate and set the size
};

Window._codeName = 'window';

util2.copy(Emitter.prototype, Window.prototype);

util2.copy(Propable.prototype, Window.prototype);

util2.copy(Stage.prototype, Window.prototype);

Propable.makeAccessors(accessorProps, Window.prototype);

Propable.makeNestedAccessors(nestedProps, Window.prototype);

Window.prototype._id = function() {
  return this.state.id;
};

Window.prototype._prop = function(def, clear, pushing) {
  checkProps(def);
  Stage.prototype._prop.call(this, def, clear, pushing);
};

// Required lazily rather than at the top of the file: ui/touch requires
// ui/window straight back, and window.js does not assign module.exports until
// its last line, so a top-level require here would hand ui/touch a half-built
// module depending on which of the two node loaded first.
Window.prototype._touchAutoConfig = function() {
  require('ui/touch').autoSubscribe();
};

Window.prototype._hide = function(broadcast) {
  if (broadcast === false) { return; }
  simply.impl.windowHide(this._id());
  // This window is going away, so the window below it decides whether the
  // digitizer stays powered.
  this._touchAutoConfig();
};

Window.prototype.hide = function() {
  WindowStack.remove(this, true);
  return this;
};

Window.prototype._show = function(pushing) {
  this._prop(this.state, true, pushing || false);
  this._buttonConfig({});
  if (this._dynamic) {
    Stage.prototype._show.call(this, pushing);
  }
  this._touchAutoConfig();
};

Window.prototype.show = function() {
  WindowStack.push(this);
  return this;
};

Window.prototype._insert = function() {
  if (this._dynamic) {
    Stage.prototype._insert.apply(this, arguments);
  }
};

Window.prototype._remove = function() {
  if (this._dynamic) {
    Stage.prototype._remove.apply(this, arguments);
  }
};

Window.prototype._clearStatus = function() {
  statusProps.forEach(Propable.unset.bind(this.state.status));
};

Window.prototype._clearAction = function() {
  actionProps.forEach(Propable.unset.bind(this.state.action));
};

Window.prototype._clear = function(flags_) {
  var flags = myutil.toFlags(flags_);
  if (myutil.flag(flags, 'action')) {
    this._clearAction();
  }
  if (myutil.flag(flags, 'status')) {
    this._clearStatus();
  }
  if (flags_ === true || flags_ === undefined) {
    Propable.prototype._clear.call(this);
  }
};

Window.prototype._action = function(actionDef) {
  if (this === WindowStack.top()) {
    simply.impl.windowActionBar(actionDef);
  }
};

Window.prototype._status = function(statusDef) {
  if (this === WindowStack.top()) {
    simply.impl.windowStatusBar(statusDef);
  }
};

// Registering any of these on a window is what powers the touch digitizer on.
var touchEvents = [
  'tap',
  'swipe',
  'touch',
];

var isBackEvent = function(type, subtype) {
  return ((type === 'click' || type === 'longClick') && subtype === 'back');
};

Window.prototype.onAddHandler = function(type, subtype) {
  if (isBackEvent(type, subtype)) {
    this._buttonAutoConfig();
  }
  if (type === 'accelData') {
    Accel.autoSubscribe();
  }
  if (touchEvents.indexOf(type) !== -1) {
    this._touchAutoConfig();
  }
};

Window.prototype.onRemoveHandler = function(type, subtype) {
  if (!type || isBackEvent(type, subtype)) {
    this._buttonAutoConfig();
  }
  if (!type || type === 'accelData') {
    Accel.autoSubscribe();
  }
  if (!type || touchEvents.indexOf(type) !== -1) {
    this._touchAutoConfig();
  }
};

Window.prototype._buttonInit = function() {
  this._button = {
    config: {},
    configMode: 'auto',
  };
  for (var i = 0, ii = buttons.length; i < ii; i++) {
    var button = buttons[i];
    if (button !== 'back') {
      this._button.config[buttons[i]] = true;
    }
  }
};

/**
 * The button configuration parameter for {@link simply.buttonConfig}.
 * The button configuration allows you to enable to disable buttons without having to register or unregister handlers if that is your preferred style.
 * You may also enable the back button manually as an alternative to registering a click handler with 'back' as its subtype using {@link simply.on}.
 * @typedef {object} simply.buttonConf
 * @property {boolean} [back] - Whether to enable the back button. Initializes as false. Simply.js can also automatically register this for you based on the amount of click handlers with subtype 'back'.
 * @property {boolean} [up] - Whether to enable the up button. Initializes as true. Note that this is disabled when using {@link simply.scrollable}.
 * @property {boolean} [select] - Whether to enable the select button. Initializes as true.
 * @property {boolean} [down] - Whether to enable the down button. Initializes as true. Note that this is disabled when using {@link simply.scrollable}.
 */

/**
 * Changes the button configuration.
 * See {@link simply.buttonConfig}
 * @memberOf simply
 * @param {simply.buttonConfig} buttonConf - An object defining the button configuration.
 */
Window.prototype._buttonConfig = function(buttonConf, auto) {
  if (buttonConf === undefined) {
    var config = {};
    for (var i = 0, ii = buttons.length; i < ii; ++i) {
      var name = buttons[i];
      config[name] = this._button.config[name];
    }
    return config;
  }
  for (var k in buttonConf) {
    if (buttons.indexOf(k) !== -1) {
      if (k === 'back') {
        this._button.configMode = buttonConf.back && !auto ? 'manual' : 'auto';
      }
      this._button.config[k] = buttonConf[k];
    }
  }
  if (simply.impl.windowButtonConfig) {
    return simply.impl.windowButtonConfig(this._button.config);
  }
};

Window.prototype.buttonConfig = function(buttonConf) {
  this._buttonConfig(buttonConf);
};

Window.prototype._buttonAutoConfig = function() {
  if (!this._button || this._button.configMode !== 'auto') {
    return;
  }
  var singleBackCount = this.listenerCount('click', 'back');
  var longBackCount = this.listenerCount('longClick', 'back');
  var useBack = singleBackCount + longBackCount > 0;
  if (useBack !== this._button.config.back) {
    this._button.config.back = useBack;
    return this._buttonConfig(this._button.config, true);
  }
};

Window.prototype.size = function() {
  var state = this.state;
  var size = this._size.copy(Feature.resolution());
  if ('status' in state && state.status !== false) {
    size.y -= Feature.statusBarHeight();
  } else if ('fullscreen' in state && state.fullscreen === false) {
    size.y -= Feature.statusBarHeight();
  }
  if ('action' in state && state.action !== false) {
    size.x -= Feature.actionBarWidth();
  }
  return size;
};

/**
 * Finds the topmost element whose box contains a point, which is how a tap
 * coordinate becomes "the tile the user meant".
 *
 * Elements are hit-tested in reverse insertion order because that is the order
 * they are drawn in: the last one inserted is painted last and therefore sits
 * on top.
 *
 * The point is in window coordinates. On a scrollable window those are NOT
 * element coordinates once the content has been scrolled, and Pebble.js does
 * not report the content offset back to JS, so callers that need reliable hit
 * testing should use a non-scrolling window.
 *
 * @param {Vector2} pos - The point to test, typically a tap event's position.
 * @param {function} [filter] - Optional predicate; only elements it returns
 *   true for are considered, so a tile grid can ignore its own background.
 * @returns {StageElement|null}
 */
Window.prototype.elementAt = function(pos, filter) {
  if (!pos) { return null; }
  for (var i = this._items.length - 1; i >= 0; --i) {
    var element = this._items[i];
    var position = element.state.position;
    var size = element.state.size;
    if (!position || !size) { continue; }
    if (pos.x < position.x || pos.x >= position.x + size.x) { continue; }
    if (pos.y < position.y || pos.y >= position.y + size.y) { continue; }
    if (filter && !filter(element)) { continue; }
    return element;
  }
  return null;
};

Window.prototype._toString = function() {
  return '[' + this.constructor._codeName + ' ' + this._id() + ']';
};

Window.prototype._emit = function(type, subtype, e) {
  e.window = this;
  var klass = this.constructor;
  if (klass) {
    e[klass._codeName] = this;
  }
  if (this.emit(type, subtype, e) === false) {
    return false;
  }
};

Window.prototype._emitShow = function(type) {
  return this._emit(type, null, {});
};

Window.emit = function(type, subtype, e) {
  var wind = WindowStack.top();
  if (wind) {
    return wind._emit(type, subtype, e);
  }
};

/**
 * Simply.js button click event. This can either be a single click or long click.
 * Use the event type 'click' or 'longClick' to subscribe to these events.
 * @typedef simply.clickEvent
 * @property {string} button - The button that was pressed: 'back', 'up', 'select', or 'down'. This is also the event subtype.
 */

Window.emitClick = function(type, button) {
  var e = {
    button: button,
  };
  return Window.emit(type, button, e);
};

module.exports = Window;
