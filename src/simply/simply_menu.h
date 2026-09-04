#pragma once

#include "simply_window.h"

// For SIMPLY_HAS_TOUCH, which decides whether the touch entry points below
// exist at all
#include "simply_touch.h"

#include "simply_msg.h"

#include "simply.h"

#include "util/list1.h"

#include <pebble.h>

//! Default cell height in pixels
#define MENU_CELL_BASIC_CELL_HEIGHT ((const int16_t) 44)

typedef enum SimplyMenuType SimplyMenuType;

enum SimplyMenuType {
  SimplyMenuTypeNone = 0,
  SimplyMenuTypeSection,
  SimplyMenuTypeItem,
};

typedef struct SimplyMenuLayer SimplyMenuLayer;

struct SimplyMenuLayer {
  MenuLayer *menu_layer;
  List1Node *sections;
  List1Node *items;
  uint16_t num_sections;
  //! Row count and header presence per section, surviving cache eviction so
  //! reloads never clamp the selection or compute offsets from placeholder
  //! counts when a menu has more sections than the cache holds
  uint16_t *row_counts;
  uint16_t row_counts_len;
  bool scroll_wrap;
  GColor8 normal_foreground;
  GColor8 normal_background;
  GColor8 highlight_foreground;
  GColor8 highlight_background;
};

typedef struct SimplyMenu SimplyMenu;

struct SimplyMenu {
  SimplyWindow window;
  SimplyMenuLayer menu_layer;
  AppTimer *spinner_timer;
  AppTimer *reload_timer;  // Timer for debounced reloads
#if !defined(PBL_PLATFORM_APLITE)
  AppTimer *scroll_timer;
  MenuIndex scroll_index;
#ifdef SIMPLY_HAS_TOUCH
  //! Whether scroll_index was put there by a finger rather than by the
  //! selection. A drag leaves a row sitting in the middle of the screen
  //! without selecting it, and that row is the one worth marqueeing, so it
  //! holds the marquee until the selection moves again.
  bool scroll_index_pinned;
#endif
  int16_t scroll_offset;
  int16_t max_scroll_offset;
  bool scrolling_active;
  bool needs_scrolling;
  // Idle timeout tracking
  time_t last_input_time;
  bool scroll_idle;
#if defined(PBL_ROUND)
  // For round displays: independent scrolling for title and subtitle
  int16_t title_scroll_offset;
  int16_t title_max_scroll_offset;
  bool title_needs_scroll;
  bool title_scrolling_active;
  int16_t subtitle_scroll_offset;
  int16_t subtitle_max_scroll_offset;
  bool subtitle_needs_scroll;
  bool subtitle_scrolling_active;
  // Cached font heights to avoid expensive measurements every frame
  int16_t title_height;
  int16_t subtitle_height;
#endif
#endif
};

typedef struct SimplyMenuCommon SimplyMenuCommon;

struct SimplyMenuCommon {
  List1Node node;
  uint16_t section;
  char *title;
};

typedef struct SimplyMenuCommonMember SimplyMenuCommonMember;

struct SimplyMenuCommonMember {
  union {
    SimplyMenuCommon common;
    SimplyMenuCommon;
  };
};

typedef struct SimplyMenuSection SimplyMenuSection;

struct SimplyMenuSection {
  SimplyMenuCommonMember;
  uint16_t num_items;
  GColor8 title_foreground;
  GColor8 title_background;
};

typedef struct SimplyMenuItem SimplyMenuItem;

struct SimplyMenuItem {
  SimplyMenuCommonMember;
  char *subtitle;
  uint32_t icon;
  uint16_t item;
};

SimplyMenu *simply_menu_create(Simply *simply);
void simply_menu_destroy(SimplyMenu *self);

//! Select and activate whatever row is under a screen point.
//!
//! Menus are drawn entirely in C by a MenuLayer, so the JS side cannot
//! hit-test them the way it can hit-test the elements of a stage window. That
//! is why tapping a menu row has to be resolved here.
//! @return true if a row was hit and activated.
bool simply_menu_handle_tap(SimplyMenu *self, int16_t x, int16_t y);

//! Long-press equivalent: selects the row under the point and fires the same
//! event holding the select button does.
bool simply_menu_handle_long_press(SimplyMenu *self, int16_t x, int16_t y);

//! Touch counts as user input for the menu's idle tracking (marquee scroll,
//! inactivity timeout).
void simply_menu_touch_note_input(SimplyMenu *self);

#ifdef SIMPLY_HAS_TOUCH

//! The scroll offsets a finger may drag this menu between. Returns false when
//! the menu has no opinion and the ordinary content bounds apply, which is
//! every rectangular platform.
bool simply_menu_scroll_limits(SimplyMenu *self, int *min_y, int *max_y);

//! Marquee whichever row the middle of the screen ends up over once a drag has
//! come to rest at `scroll_offset_y`, so a long title can still be read without
//! the row having to be selected first. On the watches with no digitizer the
//! marquee simply follows the selection, since nothing else can move the list.
void simply_menu_marquee_at(SimplyMenu *self, int scroll_offset_y);

#endif


bool simply_menu_handle_packet(Simply *simply, Packet *packet);