#pragma once

#include "simply_touch.h"

#include <pebble.h>

// The scroll position cue the firmware's MenuLayer shows while a finger
// scrolls it (PebbleOS src/fw/applib/ui/menu_layer.c). This app moves its
// lists from its own touch handler, which the firmware's cue never sees, so
// the same drawing lives here: a thin thumb down the right edge on a
// rectangular display, an arc hugging the bezel at three o'clock on a round
// one. Built for the platforms that draw it: those with a digitizer (the
// menus) and the rectangular ones with a microphone (the assistant, which
// keeps its scrollbar up all the time). Aplite has neither.
#if defined(SIMPLY_HAS_TOUCH) || (defined(PBL_MICROPHONE) && defined(PBL_RECT))
#define SIMPLY_SCROLLBAR 1
#endif

//! How wide a strip the rectangular scrollbar takes at the right edge,
//! including the space around it, for content that must not run under it
#define SIMPLY_SCROLLBAR_INSET 5

#ifdef SIMPLY_SCROLLBAR

//! Draw the scrollbar for `scroll_layer` onto `overlay`, a layer covering the
//! whole window and drawn after the scrolling content. Nothing is drawn when
//! the content fits its frame. `foreground` is the thumb's colour and
//! `background` the colour of what the content is drawn on.
void simply_scrollbar_draw(GContext *ctx, const Layer *overlay, ScrollLayer *scroll_layer,
                           GColor foreground, GColor background);

#endif
