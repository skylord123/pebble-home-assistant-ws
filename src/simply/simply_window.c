#include "simply_window.h"

#include "simply_msg.h"
#include "simply_res.h"
#include "simply_menu.h"
#include "simply_window_stack.h"
#include "simply_voice.h"

#include "simply.h"

#include "util/graphics.h"
#include "util/scroll_layer.h"
#include "util/status_bar_layer.h"
#include "util/string.h"

#include <pebble.h>

typedef struct WindowPropsPacket WindowPropsPacket;

struct __attribute__((__packed__)) WindowPropsPacket {
  Packet packet;
  uint32_t id;
  GColor8 background_color;
  bool scrollable;
  bool paging;
};

typedef struct WindowButtonConfigPacket WindowButtonConfigPacket;

struct __attribute__((__packed__)) WindowButtonConfigPacket {
  Packet packet;
  uint8_t button_mask;
};

typedef struct WindowStatusBarPacket WindowStatusBarPacket;

struct __attribute__((__packed__)) WindowStatusBarPacket {
  Packet packet;
  GColor8 background_color;
  GColor8 color;
  StatusBarLayerSeparatorMode separator:8;
  bool status;
};

typedef struct WindowActionBarPacket WindowActionBarPacket;

struct __attribute__((__packed__)) WindowActionBarPacket {
  Packet packet;
  uint32_t image[3];
  GColor8 background_color;
  bool action;
  //! When set on a scrollable window, the up/down action bar icons are
  //! managed natively: arrows appear only in the directions the content can
  //! still scroll, updating as the scroll offset changes
  bool scroll_arrows;
};

typedef struct ClickPacket ClickPacket;

struct __attribute__((__packed__)) ClickPacket {
  Packet packet;
  ButtonId button:8;
};

typedef ClickPacket LongClickPacket;


static GColor8 s_button_palette[] = { { GColorWhiteARGB8 }, { GColorClearARGB8 } };


static void prv_update_layer_placement(SimplyWindow *self, GRect *frame_out);
static void click_config_provider(void *data);

static bool prv_send_click(SimplyMsg *self, Command type, ButtonId button) {
  ClickPacket packet = {
    .packet.type = type,
    .packet.length = sizeof(packet),
    .button = button,
  };
  return simply_msg_send_packet(&packet.packet);
}

static bool prv_send_single_click(SimplyMsg *self, ButtonId button) {
  return prv_send_click(self, CommandClick, button);
}

static bool prv_send_long_click(SimplyMsg *self, ButtonId button) {
  return prv_send_click(self, CommandLongClick, button);
}

static void prv_set_scroll_layer_click_config(SimplyWindow *self) {
  if (self->scroll_layer) {
    scroll_layer_set_click_config_provider_onto_window(
        self->scroll_layer, click_config_provider, self->window, self);
  }
}

// Native scroll arrows: when a scrollable window opts in, the up/down action
// bar icons show only the directions the content can still scroll, updated
// on the watch as the scroll offset changes
static GBitmap *s_scroll_arrow_up_bitmap;
static GBitmap *s_scroll_arrow_down_bitmap;

void simply_window_update_scroll_arrows(SimplyWindow *self) {
  if (!self || !self->action_bar_layer || !self->use_scroll_arrows ||
      !self->is_scrollable || !self->scroll_layer) {
    return;
  }

  if (!s_scroll_arrow_up_bitmap) {
    s_scroll_arrow_up_bitmap = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_ACTION_UP);
  }
  if (!s_scroll_arrow_down_bitmap) {
    s_scroll_arrow_down_bitmap = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_ACTION_DOWN);
  }

  const GPoint offset = scroll_layer_get_content_offset(self->scroll_layer);
  const GSize content_size = scroll_layer_get_content_size(self->scroll_layer);
  const int16_t frame_height =
      layer_get_frame(scroll_layer_get_layer(self->scroll_layer)).size.h;
  const bool can_scroll_up = (offset.y < 0);
  const bool can_scroll_down = (content_size.h + offset.y > frame_height);

  if (can_scroll_up && s_scroll_arrow_up_bitmap) {
    action_bar_layer_set_icon(self->action_bar_layer, BUTTON_ID_UP, s_scroll_arrow_up_bitmap);
  } else {
    action_bar_layer_clear_icon(self->action_bar_layer, BUTTON_ID_UP);
  }
  if (can_scroll_down && s_scroll_arrow_down_bitmap) {
    action_bar_layer_set_icon(self->action_bar_layer, BUTTON_ID_DOWN, s_scroll_arrow_down_bitmap);
  } else {
    action_bar_layer_clear_icon(self->action_bar_layer, BUTTON_ID_DOWN);
  }
}

