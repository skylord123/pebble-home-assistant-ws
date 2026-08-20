#include "simply_menu.h"

#include "simply_res.h"
#include "simply_msg.h"
#include "simply_window_stack.h"

#include "simply.h"

#include "util/color.h"
#include "util/display.h"
#include "util/graphics.h"
#include "util/graphics_text.h"
#include "util/menu_layer.h"
#include "util/noop.h"
#include "util/platform.h"
#include "util/string.h"

#include <pebble.h>

#define MAX_CACHED_SECTIONS 10

#define MAX_CACHED_ITEMS IF_APLITE_ELSE(6, 51)

#define EMPTY_TITLE ""

#define SPINNER_MS 66

#define RELOAD_DEBOUNCE_MS 50  // Wait 50ms after last section before reloading

#if !defined(PBL_PLATFORM_APLITE)
// Scrolling configuration
#define SCROLL_WAIT_MS 1000  // Wait X ms before starting to scroll
#define SCROLL_STEP_MS 100   // Scroll every X ms
#define SCROLL_STEP_PX 8     // Scroll X pixels at a time
#define SCROLL_IDLE_TIMEOUT_MS 60000  // Stop scrolling after 60 seconds of inactivity (configurable)
#endif

// The firmware selects the Large content size for displays 200px or taller
// (PebbleOS preferred_content_size.h). SDK 4.17 does not expose
// PBL_DISPLAY_HEIGHT, so name emery explicitly as well; newer SDKs pick up
// any future large-screen platform through the display height automatically.
#if defined(PBL_PLATFORM_EMERY) || (defined(PBL_DISPLAY_HEIGHT) && PBL_DISPLAY_HEIGHT >= 200)
#define MENU_CONTENT_SIZE_LARGE 1
#endif

// Menu row fonts, matching what menu_cell_basic_draw uses for the platform's
// content size so the custom-drawn scrolling selected row is identical to the
// firmware-drawn static rows. Large content size (Pebble Time 2) means 61px
// cells with Gothic 24 Bold titles and Gothic 24 subtitles (per Core Devices'
// PebbleOS system theme); the other platforms use Medium (44px cells,
// Gothic 24 Bold / Gothic 18).
#if defined(MENU_CONTENT_SIZE_LARGE)
#define MENU_TITLE_FONT_KEY FONT_KEY_GOTHIC_24_BOLD
#define MENU_SUBTITLE_FONT_KEY FONT_KEY_GOTHIC_24
#define MENU_TITLE_FONT_HEIGHT 24
#define MENU_SUBTITLE_FONT_HEIGHT 24
#else
#define MENU_TITLE_FONT_KEY FONT_KEY_GOTHIC_24_BOLD
#define MENU_SUBTITLE_FONT_KEY FONT_KEY_GOTHIC_18
#define MENU_TITLE_FONT_HEIGHT 24
#define MENU_SUBTITLE_FONT_HEIGHT 18
#endif

typedef Packet MenuClearPacket;

typedef struct MenuClearSectionPacket MenuClearSectionPacket;

struct __attribute__((__packed__)) MenuClearSectionPacket {
  Packet packet;
  uint16_t section;
};

typedef struct MenuPropsPacket MenuPropsPacket;

struct __attribute__((__packed__)) MenuPropsPacket {
  Packet packet;
  uint16_t num_sections;
  GColor8 background_color;
  GColor8 text_color;
  GColor8 highlight_background_color;
  GColor8 highlight_text_color;
  bool scroll_wrap;
};

typedef struct MenuSectionPacket MenuSectionPacket;

struct __attribute__((__packed__)) MenuSectionPacket {
  Packet packet;
  uint16_t section;
  uint16_t num_items;
  GColor8 background_color;
  GColor8 text_color;
  uint16_t title_length;
  char title[];
};

typedef struct MenuItemPacket MenuItemPacket;

struct __attribute__((__packed__)) MenuItemPacket {
  Packet packet;
  uint16_t section;
  uint16_t item;
  uint32_t icon;
  uint16_t title_length;
  uint16_t subtitle_length;
  char buffer[];
};

typedef struct MenuItemEventPacket MenuItemEventPacket;

struct __attribute__((__packed__)) MenuItemEventPacket {
  Packet packet;
  uint16_t section;
  uint16_t item;
};

typedef Packet MenuGetSelectionPacket;

typedef struct MenuSelectionPacket MenuSelectionPacket;

struct __attribute__((__packed__)) MenuSelectionPacket {
  Packet packet;
  uint16_t section;
  uint16_t item;
  MenuRowAlign align:8;
  bool animated;
};


// Inverts every color in a palettized bitmap's palette in place, preserving
// each entry's alpha so transparency and anti-aliasing survive. XORing the six
// color bits maps every channel value v to 3-v (black <-> white, dark grey <->
// light grey), and applying it twice restores the original palette.
static void prv_invert_image_palette(SimplyImage *image) {
  GColor8 *palette = gbitmap_get_palette(image->bitmap);
  if (!palette) {
    return;
  }
  for (uint16_t i = 0; i < image->palette_entries; ++i) {
    palette[i].argb ^= 0b00111111;
  }
}


static void simply_menu_clear_section_items(SimplyMenu *self, int section_index);
static void simply_menu_clear(SimplyMenu *self);

static void simply_menu_set_num_sections(SimplyMenu *self, uint16_t num_sections);
static void simply_menu_add_section(SimplyMenu *self, SimplyMenuSection *section);
static void simply_menu_add_item(SimplyMenu *self, SimplyMenuItem *item);

static MenuIndex simply_menu_get_selection(SimplyMenu *self);
static void simply_menu_set_selection(SimplyMenu *self, MenuIndex menu_index, MenuRowAlign align, bool animated);

static void refresh_spinner_timer(SimplyMenu *self);

static void reload_timer_callback(void *data);

#if !defined(PBL_PLATFORM_APLITE)
// Forward declarations for scroll timer callbacks
static void scroll_timer_callback(void *data);
static void reset_scroll_callback(void *data);
#endif

static uint32_t prv_get_milliseconds(void) {
  time_t now_s;
  uint16_t now_ms_part;
  time_ms(&now_s, &now_ms_part);
  // Truncating to 32 bits is fine: this only feeds interval math, which
  // stays correct across the wraparound, and it avoids pulling in libgcc's
  // 64-bit division helpers (~900 bytes of app RAM)
  return (uint32_t) now_s * 1000 + now_ms_part;
}

static bool prv_send_menu_item(Command type, uint16_t section, uint16_t item) {
  MenuItemEventPacket packet = {
    .packet.type = type,
    .packet.length = sizeof(packet),
    .section = section,
    .item = item,
  };
  return simply_msg_send_packet(&packet.packet);
}

static bool prv_send_menu_get_section(uint16_t index) {
  return prv_send_menu_item(CommandMenuGetSection, index, 0);
}

static bool prv_send_menu_get_item(uint16_t section, uint16_t index) {
  return prv_send_menu_item(CommandMenuGetItem, section, index);
}

static bool prv_send_menu_select_click(uint16_t section, uint16_t index) {
  return prv_send_menu_item(CommandMenuSelect, section, index);
}

static bool prv_send_menu_select_long_click(uint16_t section, uint16_t index) {
  return prv_send_menu_item(CommandMenuLongSelect, section, index);
}

