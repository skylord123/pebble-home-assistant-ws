#pragma once

#include "simply.h"

#include <pebble.h>

typedef struct SimplySplash SimplySplash;

struct SimplySplash {
  Simply *simply;
  Window *window;
#if defined(SPLASH_TEXT)
  TextLayer *title_layer;
  TextLayer *subtitle_layer;
#else
  GBitmap *image;
#endif
};

SimplySplash *simply_splash_create(Simply *simply);

void simply_splash_destroy(SimplySplash *self);
