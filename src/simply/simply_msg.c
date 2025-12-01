#include "simply_msg.h"

#include "simply_accel.h"
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

static const size_t APP_MSG_SIZE_INBOUND = IF_APLITE_ELSE(1024, 2044);
static const size_t APP_MSG_SIZE_OUTBOUND = 1024;

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

// Pending scroll state for retry when system dialogs are on top
typedef struct PendingScroll PendingScroll;

struct PendingScroll {
  Simply *simply;
  int scroll_y;
  bool animated;
  AppTimer *timer;
  int retry_count;
};

static PendingScroll s_pending_scroll = { NULL, 0, false, NULL, 0 };

#define SCROLL_RETRY_DELAY_MS 100
#define SCROLL_MAX_RETRIES 50  // 5 seconds max wait

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

static void destroy_packet(SimplyMsg *self, SimplyPacket *packet) {
  if (!packet) {
    return;
  }
  free(packet->buffer);
  packet->buffer = NULL;
  free(packet);
}

static void add_receive_packet(SimplyMsg *self, SegmentPacket *packet) {
  size_t size = packet->packet.length;
  Packet *copy = malloc(size);
  memcpy(copy, packet, size);
  SimplyPacket *node = malloc0(sizeof(*node));
  node->length = size;
  node->buffer = copy;
  list1_prepend(&self->receive_queue, &node->node);
}

static void handle_receive_queue(SimplyMsg *self, SegmentPacket *packet) {
  size_t total_length = packet->packet.length - sizeof(SegmentPacket);
  for (List1Node *walk = self->receive_queue; walk; walk = walk->next) {
    total_length += ((SimplyPacket*) walk)->length - sizeof(SegmentPacket);
  }

  void *buffer = malloc(total_length);
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

  handle_packet(self->simply, buffer);

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

// Forward declaration for retry timer callback
static void scroll_retry_timer_callback(void *data);

// Helper function to execute the scroll if possible
static bool try_execute_scroll(Simply *simply, int scroll_y, bool animated) {
  // Get the top window using the helper function
  SimplyWindow *simply_window = simply_window_stack_get_top_window(simply);
  if (!simply_window) {
    // Window not available (system dialog on top)
    return false;
  }

  // Check if the window has a scroll layer
  if (!simply_window->scroll_layer) {
    return true;  // No scroll layer, nothing to do, don't retry
  }

  // Check if the window is still valid
  if (!simply_window->window) {
    return true;  // Window invalid, don't retry
  }

  // Get the scroll layer from the SimplyWindow
  ScrollLayer *scroll_layer = simply_window->scroll_layer;

  // Extra safety check
  if (!scroll_layer) {
    return true;  // No scroll layer, don't retry
  }

  // Set the content offset
  if (scroll_layer && simply_window->is_scrollable) {
    scroll_layer_set_content_offset(scroll_layer, GPoint(0, scroll_y), animated);
  }

  return true;  // Success
}

// Timer callback to retry scroll when system dialog closes
static void scroll_retry_timer_callback(void *data) {
  s_pending_scroll.timer = NULL;

  if (!s_pending_scroll.simply) {
    return;
  }

  if (try_execute_scroll(s_pending_scroll.simply, s_pending_scroll.scroll_y, s_pending_scroll.animated)) {
    // Success - clear pending scroll
    s_pending_scroll.simply = NULL;
    s_pending_scroll.retry_count = 0;
  } else {
    // Still blocked, retry if we haven't exceeded max retries
    s_pending_scroll.retry_count++;
    if (s_pending_scroll.retry_count < SCROLL_MAX_RETRIES) {
      s_pending_scroll.timer = app_timer_register(SCROLL_RETRY_DELAY_MS, scroll_retry_timer_callback, NULL);
    } else {
      // Give up after max retries
      s_pending_scroll.simply = NULL;
      s_pending_scroll.retry_count = 0;
    }
  }
}

static void handle_scroll_message(Simply *simply, DictionaryIterator *iter) {
  Tuple *scroll_y_tuple = dict_find(iter, MESSAGE_KEY_SCROLL_Y);
  Tuple *animated_tuple = dict_find(iter, MESSAGE_KEY_ANIMATED);

  if (!scroll_y_tuple) {
    return;
  }

  int scroll_y = scroll_y_tuple->value->int32;
  bool animated = animated_tuple && animated_tuple->value->int32;

  // Cancel any pending scroll timer
  if (s_pending_scroll.timer) {
    app_timer_cancel(s_pending_scroll.timer);
    s_pending_scroll.timer = NULL;
  }

  // Try to execute the scroll immediately
  if (try_execute_scroll(simply, scroll_y, animated)) {
    // Success - clear any pending state
    s_pending_scroll.simply = NULL;
    s_pending_scroll.retry_count = 0;
  } else {
    // Window not available (system dialog on top), schedule retry
    s_pending_scroll.simply = simply;
    s_pending_scroll.scroll_y = scroll_y;
    s_pending_scroll.animated = animated;
    s_pending_scroll.retry_count = 0;
    s_pending_scroll.timer = app_timer_register(SCROLL_RETRY_DELAY_MS, scroll_retry_timer_callback, NULL);
  }
}

static void handle_packet(Simply *simply, Packet *packet) {
  if (simply_base_handle_packet(simply, packet)) { return; }
  if (simply_wakeup_handle_packet(simply, packet)) { return; }
  if (simply_window_stack_handle_packet(simply, packet)) { return; }
  if (simply_window_handle_packet(simply, packet)) { return; }
  if (simply_ui_handle_packet(simply, packet)) { return; }
  if (simply_accel_handle_packet(simply, packet)) { return; }
  if (simply_voice_handle_packet(simply, packet)) { return; }
  if (simply_menu_handle_packet(simply, packet)) { return; }
  if (simply_stage_handle_packet(simply, packet)) { return; }
}

static void received_callback(DictionaryIterator *iter, void *context) {
  // Check if this is a scroll message
  Tuple *scroll_y_tuple = dict_find(iter, MESSAGE_KEY_SCROLL_Y);
  if (scroll_y_tuple) {
    Simply *simply = context;
    handle_scroll_message(simply, iter);
    return;
  }

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
    handle_packet(context, packet);

    if (packet->length == 0) {
      break;
    }

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
    s_has_communicated = false;

    simply_msg_show_disconnected(simply->msg);
  }
}

