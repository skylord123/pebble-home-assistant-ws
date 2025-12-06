#include "simply_splash.h"

#include "simply.h"

#include "util/graphics.h"

#include <pebble.h>

#if defined(SPLASH_TEXT)

static void window_load(Window *window) {
  SimplySplash *self = window_get_user_data(window);
  Layer *root_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root_layer);

  // Match simply_ui.c card layout exactly
  const int16_t margin_x = 5;
  const int16_t margin_top = 2;

  // Use same fonts as StyleIndex_ClassicLarge (the default card style)
  GFont title_font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
  GFont subtitle_font = fonts_get_system_font(FONT_KEY_GOTHIC_28);

  // Text alignment matches simply_ui: left on rect, center on round
  GTextAlignment text_align = PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft);

  // Calculate text frame width (matching simply_ui margins)
  int16_t text_width = bounds.size.w - 2 * margin_x;
  int16_t text_x = margin_x;

  // Create title layer
  GRect title_frame = GRect(text_x, margin_top, text_width, bounds.size.h / 2);
  self->title_layer = text_layer_create(title_frame);
  text_layer_set_text(self->title_layer, SPLASH_TEXT_TITLE);
  text_layer_set_font(self->title_layer, title_font);
  text_layer_set_text_alignment(self->title_layer, text_align);
  text_layer_set_background_color(self->title_layer, GColorClear);
  text_layer_set_text_color(self->title_layer, GColorBlack);
  layer_add_child(root_layer, text_layer_get_layer(self->title_layer));

  // Calculate title height to position subtitle
  GSize title_size = graphics_text_layout_get_content_size(
      SPLASH_TEXT_TITLE, title_font, title_frame,
      GTextOverflowModeWordWrap, text_align);

  // Create subtitle layer (positioned after title, no padding like ClassicLarge style)
  GRect subtitle_frame = GRect(text_x, margin_top + title_size.h, text_width, bounds.size.h / 2);
  self->subtitle_layer = text_layer_create(subtitle_frame);
  text_layer_set_text(self->subtitle_layer, SPLASH_TEXT_SUBTITLE);
  text_layer_set_font(self->subtitle_layer, subtitle_font);
  text_layer_set_text_alignment(self->subtitle_layer, text_align);
  text_layer_set_background_color(self->subtitle_layer, GColorClear);
  text_layer_set_text_color(self->subtitle_layer, GColorBlack);
  layer_add_child(root_layer, text_layer_get_layer(self->subtitle_layer));
}

#else

static void layer_update_callback(Layer *layer, GContext *ctx) {
  SimplySplash *self = (SimplySplash*) window_get_user_data((Window*) layer);

  GRect frame = layer_get_frame(layer);

#if defined(SPLASH_LOGO)
  graphics_draw_bitmap_centered(ctx, self->image, frame);
#else
  graphics_draw_bitmap_in_rect(ctx, self->image, frame);
#endif
}

static void window_load(Window *window) {
  SimplySplash *self = window_get_user_data(window);

#if defined(SPLASH_LOGO)
  self->image = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_LOGO_SPLASH);
#else
  self->image = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_TILE_SPLASH);
#endif
}

#endif

static void window_disappear(Window *window) {
  SimplySplash *self = window_get_user_data(window);
  bool animated = false;
  window_stack_remove(self->window, animated);
  simply_splash_destroy(self);
}

SimplySplash *simply_splash_create(Simply *simply) {
  SimplySplash *self = malloc(sizeof(*self));
  *self = (SimplySplash) { .simply = simply };

  self->window = window_create();
  window_set_user_data(self->window, self);
  window_set_fullscreen(self->window, false);
  window_set_background_color(self->window, GColorWhite);
  window_set_window_handlers(self->window, (WindowHandlers) {
    .load = window_load,
    .disappear = window_disappear,
  });

#if !defined(SPLASH_TEXT)
  layer_set_update_proc(window_get_root_layer(self->window), layer_update_callback);
#endif

  return self;
}

void simply_splash_destroy(SimplySplash *self) {
#if defined(SPLASH_TEXT)
  if (self->title_layer) {
    text_layer_destroy(self->title_layer);
  }
  if (self->subtitle_layer) {
    text_layer_destroy(self->subtitle_layer);
  }
#else
  gbitmap_destroy(self->image);
#endif

  window_destroy(self->window);

  self->simply->splash = NULL;

  free(self);
}

