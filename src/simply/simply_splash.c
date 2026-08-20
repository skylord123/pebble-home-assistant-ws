#include "simply_splash.h"

#include "simply.h"

#include "simply_msg.h"

#include <pebble.h>

// The startup / connection status screen, drawn and animated entirely on the
// watch so it appears instantly at launch, before the phone JS has even
// booted. The Home Assistant logo and the sad face error state come from the
// Rebble iconography set (Apache 2.0, github.com/pebble-dev/iconography:
// brand-logos/Home_Assistant_80px.svg and pebbleos/Pebble_80x80_Emoji_sad.svg)
// translated from their SVG points into line and rect draws, so no bitmap
// resources or image heap are needed. JS drives the status text and error
// state through the CommandSplash* packets.

#define SPLASH_BG PBL_IF_COLOR_ELSE(GColorVividCerulean, GColorBlack)
#define SPLASH_ACCENT PBL_IF_COLOR_ELSE(GColorCeleste, GColorWhite)

// Aplite loads the app binary into its 24KB of app RAM, and pebble.js already
// runs close to that limit, so the splash there keeps only the logo and text:
// no pulse animation and no error/setup glyphs (the status text still tells
// the story)
#if !defined(PBL_PLATFORM_APLITE)
#define SPLASH_FANCY 1
#endif

// Pulse timing: rings re-fire every PERIOD ticks and travel for TRAVEL ticks,
// the second ring offset by half a period. The first tick is delayed so the
// pulse starts after the system's app launch transition; frames rendered
// during it are frozen on screen, which showed a stationary ring
#define PULSE_TICK_MS 40
#define PULSE_START_DELAY_MS 500
#define PULSE_PERIOD_TICKS 45
#define PULSE_TRAVEL_TICKS 38

typedef enum SplashMode {
  SplashModeConnecting = 0,
  SplashModeError = 1,
  SplashModeSetup = 2,
} SplashMode;

typedef struct SplashModePacket SplashModePacket;

struct __attribute__((__packed__)) SplashModePacket {
  Packet packet;
  uint8_t mode;
};

typedef struct SplashStatusPacket SplashStatusPacket;

struct __attribute__((__packed__)) SplashStatusPacket {
  Packet packet;
  uint16_t title_length;
  uint16_t status_length;
  uint16_t body_length;
  char buffer[];
};

#if defined(SPLASH_FANCY)
// The logo house spans 76 units in the source SVG
static int16_t prv_px(int16_t v, int16_t logo_size) {
  return (v * logo_size + 38) / 76;
}

// House outline and circuit traces as pairs of points in 76-unit space,
// origin at the house's top left
static const int8_t HOUSE_LINES[][4] = {
  {38, 0, 0, 38},   // left roof
  {0, 38, 0, 76},   // left wall
  {0, 76, 76, 76},  // base
  {76, 76, 76, 38}, // right wall
  {76, 38, 38, 0},  // right roof
  {38, 38, 38, 76}, // trunk
  {35, 76, 25, 66}, // left branch
  {53, 58, 38, 73}, // right branch
};

// Square node positions (14x14 in 76-unit space)
static const int8_t HOUSE_SQUARES[][2] = {
  {31, 24}, {11, 52}, {53, 44},
};

#if defined(SPLASH_FANCY)
// The sad face spans 9..71 in an 80-unit viewbox; points stored offset from
// its center at 40 and doubled so the half-unit eye coordinates stay exact
static const int8_t FACE_LINES_X2[][4] = {
  {-46, 62, -62, 46},   // outline, clockwise from bottom left chamfer
  {-62, 46, -62, -46},
  {-62, -46, -46, -62},
  {-46, -62, 46, -62},
  {46, -62, 62, -46},
  {62, -46, 62, 46},
  {62, 46, 46, 62},
  {46, 62, -46, 62},
  {18, 42, 6, 30},      // mouth
  {6, 30, -6, 30},
  {-6, 30, -18, 42},
};

static const int8_t FACE_EYES_X2[][4] = {
  {-45, 15, -21, 3},
  {45, 15, 21, 3},
};

// The settings icon (pebbleos/Pebble_80x80_Settings.svg): three slider
// tracks with a knob each, stored offset from the icon's center at 40
static const int8_t SLIDER_TRACKS[][4] = {
  {-34, -23, 34, -23},
  {-34, 2, 34, 2},
  {-34, 27, 34, 27},
};

// Knob top-left offsets; knobs are 17x18 in 80-unit space
static const int8_t SLIDER_KNOBS[][2] = {
  {-3, -32}, {-24, -7}, {17, 18},
};
#endif

