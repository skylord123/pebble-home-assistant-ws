#include "simply_touch.h"

#ifdef SIMPLY_HAS_TOUCH

#include "simply_msg.h"
#include "simply_menu.h"
#include "simply_window.h"
#include "simply_window_stack.h"

#include "simply.h"

#include <pebble.h>

// Gesture thresholds, kept identical to the JS side in src/js/ui/touch.js so a
// gesture means the same thing whether C or JS resolves it. The gap between
// them is deliberately dead: an ambiguous smear should do nothing rather than
// guess, because guessing wrong fires a real action on someone's house.
#define TAP_SLOP 10
#define SWIPE_MIN 30

// A finger down longer than this is not a gesture any more. Without it, a
// touchdown whose liftoff was dropped would pair with the NEXT liftoff and
// synthesize a swipe across the whole screen.
#define GESTURE_MAX_MS 2000

// How many rows a vertical swipe moves a menu.
#define SWIPE_ROWS 3

typedef struct TouchConfigPacket TouchConfigPacket;

struct __attribute__((__packed__)) TouchConfigPacket {
  Packet packet;
  bool subscribed;
  bool wants_moves;
};

typedef struct TouchDataPacket TouchDataPacket;

struct __attribute__((__packed__)) TouchDataPacket {
  Packet packet;
  TouchEventType type:8;
  int16_t x;
  int16_t y;
};

static SimplyTouch *s_touch = NULL;

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
// pair it with the seconds clock to get something subtractable.
static uint32_t now_ms(void) {
  return (uint32_t) time(NULL) * 1000u + (uint32_t) time_ms(NULL, NULL);
}

static int16_t s_down_x, s_down_y;
static uint32_t s_down_ms;
static bool s_is_down = false;

// Menus and cards are drawn entirely in C, so JS cannot hit-test them; those
// gestures have to be resolved here. Stage windows own their own elements on
// the JS side, so their gestures are forwarded instead of being handled here.
static bool prv_top_is_stage(Simply *simply) {
  SimplyWindow *top = simply_window_stack_get_top_window(simply);
  return top && simply->stage && top == (SimplyWindow*) simply->stage;
}

static SimplyMenu *prv_top_menu(Simply *simply) {
  SimplyWindow *top = simply_window_stack_get_top_window(simply);
  if (!top || !simply->menu) { return NULL; }
  return (top == (SimplyWindow*) simply->menu) ? simply->menu : NULL;
}

// @return true if the gesture was consumed here and should not go to JS.
static bool prv_handle_gesture(int16_t x, int16_t y, int dx, int dy) {
  Simply *simply = s_touch->simply;
  if (!simply || prv_top_is_stage(simply)) {
    return false;
  }

  int adx = abs(dx);
  int ady = abs(dy);
  SimplyMenu *menu = prv_top_menu(simply);

  if (adx < TAP_SLOP && ady < TAP_SLOP) {
    return menu ? simply_menu_handle_tap(menu, x, y) : false;
  }

  if (adx < SWIPE_MIN && ady < SWIPE_MIN) {
    return false;                          // ambiguous smear
  }

  if (adx > ady) {
    if (dx > 0) {
      // Swipe right is "back" everywhere on this watch. Only meaningful once
      // the phone side is up; before that the app is still on its splash and
      // the SDK stack is the only thing to pop.
      SimplyWindow *top = simply_window_stack_get_top_window(simply);
      if (top && simply_msg_has_communicated()) {
        simply_window_stack_back(simply->window_stack, top);
        return true;
      }
    }
    return false;
  }

  if (menu) {
    simply_menu_scroll_by(menu, (dy > 0) ? SWIPE_ROWS : -SWIPE_ROWS);
    return true;
  }
  return false;
}

static void handle_touch(const TouchEvent *event, void *context) {
  if (!s_touch) {
    return;
  }

  if (event->type == TouchEvent_Touchdown) {
    s_down_x = event->x;
    s_down_y = event->y;
    s_down_ms = now_ms();
    s_is_down = true;
  } else if (event->type == TouchEvent_Liftoff && s_is_down) {
    s_is_down = false;
    if (now_ms() - s_down_ms <= GESTURE_MAX_MS) {
      if (prv_handle_gesture(event->x, event->y,
                             event->x - s_down_x, event->y - s_down_y)) {
        return;                            // consumed by a menu or card
      }
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
  // `subscribed` is honoured only as a request to turn moves-level reporting
  // on; the sensor itself stays on, because C-side consumers (menus, swipe
  // back) need it regardless of what JS has registered.
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
  };
  s_touch = self;

  // Subscribed for the whole life of the app rather than on demand. Touch now
  // drives menus and back-navigation, which are drawn in C and have no JS
  // handlers to trigger an on-demand subscribe, so gating on JS handlers left
  // touch working on the dashboard and dead everywhere else.
  set_subscribe(self, true);

  return self;
}

void simply_touch_destroy(SimplyTouch *self) {
  if (!self) {
    return;
  }

  set_subscribe(self, false);

  free(self);

  s_touch = NULL;
}

#endif  // SIMPLY_HAS_TOUCH
