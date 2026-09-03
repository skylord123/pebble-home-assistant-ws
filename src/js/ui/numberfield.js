var simply = require('ui/simply');
var Feature = require('platform/feature');
var Platform = require('platform');
var Window = require('ui/window');
var Text = require('ui/text');
var Rect = require('ui/rect');
var Vector2 = require('vector2');

/**
 * NumberField - generic number selector
 *
 * On every platform with the room for it the selector window runs entirely on
 * the watch (simply_number.c): up/down adjust by the entity's step with
 * hold-to-repeat and acceleration, with no Bluetooth round trip per press.
 * Values cross the wire as integers scaled by 10^decimals; this module owns
 * that scaling so callers and the C side both deal in their natural units.
 *
 * Aplite loads an app's code into the same 24KB as its heap and cannot afford
 * that file, so it is served by a fallback drawn from stage primitives which
 * are already compiled in. The fallback copies the native window's layout, so
 * callers see one API and one appearance either way and need no platform
 * knowledge of their own.
 *
 * NumberField.show({ title, unit, value, min, max, step, decimals,
 *                    showBar, onSet, onChange, onCancel })
 *   onSet(value)  - select was pressed; perform the action and call
 *                   NumberField.hide() on success (the selector stays up
 *                   on failure so the user can retry)
 *   onChange(value) - optional; the value stopped changing and has settled.
 *                   Supplying it makes the selector live: each settled value
 *                   is reported as it is dialled so the entity can follow
 *                   along, and the selector stays up. Only for values worth
 *                   acting on before they are confirmed - a light's
 *                   brightness, not a timer's duration.
 *   onCancel()    - the selector left the screen without a successful
 *                   set (back button, or something covered it)
 *
 * NumberField.value(v) - update the displayed value from outside (e.g. a
 * state subscription); ignored while the user is actively adjusting.
 */

var NumberField = {};

var state = {
  active: false,
  hiding: false,
  scale: 1,
  onSet: null,
  onChange: null,
  onCancel: null,
};

// ---------------------------------------------------------------------------
// Fallback selector, drawn in JS from stage primitives
//
// Every number here is the native selector's own, read off simply_number.c so
// the two windows land on the same pixels. This only ever runs on aplite, so
// the rectangular branch of each PBL_IF_ROUND_ELSE is the one that applies.
// ---------------------------------------------------------------------------

