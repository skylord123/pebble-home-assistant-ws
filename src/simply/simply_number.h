#pragma once

#include "simply.h"

#include "simply_msg.h"

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
