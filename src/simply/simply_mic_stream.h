#pragma once

#include <pebble.h>

// Streaming the microphone to PebbleKit JS, which hands the audio to Home
// Assistant so its own speech-to-text hears the wearer instead of the phone's
// dictation service.
//
// Firmware 4.43 added this as mic_stream_to_phone_start() and friends, SDK
// revision 110. No SDK with it has been published, and building against one
// would not help anyway: the firmware refuses to run an app built for a newer
// SDK revision than its own, so the whole app would stop opening on every
// watch that has not updated yet. The app keeps building against the SDK it
// always has and reaches the three functions through the firmware's own table
// of exported functions instead, only once the running firmware is known to
// have them. Older firmware never sees the call and keeps using dictation.
//
// Only the platforms Core still builds firmware for can have it. Aplite,
// basalt, chalk and diorite are frozen at an older revision whose table ends
// long before these entries, so the whole thing compiles away there.

#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_FLINT) || defined(PBL_PLATFORM_GABBRO)
#define SIMPLY_HAS_MIC_STREAM 1
#endif

//! Mirrors MicStreamStartResult in the firmware's applib/mic_stream.h
typedef enum SimplyMicStreamStart {
  //! Asked for. `started` follows once the phone accepts, or `stopped` if it
  //! does not.
  SimplyMicStreamStartOk = 0,
  //! The microphone is in use, by this app or by the system
  SimplyMicStreamStartBusy,
  SimplyMicStreamStartNotForeground,
  SimplyMicStreamStartInvalidArgs,
  SimplyMicStreamStartNoMemory,
  SimplyMicStreamStartWatchface,
  //! No microphone, or no phone connected
  SimplyMicStreamStartUnavailable,
} SimplyMicStreamStart;

//! Mirrors MicStreamStopReason in the firmware's applib/mic_stream.h
typedef enum SimplyMicStreamStop {
  SimplyMicStreamStopStopped = 0,
  //! Something took the screen, such as a notification
  SimplyMicStreamStopFocusLost,
  //! The system took the microphone, such as for dictation
  SimplyMicStreamStopInterrupted,
  //! The phone refused, ended or lost the stream. Before `started` this is
  //! also how a phone app that knows nothing about streams shows up, once the
  //! firmware has waited long enough for an answer.
  SimplyMicStreamStopPhone,
  SimplyMicStreamStopError,
} SimplyMicStreamStop;

typedef void (*SimplyMicStreamStartedHandler)(void *context);
typedef void (*SimplyMicStreamStoppedHandler)(SimplyMicStreamStop reason, void *context);

#if defined(SIMPLY_HAS_MIC_STREAM)

//! Whether the running firmware can stream at all. Says nothing about the
//! phone, which only answers once asked.
bool simply_mic_stream_available(void);

//! Start streaming to this app's PebbleKit JS. `stopped` is called when the
//! stream ends for any reason other than simply_mic_stream_stop(), including
//! the phone refusing it before it ever started.
SimplyMicStreamStart simply_mic_stream_start(SimplyMicStreamStartedHandler started,
                                             SimplyMicStreamStoppedHandler stopped,
                                             void *context);

//! Stop streaming. No `stopped` call follows. Safe when not streaming.
void simply_mic_stream_stop(void);

#else

#define simply_mic_stream_available() (false)
// The handlers are named rather than dropped, so a caller's callbacks do not
// read as unused on the platforms that can never stream
#define simply_mic_stream_start(started, stopped, context) \
  ((void)(started), (void)(stopped), (void)(context), SimplyMicStreamStartUnavailable)
#define simply_mic_stream_stop()

#endif
