#pragma once

#include "simply_msg.h"
#include "simply.h"

#include <pebble.h>

// Limits
#define NATIVE_MAX_WINDOWS 8
#define NATIVE_MAX_MENU_SECTIONS 4
#define NATIVE_MAX_MENU_ITEMS 52
#define NATIVE_TITLE_LEN 48
#define NATIVE_SUBTITLE_LEN 64

// --- Menu item ---
typedef struct NativeMenuItem NativeMenuItem;

struct NativeMenuItem {
  uint16_t section;
  uint16_t index;
  uint32_t icon;
  char title[NATIVE_TITLE_LEN];
  char subtitle[NATIVE_SUBTITLE_LEN];
};

// --- Menu section ---
typedef struct NativeMenuSection NativeMenuSection;

struct NativeMenuSection {
  char title[NATIVE_TITLE_LEN];
  uint16_t num_items;
};

// --- A native screen (menu window) ---
typedef struct NativeScreen NativeScreen;

struct NativeScreen {
  Window *window;
  MenuLayer *menu_layer;
  StatusBarLayer *status_bar;

  NativeMenuSection sections[NATIVE_MAX_MENU_SECTIONS];
  uint16_t num_sections;

  NativeMenuItem items[NATIVE_MAX_MENU_ITEMS];
  uint16_t num_items;

  uint8_t screen_id;   // JS-assigned ID for event routing
  bool ready;          // All items received, menu populated

  // Scrolling state
#if !defined(PBL_PLATFORM_APLITE)
  AppTimer *scroll_timer;
  MenuIndex scroll_index;
  int16_t scroll_offset;
  int16_t max_scroll_offset;
  bool scrolling_active;
#endif
};

// --- Toast overlay ---
typedef struct NativeToast NativeToast;

struct NativeToast {
  Window *window;
  TextLayer *text_layer;
  AppTimer *dismiss_timer;
  bool active;
};

// --- The native bridge ---
typedef struct SimplyNative SimplyNative;

struct SimplyNative {
  Simply *simply;
  NativeScreen *stack[NATIVE_MAX_WINDOWS];
  uint8_t stack_count;
  NativeToast toast;
};

SimplyNative *simply_native_create(Simply *simply);
void simply_native_destroy(SimplyNative *self);

bool simply_native_handle_packet(Simply *simply, Packet *packet);
