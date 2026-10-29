#include "simply_menu.h"

#include "simply_scrollbar.h"
#include "simply_touch.h"

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

//! Spinner frames before rows still waiting on the phone are asked for again
#define REQUEST_RETRY_TICKS (3000 / SPINNER_MS)

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

// ---- Text size ---------------------------------------------------------------
//
// The wearer's Text Size setting works the way PebbleOS's own does under
// Settings > Display: Default is the content size the firmware picks for the
// display, and Smaller and Larger are one step either side of it. A 144px
// watch therefore goes Small, Medium, Large, and a watch 200px or taller goes
// Medium, Large, Extra Large. The fonts and row heights of each step are the
// firmware's own, from shell/system_theme.c and applib/ui/menu_layer_system_cells.c
// for the ordinary rows and apps/system/launcher/default/menu_layer.c for the
// launcher style ones.
//
// The firmware only lets its own apps follow that setting: menu_cell_basic_draw
// always draws an app's rows at the platform default. So at Default the rows
// are left to it exactly as before, and at any other size every row is drawn
// here, with the same layout the firmware would give it at that size.
//
// Aplite has none of it. Its app memory is too tight to spare for a second way
// of drawing rows, so its menus stay at the one size the firmware draws.

//! How the phone asks for the rows to be sized, as it arrives in the props packet
typedef enum MenuTextSize {
  MenuTextSizeDefault = 0,
  MenuTextSizeSmaller = 1,
  MenuTextSizeLarger = 2,
} MenuTextSize;

//! PebbleOS's PreferredContentSize, in the same order so a step is one apart
typedef enum MenuContentSize {
  MenuContentSizeSmall,
  MenuContentSizeMedium,
  MenuContentSizeLarge,
  MenuContentSizeExtraLarge,
  MenuContentSizeCount,
} MenuContentSize;

#if defined(MENU_CONTENT_SIZE_LARGE)
#define MENU_DEFAULT_CONTENT_SIZE MenuContentSizeLarge
#else
#define MENU_DEFAULT_CONTENT_SIZE MenuContentSizeMedium
#endif

// A section title on a round display has to live with a line width that
// changes as the band moves up and down the circle, and it sits among cells
// drawn at a much larger scale than the rectangular ones, where the system's
// 16px band looks like a slot rather than a heading. Round gets a band tall
// enough for the title, centred in it; rectangular keeps the system's own
// header exactly as it was.
#if defined(PBL_ROUND) && !defined(PBL_PLATFORM_CHALK)
// A round display taller than 200px draws its rows the way PebbleOS draws the
// app launcher's, and these are the launcher's own numbers, taken from
// apps/system/launcher/default: menu_layer_private.h for the cell heights,
// menu_layer.h for the fonts, app_glance_structured.h and .c for the icon box
// and the margin either side of it. The icon sits left in a box of that fixed
// width whatever size the icon itself is, so every title in a list starts at
// the same place, and the title and subtitle are centred as a pair beside it.
// Chalk is left alone: the launcher there is drawn to a different set of
// numbers again, and its menus keep the centred layout they have always had.
#define MENU_ROUND_LAUNCHER_STYLE 1
#define MENU_ROUND_ICON_BOX 25
#define MENU_ROUND_ICON_MARGIN 9
//! The margin a row keeps from the glass once it has followed the curve in
#define MENU_ROUND_BASE_INSET 10
#endif

#if defined(PBL_ROUND)

//! menu_cell_basic_draw insets a round row before it lays anything out in it,
//! 16px either side of the focused row and 34 either side of the rest
//! (MENU_CELL_ROUND_FOCUSED_HORIZONTAL_INSET and its unfocused twin in
//! PebbleOS's applib/ui/menu_cell_layer.h, which the app SDK does not export).
//! A title has to fit the room that leaves, not the whole width of the cell,
//! so a title the firmware would have to cut short is one that marquees.
#define MENU_ROUND_CELL_FOCUSED_INSET 16
#define MENU_ROUND_CELL_UNFOCUSED_INSET 34

//! How far in from the glass the marquee starts a round row's text, the same
//! 8px the firmware's own text flow uses (TEXT_FLOW_DEFAULT_INSET)
#define MENU_ROUND_TEXT_EDGE_INSET 8

//! A focused round row is held at the middle of the screen, so its text sits
//! where the circle is at its widest and is only clipped within a few pixels
//! of the glass. That is the width a line has to beat before it has any reason
//! to move, and it is a good deal wider than the width the firmware's own
//! inset leaves: a line between the two is one menu_cell_basic_draw would cut
//! short and this row can still show whole, standing still, by drawing itself.
#define MENU_ROUND_TEXT_CLIP_INSET 4

//! Height of one line of the header font
#define MENU_HEADER_LINE_HEIGHT 18
//! Padding above and below the title within its band
#define MENU_HEADER_PADDING 6
//! The title stays on one line. A second line does not help on a circle: the
//! band sits above the centred selection, so making it taller only pushes its
//! top line further into the narrow part of the glass, and a title that fitted
//! on one line starts breaking mid word on two.
#define MENU_HEADER_HEIGHT (MENU_HEADER_LINE_HEIGHT + 2 * MENU_HEADER_PADDING)
//! A heading is one short centred line rather than a paragraph, so it is given
//! a smaller margin from the edge of the glass than body text gets
#define MENU_HEADER_TEXT_INSET 4
#endif

#if !defined(PBL_PLATFORM_APLITE)
//! The fonts and row geometry of one content size. Every row of a menu, and
//! everything that has to agree with where the rows are (the cell height
//! callback, the touch hit test, the scroll range), asks the menu's current
//! style rather than a constant, so none of them can disagree about it.
typedef struct MenuTextStyle {
  const char *title_font_key;
  const char *subtitle_font_key;
#if defined(MENU_ROUND_LAUNCHER_STYLE)
  int16_t focused_cell_height;
  int16_t unfocused_cell_height;
#elif !defined(PBL_ROUND)
  int16_t cell_height;
  //! Margin either side of the row's contents
  int16_t horizontal_inset;
  //! Where the text starts beside an icon, measured from the inset
  int16_t title_subtitle_left_margin;
#endif
} MenuTextStyle;