static void prv_scroll_offset_changed(ScrollLayer *scroll_layer, void *context) {
  simply_window_update_scroll_arrows((SimplyWindow *)context);
}

void simply_window_set_scrollable(SimplyWindow *self, bool is_scrollable, bool is_paging,
                                  bool animated, bool reset) {
  const bool is_state_same = (self->is_scrollable == is_scrollable &&
                              self->is_paging == is_paging);
  if (!self->use_scroll_layer || (is_state_same && !reset)) { return; }

  self->is_scrollable = is_scrollable;
  self->is_paging = is_paging;
  scroll_layer_set_paging(self->scroll_layer, is_paging);

  prv_set_scroll_layer_click_config(self);

  if (!is_scrollable || reset) {
    GRect frame = GRectZero;
    prv_update_layer_placement(self, &frame);
    const bool animated = false;
    scroll_layer_set_content_offset(self->scroll_layer, GPointZero, animated);
    scroll_layer_set_content_size(self->scroll_layer, frame.size);
    simply_window_update_scroll_arrows(self);
  }

  if (self->layer) {
    layer_mark_dirty(self->layer);
  }
}

static void prv_update_layer_placement(SimplyWindow *self, GRect *frame_out) {
  Layer * const main_layer = self->layer ?: scroll_layer_get_layer(self->scroll_layer);
  if (!main_layer) { return; }

  GRect frame = { .size = layer_get_frame(window_get_root_layer(self->window)).size };

  if (self->status_bar_layer) {
    Layer * const status_bar_base_layer = status_bar_layer_get_layer(self->status_bar_layer);
    const bool has_status_bar = (layer_get_window(status_bar_base_layer) != NULL);
    const bool has_action_bar =
        (layer_get_window(action_bar_layer_get_layer(self->action_bar_layer)) != NULL);
    if (has_status_bar) {
      GRect status_frame = { .size = { frame.size.w, STATUS_BAR_LAYER_HEIGHT } };
      frame.origin.y = STATUS_BAR_LAYER_HEIGHT;
      frame.size.h -=
          PBL_IF_ROUND_ELSE(self->status_bar_insets_bottom, false) ? STATUS_BAR_LAYER_HEIGHT * 2 :
                                                                     STATUS_BAR_LAYER_HEIGHT;
      if (PBL_IF_RECT_ELSE(has_action_bar, false)) {
        status_frame.size.w -= ACTION_BAR_WIDTH;
      }
      layer_set_frame(status_bar_base_layer, status_frame);
    }
  }

  layer_set_frame(main_layer, frame);
  if (frame_out) {
    *frame_out = frame;
  }
}


void simply_window_set_status_bar(SimplyWindow *self, bool use_status_bar) {
  self->use_status_bar = use_status_bar;

  status_bar_layer_remove_from_window(self->window, self->status_bar_layer);

  if (use_status_bar) {
    status_bar_layer_add_to_window(self->window, self->status_bar_layer);
  }

  prv_update_layer_placement(self, NULL);

#ifdef PBL_SDK_2
  if (!window_stack_contains_window(self->window)) { return; }

  // HACK: Refresh app chrome state
  uint32_t id = self->id;
  self->id = 0;
  Window *window = window_create();
  window_stack_push(window, false);
  window_stack_remove(window, false);
  window_destroy(window);
  self->id = id;
#endif
}

void simply_window_set_background_color(SimplyWindow *self, GColor8 background_color) {
  self->background_color = background_color;
  window_set_background_color(self->window, gcolor8_get_or(background_color, GColorBlack));
}

void simply_window_set_status_bar_colors(SimplyWindow *self, GColor8 background_color,
                                         GColor8 foreground_color) {
  if (self->status_bar_layer) {
    status_bar_layer_set_colors(self->status_bar_layer, background_color, foreground_color);
  }
}

void simply_window_set_status_bar_separator_mode(SimplyWindow *self,
                                                 StatusBarLayerSeparatorMode separator) {
  if (self->status_bar_layer) {
    status_bar_layer_set_separator_mode(self->status_bar_layer, separator);
  }
}

void simply_window_set_action_bar(SimplyWindow *self, bool use_action_bar) {
  self->use_action_bar = use_action_bar;

  if (!self->action_bar_layer) { return; }

  action_bar_layer_remove_from_window(self->action_bar_layer);
  prv_set_scroll_layer_click_config(self);

  if (use_action_bar) {
    action_bar_layer_set_context(self->action_bar_layer, self);
    action_bar_layer_set_click_config_provider(self->action_bar_layer, click_config_provider);
    action_bar_layer_add_to_window(self->action_bar_layer, self->window);
  }

  prv_update_layer_placement(self, NULL);
}

