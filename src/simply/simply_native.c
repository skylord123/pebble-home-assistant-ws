#include "simply_native.h"
#include "simply_msg.h"
#include "simply_res.h"
#include "simply.h"

#include "util/color.h"

#include <pebble.h>

static SimplyNative *s_native;

// ============================================================
// Packet structures
// ============================================================

// JS → C: Push a new native menu
struct __attribute__((__packed__)) NativeMenuPushPacket {
  Packet packet;
  uint8_t screen_id;
  uint8_t num_sections;
  uint8_t num_items;
  // Followed by section titles and items sent as separate MenuUpdate packets
  char title[];  // Screen title (first section title)
};

// JS → C: Update/add a menu item
struct __attribute__((__packed__)) NativeMenuUpdatePacket {
  Packet packet;
  uint8_t screen_id;
  uint16_t section;
  uint16_t index;
  uint32_t icon;
  uint16_t title_len;
  uint16_t subtitle_len;
  char buffer[];  // title + \0 + subtitle + \0
};

// JS → C: Pop the top screen
struct __attribute__((__packed__)) NativeMenuPopPacket {
  Packet packet;
};

// C → JS: User selected an item
struct __attribute__((__packed__)) NativeMenuSelectPacket {
  Packet packet;
  uint8_t screen_id;
  uint16_t section;
  uint16_t index;
};

// C → JS: User long-pressed an item
typedef struct NativeMenuSelectPacket NativeMenuLongSelectPacket;

// C → JS: User pressed back
struct __attribute__((__packed__)) NativeMenuBackPacket {
  Packet packet;
  uint8_t screen_id;
};

// JS → C: Push a card screen
struct __attribute__((__packed__)) NativeCardPushPacket {
  Packet packet;
  uint8_t screen_id;
  uint16_t title_len;
  uint16_t subtitle_len;
  uint16_t body_len;
  char buffer[];  // title + \0 + subtitle + \0 + body + \0
};

// JS → C: Show toast
struct __attribute__((__packed__)) NativeToastPacket {
  Packet packet;
  uint8_t type;  // 0=sending, 1=success, 2=error
  char text[];
};

// ============================================================
// Forward declarations
// ============================================================

static NativeScreen *native_screen_create(uint8_t screen_id);
static void native_screen_destroy(NativeScreen *screen);
static void native_push(NativeScreen *screen);
static void native_pop(void);
static NativeScreen *native_top(void);
static NativeScreen *find_screen_by_id(uint8_t screen_id);

static void screen_window_load(Window *window);
static void screen_window_unload(Window *window);
static void screen_window_unload_with_destroy(Window *window);
static void screen_window_appear(Window *window);
static void screen_window_disappear(Window *window);

static void toast_show(const char *text, uint8_t type);
static void toast_dismiss(void *data);

// ============================================================
// Scrolling (non-Aplite)
// ============================================================

#if !defined(PBL_PLATFORM_APLITE)
#define NATIVE_SCROLL_WAIT_MS 1000
#define NATIVE_SCROLL_STEP_MS 100
#define NATIVE_SCROLL_STEP_PX 8

static void native_scroll_timer_callback(void *data) {
  NativeScreen *screen = data;
  if (!screen || !screen->menu_layer) return;

  screen->scroll_offset += NATIVE_SCROLL_STEP_PX;
  if (screen->scroll_offset > screen->max_scroll_offset) {
    // Reset and stop
    screen->scroll_offset = 0;
    screen->scrolling_active = false;
    screen->scroll_timer = NULL;
    layer_mark_dirty(menu_layer_get_layer(screen->menu_layer));
    return;
  }

  layer_mark_dirty(menu_layer_get_layer(screen->menu_layer));
  screen->scroll_timer = app_timer_register(NATIVE_SCROLL_STEP_MS, native_scroll_timer_callback, screen);
}

