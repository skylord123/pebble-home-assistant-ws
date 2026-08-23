#include "simply_number.h"

#include "simply.h"

#include "simply_msg.h"
#include "simply_touch.h"

#include <pebble.h>

// Repeat cadence while a button is held, and how many repeats before the
// step multiplier kicks in. The multipliers only engage when the range is
// large enough that flying is actually useful; small ranges stay precise.
#define REPEAT_INTERVAL_MS 75
#define ACCEL_TIER1_CLICKS 10
#define ACCEL_TIER1_MIN_STEPS 60
#define ACCEL_TIER2_CLICKS 30
#define ACCEL_TIER2_MIN_STEPS 600

// External value updates are ignored this long after the last button press
// so an automation changing the entity doesn't fight the user mid-adjust
#define EXTERNAL_UPDATE_HOLDOFF_MS 1000

// How long the value must hold still before a live selector reports it. Long
// enough that dialling through a range sends one value rather than every
// value it passed, short enough to read as immediate. Kept below
// EXTERNAL_UPDATE_HOLDOFF_MS so the echo of our own change still lands inside
// the holdoff and cannot bounce the value back under the user's finger.
#define SETTLE_INTERVAL_MS 500

typedef struct NumberSelectorShowPacket NumberSelectorShowPacket;

struct __attribute__((__packed__)) NumberSelectorShowPacket {
  Packet packet;
  int32_t value;
  int32_t min;
  int32_t max;
  int32_t step;
  uint8_t decimals;
  uint8_t flags;
  uint16_t title_length;
  uint16_t unit_length;
  char buffer[];
};

typedef struct NumberSelectorValuePacket NumberSelectorValuePacket;

struct __attribute__((__packed__)) NumberSelectorValuePacket {
  Packet packet;
  int32_t value;
};

typedef struct NumberSelectorResultPacket NumberSelectorResultPacket;

struct __attribute__((__packed__)) NumberSelectorResultPacket {
  Packet packet;
  int32_t value;
};

typedef struct NumberSelectorClosedPacket NumberSelectorClosedPacket;

struct __attribute__((__packed__)) NumberSelectorClosedPacket {
  Packet packet;
};

typedef struct NumberSelectorChangePacket NumberSelectorChangePacket;

struct __attribute__((__packed__)) NumberSelectorChangePacket {
  Packet packet;
  int32_t value;
};

static int64_t prv_now_ms(void) {
  time_t seconds;
  uint16_t ms;
  time_ms(&seconds, &ms);
  return (int64_t)seconds * 1000 + ms;
}

static int32_t prv_clamp(int32_t value, int32_t min, int32_t max) {
  if (value < min) { return min; }
  if (value > max) { return max; }
  return value;
}

// Render the scaled integer with its decimal point restored, e.g. value 215
// with 1 decimal -> "21.5", then the unit appended verbatim
static void prv_format_value(SimplyNumber *self, char *out, size_t out_size) {
  int32_t pow10 = 1;
  for (uint8_t i = 0; i < self->decimals; i++) { pow10 *= 10; }
  int32_t whole = self->value / pow10;
  int32_t frac = self->value % pow10;
  if (frac < 0) { frac = -frac; }
  if (self->decimals == 0) {
    snprintf(out, out_size, "%ld%s", (long)whole, self->unit);
    return;
  }
  char frac_buf[12];
  for (int8_t i = self->decimals - 1; i >= 0; i--) {
    frac_buf[i] = '0' + (frac % 10);
    frac /= 10;
  }
  frac_buf[self->decimals] = '\0';
  const char *sign = (self->value < 0 && whole == 0) ? "-" : "";
  snprintf(out, out_size, "%s%ld.%s%s", sign, (long)whole, frac_buf, self->unit);
}

static int32_t prv_wrap(int32_t value, int32_t count) {
  if (count <= 0) { return 0; }
  return ((value % count) + count) % count;
}

static int16_t prv_inset(void) {
  return PBL_IF_ROUND_ELSE(24, 8);
}