void simply_msg_show_disconnected(SimplyMsg *self) {
  Simply *simply = self->simply;
  SimplyUi *ui = simply->ui;

  simply_ui_clear(ui, ~0);
  simply_ui_set_text(ui, UiSubtitle, "Disconnected");
  simply_ui_set_text(ui, UiBody, "Run the Pebble Phone App");

  if (window_stack_get_top_window() != ui->window.window) {
    bool was_broadcast = simply_window_stack_set_broadcast(false);
    simply_window_stack_show(simply->window_stack, &ui->window, true);
    simply_window_stack_set_broadcast(was_broadcast);
  }
}

SimplyMsg *simply_msg_create(Simply *simply) {
  if (s_msg) {
    return s_msg;
  }

  SimplyMsg *self = malloc(sizeof(*self));
  *self = (SimplyMsg) { .simply = simply };
  s_msg = self;

  simply->msg = self;

  app_message_open(APP_MSG_SIZE_INBOUND, APP_MSG_SIZE_OUTBOUND);

  app_message_set_context(simply);

  app_message_register_inbox_received(received_callback);
  app_message_register_inbox_dropped(dropped_callback);
  app_message_register_outbox_sent(sent_callback);
  app_message_register_outbox_failed(failed_callback);

  return self;
}

void simply_msg_destroy(SimplyMsg *self) {
  if (!self) {
    return;
  }

  app_message_deregister_callbacks();

  self->simply->msg = NULL;

  free(self);
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
  } else {
    self->send_delay_ms *= 2;
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
