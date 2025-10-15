#pragma once

#include "simply_window.h"

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
  AppTimer *scroll_timer;
  MenuIndex scroll_index;
  int16_t scroll_offset;
  int16_t max_scroll_offset;
  bool scrolling_active;
  bool needs_scrolling;
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

bool simply_menu_handle_packet(Simply *simply, Packet *packet);
