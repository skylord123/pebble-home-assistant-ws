#include "simply_touch.h"

#ifdef SIMPLY_HAS_TOUCH

#include "simply_msg.h"
#include "simply_menu.h"
#include "simply_number.h"
#include "simply_window.h"
#include "simply_window_stack.h"

#include "simply.h"

#include <pebble.h>

// Touch drives navigation the same way the firmware's own touch UI does:
// sliding a finger scrolls the content under it (with a fling carrying it
// after liftoff), a tap activates the row it lands on, a swipe right goes
// back, and holding a row fires the same event as holding the select button.
// Menus and cards are drawn entirely in C, so those gestures are resolved
// here; stage windows own their elements on the JS side, so their taps and
// swipes are forwarded instead.

// A finger that moves less than this between touchdown and liftoff is a tap
#define TAP_SLOP 10

// ...and one that travels at least this far horizontally is a swipe. The gap
// between the two is deliberately dead: an ambiguous smear should do nothing
// rather than guess, because guessing wrong fires a real action on someone's
// house
#define SWIPE_MIN 30

// Vertical movement beyond this starts dragging the content; smaller than
// TAP_SLOP would make taps twitchy, larger would make lists feel sticky
#define DRAG_START 8

// A finger down longer than this is not a tap or swipe any more. Without it,
// a touchdown whose liftoff was dropped would pair with the NEXT liftoff and
// synthesize a swipe across the whole screen
#define GESTURE_MAX_MS 2000

// Holding still this long on a menu row is a long press
#define LONG_PRESS_MS 500

// How far a fling carries: the liftoff velocity is projected this many
// milliseconds forward and the scroll animates there
#define FLING_MS 300

typedef struct TouchConfigPacket TouchConfigPacket;

struct __attribute__((__packed__)) TouchConfigPacket {
  Packet packet;
  bool subscribed;
  bool wants_moves;
  bool enabled;
  bool long_press;
};

typedef struct TouchDataPacket TouchDataPacket;

struct __attribute__((__packed__)) TouchDataPacket {
  Packet packet;
  TouchEventType type:8;
  int16_t x;
  int16_t y;
};

typedef enum TouchMode {
  TouchModeIdle = 0,   // no finger down
  TouchModePending,    // finger down, gesture not yet decided
  TouchModeDrag,       // finger is scrolling content directly
  TouchModeConsumed,   // gesture already resolved (long press); ignore the rest
} TouchMode;

static SimplyTouch *s_touch = NULL;

static TouchMode s_mode = TouchModeIdle;
static int16_t s_down_x, s_down_y;
static uint32_t s_down_ms;
static GPoint s_down_offset;
static ScrollLayer *s_drag_layer = NULL;
static bool s_drag_is_menu = false;

// Last two positions, for the fling velocity at liftoff
static int16_t s_last_y, s_prev_y;
static uint32_t s_last_ms, s_prev_ms;

static AppTimer *s_long_press_timer = NULL;

static bool send_touch_data(const TouchEvent *event) {
  TouchDataPacket packet = {
    .packet.type = CommandTouchData,
    .packet.length = sizeof(packet),
    .type = event->type,
    .x = event->x,
    .y = event->y,
  };
  return simply_msg_send_packet(&packet.packet);
}

// Pebble's time_ms() only returns milliseconds within the current second, so
// pair it with the seconds clock to get something subtractable
static uint32_t now_ms(void) {
  return (uint32_t) time(NULL) * 1000u + (uint32_t) time_ms(NULL, NULL);
}

static SimplyMenu *prv_top_menu(Simply *simply) {
  SimplyWindow *top = simply_window_stack_get_top_window(simply);
  if (!top || !simply->menu) { return NULL; }
  return (top == (SimplyWindow*) simply->menu) ? simply->menu : NULL;
}

static bool prv_top_is_stage(Simply *simply) {
  SimplyWindow *top = simply_window_stack_get_top_window(simply);
  return top && simply->stage && top == (SimplyWindow*) simply->stage;
}

// Whatever the finger would scroll: a menu's own scroll layer, or the shared
// window scroll layer of a scrollable card or stage window
static ScrollLayer *prv_top_scroll_layer(Simply *simply, bool *is_menu_out) {
  SimplyWindow *top = simply_window_stack_get_top_window(simply);
  if (!top) { return NULL; }
  if (simply->menu && top == (SimplyWindow*) simply->menu) {
    MenuLayer *menu_layer = simply->menu->menu_layer.menu_layer;
    if (is_menu_out) { *is_menu_out = true; }
    return menu_layer ? menu_layer_get_scroll_layer(menu_layer) : NULL;
  }
  if (is_menu_out) { *is_menu_out = false; }
  return top->is_scrollable ? top->scroll_layer : NULL;
}