static void prv_draw_scaled_lines(GContext *ctx, const int8_t lines[][4], int count,
                                  GPoint origin, int16_t logo_size, int16_t divisor) {
  for (int i = 0; i < count; ++i) {
    const GPoint a = {
      origin.x + (lines[i][0] * logo_size + divisor / 2) / divisor,
      origin.y + (lines[i][1] * logo_size + divisor / 2) / divisor,
    };
    const GPoint b = {
      origin.x + (lines[i][2] * logo_size + divisor / 2) / divisor,
      origin.y + (lines[i][3] * logo_size + divisor / 2) / divisor,
    };
    graphics_draw_line(ctx, a, b);
  }
}

#endif

static void prv_layer_update(Layer *layer, GContext *ctx) {
  SimplySplash *self = window_get_user_data(layer_get_window(layer));
  if (!self) { return; }

  const GRect bounds = layer_get_bounds(layer);
  const int16_t w = bounds.size.w;
  const int16_t h = bounds.size.h;
  const bool is_round = PBL_IF_ROUND_ELSE(true, false);
  const bool big = (w >= 200);
  const int16_t logo_size = (w < h ? w : h) * (is_round ? 34 : 40) / 100;

  graphics_context_set_fill_color(ctx, SPLASH_BG);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

#if defined(SPLASH_FANCY)
  const int16_t cx = w / 2;
  const int16_t cy = h * (is_round ? 33 : 32) / 100;
  const int16_t stroke = prv_px(4, logo_size) < 2 ? 2 : prv_px(4, logo_size);

  graphics_context_set_stroke_color(ctx, GColorWhite);
  graphics_context_set_antialiased(ctx, true);

  if (self->mode == SplashModeConnecting) {
    // Pulse rings, drawn first so the logo sits on top of them
    graphics_context_set_fill_color(ctx, SPLASH_ACCENT);
    for (int i = 0; i < 2; ++i) {
      // The second ring starts half a period after the first; neither is
      // drawn before it has actually started moving or while parked
      // between pulses
      const uint16_t start = i * PULSE_PERIOD_TICKS / 2;
      if (self->tick <= start) { continue; }
      const uint16_t phase = (self->tick - start) % PULSE_PERIOD_TICKS;
      if (phase >= PULSE_TRAVEL_TICKS) { continue; }
      // Ease-out cubic in fixed point: p = 255 - (255 - t)^3 / 255^2
      const int32_t x = phase * 255 / PULSE_TRAVEL_TICKS;
      const int32_t inv = 255 - x;
      const int32_t p = 255 - (inv * inv * inv) / (255 * 255);
      const int16_t r = self->ring_r0 + (self->ring_r1 - self->ring_r0) * p / 255;
      // The house's visual center sits below its bounding box center (the
      // roof tapers to a point), so emit the rings from the shape's centroid
      const int16_t ring_cy = cy + prv_px(8, logo_size);
      const GRect ring_rect = GRect(cx - r, ring_cy - r, 2 * r, 2 * r);
      graphics_fill_radial(ctx, ring_rect, GOvalScaleModeFitCircle, big ? 3 : 2,
                           0, TRIG_MAX_ANGLE);
    }

    // Home Assistant logo
    const GPoint origin = { cx - prv_px(38, logo_size), cy - prv_px(38, logo_size) };
    graphics_context_set_stroke_width(ctx, stroke);
    prv_draw_scaled_lines(ctx, HOUSE_LINES, ARRAY_LENGTH(HOUSE_LINES), origin,
                          logo_size, 76);
    const int16_t square = prv_px(14, logo_size);
    for (int i = 0; i < (int)ARRAY_LENGTH(HOUSE_SQUARES); ++i) {
      const GRect rect = {
        { origin.x + prv_px(HOUSE_SQUARES[i][0], logo_size),
          origin.y + prv_px(HOUSE_SQUARES[i][1], logo_size) },
        { square, square },
      };
      graphics_draw_round_rect(ctx, rect, prv_px(2, logo_size));
    }
  } else if (self->mode == SplashModeError) {
    // Sad face for the error state, centered where the logo was
    const GPoint center = { cx, cy };
    graphics_context_set_stroke_width(ctx, stroke);
    prv_draw_scaled_lines(ctx, FACE_LINES_X2, ARRAY_LENGTH(FACE_LINES_X2), center,
                          logo_size, 152);
    const int16_t eye_stroke = prv_px(3, logo_size) < 2 ? 2 : prv_px(3, logo_size);
    graphics_context_set_stroke_width(ctx, eye_stroke);
    prv_draw_scaled_lines(ctx, FACE_EYES_X2, ARRAY_LENGTH(FACE_EYES_X2), center,
                          logo_size, 152);
  } else {
    // Settings sliders for the setup state; knobs are filled with the
    // background color so the track does not show through them
    const GPoint center = { cx, cy };
    graphics_context_set_stroke_width(ctx, stroke);
    prv_draw_scaled_lines(ctx, SLIDER_TRACKS, ARRAY_LENGTH(SLIDER_TRACKS), center,
                          logo_size, 80);
    const GSize knob = { (17 * logo_size + 40) / 80, (18 * logo_size + 40) / 80 };
    for (int i = 0; i < (int)ARRAY_LENGTH(SLIDER_KNOBS); ++i) {
      const GRect rect = {
        { center.x + (SLIDER_KNOBS[i][0] * logo_size + 40) / 80,
          center.y + (SLIDER_KNOBS[i][1] * logo_size + 40) / 80 },
        knob,
      };
      graphics_context_set_fill_color(ctx, SPLASH_BG);
      graphics_fill_rect(ctx, rect, prv_px(2, logo_size), GCornersAll);
      graphics_draw_round_rect(ctx, rect, prv_px(2, logo_size));
    }
  }
#endif

  // Text stack: title, status line, then a smaller detail line
  const int16_t title_h = big ? 32 : 28;
#if defined(SPLASH_FANCY)
  const int16_t title_y = cy + logo_size / 2 + h * 45 / 1000;
#else
  const int16_t title_y = (h - logo_size) / 2;
#endif
  const int16_t status_y = title_y + title_h;
  const int16_t body_y = status_y + 22;
  const int16_t body_w = is_round ? w * 68 / 100 : w - 16;

  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, self->title,
      fonts_get_system_font(big ? FONT_KEY_GOTHIC_28_BOLD : FONT_KEY_GOTHIC_24_BOLD),
      GRect(0, title_y, w, title_h + 8), GTextOverflowModeTrailingEllipsis,
      GTextAlignmentCenter, NULL);

  graphics_context_set_text_color(ctx, SPLASH_ACCENT);
  graphics_draw_text(ctx, self->status, fonts_get_system_font(FONT_KEY_GOTHIC_18),
      GRect(0, status_y, w, 24), GTextOverflowModeTrailingEllipsis,
      GTextAlignmentCenter, NULL);

  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, self->body, fonts_get_system_font(FONT_KEY_GOTHIC_14),
      GRect((w - body_w) / 2, body_y, body_w, 36), GTextOverflowModeWordWrap,
      GTextAlignmentCenter, NULL);
}

