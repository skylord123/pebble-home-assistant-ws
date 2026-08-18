#pragma once

#include "simply.h"

#include "util/color.h"
#include "util/list1.h"

#include <pebble.h>

#define simply_res_get_image(self, id) simply_res_auto_image(self, id, false)

#define simply_res_get_font(self, id) simply_res_auto_font(self, id)

typedef struct SimplyRes SimplyRes;

struct SimplyRes {
  List1Node *images;
  List1Node *fonts;
  uint32_t num_bundled_res;
};

typedef struct SimplyResItemCommon SimplyResItemCommon;

#define SimplyResItemCommonDef { \
  List1Node node;                \
  uint32_t id;                   \
}

struct SimplyResItemCommon SimplyResItemCommonDef;

#define SimplyResItemCommonMember      \
  union {                              \
    struct SimplyResItemCommon common; \
    struct SimplyResItemCommonDef;     \
  }

typedef struct SimplyImage SimplyImage;

struct SimplyImage {
  SimplyResItemCommonMember;
  uint8_t *bitmap_data;
  GBitmap *bitmap;
  GColor8 *palette;
  //! Number of palette entries the bitmap's pixels actually reference, or 0
  //! for non-palettized formats. Used to invert icon colors on highlighted
  //! menu rows without reading past the palette allocation.
  uint16_t palette_entries;
  bool is_palette_black_and_white:1;
};

typedef struct SimplyFont SimplyFont;

struct SimplyFont {
  SimplyResItemCommonMember;
  GFont font;
};

SimplyRes *simply_res_create();
void simply_res_destroy(SimplyRes *self);
void simply_res_clear(SimplyRes *self);

SimplyImage *simply_res_add_bundled_image(SimplyRes *self, uint32_t id);
SimplyImage *simply_res_add_image(SimplyRes *self, uint32_t id, int16_t width, int16_t height,
                                  uint8_t *pixels, uint16_t pixels_length);
SimplyImage *simply_res_auto_image(SimplyRes *self, uint32_t id, bool is_placeholder);
bool simply_res_evict_image(SimplyRes *self);

GFont simply_res_add_custom_font(SimplyRes *self, uint32_t id);
GFont simply_res_auto_font(SimplyRes *self, uint32_t id);

void simply_res_remove_image(SimplyRes *self, uint32_t id);
