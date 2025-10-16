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

// Scrolling configuration
#define SCROLL_WAIT_MS 1000  // Wait 1 second before starting to scroll
#define SCROLL_STEP_MS 100   // Scroll every 100ms
#define SCROLL_STEP_PX 4     // Scroll 4 pixels at a time

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


static GColor8 s_normal_palette[] = { { GColorBlackARGB8 }, { GColorClearARGB8 } };
static GColor8 s_inverted_palette[] = { { GColorWhiteARGB8 }, { GColorClearARGB8 } };


static void simply_menu_clear_section_items(SimplyMenu *self, int section_index);
static void simply_menu_clear(SimplyMenu *self);

static void simply_menu_set_num_sections(SimplyMenu *self, uint16_t num_sections);
static void simply_menu_add_section(SimplyMenu *self, SimplyMenuSection *section);
static void simply_menu_add_item(SimplyMenu *self, SimplyMenuItem *item);

static MenuIndex simply_menu_get_selection(SimplyMenu *self);
static void simply_menu_set_selection(SimplyMenu *self, MenuIndex menu_index, MenuRowAlign align, bool animated);

static void refresh_spinner_timer(SimplyMenu *self);

// Forward declarations for scroll timer callbacks
static void scroll_timer_callback(void *data);
static void reset_scroll_callback(void *data);


static int64_t prv_get_milliseconds(void) {
  time_t now_s;
  uint16_t now_ms_part;
  time_ms(&now_s, &now_ms_part);
  return ((int64_t) now_s) * 1000 + now_ms_part;
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

static void simply_menu_set_num_sections(SimplyMenu *self, uint16_t num_sections) {
  if (num_sections == 0) {
    num_sections = 1;
  }
  self->menu_layer.num_sections = num_sections;
  prv_reload_data(self);
}

static void simply_menu_add_section(SimplyMenu *self, SimplyMenuSection *section) {
  if (section->title == NULL) {
    section->title = EMPTY_TITLE;
  }
  prv_add_section(self, section);
  prv_reload_data(self);
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

  // Restart scrolling after the initial delay
  self->scroll_timer = app_timer_register(SCROLL_WAIT_MS, scroll_timer_callback, self);
}

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

  // Mark dirty to redraw without scroll
  prv_mark_dirty(self);

  // Start timer to begin scrolling after delay
  // The draw callback will determine if scrolling is actually needed
  self->scroll_timer = app_timer_register(SCROLL_WAIT_MS, scroll_timer_callback, self);
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
}

static uint16_t prv_menu_get_num_sections_callback(MenuLayer *menu_layer, void *data) {
  SimplyMenu *self = data;
  return self->menu_layer.num_sections;
}

static uint16_t prv_menu_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index,
                                               void *data) {
  SimplyMenu *self = data;
  SimplyMenuSection *section = prv_get_menu_section(self, section_index);
  return section ? section->num_items : 1;
}

