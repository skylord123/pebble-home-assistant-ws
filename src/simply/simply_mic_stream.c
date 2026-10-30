#include "simply_mic_stream.h"

#if defined(SIMPLY_HAS_MIC_STREAM)

#include <pebble_process_info.h>

#include <stddef.h>
#include <string.h>

// The first firmware with the stream functions. 4.42 and earlier stop at SDK
// revision 109, whose table ends one entry before the first of them, so a call
// there would jump through whatever happens to follow the table in memory.
#define MIC_STREAM_FIRMWARE_MAJOR 4
#define MIC_STREAM_FIRMWARE_MINOR 43

// Where the two functions used here sit in the firmware's table of exported functions.
// The table only ever grows: a function keeps its slot for good, and new ones
// are added after the last revision's. These are revision 110's, read from
// the firmware's exported_symbols.json, and the same on every platform that
// has them.
#define MIC_STREAM_START_INDEX 678
#define MIC_STREAM_STOP_INDEX 679

//! The firmware's MicStreamHandlers, two function pointers passed by value
typedef struct {
  SimplyMicStreamStartedHandler started;
  void (*stopped)(uint32_t reason, void *context);
} FirmwareMicStreamHandlers;

// The firmware is built with short enums, so its results come back a byte wide
// in a register whose upper bits mean nothing
typedef uint32_t (*MicStreamStartFn)(FirmwareMicStreamHandlers handlers, void *context);
typedef void (*MicStreamStopFn)(void);

//! The app's own header, which the build places at the very start of the app.
//! The loader writes the address of the firmware's function table into it, at
//! the offset its sym_table_addr field gives, which is the same slot every
//! SDK function finds the table through.
extern const PebbleProcessInfo __pbl_app_info;

static SimplyMicStreamStartedHandler s_started;
static SimplyMicStreamStoppedHandler s_stopped;

static void *const *prv_function_table(void) {
  // Read through volatile: the header is const as far as the compiler knows,
  // but both of these were filled in after it compiled this, the offset by the
  // build and the table address by the loader
  const volatile uint8_t *header = (const volatile uint8_t *)&__pbl_app_info;
  uint32_t offset = 0;
  for (size_t i = 0; i < sizeof(offset); ++i) {
    ((uint8_t *)&offset)[i] = header[offsetof(PebbleProcessInfo, sym_table_addr) + i];
  }
  void *const *table = NULL;
  for (size_t i = 0; i < sizeof(table); ++i) {
    ((uint8_t *)&table)[i] = header[offset + i];
  }
  return table;
}

static void *prv_function(uint16_t index) {
  void *const *table = prv_function_table();
  return table ? table[index] : NULL;
}

bool simply_mic_stream_available(void) {
  static int8_t s_available = -1;
  if (s_available < 0) {
    const WatchInfoVersion version = watch_info_get_firmware_version();
    s_available = (version.major > MIC_STREAM_FIRMWARE_MAJOR ||
                   (version.major == MIC_STREAM_FIRMWARE_MAJOR &&
                    version.minor >= MIC_STREAM_FIRMWARE_MINOR)) &&
                  prv_function(MIC_STREAM_START_INDEX) &&
                  prv_function(MIC_STREAM_STOP_INDEX);
  }
  return s_available;
}

//! The firmware's callback, which hands its byte-wide reason on as the enum
static void prv_stopped(uint32_t reason, void *context) {
  SimplyMicStreamStoppedHandler stopped = s_stopped;
  s_started = NULL;
  s_stopped = NULL;
  if (stopped) {
    stopped((SimplyMicStreamStop)(reason & 0xFF), context);
  }
}

static void prv_started(void *context) {
  if (s_started) {
    s_started(context);
  }
}

SimplyMicStreamStart simply_mic_stream_start(SimplyMicStreamStartedHandler started,
                                             SimplyMicStreamStoppedHandler stopped,
                                             void *context) {
  if (!simply_mic_stream_available()) {
    return SimplyMicStreamStartUnavailable;
  }
  MicStreamStartFn start = (MicStreamStartFn)prv_function(MIC_STREAM_START_INDEX);
  s_started = started;
  s_stopped = stopped;
  const SimplyMicStreamStart result = (SimplyMicStreamStart)(start((FirmwareMicStreamHandlers) {
    .started = prv_started,
    .stopped = prv_stopped,
  }, context) & 0xFF);
  if (result != SimplyMicStreamStartOk) {
    s_started = NULL;
    s_stopped = NULL;
  }
  return result;
}

void simply_mic_stream_stop(void) {
  // Cleared first: a stream stopped from here has no stopped call, and nothing
  // that arrives for it afterwards is anyone's business
  s_started = NULL;
  s_stopped = NULL;
  if (!simply_mic_stream_available()) {
    return;
  }
  MicStreamStopFn stop = (MicStreamStopFn)prv_function(MIC_STREAM_STOP_INDEX);
  stop();
}

#endif
