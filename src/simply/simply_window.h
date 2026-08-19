#pragma once

#include "simply_msg.h"

#include "simply.h"

#include "util/color.h"
#include "util/sdk.h"
#include "util/status_bar_layer.h"

#include <pebble.h>

typedef struct SimplyWindow SimplyWindow;

struct SimplyWindow {
  Simply *simply;
  Window *window;
  StatusBarLayer *status_bar_layer;
  ScrollLayer *scroll_layer;
  Layer *layer;
  ActionBarLayer *action_bar_layer;
  const WindowHandlers *window_handlers;
  uint32_t id;
  ButtonId button_mask:4;
  GColor8 background_color;
  bool is_scrollable:1;
  bool use_scroll_arrows:1;
  AppTimer *scroll_arrows_timer;
  bool is_paging:1;
  bool use_scroll_layer:1;
  bool use_status_bar:1;
  bool use_action_bar:1;
#if defined(PBL_ROUND)
  bool status_bar_insets_bottom:1;
#endif
};

SimplyWindow *simply_window_init(SimplyWindow *self, Simply *simply);
void simply_window_deinit(SimplyWindow *self);
void simply_window_show(SimplyWindow *self);
void simply_window_hide(SimplyWindow *self);

void simply_window_preload(SimplyWindow *self);
void simply_window_load(SimplyWindow *self);
void simply_window_unload(SimplyWindow *self);
bool simply_window_appear(SimplyWindow *self);
bool simply_window_disappear(SimplyWindow *self);

void simply_window_single_click_handler(ClickRecognizerRef recognizer, void *context);

void simply_window_set_scrollable(SimplyWindow *self, bool is_scrollable, bool is_paging,
                                  bool animated, bool reset);
void simply_window_set_status_bar(SimplyWindow *self, bool use_status_bar);
void simply_window_set_background_color(SimplyWindow *self, GColor8 background_color);

void simply_window_set_button(SimplyWindow *self, ButtonId button, bool enable);

void simply_window_set_action_bar(SimplyWindow *self, bool is_action_bar);
//! Refresh the native up/down scroll arrows on the action bar to match the
//! current scroll position. Must not be called from inside a layer render
//! pass; use the scheduled variant from drawing code.
void simply_window_update_scroll_arrows(SimplyWindow *self);
//! Deferred variant of simply_window_update_scroll_arrows that runs on the
//! next event loop iteration, safe to call while layers are being rendered
//! (e.g. from the stage draw callback when the content size changes).
void simply_window_schedule_scroll_arrows_update(SimplyWindow *self);
void simply_window_set_action_bar_icon(SimplyWindow *self, ButtonId button, uint32_t id);
void simply_window_set_action_bar_background_color(SimplyWindow *self, GColor8 background_color);
void simply_window_action_bar_clear(SimplyWindow *self);

bool simply_window_handle_packet(Simply *simply, Packet *packet);
