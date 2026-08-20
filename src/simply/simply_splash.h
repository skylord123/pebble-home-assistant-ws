#pragma once

#include "simply.h"

#include "simply_msg.h"

#include <pebble.h>

typedef struct SimplySplash SimplySplash;

struct SimplySplash {
  Simply *simply;
  Window *window;
  AppTimer *timer;
  uint16_t tick;
  int16_t ring_r0;
  int16_t ring_r1;
  uint8_t mode;
  bool destroying;
  char title[32];
  char status[64];
  char body[96];
};

SimplySplash *simply_splash_create(Simply *simply);

void simply_splash_destroy(SimplySplash *self);

bool simply_splash_handle_packet(Simply *simply, Packet *packet);

//! True while the splash window is on the native stack. Windows covered by
//! the splash must not report hide events to JS: the JS window stack should
//! stay as it was so the same page is restored when the splash goes away.
bool simply_splash_is_covering(Simply *simply);

//! Returns true once after the splash leaves the screen: the window revealed
//! beneath it reloaded empty while covered, so its appear handler must send a
//! show event to JS to trigger a re-render even though JS did not push it.
bool simply_splash_consume_reveal(void);

//! Ask JS to re-render its top window after the splash revealed it
bool simply_splash_send_reveal(void);