static bool prv_section_filter(List1Node *node, void *data) {
  SimplyMenuCommon *section = (SimplyMenuCommon *)node;
  const uint16_t section_index = (uint16_t)(uintptr_t) data;
  return (section->section == section_index);
}

static bool prv_item_filter(List1Node *node, void *data) {
  SimplyMenuItem *item = (SimplyMenuItem *)node;
  const uint32_t cell_index = (uint32_t)(uintptr_t) data;
  const uint16_t section_index = cell_index;
  const uint16_t row = cell_index >> 16;
  return (item->section == section_index && item->item == row);
}

static bool prv_request_item_filter(List1Node *node, void *data) {
  return (((SimplyMenuItem *)node)->title == NULL);
}

#define ROW_COUNT_UNKNOWN 0xffff
#define ROW_COUNT_HAS_HEADER 0x8000
#define ROW_COUNT_MASK 0x7fff

static void prv_row_counts_resize(SimplyMenu *self, uint16_t num_sections) {
  SimplyMenuLayer *menu_layer = &self->menu_layer;
  if (menu_layer->row_counts && menu_layer->row_counts_len == num_sections) { return; }
  uint16_t *counts = malloc(num_sections * sizeof(uint16_t));
  if (!counts) { return; }
  for (uint16_t i = 0; i < num_sections; ++i) {
    counts[i] = (menu_layer->row_counts && i < menu_layer->row_counts_len) ?
        menu_layer->row_counts[i] : ROW_COUNT_UNKNOWN;
  }
  free(menu_layer->row_counts);
  menu_layer->row_counts = counts;
  menu_layer->row_counts_len = num_sections;
}

static void prv_row_counts_record(SimplyMenu *self, uint16_t section, uint16_t num_items,
                                  bool has_header) {
  if (section >= self->menu_layer.row_counts_len) {
    prv_row_counts_resize(self, section + 1);
  }
  if (section < self->menu_layer.row_counts_len) {
    self->menu_layer.row_counts[section] =
        (num_items & ROW_COUNT_MASK) | (has_header ? ROW_COUNT_HAS_HEADER : 0);
  }
}

//! Returns false when the section's row count has not been received yet
static bool prv_row_counts_get(SimplyMenu *self, uint16_t section, uint16_t *num_items_out,
                               bool *has_header_out) {
  SimplyMenuLayer *menu_layer = &self->menu_layer;
  if (!menu_layer->row_counts || section >= menu_layer->row_counts_len ||
      menu_layer->row_counts[section] == ROW_COUNT_UNKNOWN) {
    return false;
  }
  if (num_items_out) { *num_items_out = menu_layer->row_counts[section] & ROW_COUNT_MASK; }
  if (has_header_out) { *has_header_out = (menu_layer->row_counts[section] & ROW_COUNT_HAS_HEADER); }
  return true;
}

static void prv_row_counts_reset(SimplyMenu *self) {
  for (uint16_t i = 0; i < self->menu_layer.row_counts_len; ++i) {
    self->menu_layer.row_counts[i] = ROW_COUNT_UNKNOWN;
  }
}

static SimplyMenuSection *prv_get_menu_section(SimplyMenu *self, int index) {
  return (SimplyMenuSection*) list1_find(self->menu_layer.sections, prv_section_filter,
                                         (void*)(uintptr_t) index);
}

static void prv_free_title(char **title) {
  if (*title && *title != EMPTY_TITLE) {
    free(*title);
    *title = NULL;
  }
}

static void prv_destroy_section(SimplyMenu *self, SimplyMenuSection *section) {
  if (!section) { return; }
  list1_remove(&self->menu_layer.sections, &section->node);
  prv_free_title(&section->title);
  free(section);
}

static void prv_destroy_section_by_index(SimplyMenu *self, int section) {
  SimplyMenuSection *section_node =
      (SimplyMenuSection *)list1_find(self->menu_layer.sections, prv_section_filter,
                                      (void *)(uintptr_t)section);
  prv_destroy_section(self, section_node);
}

static SimplyMenuItem *prv_get_menu_item(SimplyMenu *self, int section, int index) {
  const uint32_t cell_index = section | (index << 16);
  return (SimplyMenuItem *) list1_find(self->menu_layer.items, prv_item_filter,
                                      (void *)(uintptr_t) cell_index);
}

static void prv_destroy_item(SimplyMenu *self, SimplyMenuItem *item) {
  if (!item) { return; }
  list1_remove(&self->menu_layer.items, &item->node);
  prv_free_title(&item->title);
  prv_free_title(&item->subtitle);
  free(item);
}

static void prv_destroy_item_by_index(SimplyMenu *self, int section, int index) {
  const uint32_t cell_index = section | (index << 16);
  SimplyMenuItem *item =
      (SimplyMenuItem *)list1_find(self->menu_layer.items, prv_item_filter,
                                   (void *)(uintptr_t) cell_index);
  prv_destroy_item(self, item);
}

static void prv_add_section(SimplyMenu *self, SimplyMenuSection *section) {
  if (list1_size(self->menu_layer.sections) >= MAX_CACHED_SECTIONS) {
    prv_destroy_section(self, (SimplyMenuSection *)list1_last(self->menu_layer.sections));
  }
  prv_destroy_section_by_index(self, section->section);
  list1_prepend(&self->menu_layer.sections, &section->node);
}

static void prv_add_item(SimplyMenu *self, SimplyMenuItem *item) {
  if (list1_size(self->menu_layer.items) >= MAX_CACHED_ITEMS) {
    prv_destroy_item(self, (SimplyMenuItem*) list1_last(self->menu_layer.items));
  }
  prv_destroy_item_by_index(self, item->section, item->item);
  list1_prepend(&self->menu_layer.items, &item->node);
}

static void prv_request_menu_section(SimplyMenu *self, uint16_t section_index) {
  SimplyMenuSection *section = prv_get_menu_section(self, section_index);
  if (section) { return; }
  section = malloc(sizeof(*section));
  *section = (SimplyMenuSection) {
    .section = section_index,
  };
  prv_add_section(self, section);
  prv_send_menu_get_section(section_index);
}

static void prv_request_menu_item(SimplyMenu *self, uint16_t section_index, uint16_t item_index) {
  SimplyMenuItem *item = prv_get_menu_item(self, section_index, item_index);
  if (item) { return; }
  item = malloc(sizeof(*item));
  *item = (SimplyMenuItem) {
    .section = section_index,
    .item = item_index,
  };
  prv_add_item(self, item);
  prv_send_menu_get_item(section_index, item_index);
}

static void prv_mark_dirty(SimplyMenu *self) {
  if (self->menu_layer.menu_layer) {
    layer_mark_dirty(menu_layer_get_layer(self->menu_layer.menu_layer));
  }
}

static void prv_reload_data(SimplyMenu *self) {
  if (self->menu_layer.menu_layer) {
    menu_layer_reload_data(self->menu_layer.menu_layer);
  }
}

static void reload_timer_callback(void *data) {
  SimplyMenu *self = data;
  self->reload_timer = NULL;
  prv_reload_data(self);
}

static void prv_reload_data_debounced(SimplyMenu *self) {
  // Cancel any existing reload timer
  if (self->reload_timer) {
    app_timer_cancel(self->reload_timer);
    self->reload_timer = NULL;
  }

  // Schedule a new reload after a short delay
  // This debounces multiple rapid section additions
  self->reload_timer = app_timer_register(RELOAD_DEBOUNCE_MS, reload_timer_callback, self);
}

