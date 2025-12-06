#include "simply_window_stack.h"

#include "simply_window.h"
#include "simply_msg.h"

#include "simply.h"

#include "util/math.h"
#include "util/none.h"
#include "util/platform.h"
#include "util/sdk.h"

#include <pebble.h>

typedef enum WindowType WindowType;

enum WindowType {
  WindowTypeWindow = 0,
  WindowTypeMenu,
  WindowTypeCard,
  WindowTypeLast,
};

// Number of known window types for validation
const int WINDOW_TYPE_COUNT = WindowTypeLast;

typedef struct WindowShowPacket WindowShowPacket;

struct __attribute__((__packed__)) WindowShowPacket {
  Packet packet;
  WindowType type:8;
  bool pushing;
};

typedef struct WindowSignalPacket WindowSignalPacket;

struct __attribute__((__packed__)) WindowSignalPacket {
  Packet packet;
  uint32_t id;
};

typedef WindowSignalPacket WindowHidePacket;

typedef WindowHidePacket WindowEventPacket;

typedef WindowEventPacket WindowShowEventPacket;

typedef WindowEventPacket WindowHideEventPacket;

static bool s_broadcast_window = true;

static bool send_window(SimplyMsg *self, Command type, uint32_t id) {
  if (!s_broadcast_window) {
    return false;
  }
  WindowEventPacket packet = {
    .packet.type = type,
    .packet.length = sizeof(packet),
    .id = id,
  };
  return simply_msg_send_packet(&packet.packet);
}

static bool send_window_show(SimplyMsg *self, uint32_t id) {
  return send_window(self, CommandWindowShowEvent, id);
}

static bool send_window_hide(SimplyMsg *self, uint32_t id) {
  return send_window(self, CommandWindowHideEvent, id);
}

bool simply_window_stack_set_broadcast(bool broadcast) {
  bool was_broadcast = s_broadcast_window;
  s_broadcast_window = broadcast;
  return was_broadcast;
}

SimplyWindow *simply_window_stack_get_top_window(Simply *simply) {
  Window *base_window = window_stack_get_top_window();
  if (!base_window) {
    return NULL;
  }
  SimplyWindow *window = window_get_user_data(base_window);
  if (!window || (void*) window == simply->splash) {
    return NULL;
  }

  // Validate that this is actually one of our known windows
  // This prevents crashes when system dialogs (like dictation confirmation) are on top
  for (int i = 0; i < WINDOW_TYPE_COUNT; i++) {
    if (window == simply->windows[i]) {
      return window;  // It's one of ours
    }
  }

  // Not one of our windows (e.g., system dictation dialog)
  return NULL;
}

#ifdef PBL_SDK_3
static void show_window_sdk_3(SimplyWindowStack *self, SimplyWindow *window, bool is_push) {
  const bool animated = (self->simply->splash == NULL);

  if (!animated) {
    self->is_showing = true;
    window_stack_pop_all(false);
    self->is_showing = false;
  }

  Window *prev_window = window_stack_get_top_window();

  simply_window_preload(window);

  if (window->window == prev_window) {
    // It's the same window, we can't animate for now
    return;
  }

  window_stack_push(window->window, animated);

  if (IF_APLITE_ELSE(true, animated)) {
    window_stack_remove(prev_window, animated);
  }
}
#endif

#ifdef PBL_SDK_2
static void show_window_sdk_2(SimplyWindowStack *self, SimplyWindow *window, bool is_push) {
  const bool animated = (self->simply->splash == NULL);

  self->is_showing = true;
  window_stack_pop_all(!is_push);
  self->is_showing = false;

  if (is_push) {
    window_stack_push(self->pusher, false);
  }

  simply_window_preload(window);
  window_stack_push(window->window, animated);

  if (is_push) {
    window_stack_remove(self->pusher, false);
  }
}
#endif

void simply_window_stack_show(SimplyWindowStack *self, SimplyWindow *window, bool is_push) {
  IF_SDK_3_ELSE(show_window_sdk_3, show_window_sdk_2)(self, window, is_push);
}

void simply_window_stack_pop(SimplyWindowStack *self, SimplyWindow *window) {
  self->is_hiding = true;
  if (window->window == window_stack_get_top_window()) {
    bool animated = true;
    window_stack_pop(animated);
  }
  self->is_hiding = false;
}

void simply_window_stack_back(SimplyWindowStack *self, SimplyWindow *window) {
  self->is_hiding = true;
  simply_window_stack_send_hide(self, window);
  self->is_hiding = false;
}

void simply_window_stack_send_show(SimplyWindowStack *self, SimplyWindow *window) {
  if (window->id && self->is_showing) {
    send_window_show(self->simply->msg, window->id);
  }
}

void simply_window_stack_send_hide(SimplyWindowStack *self, SimplyWindow *window) {
  if (window->id && !self->is_showing) {
    send_window_hide(self->simply->msg, window->id);
    IF_SDK_2_ELSE({
      if (!self->is_hiding) {
        window_stack_push(self->pusher, false);
      }
    }, NONE);
  }
}

static void handle_window_show_packet(Simply *simply, Packet *data) {
  WindowShowPacket *packet = (WindowShowPacket*) data;
  SimplyWindow *window = simply->windows[MIN(WindowTypeLast - 1, packet->type)];
  simply_window_stack_show(simply->window_stack, window, packet->pushing);
}

static void handle_window_hide_packet(Simply *simply, Packet *data) {
  WindowHidePacket *packet = (WindowHidePacket*) data;
  SimplyWindow *window = simply_window_stack_get_top_window(simply);
  if (!window) {
    return;
  }
  if (window->id == packet->id) {
    simply_window_stack_pop(simply->window_stack, window);
  }
}

bool simply_window_stack_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandWindowShow:
      handle_window_show_packet(simply, packet);
      return true;
    case CommandWindowHide:
      handle_window_hide_packet(simply, packet);
      return true;
  }
  return false;
}

SimplyWindowStack *simply_window_stack_create(Simply *simply) {
  SimplyWindowStack *self = malloc(sizeof(*self));
  *self = (SimplyWindowStack) { .simply = simply };

  IF_SDK_2_ELSE({
    self->pusher = window_create();
  }, NONE);

  return self;
}

void simply_window_stack_destroy(SimplyWindowStack *self) {
  if (!self) {
    return;
  }

  IF_SDK_2_ELSE({
    window_destroy(self->pusher);
    self->pusher = NULL;
  }, NONE);

  free(self);
}
