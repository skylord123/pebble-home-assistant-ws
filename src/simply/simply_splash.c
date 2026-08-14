#include "simply_splash.h"

#include "simply.h"

#include "util/graphics.h"

#include <pebble.h>

static void window_load(Window *window) {
  SimplySplash *self = window_get_user_data(window);
  Layer *root_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root_layer);

  int16_t margin_x = 5;
  window_set_background_color(self->window, GColorWhite);

  GFont title_font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
  GFont subtitle_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  GTextAlignment text_align = GTextAlignmentCenter;
  int16_t text_width = bounds.size.w - 2 * margin_x;
  int16_t text_x = margin_x;

  // Title
  GRect title_frame = GRect(text_x, 5, text_width, 64);
  self->title_layer = text_layer_create(title_frame);
  text_layer_set_text(self->title_layer, SPLASH_TEXT_TITLE);
  text_layer_set_font(self->title_layer, title_font);
  text_layer_set_text_alignment(self->title_layer, text_align);
  text_layer_set_background_color(self->title_layer, GColorClear);
  text_layer_set_text_color(self->title_layer, GColorBlue);
  layer_add_child(root_layer, text_layer_get_layer(self->title_layer));

  // Logo
  self->image = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_LOGO_SPLASH);
  GRect logo_frame = GRect((bounds.size.w - 80) / 2, 67, 80, 80);
  self->logo_layer = bitmap_layer_create(logo_frame);
  bitmap_layer_set_bitmap(self->logo_layer, self->image);
  bitmap_layer_set_alignment(self->logo_layer, GAlignCenter);
  bitmap_layer_set_background_color(self->logo_layer, GColorClear);
  bitmap_layer_set_compositing_mode(self->logo_layer, GCompOpSet);
  layer_add_child(root_layer, bitmap_layer_get_layer(self->logo_layer));

  // Subtitle
  GRect subtitle_frame = GRect(text_x, 158, text_width, 24);
  self->subtitle_layer = text_layer_create(subtitle_frame);
  text_layer_set_text(self->subtitle_layer, SPLASH_TEXT_SUBTITLE);
  text_layer_set_font(self->subtitle_layer, subtitle_font);
  text_layer_set_text_alignment(self->subtitle_layer, text_align);
  text_layer_set_background_color(self->subtitle_layer, GColorClear);
  text_layer_set_text_color(self->subtitle_layer, GColorBlue);
  layer_add_child(root_layer, text_layer_get_layer(self->subtitle_layer));
}

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
  window_set_fullscreen(self->window, true);
  window_set_window_handlers(self->window, (WindowHandlers) {
    .load = window_load,
    .disappear = window_disappear,
  });

  return self;
}

void simply_splash_destroy(SimplySplash *self) {
  if (self->title_layer) {
    text_layer_destroy(self->title_layer);
  }
  if (self->subtitle_layer) {
    text_layer_destroy(self->subtitle_layer);
  }
  if (self->logo_layer) {
    bitmap_layer_destroy(self->logo_layer);
  }
  if (self->image) {
    gbitmap_destroy(self->image);
  }

  window_destroy(self->window);

  self->simply->splash = NULL;

  free(self);
}