static GPoint prv_clamp_offset(ScrollLayer *scroll_layer, int y) {
  const GSize content = scroll_layer_get_content_size(scroll_layer);
  const GRect frame = layer_get_frame(scroll_layer_get_layer(scroll_layer));
  int min = frame.size.h - content.h;
  if (min > 0) { min = 0; }
  if (y > 0) { y = 0; }
  if (y < min) { y = min; }
  return GPoint(0, y);
}

static void prv_cancel_long_press(void) {
  if (s_long_press_timer) {
    app_timer_cancel(s_long_press_timer);
    s_long_press_timer = NULL;
  }
}

static void prv_long_press_timer_callback(void *context) {
  s_long_press_timer = NULL;
  if (!s_touch || s_mode != TouchModePending) { return; }
  // Resolve the menu fresh: the window may have changed since touchdown
  SimplyMenu *menu = prv_top_menu(s_touch->simply);
  if (menu && simply_menu_handle_long_press(menu, s_down_x, s_down_y)) {
    s_mode = TouchModeConsumed;
  }
}

static void prv_begin_drag(void) {
  prv_cancel_long_press();
  s_mode = TouchModeDrag;
}

static void prv_drag_move(int16_t y) {
  // Re-resolve every move: if the window changed mid-drag the captured scroll
  // layer is gone and touching it would be a use after free
  bool is_menu = false;
  ScrollLayer *scroll_layer = prv_top_scroll_layer(s_touch->simply, &is_menu);
  if (!scroll_layer || scroll_layer != s_drag_layer) {
    s_mode = TouchModeConsumed;
    return;
  }
  const GPoint offset = prv_clamp_offset(scroll_layer,
                                         s_down_offset.y + (y - s_down_y));
  scroll_layer_set_content_offset(scroll_layer, offset, false);
  if (is_menu) {
    simply_menu_touch_note_input(s_touch->simply->menu);
  }
}

static void prv_drag_fling(void) {
  bool is_menu = false;
  ScrollLayer *scroll_layer = prv_top_scroll_layer(s_touch->simply, &is_menu);
  if (!scroll_layer || scroll_layer != s_drag_layer) { return; }

  const uint32_t dt = s_last_ms - s_prev_ms;
  if (dt == 0 || dt > 100) { return; }  // stale samples: finger had stopped
  const int dy = s_last_y - s_prev_y;
  const int carry = dy * (int) FLING_MS / (int) dt;
  if (carry == 0) { return; }

  const GPoint current = scroll_layer_get_content_offset(scroll_layer);
  const GPoint target = prv_clamp_offset(scroll_layer, current.y + carry);
  scroll_layer_set_content_offset(scroll_layer, target, true);
}

// @return true if the liftoff completed a gesture here and must not go to JS
static bool prv_handle_liftoff(int16_t x, int16_t y) {
  Simply *simply = s_touch->simply;

  if (now_ms() - s_down_ms > GESTURE_MAX_MS) {
    return false;
  }

  const int dx = x - s_down_x;
  const int dy = y - s_down_y;
  const int adx = abs(dx);
  const int ady = abs(dy);
  SimplyMenu *menu = prv_top_menu(simply);

  if (adx < TAP_SLOP && ady < TAP_SLOP) {
    // Stage windows hit-test their own elements in JS
    return menu ? simply_menu_handle_tap(menu, x, y) : false;
  }

  // Swipe right is "back" everywhere on this watch. Only meaningful once the
  // phone side is up; before that the app is still on its splash
  if (adx >= SWIPE_MIN && adx > ady && dx > 0) {
    SimplyWindow *top = simply_window_stack_get_top_window(simply);
    if (top && simply_msg_has_communicated()) {
      simply_window_stack_back(simply->window_stack, top);
      return true;
    }
  }

  return false;
}

