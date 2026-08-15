#pragma once

#include "simply.h"

#include <pebble.h>

typedef struct SimplySplash SimplySplash;

struct SimplySplash {
  Simply *simply;
  Window *window;
  const char *title;
  const char *subtitle;
  TextLayer *title_layer;
  TextLayer *subtitle_layer;
  BitmapLayer *logo_layer;
  GBitmap *image;
};

SimplySplash *simply_splash_create(Simply *simply);

void simply_splash_set_title(SimplySplash *self, const char *title);
void simply_splash_set_subtitle(SimplySplash *self, const char *subtitle);

void simply_splash_destroy(SimplySplash *self);