static void simply_menu_set_num_sections(SimplyMenu *self, uint16_t num_sections) {
  if (num_sections == 0) {
    num_sections = 1;
  }
  self->menu_layer.num_sections = num_sections;
  prv_row_counts_resize(self, num_sections);
  prv_reload_data(self);
}

static void simply_menu_add_section(SimplyMenu *self, SimplyMenuSection *section) {
  if (section->title == NULL) {
    section->title = EMPTY_TITLE;
  }
  prv_add_section(self, section);
  prv_reload_data_debounced(self);  // Use debounced reload instead of immediate
}

static void simply_menu_add_item(SimplyMenu *self, SimplyMenuItem *item) {
  if (item->title == NULL) {
    item->title = EMPTY_TITLE;
  }
  prv_add_item(self, item);
  prv_mark_dirty(self);
}

static MenuIndex simply_menu_get_selection(SimplyMenu *self) {
  if (!self->menu_layer.menu_layer) {
    return (MenuIndex) {};
  }
  return menu_layer_get_selected_index(self->menu_layer.menu_layer);
}

static void simply_menu_set_selection(SimplyMenu *self, MenuIndex menu_index, MenuRowAlign align,
                                      bool animated) {
  if (!self->menu_layer.menu_layer) { return; }
  // Apply any pending debounced reload before selecting. The selection packet
  // usually arrives in the same message batch as the section data it refers
  // to, and the MenuLayer computes the scroll offset from the row counts it
  // currently knows: selecting against stale counts restores the highlight
  // but leaves the list scrolled to the top with the selection off screen.
  if (self->reload_timer) {
    app_timer_cancel(self->reload_timer);
    self->reload_timer = NULL;
    prv_reload_data(self);
  }
  menu_layer_set_selected_index(self->menu_layer.menu_layer, menu_index, align, animated);
}

static bool prv_send_menu_selection(SimplyMenu *self) {
  MenuIndex menu_index = simply_menu_get_selection(self);
  return prv_send_menu_item(CommandMenuSelectionEvent, menu_index.section, menu_index.row);
}

static void spinner_timer_callback(void *data) {
  SimplyMenu *self = data;
  self->spinner_timer = NULL;
  prv_mark_dirty(self);
  refresh_spinner_timer(self);
}

static SimplyMenuItem *get_first_request_item(SimplyMenu *self) {
  return (SimplyMenuItem *)list1_find(self->menu_layer.items, prv_request_item_filter, NULL);
}

static SimplyMenuItem *get_last_request_item(SimplyMenu *self) {
  return (SimplyMenuItem *)list1_find_last(self->menu_layer.items, prv_request_item_filter, NULL);
}

static void refresh_spinner_timer(SimplyMenu *self) {
  if (!self->spinner_timer && get_first_request_item(self)) {
    self->spinner_timer = app_timer_register(SPINNER_MS, spinner_timer_callback, self);
  }
}

#if !defined(PBL_PLATFORM_APLITE)
static void scroll_timer_callback(void *data) {
  SimplyMenu *self = data;
  self->scroll_timer = NULL;

  // Only scroll if needed (will be set by draw callback)
  if (!self->needs_scrolling) {
    return;
  }

  if (!self->scrolling_active) {
    // First time - start scrolling
    self->scrolling_active = true;
    self->scroll_offset = SCROLL_STEP_PX;
  } else {
    // Continue scrolling
    self->scroll_offset += SCROLL_STEP_PX;

    // Check if we've scrolled past the end
    if (self->scroll_offset >= self->max_scroll_offset) {
      // Wait a bit at the end, then reset
      self->scroll_timer = app_timer_register(SCROLL_WAIT_MS, reset_scroll_callback, self);
      prv_mark_dirty(self);
      return;
    }
  }

  // Mark dirty to redraw
  prv_mark_dirty(self);

  // Schedule next scroll step
  self->scroll_timer = app_timer_register(SCROLL_STEP_MS, scroll_timer_callback, self);
}

static void reset_scroll_callback(void *data) {
  SimplyMenu *self = data;
  self->scroll_timer = NULL;

  // Reset scroll position
  self->scroll_offset = 0;
  self->scrolling_active = false;

  // Mark dirty to redraw
  prv_mark_dirty(self);

  // Check if idle timeout has been exceeded
  time_t current_time = time(NULL);
  time_t elapsed_ms = (current_time - self->last_input_time) * 1000;

  if (elapsed_ms >= SCROLL_IDLE_TIMEOUT_MS) {
    // Idle timeout exceeded - don't restart scrolling
    self->scroll_idle = true;
    return;
  }

  // Restart scrolling after the initial delay
  self->scroll_timer = app_timer_register(SCROLL_WAIT_MS, scroll_timer_callback, self);
}

#if defined(PBL_ROUND)
// Forward declarations for round display scroll callbacks
static void reset_scroll_callback_round(void *data);

// For round displays: handle independent scrolling of title and subtitle
static void scroll_timer_callback_round(void *data) {
  SimplyMenu *self = data;
  self->scroll_timer = NULL;

  // Check if either title or subtitle needs scrolling
  if (!self->title_needs_scroll && !self->subtitle_needs_scroll) {
    return;
  }

  bool title_finished = false;
  bool subtitle_finished = false;

  // Handle title scrolling
  if (self->title_needs_scroll) {
    if (!self->title_scrolling_active) {
      self->title_scrolling_active = true;
      self->title_scroll_offset = SCROLL_STEP_PX;
    } else {
      self->title_scroll_offset += SCROLL_STEP_PX;
      if (self->title_scroll_offset >= self->title_max_scroll_offset) {
        title_finished = true;
      }
    }
  }

  // Handle subtitle scrolling
  if (self->subtitle_needs_scroll) {
    if (!self->subtitle_scrolling_active) {
      self->subtitle_scrolling_active = true;
      self->subtitle_scroll_offset = SCROLL_STEP_PX;
    } else {
      self->subtitle_scroll_offset += SCROLL_STEP_PX;
      if (self->subtitle_scroll_offset >= self->subtitle_max_scroll_offset) {
        subtitle_finished = true;
      }
    }
  }

  // Check if all elements that need scrolling are finished
  bool all_finished = true;
  if (self->title_needs_scroll && !title_finished) {
    all_finished = false;
  }
  if (self->subtitle_needs_scroll && !subtitle_finished) {
    all_finished = false;
  }

  // If all elements that need scrolling are finished, wait and reset
  if (all_finished) {
    prv_mark_dirty(self);
    self->scroll_timer = app_timer_register(SCROLL_WAIT_MS, reset_scroll_callback_round, self);
    return;
  }

  // Mark dirty to redraw
  prv_mark_dirty(self);

  // Schedule next scroll step
  self->scroll_timer = app_timer_register(SCROLL_STEP_MS, scroll_timer_callback_round, self);
}

static void reset_scroll_callback_round(void *data) {
  SimplyMenu *self = data;
  self->scroll_timer = NULL;

  // Reset scroll positions
  self->title_scroll_offset = 0;
  self->title_scrolling_active = false;
  self->subtitle_scroll_offset = 0;
  self->subtitle_scrolling_active = false;

  // Mark dirty to redraw
  prv_mark_dirty(self);

  // Check if idle timeout has been exceeded
  time_t current_time = time(NULL);
  time_t elapsed_ms = (current_time - self->last_input_time) * 1000;

  if (elapsed_ms >= SCROLL_IDLE_TIMEOUT_MS) {
    // Idle timeout exceeded - don't restart scrolling
    self->scroll_idle = true;
    return;
  }

  // Restart scrolling after the initial delay
  self->scroll_timer = app_timer_register(SCROLL_WAIT_MS, scroll_timer_callback_round, self);
}
#endif