#if defined(MENU_ROUND_LAUNCHER_STYLE)
// The launcher's LauncherMenuLayerStyle. Small is never reached from a large
// display's default, and is the firmware's copy of Medium anyway.
static const MenuTextStyle s_text_styles[MenuContentSizeCount] = {
  [MenuContentSizeSmall] = { FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_14, 52, 38 },
  [MenuContentSizeMedium] = { FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_14, 52, 38 },
  [MenuContentSizeLarge] = { FONT_KEY_GOTHIC_24_BOLD, FONT_KEY_GOTHIC_18, 55, 45 },
  [MenuContentSizeExtraLarge] = { FONT_KEY_GOTHIC_28_BOLD, FONT_KEY_GOTHIC_24, 66, 56 },
};
#elif defined(PBL_ROUND)
// The system theme's menu cell fonts. A round menu keeps the same row heights
// at every size, as the firmware's own round menus do, and only its fonts
// change; Extra Large is never reached from chalk's Medium default.
static const MenuTextStyle s_text_styles[MenuContentSizeCount] = {
  [MenuContentSizeSmall] = { FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_18 },
  [MenuContentSizeMedium] = { FONT_KEY_GOTHIC_24_BOLD, FONT_KEY_GOTHIC_18 },
  [MenuContentSizeLarge] = { FONT_KEY_GOTHIC_24_BOLD, FONT_KEY_GOTHIC_24 },
  [MenuContentSizeExtraLarge] = { FONT_KEY_GOTHIC_28_BOLD, FONT_KEY_GOTHIC_28 },
};
#else
// The system theme's menu cell fonts and menu_layer_system_cells.c's
// MenuCellDimensions. Small keeps Medium's geometry, as it does in the firmware.
static const MenuTextStyle s_text_styles[MenuContentSizeCount] = {
  [MenuContentSizeSmall] = { FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_18, 44, 5, 30 },
  [MenuContentSizeMedium] = { FONT_KEY_GOTHIC_24_BOLD, FONT_KEY_GOTHIC_18, 44, 5, 30 },
  [MenuContentSizeLarge] = { FONT_KEY_GOTHIC_24_BOLD, FONT_KEY_GOTHIC_24, 61, 10, 34 },
  [MenuContentSizeExtraLarge] = { FONT_KEY_GOTHIC_28_BOLD, FONT_KEY_GOTHIC_28, 85, 10, 34 },
};
#endif
#endif

#if defined(PBL_ROUND) && !defined(MENU_ROUND_LAUNCHER_STYLE)
//! A round menu's row heights, the same at every text size
#define MENU_ROUND_FOCUSED_HEIGHT MENU_CELL_ROUND_FOCUSED_TALL_CELL_HEIGHT
#define MENU_ROUND_UNFOCUSED_HEIGHT MENU_CELL_ROUND_UNFOCUSED_SHORT_CELL_HEIGHT
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
  //! MenuTextSize
  uint8_t text_size;
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