static void handle_touch(const TouchEvent *event, void *context) {
  if (!s_touch) {
    return;
  }

  // The number selector is a native window that the JS window stack knows
  // nothing about, so it has to resolve its own gestures. It also has to run
  // before the generic handling below, which would otherwise swipe back the
  // JS window sitting hidden underneath it.
  if (simply_number_handle_touch(s_touch->simply, event)) {
    return;
  }

  switch (event->type) {
    case TouchEvent_Touchdown:
      if (event->non_navigational) {
        // Unarmed contact (latched by the firmware for the whole gesture)
        // must not drive navigation
        s_mode = TouchModeIdle;
        break;
      }
      s_mode = TouchModePending;
      s_down_x = event->x;
      s_down_y = event->y;
      s_down_ms = now_ms();
      s_last_y = s_prev_y = event->y;
      s_last_ms = s_prev_ms = s_down_ms;
      // Captured now so a drag is finger-locked from its very first pixel
      s_drag_layer = prv_top_scroll_layer(s_touch->simply, &s_drag_is_menu);
      s_down_offset = s_drag_layer ?
          scroll_layer_get_content_offset(s_drag_layer) : GPointZero;
      // A long press only means something on a menu row, and only when the
      // user has not turned long press actions off
      if (s_touch->long_press && prv_top_menu(s_touch->simply)) {
        prv_cancel_long_press();
        s_long_press_timer =
            app_timer_register(LONG_PRESS_MS, prv_long_press_timer_callback, NULL);
      }
      break;

    case TouchEvent_PositionUpdate:
      if (s_mode == TouchModePending) {
        s_prev_y = s_last_y;
        s_prev_ms = s_last_ms;
        s_last_y = event->y;
        s_last_ms = now_ms();
        if (abs(event->x - s_down_x) >= TAP_SLOP ||
            abs(event->y - s_down_y) >= TAP_SLOP) {
          // Too much travel to still be a tap or a long press
          prv_cancel_long_press();
        }
        if (s_drag_layer && abs(event->y - s_down_y) >= DRAG_START) {
          prv_begin_drag();
          prv_drag_move(event->y);
        }
      } else if (s_mode == TouchModeDrag) {
        s_prev_y = s_last_y;
        s_prev_ms = s_last_ms;
        s_last_y = event->y;
        s_last_ms = now_ms();
        prv_drag_move(event->y);
      }
      break;

    case TouchEvent_Liftoff: {
      prv_cancel_long_press();
      const TouchMode mode = s_mode;
      s_mode = TouchModeIdle;
      if (mode == TouchModeDrag) {
        prv_drag_fling();
        return;                            // the drag was the gesture
      }
      if (mode == TouchModeConsumed) {
        return;                            // a long press already fired
      }
      if (mode == TouchModePending && prv_handle_liftoff(event->x, event->y)) {
        return;                            // tap or swipe resolved here
      }
      break;
    }
  }

  if (event->type == TouchEvent_PositionUpdate && !s_touch->wants_moves) {
    return;
  }

  // A dropped touch packet is not worth retrying: by the time a retry landed
  // the gesture would already have been resolved by a later event, and a stale
  // touchdown would make the JS state machine invent a swipe that never
  // happened. Losing the event is the safe failure.
  send_touch_data(event);
}

static void set_subscribe(SimplyTouch *self, bool subscribe) {
  if (self->subscribed == subscribe) {
    return;
  }
  if (subscribe) {
    touch_service_subscribe(handle_touch, NULL);
  } else {
    touch_service_unsubscribe();
  }
  self->subscribed = subscribe;
}

static void handle_touch_config_packet(Simply *simply, Packet *data) {
  TouchConfigPacket *packet = (TouchConfigPacket*) data;
  if (!simply->touch) {
    return;
  }
  simply->touch->wants_moves = packet->wants_moves;
  simply->touch->long_press = packet->long_press;
  // The user setting is the only thing that turns the sensor off:
  // `subscribed` reflects JS handler counts, but C-side consumers (menus,
  // scrolling, swipe back) need the sensor regardless of what JS registered
  set_subscribe(simply->touch, packet->enabled);
}

bool simply_touch_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandTouchConfig:
      handle_touch_config_packet(simply, packet);
      return true;
    default:
      break;
  }
  return false;
}

SimplyTouch *simply_touch_create(Simply *simply) {
  if (s_touch) {
    return s_touch;
  }

  SimplyTouch *self = malloc(sizeof(*self));
  if (!self) {
    return NULL;
  }
  *self = (SimplyTouch) {
    .simply = simply,
    .subscribed = false,
    .wants_moves = false,
    .long_press = true,
  };
  s_touch = self;

  // Subscribed for the whole life of the app rather than on demand. Touch
  // drives menus, scrolling, and back-navigation, which are handled in C and
  // have no JS handlers to trigger an on-demand subscribe.
  set_subscribe(self, true);

  return self;
}

void simply_touch_destroy(SimplyTouch *self) {
  if (!self) {
    return;
  }

  prv_cancel_long_press();
  set_subscribe(self, false);

  free(self);

  s_touch = NULL;
}

#endif  // SIMPLY_HAS_TOUCH