static void start_scroll_timer(SimplyMenu *self, MenuIndex index) {
  // Cancel any existing scroll timer
  if (self->scroll_timer) {
    app_timer_cancel(self->scroll_timer);
    self->scroll_timer = NULL;
  }

  // Reset scroll state
  self->scroll_index = index;
  self->scroll_offset = 0;
  self->max_scroll_offset = 0;
  self->scrolling_active = false;
  self->needs_scrolling = false;

#if defined(PBL_ROUND)
  // Reset round display independent scroll states
  self->title_scroll_offset = 0;
  self->title_max_scroll_offset = 0;
  self->title_needs_scroll = false;
  self->title_scrolling_active = false;
  self->subtitle_scroll_offset = 0;
  self->subtitle_max_scroll_offset = 0;
  self->subtitle_needs_scroll = false;
  self->subtitle_scrolling_active = false;
#endif

  // Mark dirty to redraw without scroll
  prv_mark_dirty(self);

  // Start timer to begin scrolling after delay
  // The draw callback will determine if scrolling is actually needed
#if defined(PBL_ROUND)
  self->scroll_timer = app_timer_register(SCROLL_WAIT_MS, scroll_timer_callback_round, self);
#else
  self->scroll_timer = app_timer_register(SCROLL_WAIT_MS, scroll_timer_callback, self);
#endif
}

static void stop_scroll_timer(SimplyMenu *self) {
  if (self->scroll_timer) {
    app_timer_cancel(self->scroll_timer);
    self->scroll_timer = NULL;
  }
  self->scroll_offset = 0;
  self->max_scroll_offset = 0;
  self->scrolling_active = false;
  self->needs_scrolling = false;

#if defined(PBL_ROUND)
  self->title_scroll_offset = 0;
  self->title_max_scroll_offset = 0;
  self->title_needs_scroll = false;
  self->title_scrolling_active = false;
  self->subtitle_scroll_offset = 0;
  self->subtitle_max_scroll_offset = 0;
  self->subtitle_needs_scroll = false;
  self->subtitle_scrolling_active = false;
#endif
}
#endif

static uint16_t prv_menu_get_num_sections_callback(MenuLayer *menu_layer, void *data) {
  SimplyMenu *self = data;
  return self->menu_layer.num_sections;
}

static uint16_t prv_menu_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index,
                                               void *data) {
  SimplyMenu *self = data;
  uint16_t num_items;
  if (prv_row_counts_get(self, section_index, &num_items, NULL)) {
    return num_items;
  }
  SimplyMenuSection *section = prv_get_menu_section(self, section_index);
  return section ? section->num_items : 1;
}

static int16_t prv_menu_get_header_height_callback(MenuLayer *menu_layer, uint16_t section_index,
                                                   void *data) {
  SimplyMenu *self = data;
  bool has_header;
  if (prv_row_counts_get(self, section_index, NULL, &has_header)) {
    return has_header ? MENU_CELL_BASIC_HEADER_HEIGHT : 0;
  }
  SimplyMenuSection *section = prv_get_menu_section(self, section_index);
  return (section && section->title &&
          section->title != EMPTY_TITLE ? MENU_CELL_BASIC_HEADER_HEIGHT : 0);
}

ROUND_USAGE static int16_t prv_menu_get_cell_height_callback(MenuLayer *menu_layer, MenuIndex *cell_index,
                                                             void *context) {
  if (PBL_IF_ROUND_ELSE(true, false)) {
    const bool is_selected = menu_layer_is_index_selected(menu_layer, cell_index);
    return is_selected ? MENU_CELL_ROUND_FOCUSED_TALL_CELL_HEIGHT :
                         MENU_CELL_ROUND_UNFOCUSED_SHORT_CELL_HEIGHT;
  } else {
    return MENU_CELL_BASIC_CELL_HEIGHT;
  }
}

#if !defined(PBL_PLATFORM_APLITE)
static void prv_menu_selection_changed_callback(MenuLayer *menu_layer, MenuIndex new_index,
                                                 MenuIndex old_index, void *data) {
  SimplyMenu *self = data;
  // Update last input time and clear idle state
  self->last_input_time = time(NULL);
  self->scroll_idle = false;
  // Start scroll timer for the new selection
  start_scroll_timer(self, new_index);
  // Only send selection event if the window is still loaded and visible
  // This prevents crashes when the menu is being torn down
  if (self->window.window && window_is_loaded(self->window.window)) {
    prv_send_menu_selection(self);
  }
}
#endif

static void prv_menu_draw_header_callback(GContext *ctx, const Layer *cell_layer,
                                          uint16_t section_index, void *data) {
  SimplyMenu *self = data;
  SimplyMenuSection *section = prv_get_menu_section(self, section_index);
  if (!section) {
    prv_request_menu_section(self, section_index);
    return;
  }

  list1_remove(&self->menu_layer.sections, &section->node);
  list1_prepend(&self->menu_layer.sections, &section->node);

  GRect bounds = layer_get_bounds(cell_layer);

  graphics_context_set_fill_color(ctx, gcolor8_get_or(section->title_background, GColorWhite));
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  bounds.origin.x += 2;
  bounds.origin.y -= 1;

  graphics_context_set_text_color(ctx, gcolor8_get_or(section->title_foreground, GColorBlack));

  GTextAttributes *title_attributes = graphics_text_attributes_create();
  PBL_IF_ROUND_ELSE(
      graphics_text_attributes_enable_paging_on_layer(
          title_attributes, (Layer *)menu_layer_get_scroll_layer(self->menu_layer.menu_layer),
          &bounds, TEXT_FLOW_DEFAULT_INSET), NOOP);
  const GTextAlignment align = PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft);
  graphics_draw_text(ctx, section->title, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                     bounds, GTextOverflowModeTrailingEllipsis, align, title_attributes);
  graphics_text_attributes_destroy(title_attributes);
}

static void simply_menu_draw_row_spinner(SimplyMenu *self, GContext *ctx,
                                         const Layer *cell_layer) {
  GRect bounds = layer_get_bounds(cell_layer);
  GPoint center = grect_center_point(&bounds);

  const int16_t min_radius = 4 * bounds.size.h / 24;
  const int16_t max_radius = 9 * bounds.size.h / 24;
  const int16_t num_lines = 16;
  const int16_t num_drawn_lines = 3;

  const uint32_t now_ms = prv_get_milliseconds();
  const uint32_t start_index = (now_ms / SPINNER_MS) % num_lines;

  graphics_context_set_antialiased(ctx, true);

  GColor8 stroke_color =
      menu_cell_layer_is_highlighted(cell_layer) ? self->menu_layer.highlight_foreground :
                                                   self->menu_layer.normal_foreground;
  graphics_context_set_stroke_color(ctx, gcolor8_get_or(stroke_color, GColorBlack));

  for (int16_t i = 0; i < num_drawn_lines; i++) {
    const uint32_t angle = (i + start_index) * TRIG_MAX_ANGLE / num_lines;
    GPoint a = gpoint_add(center, gpoint_polar(angle, min_radius));
    GPoint b = gpoint_add(center, gpoint_polar(angle, max_radius));
    graphics_draw_line(ctx, a, b);
  }
}