// Icons that say what an entity is doing through which part of them is filled
// in, rather than through their shape. A lit bulb is a bulb with white glass
// and an unlit one is a bulb with black glass, so inverting either produces the
// other's artwork, and the same lit bulb changed appearance as the selection
// passed over its row. These are drawn exactly as they were authored on every
// row, so a lit bulb is white inside with a black outline wherever it sits, and
// the same goes for a switch and a cover.
static bool prv_icon_keeps_its_colors(uint32_t icon) {
  switch (icon) {
    case RESOURCE_ID_IMAGE_ICON_BULB:
    case RESOURCE_ID_IMAGE_ICON_BULB_ON:
    case RESOURCE_ID_IMAGE_ICON_SWITCH_ON:
    case RESOURCE_ID_IMAGE_ICON_SWITCH_OFF:
    case RESOURCE_ID_IMAGE_ICON_BLIND_OPEN:
    case RESOURCE_ID_IMAGE_ICON_BLIND_CLOSED:
      return true;
    default:
      return false;
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
  if (!section) { return; }
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
  if (!item) { return; }
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

static void prv_retry_requests(SimplyMenu *self) {
  for (SimplyMenuCommon *node = (SimplyMenuCommon *)self->menu_layer.sections; node;
       node = (SimplyMenuCommon *)node->node.next) {
    if (!node->title) {
      prv_send_menu_get_section(node->section);
    }
  }
  for (SimplyMenuItem *item = (SimplyMenuItem *)self->menu_layer.items; item;
       item = (SimplyMenuItem *)item->node.next) {
    if (!item->title) {
      prv_send_menu_get_item(item->section, item->item);
    }
  }
}

static void spinner_timer_callback(void *data) {
  SimplyMenu *self = data;
  self->spinner_timer = NULL;
  // A request lost on the way to or from the phone is never answered, so
  // ask again every so often while the spinner is showing
  if (++self->spinner_ticks >= REQUEST_RETRY_TICKS) {
    self->spinner_ticks = 0;
    prv_retry_requests(self);
  }
  // Drawing the spinner row arms the next frame, so the timer stops by itself
  // once no spinner is on screen
  prv_mark_dirty(self);
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

//! The height of a title's band, or 0 for a section that has no title. The
//! layer callback, the drawing and the touch hit test all ask this, so they
//! cannot disagree about where a section starts.
static int16_t prv_header_height(SimplyMenu *self, uint16_t section_index) {
  bool has_header;
  if (!prv_row_counts_get(self, section_index, NULL, &has_header)) {
    SimplyMenuSection *cached = prv_get_menu_section(self, section_index);
    has_header = (cached && cached->title && cached->title != EMPTY_TITLE);
  }
  if (!has_header) { return 0; }

  return PBL_IF_ROUND_ELSE(MENU_HEADER_HEIGHT, MENU_CELL_BASIC_HEADER_HEIGHT);
}

static int16_t prv_menu_get_header_height_callback(MenuLayer *menu_layer, uint16_t section_index,
                                                   void *data) {
  return prv_header_height(data, section_index);
}

#if !defined(PBL_PLATFORM_APLITE)
//! The style of the menu's current text size
static const MenuTextStyle *prv_style(SimplyMenu *self) {
  return &s_text_styles[self->menu_layer.content_size];
}

//! A font's line height, which is also the height the firmware's text layout
//! gives one line of it (fonts_get_font_height)
static int16_t prv_font_line_height(GFont font) {
  return graphics_text_layout_get_content_size("A", font, GRect(0, 0, 100, 100),
                                               GTextOverflowModeFill, GTextAlignmentLeft).h;
}

#if defined(PBL_ROUND) && !defined(MENU_ROUND_LAUNCHER_STYLE)
//! The distance menu_cell_basic_draw pulls a line of text up by, which is how
//! PebbleOS's fonts_get_font_cap_offset works it out for every font
static int16_t prv_cap_offset(int16_t font_height) {
  return font_height * 22 / 100;
}
#endif

//! Switch the rows to a Text Size. Nothing is drawn at the new size until the
//! layer has been told the rows have changed height, and a marquee measured in
//! the old fonts starts again in the new ones.
static void prv_set_text_size(SimplyMenu *self, uint8_t text_size) {
  int content_size = MENU_DEFAULT_CONTENT_SIZE;
  if (text_size == MenuTextSizeSmaller) {
    content_size -= 1;
  } else if (text_size == MenuTextSizeLarger) {
    content_size += 1;
  } else {
    text_size = MenuTextSizeDefault;
  }
  if (content_size < 0) { content_size = 0; }
  if (content_size >= MenuContentSizeCount) { content_size = MenuContentSizeCount - 1; }

  SimplyMenuLayer *menu_layer = &self->menu_layer;
  const bool changed = (menu_layer->text_size != text_size) || !menu_layer->title_height;
  menu_layer->text_size = text_size;
  menu_layer->content_size = content_size;
  if (!changed) { return; }

  const MenuTextStyle *style = prv_style(self);
  menu_layer->title_height = prv_font_line_height(fonts_get_system_font(style->title_font_key));
  menu_layer->subtitle_height =
      prv_font_line_height(fonts_get_system_font(style->subtitle_font_key));

  if (!menu_layer->menu_layer) { return; }
  const MenuIndex selected = menu_layer_get_selected_index(menu_layer->menu_layer);
  prv_reload_data(self);
  // The rows above the selection have changed height, so the list is scrolled
  // back to where it holds the selection rather than left where the old rows
  // put it
  menu_layer_set_selected_index(menu_layer->menu_layer, selected, MenuRowAlignCenter, false);
#if !defined(PBL_PLATFORM_APLITE)
#ifdef SIMPLY_HAS_TOUCH
  // The marquee goes back to the selection, which the list now holds in view
  self->scroll_index_pinned = false;
#endif
  start_scroll_timer(self, selected);
#endif
}

//! The height of a row. The layer callback, the touch hit test and the round
//! scroll range all ask this, so they cannot disagree about where a row is.
static int16_t prv_cell_height(SimplyMenu *self, bool is_selected) {
#if defined(MENU_ROUND_LAUNCHER_STYLE)
  return is_selected ? prv_style(self)->focused_cell_height :
                       prv_style(self)->unfocused_cell_height;
#elif defined(PBL_ROUND)
  (void) self;
  return is_selected ? MENU_ROUND_FOCUSED_HEIGHT : MENU_ROUND_UNFOCUSED_HEIGHT;
#else
  (void) is_selected;
  return prv_style(self)->cell_height;
#endif
}

static int16_t prv_menu_get_cell_height_callback(MenuLayer *menu_layer, MenuIndex *cell_index,
                                                 void *context) {
  return prv_cell_height(context, menu_layer_is_index_selected(menu_layer, cell_index));
}
#endif

#if !defined(PBL_PLATFORM_APLITE)
static void prv_menu_selection_changed_callback(MenuLayer *menu_layer, MenuIndex new_index,
                                                 MenuIndex old_index, void *data) {
  SimplyMenu *self = data;
  // Update last input time and clear idle state
  self->last_input_time = time(NULL);
  self->scroll_idle = false;
  // Start scroll timer for the new selection, which takes the marquee back
  // from any row a finger had left in the middle of the screen
#ifdef SIMPLY_HAS_TOUCH
  self->scroll_index_pinned = false;
#endif
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
  // Still waiting on the phone for it
  if (!section->title) {
    return;
  }

  list1_remove(&self->menu_layer.sections, &section->node);
  list1_prepend(&self->menu_layer.sections, &section->node);

  GRect bounds = layer_get_bounds(cell_layer);

  graphics_context_set_fill_color(ctx, gcolor8_get_or(section->title_background, GColorWhite));
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  graphics_context_set_text_color(ctx, gcolor8_get_or(section->title_foreground, GColorBlack));

  const GFont title_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);

#if defined(PBL_ROUND)
  // Screen text flow insets each line to the width of the glass at the height
  // the band has scrolled to, so a title is never cut off against the bezel.
  // Paging is what used to be asked for here, and it is the wrong tool: it
  // moves text down to avoid straddling a page boundary, which in a band this
  // short pushed every title clean out of its own header and left nothing but
  // a coloured bar, or on a menu whose header takes the menu's own colours,
  // an apparent gap.
  GTextAttributes *title_attributes = graphics_text_attributes_create();
  graphics_text_attributes_enable_screen_text_flow(title_attributes, MENU_HEADER_TEXT_INSET);

  GRect title_box = bounds;
  title_box.origin.y += (bounds.size.h - MENU_HEADER_LINE_HEIGHT) / 2;
  title_box.size.h = MENU_HEADER_LINE_HEIGHT;

  graphics_draw_text(ctx, section->title, title_font, title_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, title_attributes);
  graphics_text_attributes_destroy(title_attributes);
#else
  bounds.origin.x += 2;
  bounds.origin.y -= 1;
  graphics_draw_text(ctx, section->title, title_font, bounds,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
#endif
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

#if defined(MENU_ROUND_LAUNCHER_STYLE)
static int32_t prv_isqrt(int32_t value) {
  if (value <= 0) { return 0; }
  int32_t rem = 0, root = 0;
  for (int i = 0; i < 16; ++i) {
    root <<= 1;
    rem = (rem << 2) | ((value >> 30) & 3);
    value <<= 2;
    if (root < rem) {
      rem -= ++root;
      ++root;
    }
  }
  return root >> 1;
}

//! How far in from the edge of the row its contents sit.
//!
//! PebbleOS insets each launcher row by the distance from the edge of the
//! display to the edge of the circle at that row's own height, plus a fixed
//! margin, which is what makes the column of icons and titles curve inwards
//! towards the top and bottom of the list rather than run straight off the
//! glass. See prv_draw_processed in the launcher's app_glance_structured.c;
//! this is the same sum, x = R - sqrt(R^2 - (y - R)^2).
static int16_t prv_round_row_inset(SimplyMenu *self, const Layer *cell_layer) {
  Layer *root = window_get_root_layer(self->window.window);
  const int16_t radius = layer_get_bounds(root).size.h / 2;
  if (radius <= 0) { return MENU_ROUND_BASE_INSET; }

  const GRect on_screen =
      layer_convert_rect_to_screen((Layer *)cell_layer, layer_get_bounds((Layer *)cell_layer));
  const int32_t from_middle = (on_screen.origin.y + on_screen.size.h / 2) - radius;

  int32_t under_root = (int32_t) radius * radius - from_middle * from_middle;
  if (under_root < 0) { under_root = 0; }   // a row dragged clean off the circle
  return MENU_ROUND_BASE_INSET + (int16_t) (radius - prv_isqrt(under_root));
}
#endif

#if !defined(PBL_PLATFORM_APLITE)
//! Paint a custom-drawn row's background and pick its text colour, the same
//! colours the MenuLayer would have used for a row it drew itself
static void prv_prepare_row(SimplyMenu *self, GContext *ctx, const Layer *cell_layer) {
  const bool is_highlighted = menu_cell_layer_is_highlighted(cell_layer);
  const SimplyMenuLayer *menu_layer = &self->menu_layer;
  const GColor8 bg_color = is_highlighted ? menu_layer->highlight_background :
                                            menu_layer->normal_background;
  graphics_context_set_fill_color(
      ctx, gcolor8_get_or(bg_color, is_highlighted ? GColorBlack : GColorWhite));
  graphics_fill_rect(ctx, layer_get_bounds(cell_layer), 0, GCornerNone);

  const GColor8 text_color = is_highlighted ? menu_layer->highlight_foreground :
                                              menu_layer->normal_foreground;
  graphics_context_set_text_color(
      ctx, gcolor8_get_or(text_color, is_highlighted ? GColorWhite : GColorBlack));
}

#if !defined(PBL_ROUND)
//! Where a rectangular row's text starts: beside the icon's column when there
//! is an icon, at the row's inset when there is not
static int16_t prv_rect_text_x(SimplyMenu *self, GBitmap *icon) {
  const MenuTextStyle *style = prv_style(self);
  return icon ? (style->horizontal_inset + style->title_subtitle_left_margin) :
                style->horizontal_inset;
}

//! Draw a rectangular row the way menu_cell_basic_draw lays one out
//! (prv_menu_cell_basic_draw_custom_rect in PebbleOS), in the menu's current
//! fonts. A marquee slides the icon and the text left together by
//! `scroll_offset`, and the text box grows by as much so the line is only cut
//! off at the edge of the screen.
static void prv_draw_rect_row(SimplyMenu *self, GContext *ctx, const Layer *cell_layer,
                              const SimplyMenuItem *item, GBitmap *icon, int16_t scroll_offset) {
  const MenuTextStyle *style = prv_style(self);
  const GRect bounds = layer_get_bounds(cell_layer);
  const int16_t title_height = self->menu_layer.title_height;
  const int16_t subtitle_height = item->subtitle ? self->menu_layer.subtitle_height : 0;
  // The title, the subtitle under it and 10px of padding make a block centred
  // down the row. The block can be taller than the row, which only moves the
  // text up; nothing clips it.
  const int16_t vertical_margin = (bounds.size.h - (title_height + subtitle_height + 10)) / 2;
  const int16_t inset = style->horizontal_inset;

  if (icon) {
    // The icon is centred down the text block and pinned to the inset
    const GRect container = GRect(inset, vertical_margin, bounds.size.w - 2 * inset,
                                  bounds.size.h - 2 * vertical_margin);
    GSize icon_size = gbitmap_get_bounds(icon).size;
    if (icon_size.w > container.size.w) { icon_size.w = container.size.w; }
    if (icon_size.h > container.size.h) { icon_size.h = container.size.h; }
    graphics_context_set_compositing_mode(ctx, GCompOpSet);
    graphics_draw_bitmap_in_rect(
        ctx, icon, GRect(container.origin.x - scroll_offset,
                         container.origin.y + (container.size.h - icon_size.h) / 2,
                         icon_size.w, icon_size.h));
  }

  const int16_t text_x = prv_rect_text_x(self, icon) - scroll_offset;
  const int16_t text_w = bounds.size.w - text_x;
  graphics_draw_text(ctx, item->title,
                     fonts_get_system_font(style->title_font_key),
                     GRect(text_x, vertical_margin, text_w, title_height + 4),
                     GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  if (item->subtitle) {
    graphics_draw_text(ctx, item->subtitle,
                       fonts_get_system_font(style->subtitle_font_key),
                       GRect(text_x, vertical_margin + title_height, text_w, subtitle_height + 4),
                       GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  }
}
#endif
#endif

#if defined(PBL_ROUND) && !defined(MENU_ROUND_LAUNCHER_STYLE)
//! Where the parts of a round row go
typedef struct RoundRowLayout {
  //! Top of the icon, and whether there was room for it
  int16_t icon_y;
  bool show_icon;
  //! Whether there was room for the subtitle, which is only ever shown on the
  //! focused row
  bool show_subtitle;
  //! The title's text box, already pulled up by its cap offset
  int16_t title_y;
  int16_t title_h;
  //! Top of the subtitle's text box
  int16_t subtitle_y;
} RoundRowLayout;

//! Lay a round row out the way menu_cell_basic_draw does
//! (prv_menu_cell_basic_draw_custom_one_column_round in PebbleOS): the icon,
//! the title and the subtitle make one block centred in the row, with the icon
//! on top, and whatever does not fit is dropped, the icon first, then the
//! subtitle. A title with nothing else to share the row gets two lines, unless
//! `one_line` says it is going to be drawn on a single line of its own.
static RoundRowLayout prv_round_row_layout(SimplyMenu *self, const GRect *inner,
                                           const SimplyMenuItem *item, GBitmap *icon,
                                           bool is_focused, bool one_line) {
  const int16_t font_height = self->menu_layer.title_height;
  const int16_t row_height = inner->size.h;
  const bool render_subtitle = is_focused && item->subtitle;
  int16_t subtitle_height = render_subtitle ? self->menu_layer.subtitle_height : 0;
  int16_t icon_height = icon ? gbitmap_get_bounds(icon).size.h : 0;

  const bool two_lines = !(render_subtitle || icon) && !one_line;
  int16_t title_height = two_lines ? 2 * font_height : font_height;

  int16_t container = title_height + subtitle_height + icon_height;
  if (container > row_height) {
    container -= icon_height;
    if (container > row_height) {
      container = title_height + icon_height;
      if (container > row_height) {
        container = 2 * font_height;
        title_height = (container > row_height || one_line) ? font_height : container;
        subtitle_height = 0;
        icon_height = 0;
      } else {
        subtitle_height = 0;
      }
    } else {
      icon_height = 0;
    }
  }

  // Only as many lines as the title actually takes up
  if (!one_line) {
    title_height = graphics_text_layout_get_content_size(
        item->title, fonts_get_system_font(prv_style(self)->title_font_key),
        GRect(0, 0, inner->size.w, title_height), GTextOverflowModeFill,
        GTextAlignmentCenter).h;
  }

  container = title_height + subtitle_height + icon_height;
  if (container > row_height) { container = row_height; }
  const int16_t top = inner->origin.y + (row_height - container) / 2;
  const int16_t title_top = top + icon_height;

  return (RoundRowLayout) {
    .icon_y = top,
    .show_icon = (icon_height != 0),
    .show_subtitle = (subtitle_height != 0),
    .title_y = title_top - prv_cap_offset(font_height),
    .title_h = title_height,
    .subtitle_y = title_top + title_height - prv_cap_offset(self->menu_layer.subtitle_height),
  };
}
#endif

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
  GBitmap *icon = (image && image->bitmap) ? image->bitmap : NULL;
  // Icons are drawn light, for the dark rows the app has always had. Invert
  // them on a light row so they stay visible, whether that is the highlight
  // under the selection or every row of a menu the wearer has turned white.
  // This works for any palettized bitmap (the bundled icons decode to
  // multi-entry palettes with transparency and anti-aliasing, not just 2-color
  // black and white).
  bool palette_inverted = false;
  if (image && image->palette_entries && !prv_icon_keeps_its_colors(item->icon)) {
    const GColor8 row_background = menu_cell_layer_is_highlighted(cell_layer) ?
        self->menu_layer.highlight_background :
        self->menu_layer.normal_background;
    if (gcolor8_is_light(row_background)) {
      prv_invert_image_palette(image);
      palette_inverted = true;
    }
  }

  graphics_context_set_alpha_blended(ctx, true);

#if !defined(MENU_ROUND_LAUNCHER_STYLE) && !defined(PBL_PLATFORM_APLITE)
  // At the default size the firmware draws every row that fits as it is. At
  // any other size it would still draw them at the default size, so every row
  // is drawn here instead.
  const bool custom_size = (self->menu_layer.text_size != MenuTextSizeDefault);
#endif

#if !defined(PBL_PLATFORM_APLITE)
  const MenuTextStyle *style = prv_style(self);

  // Check if this is the selected item
  MenuIndex current_selection = menu_layer_get_selected_index(self->menu_layer.menu_layer);
  const bool is_selected = (cell_index->section == current_selection.section &&
                           cell_index->row == current_selection.row);

  // Which row the marquee belongs to. Normally the selected one, but a finger
  // can leave a row sitting in the middle of the screen without selecting it,
  // and on a round watch that is the row being read, so it takes the marquee
  // until the selection moves again.
#ifdef SIMPLY_HAS_TOUCH
  const bool is_marquee_row = self->scroll_index_pinned ?
      (cell_index->section == self->scroll_index.section &&
       cell_index->row == self->scroll_index.row) : is_selected;
  const MenuIndex marquee_index = self->scroll_index_pinned ? self->scroll_index :
                                                              current_selection;
#else
  const bool is_marquee_row = is_selected;
  const MenuIndex marquee_index = current_selection;
#endif

  // If this row wants the marquee but the scroll timer hasn't been started
  // yet, start it. Don't start if we're in idle state (timeout exceeded)
  if (is_marquee_row && !self->scroll_timer && !self->scrolling_active && !self->scroll_idle) {
    start_scroll_timer(self, marquee_index);
  }

  // Measure text width to determine if scrolling is needed
  if (is_marquee_row) {
    GRect bounds = layer_get_bounds(cell_layer);
    int16_t available_width = bounds.size.w;

#if !defined(PBL_ROUND)
    // RECTANGULAR DISPLAY: the text box runs from where the text starts to the
    // edge of the screen, so a line that fits it is shown whole where it stands
    available_width -= prv_rect_text_x(self, icon);
#else
#if defined(MENU_ROUND_LAUNCHER_STYLE)
    // ROUND, LAUNCHER STYLE: the same width the row is actually drawn into, so
    // a title marquees exactly when it does not fit and not otherwise. The
    // inset is the one this row's height on the circle earns it.
    {
      const int16_t row_inset = prv_round_row_inset(self, cell_layer);
      available_width -= 2 * row_inset;
      if (icon) {
        available_width -= MENU_ROUND_ICON_BOX + MENU_ROUND_ICON_MARGIN;
      }
    }
#else
    // ROUND DISPLAY: the selected row is the one that marquees, and
    // menu_cell_basic_draw draws a focused round row inside an inset of
    // MENU_ROUND_CELL_FOCUSED_INSET either side. The icon sits above the text
    // rather than beside it, so it takes no width away.
    available_width -= 2 * MENU_ROUND_CELL_FOCUSED_INSET;
#endif
#endif

    // Measure title text with the same fonts the row is drawn with
    const GFont title_font = fonts_get_system_font(style->title_font_key);
    GSize title_size = graphics_text_layout_get_content_size(
        item->title, title_font,
        GRect(0, 0, 1000, 100),
        GTextOverflowModeTrailingEllipsis,
        GTextAlignmentCenter);

    // Whether the row has outgrown the layout the firmware would give it, and
    // so has to be drawn here instead of by menu_cell_basic_draw. On a round
    // display that is a different question from whether the text fits the
    // screen, and the two are separated below.
    bool title_overflows_cell = title_size.w > available_width;

#if defined(PBL_ROUND) && !defined(MENU_ROUND_LAUNCHER_STYLE)
    //! The width the glass leaves a round row, as against the narrower width
    //! menu_cell_basic_draw's inset leaves it
    const int16_t screen_text_width = bounds.size.w - 2 * MENU_ROUND_TEXT_CLIP_INSET;

    // menu_cell_basic_draw gives a round title two lines to itself when the row
    // has neither an icon nor a subtitle to share the cell with, so a title
    // that wraps into those two lines is laid out fine as it is, and is left to
    // the firmware's layout.
    if (title_overflows_cell && !item->subtitle && !icon) {
      const GSize wrapped = graphics_text_layout_get_content_size(
          item->title, title_font,
          GRect(0, 0, available_width, 1000),
          GTextOverflowModeWordWrap,
          GTextAlignmentCenter);
      const int16_t line_height = self->menu_layer.title_height;
      title_overflows_cell = (wrapped.w > available_width) ||
                             (wrapped.h > 2 * line_height + line_height / 2);
    }
#endif

    // Check if title needs scrolling
    bool title_needs_scroll = title_overflows_cell;

#if defined(PBL_ROUND) && !defined(MENU_ROUND_LAUNCHER_STYLE)
    // A title wider than the firmware's inset but no wider than the screen is
    // one this row can show whole by taking the drawing over and centring it,
    // so it is not made to slide past a reader for no reason. Only text that
    // genuinely runs off the glass moves.
    if (title_needs_scroll) {
      title_needs_scroll = title_size.w > screen_text_width;
    }
#endif

    // Measure subtitle if present
    bool subtitle_overflows_cell = false;
    bool subtitle_needs_scroll = false;
    int16_t subtitle_width = 0;
    if (item->subtitle) {
      const GFont subtitle_font = fonts_get_system_font(style->subtitle_font_key);
      GSize subtitle_size = graphics_text_layout_get_content_size(
          item->subtitle, subtitle_font,
          GRect(0, 0, 1000, 100),
          GTextOverflowModeTrailingEllipsis,
          GTextAlignmentCenter);
      subtitle_width = subtitle_size.w;
      subtitle_overflows_cell = subtitle_size.w > available_width;
      subtitle_needs_scroll = subtitle_overflows_cell;
#if defined(PBL_ROUND) && !defined(MENU_ROUND_LAUNCHER_STYLE)
      if (subtitle_needs_scroll) {
        subtitle_needs_scroll = subtitle_size.w > screen_text_width;
      }
#endif
    }

    // Set needs_scrolling flag and calculate max offset
#if defined(PBL_ROUND)
    // For round displays: track independent scroll needs for title and subtitle
    self->title_needs_scroll = title_needs_scroll;
    self->subtitle_needs_scroll = subtitle_needs_scroll;

    // How far the text has to travel is measured against the width it is
    // actually drawn into, which for a row drawn here is the screen less the
    // margin the marquee starts from, not the firmware's narrower inset.
#if defined(MENU_ROUND_LAUNCHER_STYLE)
    const int16_t marquee_visible_width = available_width;
#else
    const int16_t marquee_visible_width = bounds.size.w - MENU_ROUND_TEXT_EDGE_INSET;
#endif

    if (title_needs_scroll) {
      self->title_max_scroll_offset = title_size.w - marquee_visible_width + 40;
    } else {
      self->title_max_scroll_offset = 0;
    }

    if (subtitle_needs_scroll) {
      self->subtitle_max_scroll_offset = subtitle_width - marquee_visible_width + 40;
    } else {
      self->subtitle_max_scroll_offset = 0;
    }

    // Drawing the row here is what rescues a title the firmware's inset would
    // have clipped, whether or not the text then has to move
    self->needs_scrolling = title_overflows_cell || subtitle_overflows_cell;
#else
    // For rectangular displays: use combined scroll offset
    (void) title_overflows_cell;
    (void) subtitle_overflows_cell;
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

  // A launcher style round list draws every row itself, so the whole list is
  // laid out the way the system app menu lays its own out. Everywhere else the
  // firmware draws a row unless it is at another text size or it marquees.
#if defined(MENU_ROUND_LAUNCHER_STYLE)
  if (true) {
#else
  // The row this is drawing is the one whose text has outgrown the firmware's
  // layout, so it is drawn here to be moved along or, on a round display,
  // centred across the whole width of the glass
  const bool marquee = is_marquee_row && self->needs_scrolling;
  if (custom_size || marquee) {
#endif
    prv_prepare_row(self, ctx, cell_layer);

#if !defined(PBL_ROUND)
    // ===== RECTANGULAR DISPLAY: Scroll icon and text together =====
    prv_draw_rect_row(self, ctx, cell_layer, item, icon, marquee ? self->scroll_offset : 0);

#elif defined(MENU_ROUND_LAUNCHER_STYLE)
    // ===== ROUND, LAUNCHER STYLE: PebbleOS's own app menu row =====
    // A horizontal pair: the icon centred in a fixed width box on the left,
    // and beside it the title with the subtitle under it, the two of them
    // centred against the row as a group. Left aligned, and the selection is
    // the band of colour behind the row rather than a change of layout.
    const GRect bounds = layer_get_bounds(cell_layer);

    // Only the selected row marquees a title too long to fit; the rest of the
    // list ends in an ellipsis so it is not a wall of moving text
    const bool marquee_title = is_marquee_row && self->title_needs_scroll;
    const bool marquee_subtitle = is_marquee_row && self->subtitle_needs_scroll;

    // The row follows the curve of the glass, and inside whatever room that
    // leaves, the icon box is a fixed width whatever the icon is, so every
    // title in a list of them starts at the same distance from the icon.
    // A list with no icons at all, which is what the main menu and the
    // settings lists are, has no gutter to line up against, so its rows are
    // centred in the room the curve leaves rather than pushed against the left
    // of an empty column.
    const int16_t inset = prv_round_row_inset(self, cell_layer);
    const int16_t icon_x = inset;
    const int16_t text_x =
        icon ? (inset + MENU_ROUND_ICON_BOX + MENU_ROUND_ICON_MARGIN) : inset;
    int16_t text_width = bounds.size.w - inset - text_x;
    if (text_width < 1) { text_width = 1; }

    const int16_t title_height = self->menu_layer.title_height;
    const int16_t subtitle_block = item->subtitle ? self->menu_layer.subtitle_height : 0;
    // The launcher lifts the title a pixel off the centre of the pair
    const int16_t text_y = (bounds.size.h - (title_height + subtitle_block)) / 2 - 1;

    // A marqueeing line is positioned by its own offset, so it is drawn from
    // the left whatever the row's alignment would otherwise be
    const GTextAlignment align = icon ? GTextAlignmentLeft : GTextAlignmentCenter;

    graphics_draw_text(ctx, item->title, fonts_get_system_font(style->title_font_key),
                       GRect(text_x - (marquee_title ? self->title_scroll_offset : 0), text_y,
                             marquee_title ? 2000 : text_width, title_height + 4),
                       GTextOverflowModeTrailingEllipsis,
                       marquee_title ? GTextAlignmentLeft : align, NULL);

    if (item->subtitle) {
      graphics_draw_text(ctx, item->subtitle,
                         fonts_get_system_font(style->subtitle_font_key),
                         GRect(text_x - (marquee_subtitle ? self->subtitle_scroll_offset : 0),
                               text_y + title_height,
                               marquee_subtitle ? 2000 : text_width,
                               subtitle_block + 4),
                         GTextOverflowModeTrailingEllipsis,
                         marquee_subtitle ? GTextAlignmentLeft : align, NULL);
    }

    // Marqueed text runs left past where it started, which is straight through
    // the icon. There is no clip rectangle to draw text into, so the icon box
    // is painted back over in the row's own colour before the icon goes down.
    if (icon && (marquee_title || marquee_subtitle)) {
      graphics_fill_rect(ctx, GRect(0, 0, text_x - MENU_ROUND_ICON_MARGIN, bounds.size.h),
                         0, GCornerNone);
    }

    if (icon) {
      const GRect icon_bounds = gbitmap_get_bounds(icon);
      graphics_context_set_compositing_mode(ctx, GCompOpSet);
      graphics_draw_bitmap_in_rect(
          ctx, icon,
          GRect(icon_x + (MENU_ROUND_ICON_BOX - icon_bounds.size.w) / 2,
                (bounds.size.h - icon_bounds.size.h) / 2,
                icon_bounds.size.w, icon_bounds.size.h));
    }

#else
    // ===== ROUND DISPLAY: Keep icon static, scroll text independently =====
    // Everything is placed where menu_cell_basic_draw would place it, inside
    // the inset it gives a focused or an unfocused row, so a row drawn here
    // lands on the same pixels as one the firmware drew. A row whose text runs
    // past that inset is the exception: its lines are drawn across the whole
    // width of the glass, centred when they fit it and moving when they do not.
    const GRect bounds = layer_get_bounds(cell_layer);
    const bool is_focused = menu_cell_layer_is_highlighted(cell_layer);
    GRect inner = bounds;
    const int16_t inset = is_focused ? MENU_ROUND_CELL_FOCUSED_INSET :
                                       MENU_ROUND_CELL_UNFOCUSED_INSET;
    inner.origin.x += inset;
    inner.size.w -= 2 * inset;
    const RoundRowLayout layout =
        prv_round_row_layout(self, &inner, item, icon, is_focused, marquee);

    if (icon && layout.show_icon) {
      const GRect icon_bounds = gbitmap_get_bounds(icon);
      graphics_context_set_compositing_mode(ctx, GCompOpSet);
      graphics_draw_bitmap_in_rect(ctx, icon,
                                   GRect(inner.origin.x + (inner.size.w - icon_bounds.size.w) / 2,
                                         layout.icon_y, icon_bounds.size.w, icon_bounds.size.h));
    }

    // A line too wide for the screen is drawn from the margin the marquee
    // starts at in a box wide enough never to cut it short
    const int16_t text_rect_width = 2000;
    const int16_t left_margin = MENU_ROUND_TEXT_EDGE_INSET;

    GRect title_box = GRect(inner.origin.x, layout.title_y, inner.size.w, layout.title_h);
    GTextAlignment title_align = GTextAlignmentCenter;
    if (marquee && self->title_needs_scroll) {
      title_box.origin.x = left_margin - self->title_scroll_offset;
      title_box.size.w = text_rect_width;
      title_align = GTextAlignmentLeft;
    } else if (marquee) {
      title_box.origin.x = bounds.origin.x;
      title_box.size.w = bounds.size.w;
    }
    graphics_draw_text(ctx, item->title, fonts_get_system_font(style->title_font_key),
                       title_box, GTextOverflowModeFill, title_align, NULL);

    if (layout.show_subtitle) {
      GRect subtitle_box = GRect(inner.origin.x, layout.subtitle_y, inner.size.w,
                                 self->menu_layer.subtitle_height);
      GTextAlignment subtitle_align = GTextAlignmentCenter;
      if (marquee && self->subtitle_needs_scroll) {
        subtitle_box.origin.x = left_margin - self->subtitle_scroll_offset;
        subtitle_box.size.w = text_rect_width;
        subtitle_align = GTextAlignmentLeft;
      } else if (marquee) {
        subtitle_box.origin.x = bounds.origin.x;
        subtitle_box.size.w = bounds.size.w;
      }
      graphics_draw_text(ctx, item->subtitle, fonts_get_system_font(style->subtitle_font_key),
                         subtitle_box, GTextOverflowModeFill, subtitle_align, NULL);
    }
#endif
  } else {
    // Standard drawing - no scrolling
    menu_cell_basic_draw(ctx, cell_layer, item->title, item->subtitle, icon);
  }

#else
  // On aplite, always use standard drawing (no scrolling)
  menu_cell_basic_draw(ctx, cell_layer, item->title, item->subtitle, icon);
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

// ---- Touch -----------------------------------------------------------------
//
// A MenuLayer renders itself and does not expose cell frames, so mapping a
// finger to a row means recomputing the layout the same way the layer's own
// callbacks declare it. The scroll offset comes from the MenuLayer's
// ScrollLayer, so this stays correct however far the list has scrolled.

#ifdef SIMPLY_HAS_TOUCH

// Cell metrics must mirror exactly what the MenuLayer uses, which is what
// the cell height callback gives it: the focused row is taller on a round
// display, and every row follows the menu's text size
static int16_t prv_touch_cell_height(SimplyMenu *self, MenuIndex index) {
  return prv_cell_height(self, menu_layer_is_index_selected(self->menu_layer.menu_layer, &index));
}

//! How many rows a section holds, from the counts the phone reported if they
//! are known and from the cached section otherwise
static uint16_t prv_section_rows(SimplyMenu *self, uint16_t section_index) {
  uint16_t num_items;
  if (prv_row_counts_get(self, section_index, &num_items, NULL)) {
    return num_items;
  }
  SimplyMenuSection *section = prv_get_menu_section(self, section_index);
  return section ? section->num_items : 1;
}

//! Which row sits at a given point down the content, if any
static bool prv_row_at_content_y(SimplyMenu *self, int content_y, MenuIndex *index_out) {
  if (content_y < 0) { return false; }

  int cursor = 0;
  const uint16_t num_sections = self->menu_layer.num_sections;
  for (uint16_t s = 0; s < num_sections; ++s) {
    const uint16_t num_items = prv_section_rows(self, s);
    const int header = prv_header_height(self, s);
    if (content_y < cursor + header) {
      return false;                        // the header itself is not a target
    }
    cursor += header;

    for (uint16_t r = 0; r < num_items; ++r) {
      MenuIndex index = { .section = s, .row = r };
      const int height = prv_touch_cell_height(self, index);
      if (content_y < cursor + height) {
        *index_out = index;
        return true;
      }
      cursor += height;
    }
  }

  return false;                            // past the last row
}

static bool prv_touch_hit_test(SimplyMenu *self, int16_t x, int16_t y,
                               MenuIndex *index_out) {
  (void) x;
  if (!self || !self->menu_layer.menu_layer) { return false; }

  MenuLayer *menu_layer = self->menu_layer.menu_layer;
  Layer *layer = menu_layer_get_layer(menu_layer);
  GRect frame = layer_get_frame(layer);
  ScrollLayer *scroll_layer = menu_layer_get_scroll_layer(menu_layer);
  GPoint offset =
      scroll_layer ? scroll_layer_get_content_offset(scroll_layer) : GPointZero;

  // Screen coordinates to content coordinates. The offset is negative once
  // the list has scrolled, which is why it is subtracted rather than added
  return prv_row_at_content_y(self, y - frame.origin.y - offset.y, index_out);
}

#if defined(PBL_ROUND)
//! Where the list may be dragged to, in scroll offset terms.
//!
//! A centre focused menu holds the selected row in the middle of the screen,
//! so the ends of the list sit half a screen beyond where a rectangular list
//! would stop: the first row still has to come down to the middle, and the last
//! row still has to come up to it. Clamping a drag to the rectangular range,
//! which is what a scroll layer reports, is why a finger could only cover a
//! fraction of a list the buttons walked from end to end.
static void prv_round_scroll_limits(SimplyMenu *self, int16_t frame_height,
                                    int *min_out, int *max_out) {
  const int focused = prv_cell_height(self, true);
  const int unfocused = prv_cell_height(self, false);
  const int middle = frame_height / 2;

  int headers = 0;
  int first_header = 0;
  int rows = 0;
  const uint16_t num_sections = self->menu_layer.num_sections;
  for (uint16_t sec = 0; sec < num_sections; ++sec) {
    const int header = prv_header_height(self, sec);
    if (sec == 0) { first_header = header; }
    headers += header;
    rows += prv_section_rows(self, sec);
  }
  if (rows < 1) { rows = 1; }

  // The first row centred: everything above it is its own header
  *max_out = middle - first_header - focused / 2;
  // The last row centred: everything above it is every header and every other
  // row, each of those drawn at its unfocused height
  *min_out = middle - headers - (rows - 1) * unfocused - focused / 2;
  if (*min_out > *max_out) { *min_out = *max_out; }
}
#endif

void simply_menu_marquee_at(SimplyMenu *self, int scroll_offset_y) {
  if (!self || !self->menu_layer.menu_layer) { return; }

  const GRect frame = layer_get_frame(menu_layer_get_layer(self->menu_layer.menu_layer));
  MenuIndex index;
  if (!prv_row_at_content_y(self, frame.size.h / 2 - scroll_offset_y, &index)) { return; }

  MenuIndex current = menu_layer_get_selected_index(self->menu_layer.menu_layer);
  const bool is_selection = (index.section == current.section && index.row == current.row);

  // Nothing to do if the row under the middle is the selected one already: the
  // marquee is on it, and restarting the timer would only make it wait again
  if (is_selection && !self->scroll_index_pinned) { return; }
  if (self->scroll_index_pinned && index.section == self->scroll_index.section &&
      index.row == self->scroll_index.row) {
    return;
  }

  start_scroll_timer(self, index);
  self->scroll_index_pinned = !is_selection;
  // The idle timeout stops a list marqueeing forever after it has been left
  // alone; a finger on the screen is the wearer paying attention again
  self->scroll_idle = false;
  self->last_input_time = time(NULL);
}

bool simply_menu_scroll_limits(SimplyMenu *self, int *min_y, int *max_y) {
#if defined(PBL_ROUND)
  if (!self || !self->menu_layer.menu_layer) { return false; }
  const GRect frame = layer_get_frame(menu_layer_get_layer(self->menu_layer.menu_layer));
  prv_round_scroll_limits(self, frame.size.h, min_y, max_y);
  return true;
#else
  // Rectangular menus scroll between the top of the content and the bottom of
  // it, which is what a scroll layer works out for itself
  return false;
#endif
}

static bool prv_touch_activate(SimplyMenu *self, int16_t x, int16_t y,
                               bool long_click) {
  MenuIndex index;
  if (!prv_touch_hit_test(self, x, y, &index)) { return false; }
  // Move the highlight first so the screen agrees with what is about to
  // happen, then fire the same event the matching button action would
  menu_layer_set_selected_index(self->menu_layer.menu_layer, index,
                                MenuRowAlignNone, false);
  simply_menu_touch_note_input(self);
  if (long_click) {
    prv_send_menu_select_long_click(index.section, index.row);
  } else {
    prv_send_menu_select_click(index.section, index.row);
  }
  return true;
}

bool simply_menu_handle_tap(SimplyMenu *self, int16_t x, int16_t y) {
  return prv_touch_activate(self, x, y, false);
}

bool simply_menu_handle_long_press(SimplyMenu *self, int16_t x, int16_t y) {
  return prv_touch_activate(self, x, y, true);
}

void simply_menu_touch_note_input(SimplyMenu *self) {
  if (!self) { return; }
#if !defined(PBL_PLATFORM_APLITE)
  self->last_input_time = time(NULL);
  self->scroll_idle = false;
#endif
}

// ---- Touch scrollbar ---------------------------------------------------------
//
// The firmware's MenuLayer shows a scrollbar while a finger scrolls it, but
// only for touches it handles itself. This app moves the list from its own
// touch handler, so the same cue is drawn here on a layer over the menu:
// shown by a drag, kept up while a fling is still moving the list, and gone a
// second after the last movement.

//! How long the scrollbar stays after the list last moved
#define SCROLLBAR_HIDE_MS 1000

static void prv_scrollbar_hide_timer_callback(void *data) {
  SimplyMenu *self = data;
  self->scrollbar_timer = NULL;
  self->scrollbar_visible = false;
  self->scrollbar_coasting = false;
  if (self->scrollbar_layer) {
    layer_mark_dirty(self->scrollbar_layer);
  }
}

//! A fresh timer each time rather than rescheduling: a timer that has just
//! expired cannot be rescheduled, and its callback would still arrive and
//! take the cue down the moment it went up. Cancelling drops that callback.
static void prv_scrollbar_arm_hide(SimplyMenu *self) {
  if (self->scrollbar_timer) {
    app_timer_cancel(self->scrollbar_timer);
  }
  self->scrollbar_timer = app_timer_register(SCROLLBAR_HIDE_MS,
                                             prv_scrollbar_hide_timer_callback, self);
}

static void prv_scrollbar_cancel_hide(SimplyMenu *self) {
  if (self->scrollbar_timer) {
    app_timer_cancel(self->scrollbar_timer);
    self->scrollbar_timer = NULL;
  }
  self->scrollbar_visible = false;
  self->scrollbar_coasting = false;
}

static void prv_scrollbar_update_proc(Layer *layer, GContext *ctx) {
  SimplyMenu *self = window_get_user_data(layer_get_window(layer));
  MenuLayer *menu_layer = self ? self->menu_layer.menu_layer : NULL;
  if (!menu_layer || !self->scrollbar_visible) { return; }

  ScrollLayer *scroll_layer = menu_layer_get_scroll_layer(menu_layer);
  // The list is still moving under a fling. Nothing reports that, but every
  // frame of it is drawn through here, so the hide waits for the movement to
  // stop just as it does for a finger. A button moving the list does not
  // count, the same as in the firmware.
  const int16_t offset_y = scroll_layer_get_content_offset(scroll_layer).y;
  if (offset_y != self->scrollbar_offset_y) {
    self->scrollbar_offset_y = offset_y;
    if (self->scrollbar_coasting) {
      prv_scrollbar_arm_hide(self);
    }
  }

  // The colours the rows are drawn in, or the MenuLayer's own defaults until
  // the phone has said otherwise
  const GColor8 fg = self->menu_layer.normal_foreground;
  const GColor8 bg = self->menu_layer.normal_background;
  simply_scrollbar_draw(ctx, layer, scroll_layer,
                        fg.a ? gcolor8_get_or(fg, GColorBlack) : GColorBlack,
                        bg.a ? gcolor8_get_or(bg, GColorWhite) : GColorWhite);
}

void simply_menu_touch_scrolled(SimplyMenu *self, bool coasting) {
  MenuLayer *menu_layer = self ? self->menu_layer.menu_layer : NULL;
  if (!menu_layer || !self->scrollbar_layer) { return; }

  // A list that fits its frame has no position to show
  ScrollLayer *scroll_layer = menu_layer_get_scroll_layer(menu_layer);
  const GRect frame = layer_get_frame(scroll_layer_get_layer(scroll_layer));
  if (scroll_layer_get_content_size(scroll_layer).h <= frame.size.h) { return; }

  self->scrollbar_coasting = coasting;
  self->scrollbar_offset_y = scroll_layer_get_content_offset(scroll_layer).y;
  if (!self->scrollbar_visible) {
    self->scrollbar_visible = true;
    layer_mark_dirty(self->scrollbar_layer);
  }
  prv_scrollbar_arm_hide(self);
}

#endif  // SIMPLY_HAS_TOUCH

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
#if !defined(PBL_PLATFORM_APLITE)
    // Rows follow the menu's own text size, and touch finds them by the same
    // heights, so the layer is never left to its default
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

#ifdef SIMPLY_HAS_TOUCH
  // Over the whole window rather than the menu, so it needs no re-placing
  // when the status bar comes and goes; it draws within the menu's frame
  self->scrollbar_layer = layer_create(layer_get_bounds(window_layer));
  layer_set_update_proc(self->scrollbar_layer, prv_scrollbar_update_proc);
  layer_add_child(window_layer, self->scrollbar_layer);
#endif
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
#ifdef SIMPLY_HAS_TOUCH
  // Whatever was mid-fade goes with the screen; the next drag starts afresh
  prv_scrollbar_cancel_hide(self);
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

#ifdef SIMPLY_HAS_TOUCH
  prv_scrollbar_cancel_hide(self);
  layer_destroy(self->scrollbar_layer);
  self->scrollbar_layer = NULL;
#endif

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
#if !defined(PBL_PLATFORM_APLITE)
  prv_set_text_size(self, packet->text_size);
#endif

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

//! Copy a string out of a packet, or NULL when it is empty or its length
//! would reach past the end of the packet
static char *prv_packet_string(const Packet *packet, const char *str, uint16_t length) {
  const char *end = (const char *)packet + packet->length;
  if (!length || str >= end || length >= (size_t)(end - str)) {
    return NULL;
  }
  return strndup2(str, length);
}

static void prv_handle_menu_section_packet(Simply *simply, Packet *data) {
  MenuSectionPacket *packet = (MenuSectionPacket *)data;
  prv_row_counts_record(simply->menu, packet->section, packet->num_items,
                        packet->title_length != 0);
  SimplyMenuSection *section = malloc(sizeof(*section));
  if (!section) { return; }
  *section = (SimplyMenuSection) {
    .section = packet->section,
    .num_items = packet->num_items,
    .title_foreground = packet->text_color,
    .title_background = packet->background_color,
    .title = prv_packet_string(data, packet->title, packet->title_length),
  };
  simply_menu_add_section(simply->menu, section);
}

static void prv_handle_menu_item_packet(Simply *simply, Packet *data) {
  MenuItemPacket *packet = (MenuItemPacket *)data;
  SimplyMenuItem *item = malloc(sizeof(*item));
  if (!item) { return; }
  *item = (SimplyMenuItem) {
    .section = packet->section,
    .item = packet->item,
    .title = prv_packet_string(data, packet->buffer, packet->title_length),
    .subtitle = prv_packet_string(data, packet->buffer + packet->title_length + 1,
                                  packet->subtitle_length),
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

#if !defined(PBL_PLATFORM_APLITE)
  prv_set_text_size(self, MenuTextSizeDefault);
#endif

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