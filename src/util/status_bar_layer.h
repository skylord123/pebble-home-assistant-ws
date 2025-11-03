#pragma once

#include <pebble.h>

#include "simply/simply.h"

// Skip SDK 2 compatibility layer for flint which has a newer SDK
#if defined(PBL_SDK_2) && !defined(PBL_PLATFORM_FLINT)

typedef struct StatusBarLayer StatusBarLayer;
struct StatusBarLayer;

//! Values that are used to indicate the different status bar separator modes.
typedef enum {
  //! The default mode. No separator will be shown.
  StatusBarLayerSeparatorModeNone = 0,
  //! A dotted separator at the bottom of the status bar.
  StatusBarLayerSeparatorModeDotted = 1,
} StatusBarLayerSeparatorMode;

static inline StatusBarLayer *status_bar_layer_create(void) {
  return NULL;
}

static inline void status_bar_layer_destroy(StatusBarLayer *status_bar_layer) {
}

static inline Layer *status_bar_layer_get_layer(StatusBarLayer *status_bar_layer) {
  return (Layer *)status_bar_layer;
}

static inline void status_bar_layer_set_colors(StatusBarLayer *status_bar_layer, GColor8 background,
                                               GColor8 foreground) {
}

static inline void status_bar_layer_set_separator_mode(StatusBarLayer *status_bar_layer,
                                                       StatusBarLayerSeparatorMode mode) {
}

static inline void status_bar_layer_add_to_window(Window *window, StatusBarLayer *status_bar_layer) {
  window_set_fullscreen(window, false);
}

static inline void status_bar_layer_remove_from_window(Window *window, StatusBarLayer *status_bar_layer) {
  window_set_fullscreen(window, true);
}

#else

static inline void status_bar_layer_add_to_window(Window *window,
                                                  StatusBarLayer *status_bar_layer) {
  if (status_bar_layer) {
    Layer *window_layer = window_get_root_layer(window);
    layer_add_child(window_layer, status_bar_layer_get_layer(status_bar_layer));
  }
}

static inline void status_bar_layer_remove_from_window(Window *window,
                                                       StatusBarLayer *status_bar_layer) {
  if (status_bar_layer) {
    layer_remove_from_parent(status_bar_layer_get_layer(status_bar_layer));
  }
}

#endif