static void prv_menu_draw_row_callback(GContext *ctx, const Layer *cell_layer,
                                       MenuIndex *cell_index, void *data) {
  SimplyMenu *self = data;
  SimplyMenuSection *section = prv_get_menu_section(self, cell_index->section);
  if (!section) {
    prv_request_menu_section(self, cell_index->section);
    return;
  }

  SimplyMenuItem *item = prv_get_menu_item(self, cell_index->section, cell_index->row);
  if (!item) {
    prv_request_menu_item(self, cell_index->section, cell_index->row);
    return;
  }

  if (item->title == NULL) {
    SimplyMenuItem *last_request = get_last_request_item(self);
    if (last_request == item) {
      simply_menu_draw_row_spinner(self, ctx, cell_layer);
      refresh_spinner_timer(self);
    }
    return;
  }

  list1_remove(&self->menu_layer.items, &item->node);
  list1_prepend(&self->menu_layer.items, &item->node);

  // Disable icons on APLITE platform to save memory
  SimplyImage *image = NULL;
#if !defined(PBL_PLATFORM_APLITE) // disable icons on APLITE as it causes crash
  image = simply_res_get_image(self->window.simply->res, item->icon);
#endif
  // Icons are designed for the normal row background, so invert their colors
  // while drawing a highlighted row to keep them visible on the highlight
  // background. This works for any palettized bitmap (the bundled icons decode
  // to multi-entry palettes with transparency and anti-aliasing, not just
  // 2-color black and white).
  bool palette_inverted = false;
  if (image && image->palette_entries && menu_cell_layer_is_highlighted(cell_layer)) {
    prv_invert_image_palette(image);
    palette_inverted = true;
  }

  graphics_context_set_alpha_blended(ctx, true);

#if !defined(PBL_PLATFORM_APLITE)
  // Check if this is the selected item
  MenuIndex current_selection = menu_layer_get_selected_index(self->menu_layer.menu_layer);
  const bool is_selected = (cell_index->section == current_selection.section &&
                           cell_index->row == current_selection.row);

  // If this is selected but scroll timer hasn't been started yet, start it
  // Don't start if we're in idle state (timeout exceeded)
  if (is_selected && !self->scroll_timer && !self->scrolling_active && !self->scroll_idle) {
    start_scroll_timer(self, current_selection);
  }

  // Measure text width to determine if scrolling is needed
  if (is_selected) {
    GRect bounds = layer_get_bounds(cell_layer);
    int16_t available_width = bounds.size.w;

#if !defined(PBL_ROUND)
#if defined(MENU_CONTENT_SIZE_LARGE)
    // RECTANGULAR DISPLAY (Large content size): menu_cell_basic_draw uses a
    // fixed 44px left text margin when an icon is present (10px inset plus
    // 34px title/subtitle margin), 10px without
    available_width -= (image && image->bitmap) ? 44 : 10;
    available_width -= 10; // right margin
#else
    // RECTANGULAR DISPLAY: Account for icon width
    if (image && image->bitmap) {
      GRect icon_rect = gbitmap_get_bounds(image->bitmap);
      available_width -= (icon_rect.size.w + 8); // icon width + margins
    }
    available_width -= 10; // text margins
#endif
#else
    // ROUND DISPLAY: Account for icon height and margins
    // Icon is centered at top, text is below it
    available_width -= 20; // left/right margins for centered text
#endif

    // Measure title text with the same fonts the row is drawn with
    const GFont title_font = fonts_get_system_font(MENU_TITLE_FONT_KEY);
    GSize title_size = graphics_text_layout_get_content_size(
        item->title, title_font,
        GRect(0, 0, 1000, 100),
        GTextOverflowModeTrailingEllipsis,
        GTextAlignmentCenter);

    // Check if title needs scrolling
    bool title_needs_scroll = title_size.w > available_width;

    // Measure subtitle if present
    bool subtitle_needs_scroll = false;
    int16_t subtitle_width = 0;
    if (item->subtitle) {
      const GFont subtitle_font = fonts_get_system_font(MENU_SUBTITLE_FONT_KEY);
      GSize subtitle_size = graphics_text_layout_get_content_size(
          item->subtitle, subtitle_font,
          GRect(0, 0, 1000, 100),
          GTextOverflowModeTrailingEllipsis,
          GTextAlignmentCenter);
      subtitle_width = subtitle_size.w;
      subtitle_needs_scroll = subtitle_size.w > available_width;
    }

    // Set needs_scrolling flag and calculate max offset
#if defined(PBL_ROUND)
    // For round displays: track independent scroll needs for title and subtitle
    self->title_needs_scroll = title_needs_scroll;
    self->subtitle_needs_scroll = subtitle_needs_scroll;

    // Cache font heights to avoid expensive measurements during drawing
    const GFont title_font_for_height = fonts_get_system_font(MENU_TITLE_FONT_KEY);
    GSize title_height_size = graphics_text_layout_get_content_size(
        "A", title_font_for_height, GRect(0, 0, 100, 100),
        GTextOverflowModeFill, GTextAlignmentLeft);
    self->title_height = title_height_size.h;

    if (item->subtitle) {
      const GFont subtitle_font_for_height = fonts_get_system_font(MENU_SUBTITLE_FONT_KEY);
      GSize subtitle_height_size = graphics_text_layout_get_content_size(
          "A", subtitle_font_for_height, GRect(0, 0, 100, 100),
          GTextOverflowModeFill, GTextAlignmentLeft);
      self->subtitle_height = subtitle_height_size.h;
    } else {
      self->subtitle_height = 0;
    }

    if (title_needs_scroll) {
      self->title_max_scroll_offset = title_size.w - available_width + 40;
    } else {
      self->title_max_scroll_offset = 0;
    }

    if (subtitle_needs_scroll) {
      self->subtitle_max_scroll_offset = subtitle_width - available_width + 40;
    } else {
      self->subtitle_max_scroll_offset = 0;
    }

    self->needs_scrolling = title_needs_scroll || subtitle_needs_scroll;
#else
    // For rectangular displays: use combined scroll offset
    self->needs_scrolling = title_needs_scroll || subtitle_needs_scroll;
    if (self->needs_scrolling) {
      // Calculate how far we need to scroll to show all text
      // Add extra padding (40px) to ensure the last word is fully visible
      int16_t max_title_scroll = title_needs_scroll ? (title_size.w - available_width + 40) : 0;
      int16_t max_subtitle_scroll = subtitle_needs_scroll ? (subtitle_width - available_width + 40) : 0;
      self->max_scroll_offset = max_title_scroll > max_subtitle_scroll ?
          max_title_scroll : max_subtitle_scroll;
    } else {
      self->max_scroll_offset = 0;
    }
#endif
  }

  // Use custom drawing when scrolling is needed (even if scroll_offset is 0, we need to draw with the correct fonts)
  if (is_selected && self->needs_scrolling) {
    // Manual drawing with scroll offset
    GRect bounds = layer_get_bounds(cell_layer);
    const bool is_highlighted = menu_cell_layer_is_highlighted(cell_layer);

    // Background - use configured highlight/normal colors
    GColor8 bg_color = is_highlighted ?
        self->menu_layer.highlight_background :
        self->menu_layer.normal_background;
    graphics_context_set_fill_color(ctx, gcolor8_get_or(bg_color, is_highlighted ? GColorBlack : GColorWhite));
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

#if !defined(PBL_ROUND)
    // ===== RECTANGULAR DISPLAY: Scroll icon and text together =====
#if defined(MENU_CONTENT_SIZE_LARGE)
    // Large content size margins from menu_cell_basic_draw: icon inset 10px,
    // text at a fixed 44px when an icon is present, 10px otherwise
    const int16_t icon_x = 10;
    const int16_t text_x = (image && image->bitmap) ? 44 : 10;
#else
    const int16_t icon_x = 4;
    const int16_t text_x = (image && image->bitmap)
        ? (int16_t)(4 + gbitmap_get_bounds(image->bitmap).size.w + 4) : 4;
#endif
    if (image && image->bitmap) {
      GRect icon_bounds = gbitmap_get_bounds(image->bitmap);
      graphics_context_set_compositing_mode(ctx, GCompOpSet);
      // Scroll the icon along with the text
      graphics_draw_bitmap_in_rect(ctx, image->bitmap,
                                   GRect(icon_x - self->scroll_offset,
                                         (bounds.size.h - icon_bounds.size.h) / 2,
                                         icon_bounds.size.w, icon_bounds.size.h));
    }

    // Text color - use configured highlight/normal colors
    GColor8 text_color = is_highlighted ?
        self->menu_layer.highlight_foreground :
        self->menu_layer.normal_foreground;
    graphics_context_set_text_color(ctx, gcolor8_get_or(text_color, is_highlighted ? GColorWhite : GColorBlack));

    // Text with scroll offset
    const int16_t scroll_x = text_x - self->scroll_offset;
    const int16_t text_w = bounds.size.w - text_x + self->scroll_offset;

    // Lay the text out exactly the way menu_cell_basic_draw does: the block of
    // title + subtitle + 10px padding is vertically centered in the cell, the
    // title box is font height + 4, and the subtitle starts one title height
    // below the title. This keeps the custom-drawn scrolling row identical to
    // the firmware-drawn static rows on every rectangular platform.
    const int16_t subtitle_font_height = item->subtitle ? MENU_SUBTITLE_FONT_HEIGHT : 0;
    const int16_t vertical_margin = (int16_t)
        ((bounds.size.h - (MENU_TITLE_FONT_HEIGHT + subtitle_font_height + 10)) / 2);
    graphics_draw_text(ctx, item->title,
                      fonts_get_system_font(MENU_TITLE_FONT_KEY),
                      GRect(scroll_x, vertical_margin, text_w, MENU_TITLE_FONT_HEIGHT + 4),
                      GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    if (item->subtitle) {
      graphics_draw_text(ctx, item->subtitle,
                        fonts_get_system_font(MENU_SUBTITLE_FONT_KEY),
                        GRect(scroll_x, vertical_margin + MENU_TITLE_FONT_HEIGHT, text_w,
                              MENU_SUBTITLE_FONT_HEIGHT + 4),
                        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    }

#else
    // ===== ROUND DISPLAY: Keep icon static, scroll text independently =====
    // Text color - use configured highlight/normal colors
    GColor8 text_color = is_highlighted ?
        self->menu_layer.highlight_foreground :
        self->menu_layer.normal_foreground;
    graphics_context_set_text_color(ctx, gcolor8_get_or(text_color, is_highlighted ? GColorWhite : GColorBlack));

    // Draw icon centered at top (static, no scroll)
    int16_t icon_y = 2;
    if (image && image->bitmap) {
      GRect icon_bounds = gbitmap_get_bounds(image->bitmap);
      graphics_context_set_compositing_mode(ctx, GCompOpSet);
      int16_t icon_x = (bounds.size.w - icon_bounds.size.w) / 2;
      graphics_draw_bitmap_in_rect(ctx, image->bitmap,
                                   GRect(icon_x, icon_y, icon_bounds.size.w, icon_bounds.size.h));
      icon_y += icon_bounds.size.h;
    }

    // For round display scrolling, we need to draw text in a much wider rect
    // so that when we apply scroll offset, the text moves through the visible area
    const int16_t text_rect_width = 2000; // very wide rect for scrolling
    const int16_t text_center_x = bounds.size.w / 2;
    const int16_t visible_width = bounds.size.w;
    const int16_t left_margin = 8; // Small left margin so text doesn't start cut off

    if (item->subtitle) {
      // Two lines of text
      const GFont title_font = fonts_get_system_font(MENU_TITLE_FONT_KEY);
      const GFont subtitle_font = fonts_get_system_font(MENU_SUBTITLE_FONT_KEY);

      // Use cached font heights (measured once during measurement phase, not every frame)
      const int16_t title_height = self->title_height;
      const int16_t subtitle_height = self->subtitle_height;
      const int16_t total_text_height = title_height + subtitle_height + 2;
      const int16_t text_start_y = icon_y + (bounds.size.h - icon_y - total_text_height) / 2;

      // Draw title - either centered (if fits) or scrolling (if too long)
      if (self->title_needs_scroll) {
        // Title is too long - scroll it with left margin
        graphics_draw_text(ctx, item->title,
                          title_font,
                          GRect(bounds.origin.x + left_margin - self->title_scroll_offset, text_start_y, text_rect_width, title_height),
                          GTextOverflowModeFill, GTextAlignmentLeft, NULL);
      } else {
        // Title fits - draw it centered
        graphics_draw_text(ctx, item->title,
                          title_font,
                          GRect(bounds.origin.x, text_start_y, bounds.size.w, title_height),
                          GTextOverflowModeFill, GTextAlignmentCenter, NULL);
      }

      // Draw subtitle - either centered (if fits) or scrolling (if too long)
      if (self->subtitle_needs_scroll) {
        // Subtitle is too long - scroll it with left margin
        graphics_draw_text(ctx, item->subtitle,
                          subtitle_font,
                          GRect(bounds.origin.x + left_margin - self->subtitle_scroll_offset, text_start_y + title_height + 2, text_rect_width, subtitle_height),
                          GTextOverflowModeFill, GTextAlignmentLeft, NULL);
      } else {
        // Subtitle fits - draw it centered
        graphics_draw_text(ctx, item->subtitle,
                          subtitle_font,
                          GRect(bounds.origin.x, text_start_y + title_height + 2, bounds.size.w, subtitle_height),
                          GTextOverflowModeFill, GTextAlignmentCenter, NULL);
      }
    } else {
      // Single line of text
      const GFont title_font = fonts_get_system_font(MENU_TITLE_FONT_KEY);

      // Use cached font height (measured once during measurement phase, not every frame)
      const int16_t text_height = self->title_height;
      const int16_t text_start_y = icon_y + (bounds.size.h - icon_y - text_height) / 2;

      // Draw title - either centered (if fits) or scrolling (if too long)
      if (self->title_needs_scroll) {
        // Title is too long - scroll it with left margin
        graphics_draw_text(ctx, item->title,
                          title_font,
                          GRect(bounds.origin.x + left_margin - self->title_scroll_offset, text_start_y, text_rect_width, text_height),
                          GTextOverflowModeFill, GTextAlignmentLeft, NULL);
      } else {
        // Title fits - draw it centered
        graphics_draw_text(ctx, item->title,
                          title_font,
                          GRect(bounds.origin.x, text_start_y, bounds.size.w, text_height),
                          GTextOverflowModeFill, GTextAlignmentCenter, NULL);
      }
    }
#endif
  } else {
    // Standard drawing - no scrolling
    menu_cell_basic_draw(ctx, cell_layer, item->title, item->subtitle, image ? image->bitmap : NULL);
  }

#else
  // On aplite, always use standard drawing (no scrolling)
  menu_cell_basic_draw(ctx, cell_layer, item->title, item->subtitle, image ? image->bitmap : NULL);
#endif

  if (palette_inverted) {
    prv_invert_image_palette(image);
  }
}

static void prv_menu_select_click_callback(MenuLayer *menu_layer, MenuIndex *cell_index,
                                           void *data) {
#if !defined(PBL_PLATFORM_APLITE)
  SimplyMenu *self = data;
  // Update last input time and clear idle state
  self->last_input_time = time(NULL);
  self->scroll_idle = false;
#endif
  prv_send_menu_select_click(cell_index->section, cell_index->row);
}

static void prv_menu_select_long_click_callback(MenuLayer *menu_layer, MenuIndex *cell_index,
                                                void *data) {
#if !defined(PBL_PLATFORM_APLITE)
  SimplyMenu *self = data;
  // Update last input time and clear idle state
  self->last_input_time = time(NULL);
  self->scroll_idle = false;
#endif
  prv_send_menu_select_long_click(cell_index->section, cell_index->row);
}

static void prv_single_click_handler(ClickRecognizerRef recognizer, void *context) {
  Window *base_window = layer_get_window(context);
  SimplyWindow *window = window_get_user_data(base_window);
#if !defined(PBL_PLATFORM_APLITE)
  SimplyMenu *self = (SimplyMenu *)window;
  // Update last input time and clear idle state
  self->last_input_time = time(NULL);
  self->scroll_idle = false;
#endif
  simply_window_single_click_handler(recognizer, window);
}

static uint16_t prv_get_section_num_rows(SimplyMenu *self, uint16_t section_index) {
  // Mirrors prv_menu_get_num_rows_callback: sections not yet loaded report 1 row
  uint16_t num_items;
  if (prv_row_counts_get(self, section_index, &num_items, NULL)) {
    return num_items;
  }
  SimplyMenuSection *section = prv_get_menu_section(self, section_index);
  return section ? section->num_items : 1;
}

// Returns true and fills target_out when the selection sits at the first (up) or
// last (down) selectable row and there is a different row to wrap to.
static bool prv_get_wrap_target(SimplyMenu *self, bool up, MenuIndex index,
                                MenuIndex *target_out) {
  const uint16_t num_sections = self->menu_layer.num_sections;
  if (up) {
    if (index.row > 0) { return false; }
    for (int32_t s = (int32_t)index.section - 1; s >= 0; --s) {
      if (prv_get_section_num_rows(self, s) > 0) { return false; }
    }
    for (int32_t s = (int32_t)num_sections - 1; s >= 0; --s) {
      const uint16_t num_rows = prv_get_section_num_rows(self, s);
      if (num_rows > 0) {
        *target_out = (MenuIndex) { .section = s, .row = num_rows - 1 };
        return (target_out->section != index.section || target_out->row != index.row);
      }
    }
  } else {
    if (index.row + 1 < prv_get_section_num_rows(self, index.section)) { return false; }
    for (uint16_t s = index.section + 1; s < num_sections; ++s) {
      if (prv_get_section_num_rows(self, s) > 0) { return false; }
    }
    for (uint16_t s = 0; s < num_sections; ++s) {
      if (prv_get_section_num_rows(self, s) > 0) {
        *target_out = (MenuIndex) { .section = s, .row = 0 };
        return (target_out->section != index.section || target_out->row != index.row);
      }
    }
  }
  return false;
}

static void prv_up_down_click_handler(ClickRecognizerRef recognizer, void *context) {
  MenuLayer *menu_layer = context;
  Window *base_window = layer_get_window(menu_layer_get_layer(menu_layer));
  SimplyMenu *self = window_get_user_data(base_window);
  const bool up = (click_recognizer_get_button_id(recognizer) == BUTTON_ID_UP);

#if !defined(PBL_PLATFORM_APLITE)
  // Update last input time and clear idle state
  self->last_input_time = time(NULL);
  self->scroll_idle = false;
#endif

  // Wrap around only on a discrete press, never while the button is held down
  // repeating, so holding a button stops at the edge instead of cycling forever
  MenuIndex target;
  if (self->menu_layer.scroll_wrap && click_number_of_clicks_counted(recognizer) <= 1 &&
      prv_get_wrap_target(self, up, menu_layer_get_selected_index(menu_layer), &target)) {
    menu_layer_set_selected_index(menu_layer, target, MenuRowAlignCenter, false);
    return;
  }

  menu_layer_set_selected_next(menu_layer, up, MenuRowAlignCenter, true);
}

static void prv_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_BACK, prv_single_click_handler);
  menu_layer_click_config(context);
  // Take over up/down so we can wrap the selection at the top and bottom
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 100, prv_up_down_click_handler);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 100, prv_up_down_click_handler);
}