static void native_start_scroll(NativeScreen *screen, MenuIndex index) {
  if (screen->scrolling_active && menu_index_compare(&screen->scroll_index, &index) == 0) return;

  // Stop previous
  if (screen->scroll_timer) {
    app_timer_cancel(screen->scroll_timer);
    screen->scroll_timer = NULL;
  }

  screen->scroll_index = index;
  screen->scroll_offset = 0;
  screen->scrolling_active = false;

  // Check if text needs scrolling
  NativeMenuItem *item = NULL;
  for (int i = 0; i < screen->num_items; i++) {
    if (screen->items[i].section == index.section && screen->items[i].index == index.row) {
      item = &screen->items[i];
      break;
    }
  }
  if (!item) return;

  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  GRect bounds = layer_get_bounds(window_get_root_layer(screen->window));
  int available_width = bounds.size.w - 10;  // margins
  if (item->icon) available_width -= 33;  // icon space

  GSize title_size = graphics_text_layout_get_content_size(
    item->title, font, GRect(0, 0, 2000, 30),
    GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);

  if (title_size.w <= available_width) return;  // No scrolling needed

  screen->max_scroll_offset = title_size.w - available_width + 20;
  screen->scrolling_active = true;
  screen->scroll_timer = app_timer_register(NATIVE_SCROLL_WAIT_MS, native_scroll_timer_callback, screen);
}

static void native_stop_scroll(NativeScreen *screen) {
  if (screen->scroll_timer) {
    app_timer_cancel(screen->scroll_timer);
    screen->scroll_timer = NULL;
  }
  screen->scrolling_active = false;
  screen->scroll_offset = 0;
}
#endif

// ============================================================
// Menu item lookup
// ============================================================

static NativeMenuItem *find_item(NativeScreen *screen, uint16_t section, uint16_t row) {
  for (int i = 0; i < screen->num_items; i++) {
    if (screen->items[i].section == section && screen->items[i].index == row) {
      return &screen->items[i];
    }
  }
  return NULL;
}

static int count_items_in_section(NativeScreen *screen, uint16_t section) {
  int count = 0;
  for (int i = 0; i < screen->num_items; i++) {
    if (screen->items[i].section == section) count++;
  }
  return count;
}

// ============================================================
// MenuLayer callbacks
// ============================================================

static uint16_t menu_get_num_sections(MenuLayer *layer, void *context) {
  NativeScreen *screen = context;
  return screen->num_sections > 0 ? screen->num_sections : 1;
}

static uint16_t menu_get_num_rows(MenuLayer *layer, uint16_t section, void *context) {
  NativeScreen *screen = context;
  return count_items_in_section(screen, section);
}

static int16_t menu_get_header_height(MenuLayer *layer, uint16_t section, void *context) {
  NativeScreen *screen = context;
  if (section < screen->num_sections && screen->sections[section].title[0]) {
    return MENU_CELL_BASIC_HEADER_HEIGHT;
  }
  return 0;
}

static int16_t menu_get_cell_height(MenuLayer *layer, MenuIndex *index, void *context) {
  (void)layer; (void)index; (void)context;
#ifdef PBL_ROUND
  if (menu_layer_is_index_selected(layer, index)) {
    return MENU_CELL_ROUND_FOCUSED_TALL_CELL_HEIGHT;
  }
  return MENU_CELL_ROUND_UNFOCUSED_SHORT_CELL_HEIGHT;
#else
  return 44;
#endif
}

static void menu_draw_header(GContext *ctx, const Layer *cell_layer, uint16_t section, void *context) {
  NativeScreen *screen = context;
  if (section < screen->num_sections && screen->sections[section].title[0]) {
    menu_cell_basic_header_draw(ctx, cell_layer, screen->sections[section].title);
  }
}