// Layout is shared with the touch hit testing, so the bar and the fields
// can only ever be drawn where a finger is expected to find them
static GRect prv_track_rect(GRect bounds) {
  const int16_t bar_margin = PBL_IF_ROUND_ELSE(34, 20);
  return GRect(bar_margin, bounds.size.h / 2 + 20, bounds.size.w - 2 * bar_margin, 14);
}

//! Whether a meridiem field is showing: only for a time of day, and only
//! when the wearer's watch is set to a 12 hour clock
static bool prv_has_meridiem(SimplyNumber *self) {
  return self->time_of_day && !clock_is_24h_style();
}

//! Hours, minutes and seconds either way, plus AM/PM for a time of day on a
//! 12 hour watch
static uint8_t prv_field_count(SimplyNumber *self) {
  return prv_has_meridiem(self) ? 4 : 3;
}

#define FIELD_COLON_W 8
#define FIELD_MERIDIEM_GAP 4

//! Four fields do not fit at full size on the narrow displays, so the text
//! steps down with the boxes rather than being clipped by them
static GFont prv_field_font(int16_t box_w) {
  if (box_w >= 32) { return fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD); }
  if (box_w >= 26) { return fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD); }
  return fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
}

//! Lay the fields out as one centered row, shrinking the boxes on narrow
//! screens rather than letting them run off the edge
static int16_t prv_layout_fields(SimplyNumber *self, GRect bounds, GRect *out) {
  const bool meridiem = prv_has_meridiem(self);
  const uint8_t count = prv_field_count(self);
  const uint8_t numeric = meridiem ? count - 1 : count;

  int16_t box_w = 36;
  int16_t meridiem_w = 40;
  const int16_t available = bounds.size.w - 2 * prv_inset();
  int16_t total = numeric * box_w + (numeric - 1) * FIELD_COLON_W +
      (meridiem ? FIELD_MERIDIEM_GAP + meridiem_w : 0);
  while (total > available && box_w > 16) {
    box_w -= 1;
    meridiem_w = box_w + 4;
    total = numeric * box_w + (numeric - 1) * FIELD_COLON_W +
        (meridiem ? FIELD_MERIDIEM_GAP + meridiem_w : 0);
  }

  const int16_t y = bounds.size.h / 2 - 24;
  int16_t x = (bounds.size.w - total) / 2;
  for (uint8_t i = 0; i < numeric; i++) {
    out[i] = GRect(x, y, box_w, 34);
    x += box_w + FIELD_COLON_W;
  }
  if (meridiem) {
    // No colon leads into AM/PM, just a gap
    out[numeric] = GRect(x - FIELD_COLON_W + FIELD_MERIDIEM_GAP, y, meridiem_w, 34);
  }
  return box_w;
}

//! Text for one field: two digits for a duration, and for a time of day an
//! unpadded 1 to 12 hour beside AM or PM on a 12 hour watch
static void prv_field_text(SimplyNumber *self, uint8_t index, char *out, size_t out_size) {
  const int32_t total = self->value < 0 ? 0 : self->value;
  const int32_t hours = total / 3600;
  const int32_t minutes = (total % 3600) / 60;

  if (!self->time_of_day) {
    const int32_t parts[3] = { hours, minutes, total % 60 };
    snprintf(out, out_size, "%02d", (int)parts[index]);
    return;
  }

  if (index == 0) {
    if (prv_has_meridiem(self)) {
      int32_t hour12 = hours % 12;
      if (hour12 == 0) { hour12 = 12; }
      snprintf(out, out_size, "%d", (int)hour12);
    } else {
      snprintf(out, out_size, "%02d", (int)hours);
    }
  } else if (index == 1) {
    snprintf(out, out_size, "%02d", (int)minutes);
  } else if (index == 2) {
    snprintf(out, out_size, "%02d", (int)(total % 60));
  } else {
    snprintf(out, out_size, "%s", hours < 12 ? "AM" : "PM");
  }
}