static void prv_menu_window_load(Window *window) {
  SimplyMenu *self = window_get_user_data(window);

  simply_window_load(&self->window);

  Layer *window_layer = window_get_root_layer(window);
  GRect frame = layer_get_frame(window_layer);
  frame.origin = GPointZero;

  MenuLayer *menu_layer = self->menu_layer.menu_layer = menu_layer_create(frame);
  Layer *menu_base_layer = menu_layer_get_layer(menu_layer);
  self->window.layer = menu_base_layer;
  layer_add_child(window_layer, menu_base_layer);

  menu_layer_set_callbacks(menu_layer, self, (MenuLayerCallbacks){
    .get_num_sections = prv_menu_get_num_sections_callback,
    .get_num_rows = prv_menu_get_num_rows_callback,
    .get_header_height = prv_menu_get_header_height_callback,
#if defined(PBL_ROUND)
    .get_cell_height = prv_menu_get_cell_height_callback,
#endif
    .draw_header = prv_menu_draw_header_callback,
    .draw_row = prv_menu_draw_row_callback,
    .select_click = prv_menu_select_click_callback,
    .select_long_click = prv_menu_select_long_click_callback,
#if !defined(PBL_PLATFORM_APLITE)
    .selection_changed = prv_menu_selection_changed_callback,
#endif
  });

  menu_layer_set_click_config_provider_onto_window(menu_layer, prv_click_config_provider, window);
}

