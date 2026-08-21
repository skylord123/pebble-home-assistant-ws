#include "simply_wakeup.h"

#include "simply_msg.h"

#include "simply.h"

#include "util/compat.h"

#include <pebble.h>

typedef struct LaunchReasonPacket LaunchReasonPacket;

struct __attribute__((__packed__)) LaunchReasonPacket {
  Packet packet;
  uint32_t reason;
  uint32_t args;
  uint32_t time;
  uint8_t is_timezone:8;
  //! The watch's own 12 or 24 hour clock setting, so the app can show times
  //! the way the wearer already asked their watch to
  uint8_t is_24h:8;
};

typedef struct WakeupSetPacket WakeupSetPacket;

struct __attribute__((__packed__)) WakeupSetPacket {
  Packet packet;
  time_t timestamp;
  int32_t cookie;
  uint8_t notify_if_missed;
};

typedef struct WakeupSignalPacket WakeupSignalPacket;

struct __attribute__((__packed__)) WakeupSignalPacket {
  Packet packet;
  int32_t id;
  int32_t cookie;
};

typedef struct WakeupCancelPacket WakeupCancelPacket;

struct __attribute__((__packed__)) WakeupCancelPacket {
  Packet packet;
  int32_t id;
};

typedef struct WakeupSetContext WakeupSetContext;

struct WakeupSetContext {
  WakeupId id;
  int32_t cookie;
};

static bool send_launch_reason(AppLaunchReason reason, uint32_t args) {
  LaunchReasonPacket packet = {
    .packet.type = CommandLaunchReason,
    .packet.length = sizeof(packet),
    .reason = reason,
    .args = args,
    .time = time(NULL),
    .is_timezone = clock_is_timezone_set(),
    .is_24h = clock_is_24h_style(),
  };
  return simply_msg_send_packet(&packet.packet);
}

static bool send_wakeup_signal(Command type, WakeupId id, int32_t cookie) {
  WakeupSignalPacket packet = {
    .packet.type = type,
    .packet.length = sizeof(packet),
    .id = id,
    .cookie = cookie,
  };
  return simply_msg_send_packet(&packet.packet);
}

static void wakeup_handler(WakeupId wakeup_id, int32_t cookie) {
  send_wakeup_signal(CommandWakeupEvent, wakeup_id, cookie);
}

static void wakeup_set_timer_callback(void *data) {
  WakeupSetContext *context = data;
  send_wakeup_signal(CommandWakeupSetResult, context->id, context->cookie);
}

static void process_launch_reason() {
  AppLaunchReason reason = launch_reason();
  uint32_t args = launch_get_args();

  send_launch_reason(reason, args);

  WakeupId wakeup_id;
  int32_t cookie;
  if (reason == APP_LAUNCH_WAKEUP && wakeup_get_launch_event(&wakeup_id, &cookie)) {
    wakeup_handler(wakeup_id, cookie);
  }
}

static void handle_wakeup_set(Simply *simply, Packet *data) {
  WakeupSetPacket *packet = (WakeupSetPacket*) data;
  WakeupId id = wakeup_schedule(packet->timestamp, packet->cookie, packet->notify_if_missed);

  WakeupSetContext *context = malloc(sizeof(*context));
  if (!context) {
    return;
  }
  context->id = id;
  context->cookie = packet->cookie;
  app_timer_register(10, wakeup_set_timer_callback, context);
}

static void handle_wakeup_cancel(Simply *simply, Packet *data) {
  WakeupCancelPacket *packet = (WakeupCancelPacket*) data;
  if (packet->id == -1) {
    wakeup_cancel_all();
  } else {
    wakeup_cancel(packet->id);
  }
}

bool simply_wakeup_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandReady:
      process_launch_reason();
      return false;
    case CommandWakeupSet:
      handle_wakeup_set(simply, packet);
      return true;
    case CommandWakeupCancel:
      handle_wakeup_cancel(simply, packet);
      return true;
  }
  return false;
}

void simply_wakeup_init(Simply *simply) {
  wakeup_service_subscribe(wakeup_handler);
}
