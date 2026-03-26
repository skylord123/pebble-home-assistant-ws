#pragma once

#include "simply_msg.h"
#include "simply.h"

#include <pebble.h>

typedef struct SimplyWatchData SimplyWatchData;

struct SimplyWatchData {
  Simply *simply;
  bool enabled;
};

SimplyWatchData *simply_watchdata_create(Simply *simply);
void simply_watchdata_destroy(SimplyWatchData *self);

bool simply_watchdata_handle_packet(Simply *simply, Packet *packet);
