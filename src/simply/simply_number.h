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
  char title[32];
  char unit[12];
};

bool simply_number_handle_packet(Simply *simply, Packet *packet);

//! True while the selector window is on the native stack. Windows covered by
//! it must not report hide events to JS: the JS window stack keeps the page
//! beneath so it is restored when the selector closes.
bool simply_number_is_covering(Simply *simply);

#ifdef SIMPLY_HAS_TOUCH

//! Handle a touch event while the selector is the window on screen: tapping
//! or dragging the bar sets the value, tapping a duration field selects it,
//! and a swipe right leaves. Returns true when the selector consumed the
//! event, which also keeps the generic swipe back from acting on the JS
//! window hidden underneath.
bool simply_number_handle_touch(Simply *simply, const TouchEvent *event);

#endif
