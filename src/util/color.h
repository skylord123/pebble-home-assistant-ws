#pragma once

#include "util/compat.h"

#include <pebble.h>

#define GColor8White (GColor8){.argb=GColorWhiteARGB8}
#define GColor8Black (GColor8){.argb=GColorBlackARGB8}
#define GColor8Clear (GColor8){.argb=GColorClearARGB8}
#define GColor8ClearWhite (GColor8){.argb=0x3F}

#ifndef PBL_SDK_3

static inline GColor gcolor8_get(GColor8 color) {
  switch (color.argb) {
    case GColorWhiteARGB8: return GColorWhite;
    case GColorBlackARGB8: return GColorBlack;
    default: return GColorClear;
  }
}

static inline GColor gcolor8_get_or(GColor8 color, GColor fallback) {
  switch (color.argb) {
    case GColorWhiteARGB8: return GColorWhite;
    case GColorBlackARGB8: return GColorBlack;
    case GColorClearARGB8: return GColorClear;
    default: return fallback;
  }
}

static inline GColor8 gcolor_get8(GColor color) {
  switch (color) {
    case GColorWhite: return GColor8White;
    case GColorBlack: return GColor8Black;
    default: return GColor8Clear;
  }
}

static inline bool gcolor8_equal_native(GColor8 color, GColor other) {
  return (color.argb == gcolor_get8(other).argb);
}

static inline GColor8 gcolor_legible_over(GColor8 background_color) {
  const int sum = background_color.r + background_color.g + background_color.b;
  const int avg = sum / 3;
  return (avg >= 2) ? GColor8Black : GColor8White;
}

#else

static inline GColor gcolor8_get(GColor8 color) {
  return color;
}

static inline GColor gcolor8_get_or(GColor8 color, GColor8 fallback) {
  return color;
}

#define gcolor8_equal_native gcolor8_equal

#endif

static inline bool gcolor8_equal(GColor8 color, GColor8 other) {
  return (color.argb == other.argb);
}

//! Whether black shows up on this color better than white does. Each channel
//! runs 0-3, so this is the lighter half of the sixty-four colors: white, the
//! greys above mid, and anything with a couple of channels near full. On the
//! black and white displays it is simply white against black. A transparent
//! color counts as dark, which is what an unset background leaves showing.
static inline bool gcolor8_is_light(GColor8 color) {
  return (color.a != 0) && (color.r + color.g + color.b >= 5);
}
