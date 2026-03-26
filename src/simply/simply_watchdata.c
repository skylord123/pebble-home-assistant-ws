#include "simply_watchdata.h"

#include "simply_msg.h"

#include "simply.h"

#include <pebble.h>

typedef struct WatchDataPacket WatchDataPacket;

struct __attribute__((__packed__)) WatchDataPacket {
  Packet packet;
  uint8_t battery;
  uint8_t charging;
  int32_t steps;
};

typedef struct WatchDataEnablePacket WatchDataEnablePacket;

struct __attribute__((__packed__)) WatchDataEnablePacket {
  Packet packet;
  uint8_t enabled;
};

static SimplyWatchData *s_watchdata = NULL;

static void send_watch_data(void) {
  if (!s_watchdata || !s_watchdata->enabled) { return; }

  BatteryChargeState charge = battery_state_service_peek();
  int32_t steps = 0;
#if defined(PBL_HEALTH)
  steps = (int32_t)health_service_sum_today(HealthMetricStepCount);
#endif

  WatchDataPacket packet = {
    .packet.type = CommandWatchData,
    .packet.length = sizeof(WatchDataPacket),
    .battery = charge.charge_percent,
    .charging = charge.is_charging ? 1 : 0,
    .steps = steps,
  };
  simply_msg_send_packet(&packet.packet);
}

static void battery_handler(BatteryChargeState charge) {
  send_watch_data();
}

static void handle_watchdata_enable_packet(Simply *simply, Packet *data) {
  SimplyWatchData *self = simply->watchdata;
  if (!self) { return; }

  WatchDataEnablePacket *packet = (WatchDataEnablePacket *)data;
  self->enabled = packet->enabled;

  if (self->enabled) {
    battery_state_service_subscribe(battery_handler);
    send_watch_data();
  } else {
    battery_state_service_unsubscribe();
  }
}

bool simply_watchdata_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandWatchDataEnable:
      handle_watchdata_enable_packet(simply, packet);
      return true;
  }
  return false;
}

SimplyWatchData *simply_watchdata_create(Simply *simply) {
  if (s_watchdata) {
    return s_watchdata;
  }

  SimplyWatchData *self = malloc(sizeof(*self));
  if (!self) { return NULL; }

  *self = (SimplyWatchData) {
    .simply = simply,
    .enabled = false,
  };

  s_watchdata = self;
  return self;
}

void simply_watchdata_destroy(SimplyWatchData *self) {
  if (!self) { return; }

  if (self->enabled) {
    battery_state_service_unsubscribe();
  }

  free(self);
  s_watchdata = NULL;
}