static void menu_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *index, void *context) {
  NativeScreen *screen = context;
  NativeMenuItem *item = find_item(screen, index->section, index->row);
  if (!item) return;

  Simply *simply = s_native->simply;
  bool selected = menu_layer_is_index_selected(screen->menu_layer, index);

  // Get icon bitmap if available
  GBitmap *icon_bitmap = NULL;
  if (item->icon && simply->res) {
    SimplyImage *image = simply_res_get_image(simply->res, item->icon);
    if (image && image->bitmap) {
      icon_bitmap = image->bitmap;
      // Switch palette for highlight
      if (selected && image->is_palette_black_and_white) {
        static GColor8 inv_palette[] = { { GColorWhiteARGB8 }, { GColorClearARGB8 } };
        gbitmap_set_palette(icon_bitmap, (GColor *)inv_palette, false);
      } else if (image->is_palette_black_and_white) {
        static GColor8 norm_palette[] = { { GColorBlackARGB8 }, { GColorClearARGB8 } };
        gbitmap_set_palette(icon_bitmap, (GColor *)norm_palette, false);
      }
    }
  }

#if !defined(PBL_PLATFORM_APLITE)
  // Custom draw with scrolling for selected item
  if (selected && screen->scrolling_active &&
      menu_index_compare(&screen->scroll_index, index) == 0 &&
      screen->scroll_offset > 0) {
    GRect bounds = layer_get_bounds(cell_layer);
    int x_offset = icon_bitmap ? 33 : 5;

    // Draw icon
    if (icon_bitmap) {
      GRect icon_rect = GRect(5, (bounds.size.h - 24) / 2, 24, 24);
      graphics_draw_bitmap_in_rect(ctx, icon_bitmap, icon_rect);
    }

    // Draw scrolling title
    GFont title_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
    GFont sub_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);

    graphics_draw_text(ctx, item->title, title_font,
      GRect(x_offset - screen->scroll_offset, 0, 2000, 28),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

    if (item->subtitle[0]) {
      graphics_draw_text(ctx, item->subtitle, sub_font,
        GRect(x_offset, 26, bounds.size.w - x_offset - 5, 16),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    }
    return;
  }
#endif

  // Standard draw
  menu_cell_basic_draw(ctx, cell_layer, item->title,
                       item->subtitle[0] ? item->subtitle : NULL,
                       icon_bitmap);
}

static void menu_select_click(MenuLayer *layer, MenuIndex *index, void *context) {
  NativeScreen *screen = context;

  // Send select event to JS
  struct NativeMenuSelectPacket pkt = {
    .packet.type = CommandNativeMenuSelect,
    .packet.length = sizeof(struct NativeMenuSelectPacket),
    .screen_id = screen->screen_id,
    .section = index->section,
    .index = index->row,
  };
  simply_msg_send_packet(&pkt.packet);
}

static void menu_select_long_click(MenuLayer *layer, MenuIndex *index, void *context) {
  NativeScreen *screen = context;

  struct NativeMenuSelectPacket pkt = {
    .packet.type = CommandNativeMenuLongSelect,
    .packet.length = sizeof(struct NativeMenuSelectPacket),
    .screen_id = screen->screen_id,
    .section = index->section,
    .index = index->row,
  };
  simply_msg_send_packet(&pkt.packet);
}

static void menu_selection_changed(MenuLayer *layer, MenuIndex new_index,
                                   MenuIndex old_index, void *context) {
#if !defined(PBL_PLATFORM_APLITE)
  NativeScreen *screen = context;
  native_start_scroll(screen, new_index);
#endif
}

// ============================================================
// Screen lifecycle
// ============================================================

static void screen_window_load(Window *window) {
  NativeScreen *screen = window_get_user_data(window);

  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  // Status bar
  screen->status_bar = status_bar_layer_create();
  status_bar_layer_set_separator_mode(screen->status_bar, StatusBarLayerSeparatorModeDotted);
  status_bar_layer_set_colors(screen->status_bar,
    (GColor8){ GColorBlackARGB8 }, (GColor8){ GColorWhiteARGB8 });

#ifdef PBL_ROUND
  layer_add_child(root, status_bar_layer_get_layer(screen->status_bar));
  GRect menu_bounds = GRect(0, STATUS_BAR_LAYER_HEIGHT, bounds.size.w,
                            bounds.size.h - STATUS_BAR_LAYER_HEIGHT);
#else
  layer_add_child(root, status_bar_layer_get_layer(screen->status_bar));
  GRect menu_bounds = GRect(0, STATUS_BAR_LAYER_HEIGHT, bounds.size.w,
                            bounds.size.h - STATUS_BAR_LAYER_HEIGHT);
#endif

  // Menu layer
  screen->menu_layer = menu_layer_create(menu_bounds);
  menu_layer_set_callbacks(screen->menu_layer, screen, (MenuLayerCallbacks) {
    .get_num_sections = menu_get_num_sections,
    .get_num_rows = menu_get_num_rows,
    .get_header_height = menu_get_header_height,
    .get_cell_height = menu_get_cell_height,
    .draw_header = menu_draw_header,
    .draw_row = menu_draw_row,
    .select_click = menu_select_click,
    .select_long_click = menu_select_long_click,
    .selection_changed = menu_selection_changed,
  });

  menu_layer_set_normal_colors(screen->menu_layer, GColorBlack, GColorWhite);
  menu_layer_set_highlight_colors(screen->menu_layer, GColorWhite, GColorBlack);
  menu_layer_set_click_config_onto_window(screen->menu_layer, window);

  layer_add_child(root, menu_layer_get_layer(screen->menu_layer));
}

static void screen_window_unload(Window *window) {
  NativeScreen *screen = window_get_user_data(window);

#if !defined(PBL_PLATFORM_APLITE)
  native_stop_scroll(screen);
#endif

  if (screen->menu_layer) {
    menu_layer_destroy(screen->menu_layer);
    screen->menu_layer = NULL;
  }
  if (screen->status_bar) {
    status_bar_layer_destroy(screen->status_bar);
    screen->status_bar = NULL;
  }
}

static void screen_window_appear(Window *window) {
  // Reload menu data when screen reappears (back navigation)
  NativeScreen *screen = window_get_user_data(window);
  if (screen && screen->menu_layer) {
    menu_layer_reload_data(screen->menu_layer);
  }
}

// ============================================================
// Screen management
// ============================================================

static NativeScreen *native_screen_create(uint8_t screen_id) {
  NativeScreen *screen = malloc(sizeof(NativeScreen));
  if (!screen) return NULL;

  memset(screen, 0, sizeof(NativeScreen));
  screen->screen_id = screen_id;
  screen->num_sections = 1;

  screen->window = window_create();
  window_set_user_data(screen->window, screen);
  window_set_background_color(screen->window, GColorBlack);
  window_set_window_handlers(screen->window, (WindowHandlers) {
    .load = screen_window_load,
    .unload = screen_window_unload_with_destroy,
    .appear = screen_window_appear,
    .disappear = screen_window_disappear,
  });

  return screen;
}

static void native_screen_destroy(NativeScreen *screen) {
  if (!screen) return;

#if !defined(PBL_PLATFORM_APLITE)
  native_stop_scroll(screen);
#endif

  if (screen->window) {
    window_destroy(screen->window);
    screen->window = NULL;
  }
  free(screen);
}

static NativeScreen *native_top(void) {
  if (!s_native || s_native->stack_count == 0) return NULL;
  return s_native->stack[s_native->stack_count - 1];
}

static void native_push(NativeScreen *screen) {
  if (!s_native || s_native->stack_count >= NATIVE_MAX_WINDOWS) {
    native_screen_destroy(screen);
    return;
  }
  s_native->stack[s_native->stack_count++] = screen;
  window_stack_push(screen->window, true);
}

static void native_pop(void) {
  if (!s_native || s_native->stack_count == 0) return;

  NativeScreen *screen = native_top();
  if (screen && screen->window) {
    // Popping the window triggers disappear → unload_with_destroy
    // which handles stack cleanup and JS notification
    window_stack_remove(screen->window, true);
  }
}

static NativeScreen *find_screen_by_id(uint8_t screen_id) {
  for (int i = 0; i < s_native->stack_count; i++) {
    if (s_native->stack[i]->screen_id == screen_id) {
      return s_native->stack[i];
    }
  }
  return NULL;
}

// ============================================================
// Toast overlay
// ============================================================

static void toast_dismiss(void *data) {
  NativeToast *toast = &s_native->toast;
  if (!toast->active) return;

  toast->active = false;
  if (toast->dismiss_timer) {
    toast->dismiss_timer = NULL;
  }
  if (toast->window) {
    window_stack_remove(toast->window, false);
  }
}

static void toast_window_load(Window *window) {
  NativeToast *toast = &s_native->toast;
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  // Center text
  int toast_h = 40;
  int toast_y = (bounds.size.h - toast_h) / 2;

  toast->text_layer = text_layer_create(GRect(10, toast_y, bounds.size.w - 20, toast_h));
  text_layer_set_background_color(toast->text_layer, GColorBlack);
  text_layer_set_text_color(toast->text_layer, GColorWhite);
  text_layer_set_font(toast->text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(toast->text_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(toast->text_layer, GTextOverflowModeTrailingEllipsis);

  layer_add_child(root, text_layer_get_layer(toast->text_layer));
}

static void toast_window_unload(Window *window) {
  NativeToast *toast = &s_native->toast;
  if (toast->text_layer) {
    text_layer_destroy(toast->text_layer);
    toast->text_layer = NULL;
  }
}

static void toast_show(const char *text, uint8_t type) {
  NativeToast *toast = &s_native->toast;

  // Cancel existing timer
  if (toast->dismiss_timer) {
    app_timer_cancel(toast->dismiss_timer);
    toast->dismiss_timer = NULL;
  }

  if (!toast->window) {
    toast->window = window_create();
    window_set_background_color(toast->window, GColorBlack);
    window_set_window_handlers(toast->window, (WindowHandlers) {
      .load = toast_window_load,
      .unload = toast_window_unload,
    });
  }

  if (!toast->active) {
    toast->active = true;
    window_stack_push(toast->window, false);
  }

  if (toast->text_layer) {
    text_layer_set_text(toast->text_layer, text);
    // Color by type
    switch (type) {
      case 1: // success
        text_layer_set_text_color(toast->text_layer, PBL_IF_COLOR_ELSE(GColorGreen, GColorWhite));
        break;
      case 2: // error
        text_layer_set_text_color(toast->text_layer, PBL_IF_COLOR_ELSE(GColorRed, GColorWhite));
        break;
      default: // sending
        text_layer_set_text_color(toast->text_layer, GColorWhite);
        break;
    }
  }

  // Auto-dismiss
  uint32_t dismiss_ms = (type == 0) ? 5000 : 1500;
  toast->dismiss_timer = app_timer_register(dismiss_ms, toast_dismiss, NULL);
}

// ============================================================
// Back button handling
// ============================================================

// This is called from the menu layer's click config, but we need to handle
// back ourselves since menu_layer_set_click_config_onto_window takes over clicks.
// We override by adding a back handler after the menu layer sets up its config.

static void screen_window_disappear(Window *window) {
  NativeScreen *screen = window_get_user_data(window);
  if (!screen || !s_native) return;

  // If this screen is on top of our stack and the window is disappearing
  // (user pressed back via menu layer's default handling), pop it from our stack
  NativeScreen *top = native_top();
  if (top == screen && s_native->stack_count > 0) {
    s_native->stack_count--;

    // Send back event to JS
    struct NativeMenuBackPacket back_pkt;
    back_pkt.packet.type = CommandNativeMenuBack;
    back_pkt.packet.length = sizeof(back_pkt);
    back_pkt.screen_id = screen->screen_id;
    simply_msg_send_packet(&back_pkt.packet);

    // Delay destroy to let window unload finish
    // Actually just null the stack slot, destroy happens in unload
  }
}

static void screen_window_unload_with_destroy(Window *window) {
  screen_window_unload(window);
  NativeScreen *screen = window_get_user_data(window);
  if (screen) {
    // Don't destroy the window here — it's being destroyed by Pebble
    screen->window = NULL;
    native_screen_destroy(screen);
  }
}

// ============================================================
// Packet handlers
// ============================================================

static void handle_native_menu_push(Simply *simply, Packet *data) {
  struct NativeMenuPushPacket *pkt = (struct NativeMenuPushPacket *)data;

  NativeScreen *screen = native_screen_create(pkt->screen_id);
  if (!screen) return;

  screen->num_sections = pkt->num_sections > 0 ? pkt->num_sections : 1;
  if (screen->num_sections > NATIVE_MAX_MENU_SECTIONS) {
    screen->num_sections = NATIVE_MAX_MENU_SECTIONS;
  }

  // Set first section title from packet
  if (pkt->title[0]) {
    strncpy(screen->sections[0].title, pkt->title, NATIVE_TITLE_LEN - 1);
    screen->sections[0].title[NATIVE_TITLE_LEN - 1] = '\0';
  }

  // Window handlers already set in native_screen_create

  native_push(screen);
}

static void handle_native_menu_update(Simply *simply, Packet *data) {
  struct NativeMenuUpdatePacket *pkt = (struct NativeMenuUpdatePacket *)data;

  NativeScreen *screen = find_screen_by_id(pkt->screen_id);
  if (!screen) return;

  // Special case: index 0xFFFF means set section title
  if (pkt->index == 0xFFFF) {
    if (pkt->section < screen->num_sections && pkt->title_len > 0) {
      strncpy(screen->sections[pkt->section].title, pkt->buffer, NATIVE_TITLE_LEN - 1);
      screen->sections[pkt->section].title[NATIVE_TITLE_LEN - 1] = '\0';
    }
    if (screen->menu_layer) {
      menu_layer_reload_data(screen->menu_layer);
    }
    return;
  }

  // Find or add item
  NativeMenuItem *item = find_item(screen, pkt->section, pkt->index);
  if (!item && screen->num_items < NATIVE_MAX_MENU_ITEMS) {
    item = &screen->items[screen->num_items++];
  }
  if (!item) return;

  item->section = pkt->section;
  item->index = pkt->index;
  item->icon = pkt->icon;

  // Extract title and subtitle from buffer
  if (pkt->title_len > 0 && pkt->title_len < NATIVE_TITLE_LEN) {
    strncpy(item->title, pkt->buffer, NATIVE_TITLE_LEN - 1);
    item->title[NATIVE_TITLE_LEN - 1] = '\0';
  } else {
    item->title[0] = '\0';
  }

  if (pkt->subtitle_len > 0) {
    const char *sub = pkt->buffer + pkt->title_len + 1;
    strncpy(item->subtitle, sub, NATIVE_SUBTITLE_LEN - 1);
    item->subtitle[NATIVE_SUBTITLE_LEN - 1] = '\0';
  } else {
    item->subtitle[0] = '\0';
  }

  // Update section info
  if (pkt->section < screen->num_sections) {
    int count = count_items_in_section(screen, pkt->section);
    screen->sections[pkt->section].num_items = count;
  }

  // Reload menu if visible
  if (screen->menu_layer) {
    menu_layer_reload_data(screen->menu_layer);
  }
}

static void handle_native_menu_pop(Simply *simply, Packet *data) {
  native_pop();
}

static void handle_native_card_push(Simply *simply, Packet *data) {
  struct NativeCardPushPacket *pkt = (struct NativeCardPushPacket *)data;

  // Use a simple card window
  const char *title = pkt->buffer;
  const char *subtitle = pkt->buffer + pkt->title_len + 1;
  const char *body = pkt->buffer + pkt->title_len + 1 + pkt->subtitle_len + 1;

  // Create a screen with a single item to display card-like content
  NativeScreen *screen = native_screen_create(pkt->screen_id);
  if (!screen) return;

  screen->num_sections = 1;
  strncpy(screen->sections[0].title, title, NATIVE_TITLE_LEN - 1);

  // Add subtitle and body as menu items
  if (pkt->subtitle_len > 0) {
    NativeMenuItem *item = &screen->items[screen->num_items++];
    item->section = 0;
    item->index = 0;
    strncpy(item->title, subtitle, NATIVE_TITLE_LEN - 1);
    if (pkt->body_len > 0) {
      strncpy(item->subtitle, body, NATIVE_SUBTITLE_LEN - 1);
    }
  } else if (pkt->body_len > 0) {
    NativeMenuItem *item = &screen->items[screen->num_items++];
    item->section = 0;
    item->index = 0;
    strncpy(item->title, body, NATIVE_TITLE_LEN - 1);
  }

  // Window handlers already set in native_screen_create

  native_push(screen);
}

static void handle_native_toast(Simply *simply, Packet *data) {
  struct NativeToastPacket *pkt = (struct NativeToastPacket *)data;
  toast_show(pkt->text, pkt->type);
}

// ============================================================
// Packet dispatch
// ============================================================

bool simply_native_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandNativeMenuPush:
      handle_native_menu_push(simply, packet);
      return true;
    case CommandNativeMenuUpdate:
      handle_native_menu_update(simply, packet);
      return true;
    case CommandNativeMenuPop:
      handle_native_menu_pop(simply, packet);
      return true;
    case CommandNativeCardPush:
      handle_native_card_push(simply, packet);
      return true;
    case CommandNativeToast:
      handle_native_toast(simply, packet);
      return true;
  }
  return false;
}

// ============================================================
// Init / Destroy
// ============================================================

SimplyNative *simply_native_create(Simply *simply) {
  if (s_native) return s_native;

  SimplyNative *self = malloc(sizeof(SimplyNative));
  if (!self) return NULL;

  memset(self, 0, sizeof(SimplyNative));
  self->simply = simply;

  s_native = self;
  return self;
}

void simply_native_destroy(SimplyNative *self) {
  if (!self) return;

  // Dismiss toast
  if (self->toast.dismiss_timer) {
    app_timer_cancel(self->toast.dismiss_timer);
  }
  if (self->toast.window) {
    window_destroy(self->toast.window);
  }

  // Destroy all screens
  for (int i = 0; i < self->stack_count; i++) {
    if (self->stack[i]) {
      native_screen_destroy(self->stack[i]);
      self->stack[i] = NULL;
    }
  }

  free(self);
  s_native = NULL;
}
