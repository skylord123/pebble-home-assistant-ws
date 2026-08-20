#include "simply_number.h"

#include "simply.h"

#include "simply_msg.h"

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

// Seconds a press on the given duration field adds or subtracts
static int32_t prv_field_step(uint8_t field) {
  if (field == 0) { return 3600; }
  if (field == 1) { return 60; }
  return 1;
}

// Draw the value as HH:MM:SS with the selected field boxed. The field is
// only an input aid, so nothing here needs its own stored value.
static void prv_draw_duration(SimplyNumber *self, GContext *ctx, int16_t w, int16_t h, int16_t inset) {
  const int32_t total = self->value < 0 ? 0 : self->value;
  const int32_t parts[3] = { total / 3600, (total % 3600) / 60, total % 60 };

  const int16_t colon_w = 10;
  int16_t box_w = (w - 2 * inset - 2 * colon_w) / 3;
  if (box_w > 40) { box_w = 40; }
  const int16_t box_h = 34;
  const int16_t total_w = 3 * box_w + 2 * colon_w;
  const int16_t y = h / 2 - 24;
  int16_t x = (w - total_w) / 2;

  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);

  for (uint8_t i = 0; i < 3; i++) {
    char buf[4];
    snprintf(buf, sizeof(buf), "%02d", (int)parts[i]);

    if (i == self->field) {
      graphics_context_set_fill_color(ctx, GColorBlack);
      graphics_fill_rect(ctx, GRect(x, y, box_w, box_h), 3, GCornersAll);
      graphics_context_set_text_color(ctx, GColorWhite);
    } else {
      graphics_context_set_text_color(ctx, GColorBlack);
    }
    graphics_draw_text(ctx, buf, font, GRect(x, y - 3, box_w, box_h),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

    x += box_w;
    if (i < 2) {
      graphics_context_set_text_color(ctx, GColorBlack);
      graphics_draw_text(ctx, ":", font, GRect(x, y - 3, colon_w, box_h),
          GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
      x += colon_w;
    }
  }
}

static void prv_layer_update(Layer *layer, GContext *ctx) {
  SimplyNumber *self = window_get_user_data(layer_get_window(layer));
  const GRect bounds = layer_get_bounds(layer);
  const int16_t w = bounds.size.w;
  const int16_t h = bounds.size.h;
  const int16_t inset = PBL_IF_ROUND_ELSE(24, 8);

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
    prv_draw_duration(self, ctx, w, h, inset);
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
    const int16_t bar_margin = PBL_IF_ROUND_ELSE(34, 20);
    const GRect track = GRect(bar_margin, h / 2 + 20, w - 2 * bar_margin, 14);
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
  // In duration mode the step comes from the selected field, and the
  // acceleration stops at ten so holding seconds does not jump by minutes
  if (self->duration_mode) {
    const int32_t step = prv_field_step(self->field);
    return (clicks > ACCEL_TIER1_CLICKS) ? step * 10 : step;
  }
  const int32_t total_steps = self->step > 0 ? (self->max - self->min) / self->step : 0;
  int32_t mult = 1;
  if (clicks > ACCEL_TIER1_CLICKS && total_steps > ACCEL_TIER1_MIN_STEPS) { mult = 10; }
  if (clicks > ACCEL_TIER2_CLICKS && total_steps > ACCEL_TIER2_MIN_STEPS) { mult = 100; }
  return self->step * mult;
}

static void prv_adjust(SimplyNumber *self, int32_t delta) {
  const int32_t value = prv_clamp(self->value + delta, self->min, self->max);
  self->last_input_ms = prv_now_ms();
  if (value != self->value) {
    self->value = value;
    layer_mark_dirty(window_get_root_layer(self->window));
  }
}

static void prv_up_click(ClickRecognizerRef recognizer, void *context) {
  SimplyNumber *self = context;
  prv_adjust(self, prv_accel_delta(self, click_number_of_clicks_counted(recognizer)));
}

static void prv_down_click(ClickRecognizerRef recognizer, void *context) {
  SimplyNumber *self = context;
  prv_adjust(self, -prv_accel_delta(self, click_number_of_clicks_counted(recognizer)));
}

static void prv_confirm(SimplyNumber *self) {
  NumberSelectorResultPacket packet = {
    .packet = { .type = CommandNumberSelectorResult, .length = sizeof(packet) },
    .value = self->value,
  };
  simply_msg_send_packet(&packet.packet);
}

static void prv_select_click(ClickRecognizerRef recognizer, void *context) {
  SimplyNumber *self = context;
  // Duration mode walks hours to minutes to seconds first, then confirms
  if (self->duration_mode && self->field < 2) {
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
  layer_mark_dirty(window_get_root_layer(self->window));
}

bool simply_number_is_covering(Simply *simply) {
  return (simply->number && window_stack_contains_window(simply->number->window));
}

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
