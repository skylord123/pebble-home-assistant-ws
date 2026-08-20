var simply = require('ui/simply');

/**
 * NumberField - generic native number selector
 *
 * The selector window runs entirely on the watch (simply_number.c):
 * up/down adjust by the entity's step with hold-to-repeat and
 * acceleration, with no Bluetooth round trip per press. Values cross the
 * wire as integers scaled by 10^decimals; this module owns that scaling
 * so callers and the C side both deal in their natural units.
 *
 * NumberField.show({ title, unit, value, min, max, step, decimals,
 *                    showBar, onSet, onCancel })
 *   onSet(value)  - select was pressed; perform the action and call
 *                   NumberField.hide() on success (the selector stays up
 *                   on failure so the user can retry)
 *   onCancel()    - the selector left the screen without a successful
 *                   set (back button, or something covered it)
 *
 * NumberField.value(v) - update the displayed value from outside (e.g. a
 * state subscription); ignored by the watch while the user is actively
 * adjusting.
 */
var NumberField = {};

var state = {
  active: false,
  hiding: false,
  scale: 1,
  onSet: null,
  onCancel: null,
};

NumberField.show = function(opts) {
  state.active = true;
  state.hiding = false;
  state.scale = Math.pow(10, opts.decimals || 0);
  state.onSet = opts.onSet;
  state.onCancel = opts.onCancel;
  simply.impl.numberSelectorShow({
    value: Math.round(opts.value * state.scale),
    min: Math.round(opts.min * state.scale),
    max: Math.round(opts.max * state.scale),
    step: Math.max(1, Math.round(opts.step * state.scale)),
    decimals: opts.decimals || 0,
    showBar: opts.showBar !== false,
    title: opts.title || '',
    unit: opts.unit || '',
  });
};

NumberField.hide = function() {
  if (!state.active) { return; }
  state.hiding = true;
  simply.impl.numberSelectorHide();
};

NumberField.value = function(value) {
  if (!state.active) { return; }
  simply.impl.numberSelectorValue(Math.round(value * state.scale));
};

NumberField.emitResult = function(scaledValue) {
  if (state.onSet) {
    state.onSet(scaledValue / state.scale);
  }
};

NumberField.emitClosed = function() {
  var wasHiding = state.hiding;
  var onCancel = state.onCancel;
  state.active = false;
  state.hiding = false;
  state.onSet = null;
  state.onCancel = null;
  // A programmatic hide (after a successful set) is not a cancel
  if (!wasHiding && onCancel) {
    onCancel();
  }
};

module.exports = NumberField;