static void prv_draw_fields(SimplyNumber *self, GContext *ctx, GRect bounds) {
  GRect boxes[4];
  const int16_t box_w = prv_layout_fields(self, bounds, boxes);
  const uint8_t count = prv_field_count(self);
  const uint8_t numeric = prv_has_meridiem(self) ? count - 1 : count;
  GFont font = prv_field_font(box_w);

  for (uint8_t i = 0; i < count; i++) {
    const GRect box = boxes[i];
    char buf[4];
    prv_field_text(self, i, buf, sizeof(buf));

    if (i == self->field) {
      graphics_context_set_fill_color(ctx, GColorBlack);
      graphics_fill_rect(ctx, box, 3, GCornersAll);
      graphics_context_set_text_color(ctx, GColorWhite);
    } else {
      graphics_context_set_text_color(ctx, GColorBlack);
    }
    graphics_draw_text(ctx, buf, font, GRect(box.origin.x, box.origin.y - 3, box.size.w, box.size.h),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

    // Colons separate the numeric fields; AM/PM stands on its own
    if (i + 1 < numeric) {
      graphics_context_set_text_color(ctx, GColorBlack);
      graphics_draw_text(ctx, ":", font,
          GRect(box.origin.x + box.size.w, box.origin.y - 3, FIELD_COLON_W, box.size.h),
          GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    }
  }
}

static void prv_layer_update(Layer *layer, GContext *ctx) {
  SimplyNumber *self = window_get_user_data(layer_get_window(layer));
  const GRect bounds = layer_get_bounds(layer);
  const int16_t w = bounds.size.w;
  const int16_t h = bounds.size.h;
  const int16_t inset = prv_inset();

  // Overriding the root layer's update proc replaces the default proc that
  // paints the window background, so clear the frame ourselves
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  graphics_context_set_text_color(ctx, GColorBlack);

  // Title
  graphics_draw_text(ctx, self->title,
      fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
      GRect(inset, PBL_IF_ROUND_ELSE(14, 2), w - 2 * inset, 52),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

  // Value
  if (self->duration_mode) {
    prv_draw_fields(self, ctx, bounds);
  } else {
    char value_buf[32];
    prv_format_value(self, value_buf, sizeof(value_buf));
    graphics_draw_text(ctx, value_buf,
        fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD),
        GRect(0, h / 2 - 22, w, 34),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }

  // Progress bar: outlined track with a filled portion, which works on
  // every display without needing gray
  if (self->show_bar && !self->duration_mode) {
    const GRect track = prv_track_rect(bounds);
    graphics_context_set_stroke_color(ctx, GColorBlack);
    graphics_draw_rect(ctx, track);
    const int32_t range = self->max - self->min;
    if (range > 0) {
      const int16_t fill_w = (int16_t)((int64_t)(track.size.w - 4) * (self->value - self->min) / range);
      if (fill_w > 0) {
        graphics_context_set_fill_color(ctx, GColorBlack);
        graphics_fill_rect(ctx, GRect(track.origin.x + 2, track.origin.y + 2, fill_w, track.size.h - 4),
            0, GCornerNone);
      }
    }
  }

  // Hint
  graphics_draw_text(ctx,
      self->duration_mode ? "UP/DOWN set, SELECT next\nBACK prev, hold SELECT done"
                          : "UP/DOWN adjust, hold to fly\nSELECT to set",
      fonts_get_system_font(FONT_KEY_GOTHIC_14),
      GRect(inset, h - PBL_IF_ROUND_ELSE(52, 40), w - 2 * inset, 36),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static int32_t prv_accel_delta(SimplyNumber *self, uint8_t clicks) {
  const int32_t total_steps = self->step > 0 ? (self->max - self->min) / self->step : 0;
  int32_t mult = 1;
  if (clicks > ACCEL_TIER1_CLICKS && total_steps > ACCEL_TIER1_MIN_STEPS) { mult = 10; }
  if (clicks > ACCEL_TIER2_CLICKS && total_steps > ACCEL_TIER2_MIN_STEPS) { mult = 100; }
  return self->step * mult;
}

static void prv_cancel_settle(SimplyNumber *self) {
  if (self->settle_timer) {
    app_timer_cancel(self->settle_timer);
    self->settle_timer = NULL;
  }
}

static void prv_settle_timeout(void *data) {
  SimplyNumber *self = data;
  self->settle_timer = NULL;
  const int32_t value = prv_clamp(self->value, self->min, self->max);
  if (value == self->last_sent_value) { return; }
  self->last_sent_value = value;
  NumberSelectorChangePacket packet = {
    .packet = { .type = CommandNumberSelectorChangeEvent, .length = sizeof(packet) },
    .value = value,
  };
  simply_msg_send_packet(&packet.packet);
}

// Restart the countdown on every change, so a run of presses reports once it
// finishes rather than once per press
static void prv_schedule_settle(SimplyNumber *self) {
  if (!self->live) { return; }
  if (self->settle_timer) {
    if (app_timer_reschedule(self->settle_timer, SETTLE_INTERVAL_MS)) { return; }
    self->settle_timer = NULL;
  }
  self->settle_timer = app_timer_register(SETTLE_INTERVAL_MS, prv_settle_timeout, self);
}

static void prv_adjust(SimplyNumber *self, int32_t delta) {
  const int32_t value = prv_clamp(self->value + delta, self->min, self->max);
  self->last_input_ms = prv_now_ms();
  if (value != self->value) {
    self->value = value;
    prv_schedule_settle(self);
    layer_mark_dirty(window_get_root_layer(self->window));
  }
}

// Each duration field wraps within its own range and leaves the others
// alone, the way the built in timer behaves: stepping down from 00 hours
// lands on 23 rather than dragging the whole value to its minimum
static void prv_adjust_field(SimplyNumber *self, int32_t units) {
  const int32_t total = self->value < 0 ? 0 : self->value;
  int32_t h = total / 3600;
  int32_t m = (total % 3600) / 60;
  int32_t s = total % 60;

  // Hours wrap at 24, or sooner when the caller's maximum cannot reach a
  // full day
  int32_t hours_count = self->max / 3600 + 1;
  if (hours_count > 24) { hours_count = 24; }
  if (hours_count < 1) { hours_count = 1; }

  if (self->time_of_day) {
    if (self->field == 0) {
      if (prv_has_meridiem(self)) {
        // Stay in the half of the day that is showing: AM and PM is its own
        // field, so counting past 11 must not quietly move the value by
        // twelve hours
        const bool afternoon = (h >= 12);
        int32_t hour12 = prv_wrap((h % 12) + units, 12);
        h = hour12 + (afternoon ? 12 : 0);
      } else {
        h = prv_wrap(h + units, 24);
      }
    } else if (self->field == 1) {
      m = prv_wrap(m + units, 60);
    } else if (self->field == 2) {
      s = prv_wrap(s + units, 60);
    } else {
      h = (h + 12) % 24;   // the meridiem field flips the half of the day
    }
  } else if (self->field == 0) {
    h = prv_wrap(h + units, hours_count);
  } else if (self->field == 1) {
    m = prv_wrap(m + units, 60);
  } else {
    s = prv_wrap(s + units, 60);
  }

  // Fields wrap within their own ranges, so duration mode expects a
  // maximum that falls on a field boundary (23:59:59 for a full day). With
  // a maximum part way through a field, both directions can land above it
  // and get pinned here, so pick the boundary below instead.
  int32_t value = h * 3600 + m * 60 + s;
  if (value > self->max) { value = self->max; }

  self->last_input_ms = prv_now_ms();
  if (value != self->value) {
    self->value = value;
    prv_schedule_settle(self);
    layer_mark_dirty(window_get_root_layer(self->window));
  }
}

// Holding steps ten at a time
static int32_t prv_duration_units(ClickRecognizerRef recognizer) {
  return (click_number_of_clicks_counted(recognizer) > ACCEL_TIER1_CLICKS) ? 10 : 1;
}

static void prv_up_click(ClickRecognizerRef recognizer, void *context) {
  SimplyNumber *self = context;
  if (self->duration_mode) {
    prv_adjust_field(self, prv_duration_units(recognizer));
    return;
  }
  prv_adjust(self, prv_accel_delta(self, click_number_of_clicks_counted(recognizer)));
}

static void prv_down_click(ClickRecognizerRef recognizer, void *context) {
  SimplyNumber *self = context;
  if (self->duration_mode) {
    prv_adjust_field(self, -prv_duration_units(recognizer));
    return;
  }
  prv_adjust(self, -prv_accel_delta(self, click_number_of_clicks_counted(recognizer)));
}

static void prv_confirm(SimplyNumber *self) {
  // The result carries the same value a pending change event would have, so
  // let the confirmation be the one that reports it
  prv_cancel_settle(self);
  // Duration fields wrap without consulting the minimum, so the range is
  // enforced here instead: callers are promised a value within [min, max]
  NumberSelectorResultPacket packet = {
    .packet = { .type = CommandNumberSelectorResult, .length = sizeof(packet) },
    .value = prv_clamp(self->value, self->min, self->max),
  };
  simply_msg_send_packet(&packet.packet);
}

static void prv_select_click(ClickRecognizerRef recognizer, void *context) {
  SimplyNumber *self = context;
  // Duration mode walks hours to minutes to seconds first, then confirms
  if (self->duration_mode && self->field + 1 < prv_field_count(self)) {
    self->field++;
    self->last_input_ms = prv_now_ms();
    layer_mark_dirty(window_get_root_layer(self->window));
    return;
  }
  prv_confirm(self);
}

static void prv_select_long_click(ClickRecognizerRef recognizer, void *context) {
  prv_confirm(context);
}

// Back steps to the previous field so an overshoot does not mean starting
// over; on the first field it leaves as usual
static void prv_back_click(ClickRecognizerRef recognizer, void *context) {
  SimplyNumber *self = context;
  if (self->duration_mode && self->field > 0) {
    self->field--;
    self->last_input_ms = prv_now_ms();
    layer_mark_dirty(window_get_root_layer(self->window));
    return;
  }
  window_stack_remove(self->window, false);
}

static void prv_click_config_provider(void *context) {
  window_set_click_context(BUTTON_ID_UP, context);
  window_set_click_context(BUTTON_ID_DOWN, context);
  window_set_click_context(BUTTON_ID_SELECT, context);
  window_set_click_context(BUTTON_ID_BACK, context);
  window_single_repeating_click_subscribe(BUTTON_ID_UP, REPEAT_INTERVAL_MS, prv_up_click);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, REPEAT_INTERVAL_MS, prv_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, prv_select_long_click, NULL);
  window_single_click_subscribe(BUTTON_ID_BACK, prv_back_click);
}

static void prv_send_closed(void) {
  NumberSelectorClosedPacket packet = {
    .packet = { .type = CommandNumberSelectorClosedEvent, .length = sizeof(packet) },
  };
  simply_msg_send_packet(&packet.packet);
}

static void prv_destroy(SimplyNumber *self) {
  window_destroy(self->window);
  self->simply->number = NULL;
  free(self);
}

static void prv_destroy_later(void *data) {
  SimplyNumber *self = data;
  bool animated = false;
  window_stack_remove(self->window, animated);
  prv_destroy(self);
}

static void prv_window_disappear(Window *window) {
  SimplyNumber *self = window_get_user_data(window);
  if (self->destroying) { return; }
  self->destroying = true;
  // The selector is going away and the struct with it, so a settle timer must
  // not be left to fire into freed memory. Leaving without confirming also
  // means the last value was not chosen, so there is nothing to report.
  prv_cancel_settle(self);
  prv_send_closed();
  // Defer the teardown: destroying a window from inside its own disappear
  // handler is unsafe while the window stack is mid-transition
  app_timer_register(0, prv_destroy_later, self);
}

static SimplyNumber *prv_create(Simply *simply) {
  SimplyNumber *self = malloc(sizeof(*self));
  if (!self) { return NULL; }
  *self = (SimplyNumber) { .simply = simply };

  self->window = window_create();
  window_set_user_data(self->window, self);
  window_set_background_color(self->window, GColorWhite);
  window_set_window_handlers(self->window, (WindowHandlers) {
    .disappear = prv_window_disappear,
  });
  window_set_click_config_provider_with_context(self->window, prv_click_config_provider, self);
  layer_set_update_proc(window_get_root_layer(self->window), prv_layer_update);

  return self;
}

static void prv_copy_string(char *out, size_t out_size, const char *in) {
  strncpy(out, in, out_size - 1);
  out[out_size - 1] = '\0';
}

static void prv_handle_show(Simply *simply, Packet *data) {
  NumberSelectorShowPacket *packet = (NumberSelectorShowPacket *)data;
  SimplyNumber *self = simply->number;
  if (!self) {
    self = prv_create(simply);
    if (!self) { return; }
    simply->number = self;
  }

  self->min = packet->min;
  self->max = packet->max;
  self->step = packet->step > 0 ? packet->step : 1;
  self->value = prv_clamp(packet->value, self->min, self->max);
  self->decimals = packet->decimals;
  self->show_bar = (packet->flags & 1);
  self->duration_mode = (packet->flags & 2);
  self->time_of_day = (packet->flags & 4);
  self->live = (packet->flags & 8);
  // A reused selector must not carry the previous entity's pending report or
  // its idea of what has already been sent
  prv_cancel_settle(self);
  self->last_sent_value = self->value;
  // Always start on the leftmost field so select walks the whole value
  // left to right; starting further in leaves the earlier fields
  // reachable only by pressing back, which nobody expects
  self->field = 0;
  self->last_input_ms = 0;

  const char *title = packet->buffer;
  const char *unit = title + packet->title_length + 1;
  prv_copy_string(self->title, sizeof(self->title), title);
  prv_copy_string(self->unit, sizeof(self->unit), unit);

  if (!window_stack_contains_window(self->window)) {
    window_stack_push(self->window, false);
  }
  layer_mark_dirty(window_get_root_layer(self->window));
}

static void prv_handle_value(Simply *simply, Packet *data) {
  SimplyNumber *self = simply->number;
  if (!self) { return; }
  if (prv_now_ms() - self->last_input_ms < EXTERNAL_UPDATE_HOLDOFF_MS) { return; }
  self->value = prv_clamp(((NumberSelectorValuePacket *)data)->value, self->min, self->max);
  // This value came from the entity, so reporting it back would tell it what
  // it already knows; dialling away and returning to it stays quiet too
  self->last_sent_value = self->value;
  layer_mark_dirty(window_get_root_layer(self->window));
}

bool simply_number_is_covering(Simply *simply) {
  return (simply->number && window_stack_contains_window(simply->number->window));
}

#ifdef SIMPLY_HAS_TOUCH

// A finger that moves less than this between touchdown and liftoff is a tap,
// and one travelling at least SWIPE_MIN horizontally is a swipe. Kept in step
// with simply_touch.c so gestures feel the same here as everywhere else.
#define TOUCH_TAP_SLOP 10
#define TOUCH_SWIPE_MIN 30
#define TOUCH_GESTURE_MAX_MS 2000

// Extra margin around the bar and the fields, since both are smaller than a
// fingertip
#define TOUCH_PAD 12

typedef enum {
  NumberTouchIdle = 0,
  NumberTouchPending,   // finger down, gesture undecided
  NumberTouchScrub,     // finger is dragging the bar
} NumberTouchMode;

static NumberTouchMode s_touch_mode = NumberTouchIdle;
static int16_t s_touch_down_x, s_touch_down_y;
static int64_t s_touch_down_ms;

static bool prv_rect_hit(GRect r, int16_t x, int16_t y, int16_t pad) {
  return x >= r.origin.x - pad && x <= r.origin.x + r.size.w + pad &&
         y >= r.origin.y - pad && y <= r.origin.y + r.size.h + pad;
}

// Map a horizontal position on the bar to a value, snapped to the caller's
// step so dragging cannot produce a value the buttons never would
static void prv_set_from_x(SimplyNumber *self, GRect bounds, int16_t x) {
  const GRect track = prv_track_rect(bounds);
  const int32_t inner_x = track.origin.x + 2;
  const int32_t inner_w = track.size.w - 4;
  if (inner_w <= 0) { return; }

  int32_t pos = x - inner_x;
  if (pos < 0) { pos = 0; }
  if (pos > inner_w) { pos = inner_w; }

  const int32_t range = self->max - self->min;
  int32_t value = self->min + (int32_t)(((int64_t)range * pos + inner_w / 2) / inner_w);
  if (self->step > 0) {
    const int32_t steps = (value - self->min + self->step / 2) / self->step;
    value = self->min + steps * self->step;
  }
  value = prv_clamp(value, self->min, self->max);

  self->last_input_ms = prv_now_ms();
  if (value != self->value) {
    self->value = value;
    prv_schedule_settle(self);
    layer_mark_dirty(window_get_root_layer(self->window));
  }
}

static void prv_select_field_at(SimplyNumber *self, GRect bounds, int16_t x, int16_t y) {
  GRect boxes[4];
  prv_layout_fields(self, bounds, boxes);
  const uint8_t count = prv_field_count(self);
  for (uint8_t i = 0; i < count; i++) {
    if (prv_rect_hit(boxes[i], x, y, TOUCH_PAD)) {
      if (self->field != i) {
        self->field = i;
        self->last_input_ms = prv_now_ms();
        layer_mark_dirty(window_get_root_layer(self->window));
      }
      return;
    }
  }
}

bool simply_number_handle_touch(Simply *simply, const TouchEvent *event) {
  SimplyNumber *self = simply->number;
  // Only while the selector is the window actually on screen. Without this
  // the swipe back in simply_touch would act on the JS window underneath,
  // dismissing the page behind the selector while the selector stayed up.
  if (!self || window_stack_get_top_window() != self->window) {
    return false;
  }

  const GRect bounds = layer_get_bounds(window_get_root_layer(self->window));

  switch (event->type) {
    case TouchEvent_Touchdown:
      if (event->non_navigational) {
        s_touch_mode = NumberTouchIdle;
        return true;
      }
      s_touch_down_x = event->x;
      s_touch_down_y = event->y;
      s_touch_down_ms = prv_now_ms();
      // Touching the bar grabs it straight away, so a tap sets the value and
      // a drag carries on from there. Anywhere else stays undecided so it can
      // still turn into a swipe.
      if (!self->duration_mode && self->show_bar &&
          prv_rect_hit(prv_track_rect(bounds), event->x, event->y, TOUCH_PAD)) {
        s_touch_mode = NumberTouchScrub;
        prv_set_from_x(self, bounds, event->x);
      } else {
        s_touch_mode = NumberTouchPending;
      }
      return true;

    case TouchEvent_PositionUpdate:
      if (s_touch_mode == NumberTouchScrub) {
        prv_set_from_x(self, bounds, event->x);
      }
      return true;

    case TouchEvent_Liftoff: {
      const NumberTouchMode mode = s_touch_mode;
      s_touch_mode = NumberTouchIdle;
      if (mode == NumberTouchScrub) {
        return true;
      }
      if (mode != NumberTouchPending ||
          prv_now_ms() - s_touch_down_ms > TOUCH_GESTURE_MAX_MS) {
        return true;
      }

      const int dx = event->x - s_touch_down_x;
      const int dy = event->y - s_touch_down_y;
      const int adx = abs(dx);
      const int ady = abs(dy);

      if (adx < TOUCH_TAP_SLOP && ady < TOUCH_TAP_SLOP) {
        if (self->duration_mode) {
          prv_select_field_at(self, bounds, event->x, event->y);
        }
        return true;
      }

      // Swipe right leaves, the same as the back button and the same as
      // everywhere else on the watch
      if (adx >= TOUCH_SWIPE_MIN && adx > ady && dx > 0) {
        window_stack_remove(self->window, false);
      }
      return true;
    }
  }

  return true;
}

#endif  // SIMPLY_HAS_TOUCH

bool simply_number_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandNumberSelectorShow:
      prv_handle_show(simply, packet);
      return true;
    case CommandNumberSelectorHide:
      if (simply->number) {
        // disappear tears the selector down
        window_stack_remove(simply->number->window, false);
      }
      return true;
    case CommandNumberSelectorValue:
      prv_handle_value(simply, packet);
      return true;
  }
  return false;
}