var Fallback = (function() {
  var INSET = 8;                        // prv_inset()
  var BAR_MARGIN = 20;                  // prv_track_rect()
  var BAR_HEIGHT = 14;
  var FIELD_H = 34;                     // prv_layout_fields()
  var FIELD_COLON_W = 8;
  var FIELD_MERIDIEM_GAP = 4;
  var FIELD_BOX_W = 36;
  var FIELD_MIN_BOX_W = 16;
  var FIELD_RADIUS = 3;                 // prv_draw_fields()
  var SETTLE_INTERVAL_MS = 500;
  var EXTERNAL_UPDATE_HOLDOFF_MS = 1000;
  //! The native selector repeats at 75ms while a button is held and multiplies
  //! the step once the presses mount up. Nothing reports a button release to
  //! JS, so a hold cannot be followed here; it becomes one jump of the same
  //! multiplier instead, which still crosses a long range in a few presses.
  var HOLD_MULTIPLIER = 10;

  var HINT_NUMBER = 'UP/DOWN adjust, hold to fly\nSELECT to set';
  var HINT_DURATION = 'UP/DOWN set, SELECT next\nBACK prev, hold SELECT done';

  //! The selector currently on screen, or null
  var s = null;

  function now() {
    return new Date().getTime();
  }

  function clamp(value, min, max) {
    return value < min ? min : (value > max ? max : value);
  }

  //! prv_wrap(): a modulo that stays positive
  function wrap(value, count) {
    if (count <= 0) { return 0; }
    return ((value % count) + count) % count;
  }

  function trunc(value) {
    return value < 0 ? Math.ceil(value) : Math.floor(value);
  }

  function pad2(value) {
    return (value < 10 ? '0' : '') + value;
  }

  //! prv_format_value()
  function formatValue() {
    var pow10 = Math.pow(10, s.decimals);
    var whole = trunc(s.value / pow10);
    var frac = Math.abs(s.value % pow10);
    if (s.decimals === 0) {
      return whole + s.unit;
    }
    var fracText = String(frac);
    while (fracText.length < s.decimals) {
      fracText = '0' + fracText;
    }
    var sign = (s.value < 0 && whole === 0) ? '-' : '';
    return sign + whole + '.' + fracText + s.unit;
  }

  //! prv_has_meridiem(): only a time of day, and only on a 12 hour watch
  function hasMeridiem() {
    return s.timeOfDay && !Platform.clockIs24h();
  }

  function fieldCount() {
    return hasMeridiem() ? 4 : 3;
  }

  //! prv_layout_fields(): one centred row, the boxes shrinking on a narrow
  //! screen rather than running off the edge
  function layoutFields(width, height) {
    var meridiem = hasMeridiem();
    var count = fieldCount();
    var numeric = meridiem ? count - 1 : count;
    var boxW = FIELD_BOX_W;
    var meridiemW = 40;
    var available = width - 2 * INSET;

    function total() {
      return numeric * boxW + (numeric - 1) * FIELD_COLON_W +
          (meridiem ? FIELD_MERIDIEM_GAP + meridiemW : 0);
    }

    while (total() > available && boxW > FIELD_MIN_BOX_W) {
      boxW -= 1;
      meridiemW = boxW + 4;
    }

    var y = trunc(height / 2) - 24;
    var x = trunc((width - total()) / 2);
    var boxes = [];
    for (var i = 0; i < numeric; i++) {
      boxes.push({ x: x, y: y, w: boxW });
      x += boxW + FIELD_COLON_W;
    }
    if (meridiem) {
      // No colon leads into AM/PM, just a gap
      boxes.push({ x: x - FIELD_COLON_W + FIELD_MERIDIEM_GAP, y: y, w: meridiemW });
    }
    return { boxes: boxes, numeric: numeric, font: fieldFont(boxW) };
  }

  //! prv_field_font(): the text steps down with the boxes
  function fieldFont(boxW) {
    if (boxW >= 32) { return 'gothic_28_bold'; }
    if (boxW >= 26) { return 'gothic_24_bold'; }
    return 'gothic_18_bold';
  }

  //! prv_field_text()
  function fieldText(index) {
    var total = s.value < 0 ? 0 : s.value;
    var hours = trunc(total / 3600);
    var minutes = trunc((total % 3600) / 60);
    var seconds = total % 60;

    if (!s.timeOfDay) {
      return pad2([hours, minutes, seconds][index]);
    }
    if (index === 0) {
      if (hasMeridiem()) {
        var hour12 = hours % 12;
        if (hour12 === 0) { hour12 = 12; }
        return String(hour12);
      }
      return pad2(hours);
    }
    if (index === 1) { return pad2(minutes); }
    if (index === 2) { return pad2(seconds); }
    return hours < 12 ? 'AM' : 'PM';
  }

  //! prv_adjust_field(): each field wraps within its own range
  function adjustField(units) {
    var total = s.value < 0 ? 0 : s.value;
    var h = trunc(total / 3600);
    var m = trunc((total % 3600) / 60);
    var sec = total % 60;

    var hoursCount = trunc(s.max / 3600) + 1;
    if (hoursCount > 24) { hoursCount = 24; }
    if (hoursCount < 1) { hoursCount = 1; }

    if (s.timeOfDay) {
      if (s.field === 0) {
        if (hasMeridiem()) {
          // Stay in the half of the day that is showing: AM and PM is its own
          // field, so counting past 11 must not quietly move the value by
          // twelve hours
          var afternoon = (h >= 12);
          h = wrap((h % 12) + units, 12) + (afternoon ? 12 : 0);
        } else {
          h = wrap(h + units, 24);
        }
      } else if (s.field === 1) {
        m = wrap(m + units, 60);
      } else if (s.field === 2) {
        sec = wrap(sec + units, 60);
      } else {
        h = (h + 12) % 24;  // the meridiem field flips the half of the day
      }
    } else if (s.field === 0) {
      h = wrap(h + units, hoursCount);
    } else if (s.field === 1) {
      m = wrap(m + units, 60);
    } else {
      sec = wrap(sec + units, 60);
    }

    var value = h * 3600 + m * 60 + sec;
    if (value > s.max) { value = s.max; }
    return value;
  }

  function scheduleSettle() {
    if (!s.live) { return; }
    if (s.settleTimer) { clearTimeout(s.settleTimer); }
    s.settleTimer = setTimeout(function() {
      if (!s) { return; }
      s.settleTimer = null;
      var value = clamp(s.value, s.min, s.max);
      if (value === s.lastSent) { return; }
      s.lastSent = value;
      if (s.onChange) { s.onChange(value / s.scale); }
    }, SETTLE_INTERVAL_MS);
  }

  function render() {
    if (!s || !s.els) { return; }
    if (s.duration) {
      var box = s.boxes[s.field];
      s.els.highlight.position(new Vector2(box.x, box.y));
      s.els.highlight.size(new Vector2(box.w, FIELD_H));
      for (var i = 0; i < s.els.fields.length; i++) {
        s.els.fields[i].text(fieldText(i));
        s.els.fields[i].color(i === s.field ? 'white' : 'black');
      }
      return;
    }
    s.els.value.text(formatValue());
    if (s.els.fill) {
      var range = s.max - s.min;
      var span = s.w - 2 * BAR_MARGIN - 4;
      var fillW = range > 0 ? trunc(span * (s.value - s.min) / range) : 0;
      if (fillW < 0) { fillW = 0; }
      s.els.fill.size(new Vector2(fillW, BAR_HEIGHT - 4));
    }
  }

  function build() {
    var resolution = Feature.resolution();
    s.w = resolution.x;
    s.h = resolution.y;

    s.win = new Window({ backgroundColor: 'white', status: false });
    s.els = {};

    s.els.title = new Text({
      text: s.title,
      color: 'black',
      font: 'gothic_24_bold',
      position: new Vector2(INSET, 2),
      size: new Vector2(s.w - 2 * INSET, 52),
      textAlign: 'center',
      textOverflow: 'ellipsis',
    });
    s.win.add(s.els.title);

    if (s.duration) {
      var layout = layoutFields(s.w, s.h);
      s.boxes = layout.boxes;

      // Behind the fields, so the selected one reads white out of it
      s.els.highlight = new Rect({
        position: new Vector2(s.boxes[0].x, s.boxes[0].y),
        size: new Vector2(s.boxes[0].w, FIELD_H),
        backgroundColor: 'black',
        borderColor: 'clear',
        radius: FIELD_RADIUS,
      });
      s.win.add(s.els.highlight);

      s.els.fields = [];
      for (var i = 0; i < s.boxes.length; i++) {
        var box = s.boxes[i];
        var field = new Text({
          text: fieldText(i),
          color: 'black',
          font: layout.font,
          position: new Vector2(box.x, box.y - 3),
          size: new Vector2(box.w, FIELD_H),
          textAlign: 'center',
        });
        s.win.add(field);
        s.els.fields.push(field);

        // Colons separate the numeric fields; AM/PM stands on its own
        if (i + 1 < layout.numeric) {
          s.win.add(new Text({
            text: ':',
            color: 'black',
            font: layout.font,
            position: new Vector2(box.x + box.w, box.y - 3),
            size: new Vector2(FIELD_COLON_W, FIELD_H),
            textAlign: 'center',
          }));
        }
      }
    } else {
      s.els.value = new Text({
        text: formatValue(),
        color: 'black',
        font: 'gothic_28_bold',
        position: new Vector2(0, trunc(s.h / 2) - 22),
        size: new Vector2(s.w, FIELD_H),
        textAlign: 'center',
        textOverflow: 'ellipsis',
      });
      s.win.add(s.els.value);

      // An outlined track with a filled portion, which works on every display
      // without needing gray
      if (s.showBar) {
        var trackY = trunc(s.h / 2) + 20;
        s.win.add(new Rect({
          position: new Vector2(BAR_MARGIN, trackY),
          size: new Vector2(s.w - 2 * BAR_MARGIN, BAR_HEIGHT),
          backgroundColor: 'clear',
          borderColor: 'black',
          borderWidth: 1,
        }));
        s.els.fill = new Rect({
          position: new Vector2(BAR_MARGIN + 2, trackY + 2),
          size: new Vector2(0, BAR_HEIGHT - 4),
          backgroundColor: 'black',
          borderColor: 'clear',
        });
        s.win.add(s.els.fill);
      }
    }

    s.win.add(new Text({
      text: s.duration ? HINT_DURATION : HINT_NUMBER,
      color: 'black',
      font: 'gothic_14',
      position: new Vector2(INSET, s.h - 40),
      size: new Vector2(s.w - 2 * INSET, 36),
      textAlign: 'center',
    }));

    s.win.on('click', 'up', function() { step(1, 1); });
    s.win.on('click', 'down', function() { step(-1, 1); });
    s.win.on('longClick', 'up', function() { step(1, HOLD_MULTIPLIER); });
    s.win.on('longClick', 'down', function() { step(-1, HOLD_MULTIPLIER); });

    s.win.on('click', 'select', function() {
      // Duration mode walks hours to minutes to seconds first, then confirms
      if (s.duration && s.field + 1 < fieldCount()) {
        s.field++;
        s.lastInput = now();
        render();
        return;
      }
      confirm();
    });
    s.win.on('longClick', 'select', function() { confirm(); });

    s.win.on('click', 'back', function() {
      if (s.duration && s.field > 0) {
        s.field--;
        s.lastInput = now();
        render();
        return;
      }
      s.win.hide();
    });

    // Back, or anything covering the selector, ends it the same way the native
    // window's disappearance does
    s.win.on('hide', function() { finish(); });

    render();
    s.win.show();
  }

  function step(direction, multiplier) {
    if (!s) { return; }
    s.lastInput = now();
    var value;
    if (s.duration) {
      value = adjustField(direction * multiplier);
    } else {
      value = clamp(s.value + direction * s.step * multiplier, s.min, s.max);
    }
    if (value === s.value) { return; }
    s.value = value;
    scheduleSettle();
    render();
  }

  //! Report the value and stay up: the caller performs the action and hides
  //! the selector itself, so a failure leaves it there to retry
  function confirm() {
    if (!s) { return; }
    var onSet = s.onSet;
    var value = clamp(s.value, s.min, s.max) / s.scale;
    if (onSet) { onSet(value); }
  }

  function finish() {
    if (!s) { return; }
    var wasHiding = s.hiding;
    var onCancel = s.onCancel;
    if (s.settleTimer) { clearTimeout(s.settleTimer); }
    s = null;
    // A programmatic hide (after a successful set) is not a cancel
    if (!wasHiding && onCancel) { onCancel(); }
  }

  return {
    active: function() {
      return s !== null;
    },

    show: function(opts, duration, timeOfDay) {
      // Only one selector at a time, and the outgoing one is not a cancel of
      // the incoming one's caller
      if (s) {
        s.hiding = true;
        s.win.hide();
      }
      var scale = duration ? 1 : Math.pow(10, opts.decimals || 0);
      s = {
        scale: scale,
        value: Math.round((opts.value || 0) * scale),
        min: Math.round((opts.min || 0) * scale),
        max: Math.round((opts.max !== undefined ? opts.max : (duration ? 86399 : 0)) * scale),
        step: duration ? 1 : Math.max(1, Math.round((opts.step || 1) * scale)),
        decimals: duration ? 0 : (opts.decimals || 0),
        unit: duration ? '' : (opts.unit || ''),
        title: opts.title || '',
        showBar: duration ? false : (opts.showBar !== false),
        duration: !!duration,
        timeOfDay: !!timeOfDay,
        field: 0,
        // A half dialled duration or time of day is not worth acting on
        live: duration ? false : !!opts.onChange,
        onSet: opts.onSet,
        onChange: duration ? null : opts.onChange,
        onCancel: opts.onCancel,
        lastSent: null,
        lastInput: 0,
        settleTimer: null,
        hiding: false,
        win: null,
        els: null,
        boxes: null,
        w: 0,
        h: 0,
      };
      build();
    },

    hide: function() {
      if (!s) { return; }
      s.hiding = true;
      s.win.hide();
    },

    value: function(value) {
      if (!s) { return; }
      // The echo of our own change still lands inside the holdoff, so a value
      // being actively dialled is not dragged back by it
      if (now() - s.lastInput < EXTERNAL_UPDATE_HOLDOFF_MS) { return; }
      var scaled = clamp(Math.round(value * s.scale), s.min, s.max);
      if (scaled === s.value) { return; }
      s.value = scaled;
      render();
    },
  };
})();