#if !defined(PBL_PLATFORM_APLITE)
static void initial_scroll_timer_callback(void *data) {
  SimplyMenu *self = data;
  // Start scroll timer for the initially selected item
  if (self->menu_layer.menu_layer) {
    MenuIndex selected = menu_layer_get_selected_index(self->menu_layer.menu_layer);
    start_scroll_timer(self, selected);
  }
}
#endif

static void prv_menu_window_appear(Window *window) {
  SimplyMenu *self = window_get_user_data(window);
  simply_window_appear(&self->window);

#if !defined(PBL_PLATFORM_APLITE)
  // Initialize last input time when menu appears
  self->last_input_time = time(NULL);
  self->scroll_idle = false;

  // Stop any existing scroll timer first
  stop_scroll_timer(self);

  // Trigger initial scroll after a short delay to ensure menu is loaded
  app_timer_register(100, initial_scroll_timer_callback, self);
#endif
}

static void prv_menu_window_disappear(Window *window) {
  SimplyMenu *self = window_get_user_data(window);

#if !defined(PBL_PLATFORM_APLITE)
  // Stop scrolling when window disappears
  stop_scroll_timer(self);
#endif

  // Cancel any pending reload timer
  if (self->reload_timer) {
    app_timer_cancel(self->reload_timer);
    self->reload_timer = NULL;
  }

  if (simply_window_disappear(&self->window)) {
    simply_res_clear(self->window.simply->res);
    simply_menu_clear(self);
  }
}

