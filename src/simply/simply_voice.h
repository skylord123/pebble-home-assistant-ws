#pragma once

#include "simply_msg.h"
#include "simply.h"
#include "util/compat.h"

#include <pebble.h>

#define SIMPLY_VOICE_BUFFER_LENGTH 512

typedef struct SimplyVoice SimplyVoice;

struct SimplyVoice {
  Simply *simply;
  DictationSession *session;
  AppTimer *timer;

  bool in_progress;

  //! Whose session this is. The native assist screen shows the transcript
  //! itself the moment it arrives, so its results go straight to
  //! simply_assist rather than out to a JS Voice.dictate() callback.
  bool for_assist;
};

#if defined(PBL_PLATFORM_APLITE)

#define simply_voice_create(simply) NULL
#define simply_voice_destroy(self)

#define simply_voice_handle_packet(simply, packet) (false)

#define simply_voice_dictation_in_progress() (false)

#define simply_voice_start(simply, enable_confirmation, for_assist) (false)

#else

SimplyVoice *simply_voice_create(Simply *simply);
void simply_voice_destroy(SimplyVoice *self);

bool simply_voice_handle_packet(Simply *simply, Packet *packet);

bool simply_voice_dictation_in_progress();

//! Open the microphone. There is only ever one dictation session, so
//! `for_assist` records where its result should go: to the native assist
//! screen, or back to JS as a Voice.dictate() callback. Returns false when a
//! session is already running.
bool simply_voice_start(Simply *simply, bool enable_confirmation, bool for_assist);

#endif
