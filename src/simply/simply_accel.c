#include "simply_accel.h"

#include "simply_msg.h"

#include "simply.h"

#include <pebble.h>

typedef Packet AccelPeekPacket;

typedef struct AccelConfigPacket AccelConfigPacket;

struct __attribute__((__packed__)) AccelConfigPacket {
  Packet packet;
  uint16_t num_samples;
  AccelSamplingRate rate:8;
  bool data_subscribed;
};

typedef struct AccelTapPacket AccelTapPacket;

struct __attribute__((__packed__)) AccelTapPacket {
  Packet packet;
  AccelAxisType axis:8;
  int8_t direction;
};

typedef struct AccelDataPacket AccelDataPacket;

struct __attribute__((__packed__)) AccelDataPacket {
  Packet packet;
  bool is_peek;
  uint8_t num_samples;
  AccelData data[];
};

static SimplyAccel *s_accel = NULL;

static bool send_accel_tap(AccelAxisType axis, int32_t direction) {
  AccelTapPacket packet = {
    .packet.type = CommandAccelTap,
    .packet.length = sizeof(packet),
    .axis = axis,
    .direction = direction,
  };
  return simply_msg_send_packet(&packet.packet);
}

// The app never streams accelerometer data or peeks it, so aplite (where
// the binary shares 24KB of app RAM with the heap) keeps only tap events,
// which feed the inactivity timeout's activity detection
#if !defined(PBL_PLATFORM_APLITE)
static bool send_accel_data(SimplyMsg *self, AccelData *data, uint32_t num_samples, bool is_peek) {
  size_t data_length = sizeof(AccelData) * num_samples;
  size_t length = sizeof(AccelDataPacket) + data_length;
  AccelDataPacket *packet = malloc(length);
  if (!packet) {
    return false;
  }
  packet->packet = (Packet) {
    .type = CommandAccelData,
    .length = length,
  };
  packet->is_peek = is_peek;
  packet->num_samples = num_samples;
  memcpy(packet->data, data, data_length);
  bool result = simply_msg_send((uint8_t*) packet, length);
  free(packet);
  return result;
}

static void handle_accel_data(AccelData *data, uint32_t num_samples) {
  send_accel_data(s_accel->simply->msg, data, num_samples, false);
}

static void set_data_subscribe(SimplyAccel *self, bool subscribe) {
  if (self->data_subscribed == subscribe) {
    return;
  }
  if (subscribe) {
    accel_data_service_subscribe(self->num_samples, handle_accel_data);
    accel_service_set_sampling_rate(self->rate);
  } else {
    accel_data_service_unsubscribe();
  }
  self->data_subscribed = subscribe;
}

#endif

static void handle_accel_tap(AccelAxisType axis, int32_t direction) {
  send_accel_tap(axis, direction);
}

#if !defined(PBL_PLATFORM_APLITE)

static void accel_peek_timer_callback(void *context) {
  Simply *simply = context;
  AccelData data = { .x = 0 };
  if (s_accel->data_subscribed) {
    accel_service_peek(&data);
  }
  if (!send_accel_data(simply->msg, &data, 1, true)) {
    app_timer_register(10, accel_peek_timer_callback, simply);
  }
}

static void handle_accel_peek_packet(Simply *simply, Packet *data) {
  app_timer_register(10, accel_peek_timer_callback, simply);
}

static void handle_accel_config_packet(Simply *simply, Packet *data) {
  AccelConfigPacket *packet = (AccelConfigPacket*) data;
  s_accel->num_samples = packet->num_samples;
  s_accel->rate = packet->rate;
  set_data_subscribe(simply->accel, packet->data_subscribed);
}
#endif

bool simply_accel_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandAccelPeek:
#if !defined(PBL_PLATFORM_APLITE)
      handle_accel_peek_packet(simply, packet);
#endif
      return true;
    case CommandAccelConfig:
#if !defined(PBL_PLATFORM_APLITE)
      handle_accel_config_packet(simply, packet);
#endif
      return true;
  }
  return false;
}

SimplyAccel *simply_accel_create(Simply *simply) {
  if (s_accel) {
    return s_accel;
  }

  SimplyAccel *self = malloc(sizeof(*self));
  *self = (SimplyAccel) {
    .simply = simply,
    .rate = ACCEL_SAMPLING_100HZ,
    .num_samples = 25,
  };
  s_accel = self;

  accel_tap_service_subscribe(handle_accel_tap);

  return self;
}

void simply_accel_destroy(SimplyAccel *self) {
  if (!self) {
    return;
  }

  accel_tap_service_unsubscribe();

  free(self);

  s_accel = NULL;
}

