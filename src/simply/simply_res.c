#include "simply_res.h"

#include "util/color.h"
#include "util/graphics.h"
#include "util/memory.h"
#include "util/sdk.h"
#include "util/window.h"

#include <pebble.h>

static bool id_filter(List1Node *node, void *data) {
  return (((SimplyResItemCommon*) node)->id == (uint32_t)(uintptr_t) data);
}

static void destroy_image(SimplyRes *self, SimplyImage *image) {
  if (!image) {
    return;
  }

  list1_remove(&self->images, &image->node);
  gbitmap_destroy(image->bitmap);
  free(image->palette);
  free(image);
}

static void destroy_font(SimplyRes *self, SimplyFont *font) {
  if (!font) {
    return;
  }

  list1_remove(&self->fonts, &font->node);
  fonts_unload_custom_font(font->font);
  free(font);
}

static void setup_image(SimplyImage *image) {
  image->is_palette_black_and_white = gbitmap_is_palette_black_and_white(image->bitmap);

  if (!image->is_palette_black_and_white) {
    return;
  }

  GColor8 *palette = gbitmap_get_palette(image->bitmap);
  GColor8 *palette_copy = malloc0(2 * sizeof(GColor8));
  memcpy(palette_copy, palette, 2 * sizeof(GColor8));
  gbitmap_set_palette(image->bitmap, palette_copy, false);
  image->palette = palette_copy;
}

bool simply_res_evict_image(SimplyRes *self) {
  SimplyImage *last_image = (SimplyImage *)list1_last(self->images);
  if (!last_image) {
    return false;
  }

  destroy_image(self, last_image);
  return true;
}

static void add_image(SimplyRes *self, SimplyImage *image) {
  list1_prepend(&self->images, &image->node);

  setup_image(image);

  window_stack_schedule_top_window_render();
}

typedef GBitmap *(*GBitmapCreator)(SimplyImage *image, void *data);

static SimplyImage *create_image(SimplyRes *self, GBitmapCreator creator, void *data) {
  // On APLITE, proactively evict images before attempting allocation
  // to prevent malloc failures and crashes due to severe memory constraints
  #if defined(PBL_PLATFORM_APLITE)
    // On APLITE, only evict if we have more than 4 images cached
    int image_count = 0;
    List1Node *node = self->images;
    while (node) {
      image_count++;
      node = node->next;
    }

    // Only evict if cache is getting full (more than 4 images)
    if (image_count > 4) {
      simply_res_evict_image(self);
    }
  #endif

  SimplyImage *image = NULL;
  while (!(image = malloc0(sizeof(*image)))) {
    if (!simply_res_evict_image(self)) {
      return NULL;
    }
  }

  GBitmap *bitmap = NULL;
  while (!(bitmap = creator(image, data))) {
    if (!simply_res_evict_image(self)) {
      free(image);
      return NULL;
    }
  }

  image->bitmap = bitmap;

  return image;
}

static GBitmap *create_bitmap_with_id(SimplyImage *image, void *data) {
  const uint32_t id = (uint32_t)(uintptr_t) data;
  GBitmap *bitmap = gbitmap_create_with_resource(id);
  if (bitmap) {
    image->id = id;
  }
  return bitmap;
}

SimplyImage *simply_res_add_bundled_image(SimplyRes *self, uint32_t id) {
  SimplyImage *image = create_image(self, create_bitmap_with_id, (void*)(uintptr_t) id);
  if (image) {
    add_image(self, image);
  }
  return image;
}

typedef struct {
  GSize size;
  size_t data_length;
  const uint8_t *data;
} CreateDataContext;

SDK_2_USAGE static GBitmap *create_bitmap_with_data(SimplyImage *image, void *data) {
  CreateDataContext *ctx = data;
  GBitmap *bitmap = gbitmap_create_blank(ctx->size, GBitmapFormat1Bit);
  if (bitmap) {
    image->bitmap_data = gbitmap_get_data(bitmap);
    memcpy(image->bitmap_data, ctx->data, ctx->data_length);
  }
  return bitmap;
}

SDK_3_USAGE static GBitmap *create_bitmap_with_png_data(SimplyImage *image, void *data) {
  CreateDataContext *ctx = data;
  return ctx->data ? gbitmap_create_from_png_data(ctx->data, ctx->data_length) : NULL;
}

SimplyImage *simply_res_add_image(SimplyRes *self, uint32_t id, int16_t width, int16_t height,
                                  uint8_t *pixels, uint16_t pixels_length) {
  SimplyImage *image = (SimplyImage*) list1_find(self->images, id_filter, (void*)(uintptr_t) id);
  if (image) {
    destroy_image(self, image);
  }

  CreateDataContext context = {
    .size = GSize(width, height),
    .data_length = pixels_length,
    .data = pixels,
  };
  image = IF_SDK_3_ELSE(create_image(self, create_bitmap_with_png_data, &context),
                        create_image(self, create_bitmap_with_data, &context));
  if (image) {
    image->id = id;
    add_image(self, image);
  }
  return image;
}

void simply_res_remove_image(SimplyRes *self, uint32_t id) {
  SimplyImage *image = (SimplyImage*) list1_find(self->images, id_filter, (void*)(uintptr_t) id);
  if (image) {
    destroy_image(self, image);
  }
}

SimplyImage *simply_res_auto_image(SimplyRes *self, uint32_t id, bool is_placeholder) {
  if (!id) {
    return NULL;
  }
  SimplyImage *image = (SimplyImage*) list1_find(self->images, id_filter, (void*)(uintptr_t) id);
  if (image) {
    return image;
  }
  if (id <= self->num_bundled_res) {
    return simply_res_add_bundled_image(self, id);
  }
  if (is_placeholder) {
    return simply_res_add_image(self, id, 0, 0, NULL, 0);
  }
  return NULL;
}

GFont simply_res_add_custom_font(SimplyRes *self, uint32_t id) {
  SimplyFont *font = malloc0(sizeof(*font));
  if (!font) {
    return NULL;
  }

  ResHandle handle = resource_get_handle(id);
  if (!handle) {
    return NULL;
  }

  GFont custom_font = fonts_load_custom_font(handle);
  if (!custom_font) {
    free(font);
    return NULL;
  }

  font->id = id;
  font->font = custom_font;

  list1_prepend(&self->fonts, &font->node);

  window_stack_schedule_top_window_render();

  return font->font;
}

GFont simply_res_auto_font(SimplyRes *self, uint32_t id) {
  if (!id) {
    return NULL;
  }
  SimplyFont *font = (SimplyFont*) list1_find(self->fonts, id_filter, (void*)(uintptr_t) id);
  if (font) {
    return font->font;
  }
  if (id <= self->num_bundled_res) {
    return simply_res_add_custom_font(self, id);
  }
  return NULL;
}

void simply_res_clear(SimplyRes *self) {
  while (self->images) {
    destroy_image(self, (SimplyImage*) self->images);
  }

  while (self->fonts) {
    destroy_font(self, (SimplyFont*) self->fonts);
  }
}

SimplyRes *simply_res_create() {
  SimplyRes *self = malloc(sizeof(*self));
  *self = (SimplyRes) { .images = NULL };

  while (resource_get_handle(self->num_bundled_res + 1)) {
    ++self->num_bundled_res;
  }

  return self;
}

void simply_res_destroy(SimplyRes *self) {
  simply_res_clear(self);
  free(self);
}