#if defined(SPLASH_FANCY)
static void prv_timer_callback(void *data) {
  SimplySplash *self = data;
  self->timer = NULL;
  if (self->mode != SplashModeConnecting) { return; }
  self->tick++;
  layer_mark_dirty(window_get_root_layer(self->window));
  self->timer = app_timer_register(PULSE_TICK_MS, prv_timer_callback, self);
}

static void prv_stop_timer(SimplySplash *self) {
  if (self->timer) {
    app_timer_cancel(self->timer);
    self->timer = NULL;
  }
}

static int16_t prv_isqrt(int32_t v) {
  int32_t r = 0;
  while ((r + 1) * (r + 1) <= v) { r++; }
  return r;
}
#else
static void prv_stop_timer(SimplySplash *self) {}
#endif

static void window_load(Window *window) {
  SimplySplash *self = window_get_user_data(window);
  Layer *root_layer = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(root_layer);
  const int16_t w = bounds.size.w;
  const int16_t h = bounds.size.h;
  const bool is_round = PBL_IF_ROUND_ELSE(true, false);
  const int16_t logo_size = (w < h ? w : h) * (is_round ? 34 : 40) / 100;
  const int16_t cx = w / 2;
  const int16_t cy = h * (is_round ? 33 : 32) / 100;

#if defined(SPLASH_FANCY)
  // Rings start just outside the logo and must clear the farthest screen
  // corner before they reset so they always travel fully off screen; they
  // are centered on the logo's visual centroid, a bit below cy
  const int16_t ring_cy = cy + prv_px(8, logo_size);
  const int16_t corner_x = cx > w - cx ? cx : w - cx;
  const int16_t corner_y = ring_cy > h - ring_cy ? ring_cy : h - ring_cy;
  self->ring_r0 = logo_size * 125 / 200;
  self->ring_r1 = prv_isqrt((int32_t)corner_x * corner_x +
                            (int32_t)corner_y * corner_y) + 6;
#endif

  layer_set_update_proc(root_layer, prv_layer_update);

}

