#pragma once

#include "simply.h"

#include "simply_msg.h"
#include "simply_touch.h"

#include <pebble.h>

typedef struct SimplyNumber SimplyNumber;

//! A native number selector window: JS sends the range and value once and
//! every up/down press (including hold-to-repeat with acceleration) runs
//! entirely on the watch. Select reports the chosen value back to JS, which
//! performs the service call and then hides the selector on success. All
//! values travel as integers pre-scaled by 10^decimals so no floating point
//! is needed on the watch.
struct SimplyNumber {
  Simply *simply;
  Window *window;
  int32_t value;
  int32_t min;
  int32_t max;
  int32_t step;
  uint8_t decimals;
  bool show_bar;
  bool destroying;
  //! Duration mode shows the value as HH:MM:SS and edits it one field at a
  //! time. The value stays a single count of seconds; the selected field
  //! only decides how much a press adds or subtracts.
  bool duration_mode;
  //! A time of day rather than a length of time: hours read 1 to 12 beside
  //! an AM/PM field on a 12 hour watch, and 00 to 23 on a 24 hour one.
  bool time_of_day;
  //! Selected field: hours, minutes, seconds, then AM/PM where it is shown
  uint8_t field;
  //! Millisecond timestamp of the last button press, used to ignore external
  //! value updates while the user is actively adjusting
  int64_t last_input_ms;
  //! Report the value to JS once it stops changing, without waiting for
  //! select, so an entity can follow along as it is dialled. Opt in per
  //! selector: a value that is only meaningful once confirmed (a timer's
  //! duration, a date) must not act on every intermediate number.
  bool live;
  //! Pending settle timer, and the value the last change event carried so a
  //! value dialled away from and back to does not report twice
  AppTimer *settle_timer;
  int32_t last_sent_value;
  //! The menu's own colours, so the selector is not a white window thrown up
  //! over a dark list. The selected duration field swaps them rather than
  //! assuming black on white.
  GColor8 background_color;
  GColor8 text_color;
  char title[32];
  char unit[12];
};

#if defined(PBL_PLATFORM_APLITE)

#define simply_number_handle_packet(simply, packet) (false)
#define simply_number_is_covering(simply) (false)

#else

bool simply_number_handle_packet(Simply *simply, Packet *packet);

//! True while the selector window is on the native stack. Windows covered by
//! it must not report hide events to JS: the JS window stack keeps the page
//! beneath so it is restored when the selector closes.
bool simply_number_is_covering(Simply *simply);

#endif

#ifdef SIMPLY_HAS_TOUCH

//! Handle a touch event while the selector is the window on screen: tapping
//! or dragging the bar sets the value, tapping a duration field selects it,
//! and a swipe right leaves. Returns true when the selector consumed the
//! event, which also keeps the generic swipe back from acting on the JS
//! window hidden underneath.
bool simply_number_handle_touch(Simply *simply, const TouchEvent *event);

#endif
