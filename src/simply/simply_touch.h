#pragma once

#include "simply_msg.h"
#include "simply.h"

#include <pebble.h>

// The touch digitizer only exists on the platforms that ship one (Pebble
// Time 2 and Core Time 2's round sibling). Everything else compiles the whole
// subsystem away, the same way simply_voice does for aplite's missing
// microphone.
#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_GABBRO)
#define SIMPLY_HAS_TOUCH 1
#endif

typedef struct SimplyTouch SimplyTouch;

struct SimplyTouch {
  Simply *simply;

  // The touch sensor is powered while subscribed, so we only subscribe while
  // the JS side says a window actually wants touch events.
  bool subscribed;

  // Position updates fire continuously while a finger is down and would swamp
  // AppMessage, so they are opt-in and off by default. Taps and swipes are
  // derived on the JS side from touchdown/liftoff alone.
  bool wants_moves;

  // Whether holding a finger on a menu row fires the long select event, so
  // touch can be used for navigation only without triggering entity actions.
  bool long_press;
};

#ifdef SIMPLY_HAS_TOUCH

SimplyTouch *simply_touch_create(Simply *simply);
void simply_touch_destroy(SimplyTouch *self);

bool simply_touch_handle_packet(Simply *simply, Packet *packet);

#else

#define simply_touch_create(simply) NULL
#define simply_touch_destroy(self)

#define simply_touch_handle_packet(simply, packet) (false)

#endif