static void window_appear(Window *window) {
#if defined(SPLASH_FANCY)
  SimplySplash *self = window_get_user_data(window);
  if (!self->timer && self->mode == SplashModeConnecting) {
    self->timer = app_timer_register(PULSE_START_DELAY_MS, prv_timer_callback, self);
  }
#endif
}

// Set when the splash leaves the screen so the window revealed beneath it
// knows to ask JS for a re-render (it reloaded empty while covered)
static bool s_reveal_pending = false;

typedef struct SplashRevealPacket SplashRevealPacket;

struct __attribute__((__packed__)) SplashRevealPacket {
  Packet packet;
};

bool simply_splash_send_reveal(void) {
  SplashRevealPacket packet = {
    .packet = { .type = CommandSplashReveal, .length = sizeof(packet) },
  };
  return simply_msg_send_packet(&packet.packet);
}

bool simply_splash_consume_reveal(void) {
  const bool pending = s_reveal_pending;
  s_reveal_pending = false;
  return pending;
}

static void prv_destroy_later(void *data) {
  SimplySplash *self = data;
  bool animated = false;
  window_stack_remove(self->window, animated);
  simply_splash_destroy(self);
}

static void window_disappear(Window *window) {
  SimplySplash *self = window_get_user_data(window);
  // disappear can fire again when the covered window is explicitly removed
  // from the stack; the teardown must only be scheduled once
  if (self->destroying) { return; }
  self->destroying = true;
  prv_stop_timer(self);
  s_reveal_pending = true;
  // Defer the teardown: destroying a window from inside its own disappear
  // handler is unsafe while the window stack is mid-transition
  app_timer_register(0, prv_destroy_later, self);
}

SimplySplash *simply_splash_create(Simply *simply) {
  SimplySplash *self = malloc(sizeof(*self));
  *self = (SimplySplash) { .simply = simply };

  strncpy(self->title, "Home Assistant", sizeof(self->title) - 1);
  strncpy(self->status, "Connecting", sizeof(self->status) - 1);

  self->window = window_create();
  window_set_user_data(self->window, self);
  window_set_background_color(self->window, SPLASH_BG);
  window_set_window_handlers(self->window, (WindowHandlers) {
    .load = window_load,
    .appear = window_appear,
    .disappear = window_disappear,
  });

  return self;
}

void simply_splash_destroy(SimplySplash *self) {
  prv_stop_timer(self);

  window_destroy(self->window);

  self->simply->splash = NULL;

  free(self);
}

static void prv_copy_string(char *out, size_t out_size, const char *in) {
  strncpy(out, in, out_size - 1);
  out[out_size - 1] = '\0';
}

static void prv_handle_status_packet(Simply *simply, Packet *data) {
  SimplySplash *self = simply->splash;
  if (!self) { return; }
  SplashStatusPacket *packet = (SplashStatusPacket *)data;
  const char *title = packet->buffer;
  const char *status = title + packet->title_length + 1;
  const char *body = status + packet->status_length + 1;
  prv_copy_string(self->title, sizeof(self->title), title);
  prv_copy_string(self->status, sizeof(self->status), status);
  prv_copy_string(self->body, sizeof(self->body), body);
  layer_mark_dirty(window_get_root_layer(self->window));
}

bool simply_splash_is_covering(Simply *simply) {
  return (simply->splash && window_stack_contains_window(simply->splash->window));
}

bool simply_splash_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandSplashShow:
      if (!simply->splash) {
        simply->splash = simply_splash_create(simply);
      }
      if (!window_stack_contains_window(simply->splash->window)) {
        window_stack_push(simply->splash->window, false);
      }
      return true;
    case CommandSplashHide:
      if (simply->splash) {
        // disappear tears the splash down
        window_stack_remove(simply->splash->window, false);
      }
      return true;
    case CommandSplashStatus:
      prv_handle_status_packet(simply, packet);
      return true;
    case CommandSplashMode:
      if (simply->splash) {
        SimplySplash *self = simply->splash;
        self->mode = ((SplashModePacket *)packet)->mode;
#if defined(SPLASH_FANCY)
        if (self->mode == SplashModeConnecting) {
          if (!self->timer) {
            self->timer = app_timer_register(PULSE_TICK_MS, prv_timer_callback, self);
          }
        } else {
          prv_stop_timer(self);
        }
#endif
        layer_mark_dirty(window_get_root_layer(self->window));
      }
      return true;
  }
  return false;
}