// ---------------------------------------------------------------------------
// Public API. Callers never choose between the two.
// ---------------------------------------------------------------------------

NumberField.show = function(opts) {
  if (!Feature.nativeNumberSelector()) {
    return Fallback.show(opts, false, false);
  }
  state.active = true;
  state.hiding = false;
  state.scale = Math.pow(10, opts.decimals || 0);
  state.onSet = opts.onSet;
  state.onChange = opts.onChange;
  state.onCancel = opts.onCancel;
  simply.impl.numberSelectorShow({
    live: !!opts.onChange,
    value: Math.round(opts.value * state.scale),
    min: Math.round(opts.min * state.scale),
    max: Math.round(opts.max * state.scale),
    step: Math.max(1, Math.round(opts.step * state.scale)),
    decimals: opts.decimals || 0,
    showBar: opts.showBar !== false,
    duration: false,
    title: opts.title || '',
    unit: opts.unit || '',
  });
};

/**
 * Pick a duration as HH:MM:SS. Up/down adjust the selected field, select
 * moves to the next one and confirms on the last, holding select confirms
 * from anywhere, and back steps to the previous field.
 *
 * showDuration({ title, value, min, max, onSet, onCancel }) with every
 * value in seconds; onSet receives seconds.
 */
NumberField.showDuration = function(opts) {
  showFields(opts, false);
};