static int16_t prv_menu_get_header_height_callback(MenuLayer *menu_layer, uint16_t section_index,
                                                   void *data) {
  SimplyMenu *self = data;
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

static void prv_menu_selection_changed_callback(MenuLayer *menu_layer, MenuIndex new_index,
                                                 MenuIndex old_index, void *data) {
  SimplyMenu *self = data;
  // Start scroll timer for the new selection
  start_scroll_timer(self, new_index);
  // Only send selection event if the window is still loaded and visible
  // This prevents crashes when the menu is being torn down
  if (self->window.window && window_is_loaded(self->window.window)) {
    prv_send_menu_selection(self);
  }
}

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

  const int64_t now_ms = prv_get_milliseconds();
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

  SimplyImage *image = simply_res_get_image(self->window.simply->res, item->icon);
  GColor8 *palette = NULL;

  if (image && image->is_palette_black_and_white) {
    palette = gbitmap_get_palette(image->bitmap);
    const bool is_highlighted = menu_cell_layer_is_highlighted(cell_layer);
    gbitmap_set_palette(image->bitmap, is_highlighted ? s_inverted_palette : s_normal_palette,
                        false);
  }

  graphics_context_set_alpha_blended(ctx, true);

  // Check if this is the selected item
  MenuIndex current_selection = menu_layer_get_selected_index(self->menu_layer.menu_layer);
  const bool is_selected = (cell_index->section == current_selection.section &&
                           cell_index->row == current_selection.row);

  // If this is selected but scroll timer hasn't been started yet, start it
  if (is_selected && !self->scroll_timer && !self->scrolling_active) {
    start_scroll_timer(self, current_selection);
  }

  // Measure text width to determine if scrolling is needed
  if (is_selected) {
    GRect bounds = layer_get_bounds(cell_layer);
    int16_t available_width = bounds.size.w;

    // Account for icon width if present
    if (image && image->bitmap) {
      GRect icon_rect = gbitmap_get_bounds(image->bitmap);
      available_width -= (icon_rect.size.w + 8); // icon width + margins
    }
    available_width -= 10; // text margins

    // Measure title text
    const GFont title_font = item->subtitle ?
        fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD) :
        fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
    GSize title_size = graphics_text_layout_get_content_size(
        item->title, title_font,
        GRect(0, 0, 1000, 100),
        GTextOverflowModeTrailingEllipsis,
        GTextAlignmentLeft);

    // Check if title needs scrolling
    bool title_needs_scroll = title_size.w > available_width;

    // Measure subtitle if present
    bool subtitle_needs_scroll = false;
    int16_t subtitle_width = 0;
    if (item->subtitle) {
      const GFont subtitle_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
      GSize subtitle_size = graphics_text_layout_get_content_size(
          item->subtitle, subtitle_font,
          GRect(0, 0, 1000, 100),
          GTextOverflowModeTrailingEllipsis,
          GTextAlignmentLeft);
      subtitle_width = subtitle_size.w;
      subtitle_needs_scroll = subtitle_size.w > available_width;
    }

    // Set needs_scrolling flag and calculate max offset
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
  }

  // Use custom drawing only when actively scrolling
  if (is_selected && self->scroll_offset > 0 && self->needs_scrolling) {
    // Manual drawing with scroll offset
    GRect bounds = layer_get_bounds(cell_layer);
    const bool is_highlighted = menu_cell_layer_is_highlighted(cell_layer);

    // Background - highlighted items have WHITE background
    graphics_context_set_fill_color(ctx, is_highlighted ? GColorWhite : GColorBlack);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    // Icon - apply scroll offset to icon as well
    int16_t text_x = 4;
    if (image && image->bitmap) {
      GRect icon_bounds = gbitmap_get_bounds(image->bitmap);
      graphics_context_set_compositing_mode(ctx, GCompOpSet);
      // Scroll the icon along with the text
      graphics_draw_bitmap_in_rect(ctx, image->bitmap,
                                   GRect(4 - self->scroll_offset, (bounds.size.h - icon_bounds.size.h) / 2,
                                        icon_bounds.size.w, icon_bounds.size.h));
      text_x = 4 + icon_bounds.size.w + 4;
    }

    graphics_context_set_text_color(ctx, is_highlighted ? GColorBlack : GColorWhite);

    // Text with scroll offset
    const int16_t scroll_x = text_x - self->scroll_offset;
    const int16_t text_w = bounds.size.w - text_x + self->scroll_offset;

    if (item->subtitle) {
      // Two lines - move UP 4 more pixels
      graphics_draw_text(ctx, item->title,
                        fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                        GRect(scroll_x, -4, text_w, 24),
                        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
      graphics_draw_text(ctx, item->subtitle,
                        fonts_get_system_font(FONT_KEY_GOTHIC_18),
                        GRect(scroll_x, 20, text_w, 18),
                        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    } else {
      // Single line - move DOWN, use vertical alignment
      graphics_draw_text(ctx, item->title,
                        fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                        GRect(scroll_x, 4, text_w, bounds.size.h),
                        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    }
  } else {
    // Standard drawing - no scrolling
    menu_cell_basic_draw(ctx, cell_layer, item->title, item->subtitle, image ? image->bitmap : NULL);
  }

  if (palette) {
    gbitmap_set_palette(image->bitmap, palette, false);
  }
}

static void prv_menu_select_click_callback(MenuLayer *menu_layer, MenuIndex *cell_index,
                                           void *data) {
  prv_send_menu_select_click(cell_index->section, cell_index->row);
}

static void prv_menu_select_long_click_callback(MenuLayer *menu_layer, MenuIndex *cell_index,
                                                void *data) {
  prv_send_menu_select_long_click(cell_index->section, cell_index->row);
}

static void prv_single_click_handler(ClickRecognizerRef recognizer, void *context) {
  Window *base_window = layer_get_window(context);
  SimplyWindow *window = window_get_user_data(base_window);
  simply_window_single_click_handler(recognizer, window);
}

static void prv_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_BACK, prv_single_click_handler);
  menu_layer_click_config(context);
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
    .selection_changed = prv_menu_selection_changed_callback,
  });

  menu_layer_set_click_config_provider_onto_window(menu_layer, prv_click_config_provider, window);
}

static void initial_scroll_timer_callback(void *data) {
  SimplyMenu *self = data;
  // Start scroll timer for the initially selected item
  if (self->menu_layer.menu_layer) {
    MenuIndex selected = menu_layer_get_selected_index(self->menu_layer.menu_layer);
    start_scroll_timer(self, selected);
  }
}

static void prv_menu_window_appear(Window *window) {
  SimplyMenu *self = window_get_user_data(window);
  simply_window_appear(&self->window);

  // Stop any existing scroll timer first
  stop_scroll_timer(self);

  // Trigger initial scroll after a short delay to ensure menu is loaded
  app_timer_register(100, initial_scroll_timer_callback, self);
}

static void prv_menu_window_disappear(Window *window) {
  SimplyMenu *self = window_get_user_data(window);

  // Stop scrolling when window disappears
  stop_scroll_timer(self);

  if (simply_window_disappear(&self->window)) {
    simply_res_clear(self->window.simply->res);
    simply_menu_clear(self);
  }
}

static void prv_menu_window_unload(Window *window) {
  SimplyMenu *self = window_get_user_data(window);

  // Clean up scroll timer
  stop_scroll_timer(self);

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
    .scroll_timer = NULL,
    .scroll_offset = 0,
    .max_scroll_offset = 0,
    .scrolling_active = false,
    .needs_scrolling = false,
    .scroll_index = { .section = 0, .row = 0 },
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

  free(self);
}
