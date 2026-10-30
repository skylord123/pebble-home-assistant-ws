#include "simply_msg.h"

#include "simply_splash.h"
#include "simply_number.h"
#include "simply_assist.h"

#include "simply_accel.h"
#include "simply_touch.h"
#include "simply_voice.h"
#include "simply_res.h"
#include "simply_stage.h"
#include "simply_menu.h"
#include "simply_ui.h"
#include "simply_window_stack.h"
#include "simply_wakeup.h"

#include "simply.h"

#include "util/dict.h"
#include "util/list1.h"
#include "util/math.h"
#include "util/memory.h"
#include "util/platform.h"
#include "util/string.h"

#include <pebble.h>

#define SEND_DELAY_MS 10
#define SEND_DELAY_MAX_MS 1000

static const size_t APP_MSG_SIZE_INBOUND = IF_APLITE_ELSE(1024, 2044);
static const size_t APP_MSG_SIZE_OUTBOUND = IF_APLITE_ELSE(512, 1024);

typedef enum VibeType VibeType;

enum VibeType {
  VibeShort = 0,
  VibeLong = 1,
  VibeDouble = 2,
};

typedef enum LightType LightType;

enum LightType {
  LightOn = 0,
  LightAuto = 1,
  LightTrigger = 2,
};

typedef struct SegmentPacket SegmentPacket;

struct __attribute__((__packed__)) SegmentPacket {
  Packet packet;
  bool is_last;
  uint8_t buffer[];
};

typedef struct ImagePacket ImagePacket;

struct __attribute__((__packed__)) ImagePacket {
  Packet packet;
  uint32_t id;
  int16_t width;
  int16_t height;
  uint16_t pixels_length;
  uint8_t pixels[];
};

typedef struct VibePacket VibePacket;

struct __attribute__((__packed__)) VibePacket {
  Packet packet;
  VibeType type:8;
};

typedef struct LightPacket LightPacket;

struct __attribute__((__packed__)) LightPacket {
  Packet packet;
  LightType type:8;
};

static SimplyMsg *s_msg = NULL;

static bool s_has_communicated = false;

// The phone app runs a new copy of the JS every time the watch reconnects to
// it, and the old copy is gone along with every window it knew about. Set once
// a JS has said it is ready, so the next one to say so is known to be a new
// one taking over a running app.
static bool s_js_seen = false;
static bool s_js_restarted = false;

// The phone went away and has not yet sent a new JS
static bool s_phone_lost = false;

typedef struct CommandHandlerEntry CommandHandlerEntry;

struct CommandHandlerEntry {
  int16_t start_type;
  int16_t end_type;
  PacketHandler handler;
};

static void handle_packet(Simply *simply, Packet *packet);

bool simply_msg_has_communicated() {
  return s_has_communicated;
}

bool simply_msg_js_restarted() {
  return s_js_restarted;
}

static void drop_send_queue(SimplyMsg *self);

static void prv_handle_ready(SimplyMsg *self) {
  s_js_restarted = s_js_seen;
  s_js_seen = true;
  s_phone_lost = false;
  if (s_js_restarted) {
    // Its windows reuse the old ones' ids, so the windows still on screen
    // must stop answering to them
    drop_send_queue(self);
    simply_window_stack_forget(self->simply);
  }
}

static void prv_phone_lost(SimplyMsg *self) {
  s_has_communicated = false;
  s_phone_lost = true;
  // Whatever was waiting to go out was meant for the JS that just went, and
  // the next one would take a stale back press or window event as its own
  drop_send_queue(self);
  simply_splash_show_phone_lost(self->simply, false);
}

static void prv_app_connection_handler(bool connected) {
  SimplyMsg *self = s_msg;
  if (!self) { return; }
  if (!connected) {
    prv_phone_lost(self);
  } else if (s_phone_lost && simply_splash_is_covering(self->simply)) {
    simply_splash_show_phone_lost(self->simply, true);
    // The phone app may have kept the JS rather than started a new one, and
    // such a JS has no reason to say anything. Asking it to draw its page
    // again gets an answer from it; a new JS says it is ready instead.
    simply_splash_send_reveal();
  }
}