void simply_window_set_action_bar_icon(SimplyWindow *self, ButtonId button, uint32_t id) {
  if (!self->action_bar_layer) { return; }

  SimplyImage *icon = simply_res_auto_image(self->simply->res, id, true);

  if (!icon) {
    action_bar_layer_clear_icon(self->action_bar_layer, button);
    return;
  }

  if (icon->is_palette_black_and_white) {
    gbitmap_set_palette(icon->bitmap, s_button_palette, false);
  }

  action_bar_layer_set_icon(self->action_bar_layer, button, icon->bitmap);
  simply_window_set_action_bar(self, true);
}

void simply_window_set_action_bar_background_color(SimplyWindow *self, GColor8 background_color) {
  if (!self->action_bar_layer) { return; }

  s_button_palette[0] = gcolor8_equal(background_color, GColor8White) ? GColor8Black : GColor8White;

  action_bar_layer_set_background_color(self->action_bar_layer, gcolor8_get(background_color));
  simply_window_set_action_bar(self, true);
}

void simply_window_action_bar_clear(SimplyWindow *self) {
  if (!self->action_bar_layer) { return; }

  simply_window_set_action_bar(self, false);

  for (ButtonId button = BUTTON_ID_UP; button <= BUTTON_ID_DOWN; ++button) {
    action_bar_layer_clear_icon(self->action_bar_layer, button);
  }
}

void simply_window_set_button(SimplyWindow *self, ButtonId button, bool enable) {
  if (enable) {
    self->button_mask |= 1 << button;
  } else {
    self->button_mask &= ~(1 << button);
  }
}

void simply_window_single_click_handler(ClickRecognizerRef recognizer, void *context) {
  SimplyWindow *self = context;
  ButtonId button = click_recognizer_get_button_id(recognizer);
  bool is_enabled = (self->button_mask & (1 << button));
  if (button == BUTTON_ID_BACK) {
    if (!simply_msg_has_communicated()) {
      bool animated = true;
      window_stack_pop(animated);
    } else if (!is_enabled) {
      simply_window_stack_back(self->simply->window_stack, self);
    }
  }
  if (is_enabled) {
    prv_send_single_click(self->simply->msg, button);
  }
}

static void long_click_handler(ClickRecognizerRef recognizer, void *context) {
  SimplyWindow *self = context;
  ButtonId button = click_recognizer_get_button_id(recognizer);
  bool is_enabled = (self->button_mask & (1 << button));
  if (is_enabled) {
    prv_send_long_click(self->simply->msg, button);
  }
}

static void click_config_provider(void *context) {
  SimplyWindow *self = context;
  for (int i = 0; i < NUM_BUTTONS; ++i) {
    if (!self->is_scrollable || (i != BUTTON_ID_UP && i != BUTTON_ID_DOWN)) {
      window_set_click_context(i, context);
      window_single_click_subscribe(i, simply_window_single_click_handler);
      window_long_click_subscribe(i, 500, (ClickHandler) long_click_handler, NULL);
    }
  }
  if (self->is_scrollable) {
    scroll_layer_click_config(self->scroll_layer);
  }
}

void simply_window_preload(SimplyWindow *self) {
  if (self->window) { return; }

  Window *window = self->window = window_create();
  window_set_background_color(window, GColorClear);
  window_set_user_data(window, self);
  if (self->window_handlers) {
    window_set_window_handlers(window, *self->window_handlers);
  }
}

void simply_window_load(SimplyWindow *self) {
  Window *window = self->window;

  Layer *window_layer = window_get_root_layer(window);
  GRect frame = layer_get_frame(window_layer);
  frame.origin = GPointZero;

  self->scroll_layer = scroll_layer_create(frame);
  Layer *scroll_base_layer = scroll_layer_get_layer(self->scroll_layer);
  layer_add_child(window_layer, scroll_base_layer);

  scroll_layer_set_context(self->scroll_layer, self);
  scroll_layer_set_shadow_hidden(self->scroll_layer, true);
  scroll_layer_set_callbacks(self->scroll_layer, (ScrollLayerCallbacks) {
    .content_offset_changed_handler = prv_scroll_offset_changed,
  });

  self->status_bar_layer = status_bar_layer_create();
  status_bar_layer_set_separator_mode(self->status_bar_layer, StatusBarLayerSeparatorModeDotted);
  simply_window_set_status_bar(self, self->use_status_bar);

  self->action_bar_layer = action_bar_layer_create();
  action_bar_layer_set_context(self->action_bar_layer, self);

  window_set_click_config_provider_with_context(window, click_config_provider, self);
  simply_window_set_action_bar(self, self->use_action_bar);
}