static void prv_menu_window_unload(Window *window) {
  SimplyMenu *self = window_get_user_data(window);

#if !defined(PBL_PLATFORM_APLITE)
  // Clean up scroll timer
  stop_scroll_timer(self);
#endif

  // Cancel any pending reload timer
  if (self->reload_timer) {
    app_timer_cancel(self->reload_timer);
    self->reload_timer = NULL;
  }

  menu_layer_destroy(self->menu_layer.menu_layer);
  self->menu_layer.menu_layer = NULL;

  simply_window_unload(&self->window);
}

static void simply_menu_clear_section_items(SimplyMenu *self, int section_index) {
  SimplyMenuItem *item = NULL;
  do {
    item = (SimplyMenuItem *)list1_find(self->menu_layer.items, prv_section_filter,
                                        (void *)(uintptr_t) section_index);
    prv_destroy_item(self, item);
  } while (item);
}

static void simply_menu_clear(SimplyMenu *self) {
  prv_row_counts_reset(self);

  while (self->menu_layer.sections) {
    prv_destroy_section(self, (SimplyMenuSection *)self->menu_layer.sections);
  }

  while (self->menu_layer.items) {
    prv_destroy_item(self, (SimplyMenuItem *)self->menu_layer.items);
  }

  prv_reload_data(self);
}

static void prv_handle_menu_clear_packet(Simply *simply, Packet *data) {
  simply_menu_clear(simply->menu);
}

static void prv_handle_menu_clear_section_packet(Simply *simply, Packet *data) {
  MenuClearSectionPacket *packet = (MenuClearSectionPacket *)data;
  simply_menu_clear_section_items(simply->menu, packet->section);
}

static void prv_handle_menu_props_packet(Simply *simply, Packet *data) {
  MenuPropsPacket *packet = (MenuPropsPacket *)data;
  SimplyMenu *self = simply->menu;

  self->menu_layer.scroll_wrap = packet->scroll_wrap;
  simply_menu_set_num_sections(self, packet->num_sections);

  if (!self->window.window) { return; }

  window_set_background_color(self->window.window, gcolor8_get_or(packet->background_color,
                                                                  GColorWhite));

  SimplyMenuLayer *menu_layer = &self->menu_layer;
  if (!menu_layer->menu_layer) { return; }

  menu_layer->normal_background = packet->background_color;
  menu_layer->normal_foreground = packet->text_color;
  menu_layer->highlight_background = packet->highlight_background_color;
  menu_layer->highlight_foreground = packet->highlight_text_color;

  menu_layer_set_normal_colors(menu_layer->menu_layer,
                               gcolor8_get_or(menu_layer->normal_background, GColorWhite),
                               gcolor8_get_or(menu_layer->normal_foreground, GColorBlack));
  menu_layer_set_highlight_colors(menu_layer->menu_layer,
                                  gcolor8_get_or(menu_layer->highlight_background, GColorBlack),
                                  gcolor8_get_or(menu_layer->highlight_foreground, GColorWhite));
}

static void prv_handle_menu_section_packet(Simply *simply, Packet *data) {
  MenuSectionPacket *packet = (MenuSectionPacket *)data;
  prv_row_counts_record(simply->menu, packet->section, packet->num_items,
                        packet->title_length != 0);
  SimplyMenuSection *section = malloc(sizeof(*section));
  *section = (SimplyMenuSection) {
    .section = packet->section,
    .num_items = packet->num_items,
    .title_foreground = packet->text_color,
    .title_background = packet->background_color,
    .title = packet->title_length ? strdup2(packet->title) : NULL,
  };
  simply_menu_add_section(simply->menu, section);
}

static void prv_handle_menu_item_packet(Simply *simply, Packet *data) {
  MenuItemPacket *packet = (MenuItemPacket *)data;
  SimplyMenuItem *item = malloc(sizeof(*item));
  *item = (SimplyMenuItem) {
    .section = packet->section,
    .item = packet->item,
    .title = packet->title_length ? strdup2(packet->buffer) : NULL,
    .subtitle = packet->subtitle_length ? strdup2(packet->buffer + packet->title_length + 1) : NULL,
    .icon = packet->icon,
  };
  simply_menu_add_item(simply->menu, item);
}

static void prv_handle_menu_get_selection_packet(Simply *simply, Packet *data) {
  prv_send_menu_selection(simply->menu);
}

static void prv_handle_menu_selection_packet(Simply *simply, Packet *data) {
  MenuSelectionPacket *packet = (MenuSelectionPacket *)data;
  MenuIndex menu_index = {
    .section = packet->section,
    .row = packet->item,
  };
  simply_menu_set_selection(simply->menu, menu_index, packet->align, packet->animated);
}

bool simply_menu_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandMenuClear:
      prv_handle_menu_clear_packet(simply, packet);
      return true;
    case CommandMenuClearSection:
      prv_handle_menu_clear_section_packet(simply, packet);
      return true;
    case CommandMenuProps:
      prv_handle_menu_props_packet(simply, packet);
      return true;
    case CommandMenuSection:
      prv_handle_menu_section_packet(simply, packet);
      return true;
    case CommandMenuItem:
      prv_handle_menu_item_packet(simply, packet);
      return true;
    case CommandMenuSelection:
      prv_handle_menu_selection_packet(simply, packet);
      return true;
    case CommandMenuGetSelection:
      prv_handle_menu_get_selection_packet(simply, packet);
      return true;
  }
  return false;
}

SimplyMenu *simply_menu_create(Simply *simply) {
  SimplyMenu *self = malloc(sizeof(*self));
  *self = (SimplyMenu) {
    .window.simply = simply,
#if defined(PBL_ROUND)
    .window.status_bar_insets_bottom = true,
#endif
    .menu_layer.num_sections = 1,
    .menu_layer.scroll_wrap = true,
    .reload_timer = NULL,
#if !defined(PBL_PLATFORM_APLITE)
    .scroll_timer = NULL,
    .scroll_offset = 0,
    .max_scroll_offset = 0,
    .scrolling_active = false,
    .needs_scrolling = false,
    .scroll_index = { .section = 0, .row = 0 },
    .last_input_time = 0,
    .scroll_idle = false,
#if defined(PBL_ROUND)
    .title_scroll_offset = 0,
    .title_max_scroll_offset = 0,
    .title_needs_scroll = false,
    .title_scrolling_active = false,
    .subtitle_scroll_offset = 0,
    .subtitle_max_scroll_offset = 0,
    .subtitle_needs_scroll = false,
    .subtitle_scrolling_active = false,
    .title_height = 0,
    .subtitle_height = 0,
#endif
#endif
  };

  static const WindowHandlers s_window_handlers = {
    .load = prv_menu_window_load,
    .appear = prv_menu_window_appear,
    .disappear = prv_menu_window_disappear,
    .unload = prv_menu_window_unload,
  };
  self->window.window_handlers = &s_window_handlers;

  simply_window_init(&self->window, simply);
  simply_window_set_background_color(&self->window, GColor8White);

  return self;
}

void simply_menu_destroy(SimplyMenu *self) {
  if (!self) {
    return;
  }

  simply_window_deinit(&self->window);

  free(self->menu_layer.row_counts);
  free(self);
}