static void destroy_packet(SimplyMsg *self, SimplyPacket *packet) {
  if (!packet) {
    return;
  }
  free(packet->buffer);
  packet->buffer = NULL;
  free(packet);
}

// A message split across segments is held whole in memory before it can be
// read, so a big enough one cannot be received at all. Losing it is the only
// option left, but losing it has to be survivable: the queue is dropped so no
// half a message is ever handed on as if it were complete.
static void drop_receive_queue(SimplyMsg *self) {
  while (self->receive_queue) {
    SimplyPacket *node = (SimplyPacket*) self->receive_queue;
    list1_remove(&self->receive_queue, &node->node);
    destroy_packet(self, node);
  }
}

static void add_receive_packet(SimplyMsg *self, SegmentPacket *packet) {
  if (self->discarding) { return; }
  size_t size = packet->packet.length;
  Packet *copy = malloc(size);
  if (!copy) {
    drop_receive_queue(self);
    self->discarding = true;
    return;
  }
  memcpy(copy, packet, size);
  SimplyPacket *node = malloc0(sizeof(*node));
  if (!node) {
    free(copy);
    drop_receive_queue(self);
    self->discarding = true;
    return;
  }
  node->length = size;
  node->buffer = copy;
  list1_prepend(&self->receive_queue, &node->node);
}

static void handle_receive_queue(SimplyMsg *self, SegmentPacket *packet) {
  // The rest of a message whose start was dropped is not a message
  if (self->discarding) {
    self->discarding = false;
    drop_receive_queue(self);
    return;
  }
  size_t total_length = packet->packet.length - sizeof(SegmentPacket);
  for (List1Node *walk = self->receive_queue; walk; walk = walk->next) {
    total_length += ((SimplyPacket*) walk)->length - sizeof(SegmentPacket);
  }

  void *buffer = malloc(total_length);
  if (!buffer) {
    drop_receive_queue(self);
    return;
  }
  void *cursor = buffer + total_length;
  SegmentPacket *other = packet;
  SimplyPacket *walk = NULL;
  while (true) {
    size_t copy_size = other->packet.length - sizeof(SegmentPacket);
    cursor -= copy_size;
    memcpy(cursor, other->buffer, copy_size);

    if (walk) {
      list1_remove(&self->receive_queue, &walk->node);
      destroy_packet(self, walk);
    }

    walk = (SimplyPacket*) self->receive_queue;
    if (!walk) {
      break;
    }

    other = walk->buffer;
  }

  const Packet *joined = buffer;
  if (total_length >= sizeof(Packet) && joined->length >= sizeof(Packet) &&
      joined->length <= total_length) {
    handle_packet(self->simply, buffer);
  }

  free(buffer);
}

static void handle_segment_packet(Simply *simply, Packet *data) {
  SegmentPacket *packet = (SegmentPacket*) data;
  if (packet->is_last) {
    handle_receive_queue(simply->msg, packet);
  } else {
    add_receive_packet(simply->msg, packet);
  }
}

static void handle_image_packet(Simply *simply, Packet *data) {
  ImagePacket *packet = (ImagePacket*) data;
  simply_res_add_image(simply->res, packet->id, packet->width, packet->height, packet->pixels,
                       packet->pixels_length);
}

static void handle_vibe_packet(Simply *simply, Packet *data) {
  VibePacket *packet = (VibePacket*) data;
  switch (packet->type) {
    case VibeShort: vibes_short_pulse(); break;
    case VibeLong: vibes_long_pulse(); break;
    case VibeDouble: vibes_double_pulse(); break;
  }
}

static void handle_light_packet(Simply *simply, Packet *data) {
  LightPacket *packet = (LightPacket*) data;
  switch (packet->type) {
    case LightOn: light_enable(true); break;
    case LightAuto: light_enable(false); break;
    case LightTrigger: light_enable_interaction(); break;
  }
}

