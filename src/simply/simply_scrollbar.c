#include "simply_scrollbar.h"

#ifdef SIMPLY_SCROLLBAR

// The firmware's own numbers, so the two are indistinguishable on screen
#define SCROLLBAR_WIDTH 3
#define SCROLLBAR_MARGIN 1
#define SCROLLBAR_MIN_THUMB_HEIGHT 8
//! The round track spans 30 degrees either side of three o'clock
#define SCROLLBAR_TRACK_SWEEP DEG_TO_TRIGANGLE(60)
#define SCROLLBAR_MIN_THUMB_SWEEP DEG_TO_TRIGANGLE(10)

static int32_t prv_clip(int32_t value, int32_t low, int32_t high) {
  return value < low ? low : (value > high ? high : value);
}

#if defined(PBL_ROUND)

//! An arc band with round ends. graphics_fill_radial cuts its ends flat, so a
//! dot the width of the band finishes each one. The SDK's radial fill takes a
//! rect, works out a centre half a pixel inside its middle and a radius half
//! a pixel short of its half side, then moves both back out by that half: on
//! a square of side 2r it lands on exactly the centre and radius the firmware
//! hands its own internal fill, so the two rasterise the same pixels.
static void prv_fill_capped_arc(GContext *ctx, GPoint center, int16_t radius_outer,
                                int16_t thickness, int32_t angle_start, int32_t angle_end) {
  const GRect circle = GRect(center.x - radius_outer, center.y - radius_outer,
                             2 * radius_outer, 2 * radius_outer);
  graphics_fill_radial(ctx, circle, GOvalScaleModeFitCircle, thickness, angle_start, angle_end);
  const int32_t radius_mid = radius_outer - thickness / 2;
  const int32_t angles[2] = { angle_start, angle_end };
  for (int i = 0; i < 2; ++i) {
    const GPoint cap = GPoint(
        center.x + (int16_t)((radius_mid * sin_lookup(angles[i])) / TRIG_MAX_RATIO),
        center.y - (int16_t)((radius_mid * cos_lookup(angles[i])) / TRIG_MAX_RATIO));
    graphics_fill_circle(ctx, cap, thickness / 2);
  }
}

void simply_scrollbar_draw(GContext *ctx, const Layer *overlay, ScrollLayer *scroll_layer,
                           GColor foreground, GColor background) {
  const GRect frame = layer_get_frame(scroll_layer_get_layer(scroll_layer));
  const int16_t content_h = scroll_layer_get_content_size(scroll_layer).h;
  const int16_t scrollable_h = content_h - frame.size.h;
  if (scrollable_h <= 0) { return; }

  const int32_t track_sweep = SCROLLBAR_TRACK_SWEEP;
  const int32_t thumb_sweep = prv_clip((track_sweep * frame.size.h) / content_h,
                                       SCROLLBAR_MIN_THUMB_SWEEP, track_sweep);
  // A centre focused menu scrolls past both ends of its content; the thumb
  // stops at the track's
  const int32_t progress = prv_clip(-scroll_layer_get_content_offset(scroll_layer).y,
                                    0, scrollable_h);
  const int32_t track_start = DEG_TO_TRIGANGLE(90) - track_sweep / 2;
  const int32_t thumb_start = track_start + ((track_sweep - thumb_sweep) * progress) / scrollable_h;

  // The arc follows the glass, not the frame: a list under a status bar would
  // otherwise float its arc into the rows. The overlay covers the window, so
  // its bounds are the display.
  const GSize display = layer_get_bounds(overlay).size;
  const GPoint center = GPoint(display.w / 2, display.h / 2);
  const int16_t radius_outer =
      (display.w < display.h ? display.w : display.h) / 2 - SCROLLBAR_MARGIN;

  graphics_context_set_antialiased(ctx, true);
  // The whole track first, in the grey nearer the background, so the thumb
  // reads as a position along it
  const int luminance = background.r + background.g + background.b;
  graphics_context_set_fill_color(ctx, luminance >= 5 ? GColorLightGray : GColorDarkGray);
  prv_fill_capped_arc(ctx, center, radius_outer, SCROLLBAR_WIDTH,
                      track_start, track_start + track_sweep);
  graphics_context_set_fill_color(ctx, foreground);
  prv_fill_capped_arc(ctx, center, radius_outer, SCROLLBAR_WIDTH,
                      thumb_start, thumb_start + thumb_sweep);
}

#else

void simply_scrollbar_draw(GContext *ctx, const Layer *overlay, ScrollLayer *scroll_layer,
                           GColor foreground, GColor background) {
  const GRect frame = layer_get_frame(scroll_layer_get_layer(scroll_layer));
  const int16_t content_h = scroll_layer_get_content_size(scroll_layer).h;
  const int16_t scrollable_h = content_h - frame.size.h;
  const int16_t track_h = frame.size.h - 2 * SCROLLBAR_MARGIN;
  if (scrollable_h <= 0 || track_h <= SCROLLBAR_MIN_THUMB_HEIGHT) { return; }

  const int16_t thumb_h = prv_clip(((int32_t)track_h * frame.size.h) / content_h,
                                   SCROLLBAR_MIN_THUMB_HEIGHT, track_h);
  const int16_t progress = prv_clip(-scroll_layer_get_content_offset(scroll_layer).y,
                                    0, scrollable_h);
  const int16_t thumb_y = SCROLLBAR_MARGIN +
      ((int32_t)(track_h - thumb_h) * progress) / scrollable_h;

  // The overlay shares the window's coordinates, so the frame places the thumb
  const GRect thumb = GRect(frame.origin.x + frame.size.w - SCROLLBAR_MARGIN - SCROLLBAR_WIDTH,
                            frame.origin.y + thumb_y, SCROLLBAR_WIDTH, thumb_h);
  // A one pixel halo in the background colour keeps the thumb visible over
  // the highlighted row as well as the plain ones
  const GRect halo = grect_inset(thumb, GEdgeInsets(-1));
  graphics_context_set_fill_color(ctx, background);
  graphics_fill_rect(ctx, halo, 2, GCornersAll);
  graphics_context_set_fill_color(ctx, foreground);
  graphics_fill_rect(ctx, thumb, 1, GCornersAll);
}

#endif  // PBL_ROUND

#endif  // SIMPLY_SCROLLBAR