/**
 * Pick a time of day, in seconds since midnight. The watch decides how it
 * reads: hours run 1 to 12 beside an AM/PM field on a 12 hour watch, and 00
 * to 23 on a 24 hour one. Seconds are carried through untouched rather than
 * being dialled past, so a value that arrived with them keeps them.
 *
 * showTimeOfDay({ title, value, onSet, onCancel }) with seconds since
 * midnight; onSet receives seconds since midnight.
 */
NumberField.showTimeOfDay = function(opts) {
  showFields(opts, true);
};

function showFields(opts, timeOfDay) {
  if (!Feature.nativeNumberSelector()) {
    return Fallback.show(opts, true, timeOfDay);
  }
  state.active = true;
  state.hiding = false;
  state.scale = 1;
  state.onSet = opts.onSet;
  // A half dialled duration or time of day is not worth acting on
  state.onChange = null;
  state.onCancel = opts.onCancel;
  simply.impl.numberSelectorShow({
    value: Math.round(opts.value || 0),
    min: Math.round(opts.min || 0),
    max: Math.round(opts.max !== undefined ? opts.max : 86399),
    step: 1,
    decimals: 0,
    showBar: false,
    duration: true,
    timeOfDay: timeOfDay,
    title: opts.title || '',
    unit: '',
  });
}

NumberField.hide = function() {
  if (!Feature.nativeNumberSelector()) {
    return Fallback.hide();
  }
  if (!state.active) { return; }
  state.hiding = true;
  simply.impl.numberSelectorHide();
};

NumberField.value = function(value) {
  if (!Feature.nativeNumberSelector()) {
    return Fallback.value(value);
  }
  if (!state.active) { return; }
  simply.impl.numberSelectorValue(Math.round(value * state.scale));
};

// The watch reports these; the fallback calls its callers directly instead

NumberField.emitResult = function(scaledValue) {
  if (state.onSet) {
    state.onSet(scaledValue / state.scale);
  }
};

NumberField.emitChange = function(scaledValue) {
  if (state.onChange) {
    state.onChange(scaledValue / state.scale);
  }
};

NumberField.emitClosed = function() {
  var wasHiding = state.hiding;
  var onCancel = state.onCancel;
  state.active = false;
  state.hiding = false;
  state.onSet = null;
  state.onChange = null;
  state.onCancel = null;
  // A programmatic hide (after a successful set) is not a cancel
  if (!wasHiding && onCancel) {
    onCancel();
  }
};

module.exports = NumberField;