static bool simply_base_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandReady:
      prv_handle_ready(simply->msg);
      // The launch reason goes back from the wakeup handler
      return false;
    case CommandSegment:
      handle_segment_packet(simply, packet);
      return true;
    case CommandImagePacket:
      handle_image_packet(simply, packet);
      return true;
    case CommandVibe:
      handle_vibe_packet(simply, packet);
      return true;
    case CommandLight:
      handle_light_packet(simply, packet);
      return true;
  }
  return false;
}

static void handle_packet(Simply *simply, Packet *packet) {
  // Anything but a ready from a JS the watch had given up on means it was
  // still there after all, and it is still the one that knows the windows
  if (s_phone_lost && packet->type != CommandReady) {
    s_phone_lost = false;
    simply_splash_phone_back(simply);
  }
  if (simply_base_handle_packet(simply, packet)) { return; }
  if (simply_wakeup_handle_packet(simply, packet)) { return; }
  if (simply_window_stack_handle_packet(simply, packet)) { return; }
  if (simply_window_handle_packet(simply, packet)) { return; }
  if (simply_splash_handle_packet(simply, packet)) { return; }
  if (simply_number_handle_packet(simply, packet)) { return; }
  if (simply_assist_handle_packet(simply, packet)) { return; }
  if (simply_ui_handle_packet(simply, packet)) { return; }
  if (simply_accel_handle_packet(simply, packet)) { return; }
  if (simply_touch_handle_packet(simply, packet)) { return; }
  if (simply_voice_handle_packet(simply, packet)) { return; }
  if (simply_menu_handle_packet(simply, packet)) { return; }
  if (simply_stage_handle_packet(simply, packet)) { return; }
}

static void received_callback(DictionaryIterator *iter, void *context) {
  Tuple *tuple = dict_find(iter, 0);
  if (!tuple) {
    return;
  }

  s_has_communicated = true;

  size_t length = tuple->length;
  if (length == 0) {
    return;
  }

  uint8_t *buffer = tuple->value->data;
  while (true) {
    Packet *packet = (Packet*) buffer;
    // A packet that claims more than is left, or less than its own header,
    // would send the walk off the end of the message
    if (length < sizeof(Packet) || packet->length < sizeof(Packet) ||
        packet->length > length) {
      break;
    }
    handle_packet(context, packet);

    length -= packet->length;
    if (length == 0) {
      break;
    }

    buffer += packet->length;
  }
}

static void dropped_callback(AppMessageResult reason, void *context) {
}

static void sent_callback(DictionaryIterator *iter, void *context) {
}

static void failed_callback(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  Simply *simply = context;

  if (reason == APP_MSG_NOT_CONNECTED) {
    simply_msg_show_disconnected(simply->msg);
  }
}

// This used to write the message into whichever card JS had last shown and
// push it over the page. JS never heard about it, so once the phone was back
// the wearer was left on a card that belonged to no one, whose Back asked JS
// about a window it did not have. The splash stands in front of the page
// instead, takes nothing away from it, and Back on it leaves the app.
void simply_msg_show_disconnected(SimplyMsg *self) {
  prv_phone_lost(self);
}

SimplyMsg *simply_msg_create(Simply *simply) {
  if (s_msg) {
    return s_msg;
  }

  SimplyMsg *self = malloc(sizeof(*self));
  *self = (SimplyMsg) { .simply = simply, .send_delay_ms = SEND_DELAY_MS };
  s_msg = self;

  simply->msg = self;

  app_message_open(APP_MSG_SIZE_INBOUND, APP_MSG_SIZE_OUTBOUND);

  app_message_set_context(simply);

  app_message_register_inbox_received(received_callback);
  app_message_register_inbox_dropped(dropped_callback);
  app_message_register_outbox_sent(sent_callback);
  app_message_register_outbox_failed(failed_callback);

  connection_service_subscribe((ConnectionHandlers) {
    .pebble_app_connection_handler = prv_app_connection_handler,
  });

  return self;
}