bool simply_window_appear(SimplyWindow *self) {
  if (!self->id) {
    return false;
  }
  if (simply_msg_has_communicated()) {
    simply_window_stack_send_show(self->simply->window_stack, self);
  }
  return true;
}

bool simply_window_disappear(SimplyWindow *self) {
  if (!self->id) {
    return false;
  }
  // If the window is disappearing because of the dictation API
  if (simply_voice_dictation_in_progress()) {
    return false;
  }
  if (simply_msg_has_communicated()) {
    simply_window_stack_send_hide(self->simply->window_stack, self);
  }

#ifdef PBL_PLATFORM_BASALT
  simply_window_set_status_bar(self, false);
#endif

  return true;
}

void simply_window_unload(SimplyWindow *self) {
  // Unregister the click config provider
  window_set_click_config_provider_with_context(self->window, NULL, NULL);

  scroll_layer_destroy(self->scroll_layer);
  self->scroll_layer = NULL;

  action_bar_layer_destroy(self->action_bar_layer);
  self->action_bar_layer = NULL;

  status_bar_layer_destroy(self->status_bar_layer);
  self->status_bar_layer = NULL;

  window_destroy(self->window);
  self->window = NULL;
}

static void prv_handle_window_props_packet(Simply *simply, Packet *data) {
  SimplyWindow *window = simply_window_stack_get_top_window(simply);
  if (!window) { return; }

  WindowPropsPacket *packet = (WindowPropsPacket *)data;
  simply_window_set_background_color(window, packet->background_color);
  const bool is_same_window = (window->id == packet->id);
  simply_window_set_scrollable(window, packet->scrollable, packet->paging, is_same_window,
                               !is_same_window);
  window->id = packet->id;
}

static void prv_handle_window_button_config_packet(Simply *simply, Packet *data) {
  WindowButtonConfigPacket *packet = (WindowButtonConfigPacket*) data;
  SimplyWindow *window = simply_window_stack_get_top_window(simply);
  if (window) {
    window->button_mask = packet->button_mask;
  }
}

static void prv_handle_window_status_bar_packet(Simply *simply, Packet *data) {
  SimplyWindow *window = simply_window_stack_get_top_window(simply);
  if (!window) { return; }

  WindowStatusBarPacket *packet = (WindowStatusBarPacket *)data;
  simply_window_set_status_bar_colors(window, packet->background_color, packet->color);
  simply_window_set_status_bar_separator_mode(window, packet->separator);
  simply_window_set_status_bar(window, packet->status);
}

static void prv_handle_window_action_bar_packet(Simply *simply, Packet *data) {
  SimplyWindow *window = simply_window_stack_get_top_window(simply);
  if (!window) { return; }

  WindowActionBarPacket *packet = (WindowActionBarPacket *)data;
  window->use_scroll_arrows = packet->scroll_arrows;
  simply_window_set_action_bar_background_color(window, packet->background_color);
  for (unsigned int i = 0; i < ARRAY_LENGTH(packet->image); ++i) {
    simply_window_set_action_bar_icon(window, i + 1, packet->image[i]);
  }
  simply_window_set_action_bar(window, packet->action);
  simply_window_update_scroll_arrows(window);
}

bool simply_window_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandWindowProps:
      prv_handle_window_props_packet(simply, packet);
      return true;
    case CommandWindowButtonConfig:
      prv_handle_window_button_config_packet(simply, packet);
      return true;
    case CommandWindowStatusBar:
      prv_handle_window_status_bar_packet(simply, packet);
      return true;
    case CommandWindowActionBar:
      prv_handle_window_action_bar_packet(simply, packet);
      return true;
  }
  return false;
}

SimplyWindow *simply_window_init(SimplyWindow *self, Simply *simply) {
  self->simply = simply;
  self->use_status_bar = false;

  for (int i = 0; i < NUM_BUTTONS; ++i) {
    if (i != BUTTON_ID_BACK) {
      self->button_mask |= 1 << i;
    }
  }

  simply_window_preload(self);

  return self;
}

void simply_window_deinit(SimplyWindow *self) {
  if (self) {
    window_destroy(self->window);
    self->window = NULL;
  }
}