void simply_msg_destroy(SimplyMsg *self) {
  if (!self) {
    return;
  }

  app_message_deregister_callbacks();
  connection_service_unsubscribe();

  self->simply->msg = NULL;

  free(self);
}

static void drop_send_queue(SimplyMsg *self) {
  if (self->send_timer) {
    app_timer_cancel(self->send_timer);
    self->send_timer = NULL;
  }
  free(self->send_buffer);
  self->send_buffer = NULL;
  self->send_length = 0;
  self->send_delay_ms = SEND_DELAY_MS;
  while (self->send_queue) {
    SimplyPacket *node = (SimplyPacket*) self->send_queue;
    list1_remove(&self->send_queue, &node->node);
    destroy_packet(self, node);
  }
}

static bool send_msg(uint8_t *buffer, size_t length) {
  DictionaryIterator *iter = NULL;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    return false;
  }
  dict_write_data(iter, 0, buffer, length);
  return (app_message_outbox_send() == APP_MSG_OK);
}

bool simply_msg_send(uint8_t *buffer, size_t length) {
  return send_msg(buffer, length);
}

static void make_multi_packet(SimplyMsg *self, SimplyPacket *packet) {
  if (!packet) {
    return;
  }
  size_t length = 0;
  SimplyPacket *last;
  for (SimplyPacket *walk = packet;;) {
    length += walk->length;
    SimplyPacket *next = (SimplyPacket*) walk->node.next;
    if (!next || length + next->length > APP_MSG_SIZE_OUTBOUND - 2 * sizeof(Tuple)) {
      last = next;
      break;
    }
    walk = next;
  }
  uint8_t *buffer = malloc(length);
  if (!buffer) {
    return;
  }
  uint8_t *cursor = buffer;
  for (SimplyPacket *walk = packet; walk && walk != last;) {
    memcpy(cursor, walk->buffer, walk->length);
    cursor += walk->length;
    SimplyPacket *next = (SimplyPacket*) walk->node.next;
    list1_remove(&self->send_queue, &walk->node);
    destroy_packet(self, walk);
    walk = next;
  }
  self->send_buffer = buffer;
  self->send_length = length;
}

static void send_msg_retry(void *data) {
  SimplyMsg *self = data;
  self->send_timer = NULL;
  if (!self->send_buffer) {
    make_multi_packet(self, (SimplyPacket*) self->send_queue);
  }
  if (!self->send_buffer) {
    return;
  }
  if (send_msg(self->send_buffer, self->send_length)) {
    free(self->send_buffer);
    self->send_buffer = NULL;
    self->send_delay_ms = SEND_DELAY_MS;
  } else if (self->send_delay_ms < SEND_DELAY_MAX_MS) {
    // Back off while the outbox is busy, but never so far that the next click
    // waits seconds behind it
    self->send_delay_ms *= 2;
    if (self->send_delay_ms > SEND_DELAY_MAX_MS) {
      self->send_delay_ms = SEND_DELAY_MAX_MS;
    }
  }
  self->send_timer = app_timer_register(self->send_delay_ms, send_msg_retry, self);
}

static SimplyPacket *add_packet(SimplyMsg *self, Packet *buffer) {
  SimplyPacket *packet = malloc(sizeof(*packet));
  if (!packet) {
    free(buffer);
    return NULL;
  }
  *packet = (SimplyPacket) {
    .length = buffer->length,
    .buffer = buffer,
  };
  list1_append(&self->send_queue, &packet->node);
  if (self->send_delay_ms <= SEND_DELAY_MS) {
    if (self->send_timer) {
      app_timer_cancel(self->send_timer);
    }
    self->send_timer = app_timer_register(SEND_DELAY_MS, send_msg_retry, self);
  }
  return packet;
}

bool simply_msg_send_packet(Packet *packet) {
  Packet *copy = malloc(packet->length);
  if (!copy) {
    return false;
  }
  memcpy(copy, packet, packet->length);
  return add_packet(s_msg, copy);
}
