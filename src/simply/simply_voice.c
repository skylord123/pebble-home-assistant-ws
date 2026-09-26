#include "simply_voice.h"

#include "simply_assist.h"
#include "simply_msg.h"

#include "simply.h"

#include <pebble.h>

#if !defined(PBL_PLATFORM_APLITE)
typedef struct VoiceStartPacket VoiceStartPacket;

struct __attribute__((__packed__)) VoiceStartPacket {
  Packet packet;
  bool enable_confirmation;
};


typedef struct VoiceDataPacket VoiceDataPacket;

struct __attribute__((__packed__)) VoiceDataPacket {
  Packet packet;
  int8_t status;
  char result[];
};

static SimplyVoice *s_voice;

static bool send_voice_data(int status, char *transcription) {
  // Handle NULL Case
  if (transcription == NULL) {
    return send_voice_data(DictationSessionStatusFailureSystemAborted, "");
  }

  // Handle success case
  size_t transcription_length = strlen(transcription) + 1;
  size_t packet_length = sizeof(VoiceDataPacket) + transcription_length;

  uint8_t buffer[packet_length];
  VoiceDataPacket *packet = (VoiceDataPacket *)buffer;
  *packet = (VoiceDataPacket) {
    .packet.type = CommandVoiceData,
    .packet.length = packet_length,
    .status = (uint8_t) status,
  };

  strncpy(packet->result, transcription, transcription_length);

  return simply_msg_send_packet(&packet->packet);
}

//! A transcript longer than the buffer is cut short, which can land part way
//! through a character, and the phone cannot decode half of one
static void prv_trim_partial_utf8(char *text) {
  size_t length = strlen(text);
  size_t start = length;
  while (start > 0 && ((unsigned char)text[start - 1] & 0xC0) == 0x80) { start--; }
  if (start == 0) { return; }
  const unsigned char lead = (unsigned char)text[start - 1];
  const size_t expected = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
  if (length - (start - 1) < expected) {
    text[start - 1] = '\0';
  }
}

// Define a callback for the dictation session
static void dictation_session_callback(DictationSession *session, DictationSessionStatus status,
                                       char *transcription, void *context) {
  s_voice->in_progress = false;
  if (transcription) {
    prv_trim_partial_utf8(transcription);
  }

  // The assist screen draws its own result, so it never crosses the bridge as
  // a Voice.dictate() callback
  if (s_voice->for_assist) {
    s_voice->for_assist = false;
    simply_assist_handle_dictation(s_voice->simply, status, transcription);
    return;
  }

  // Send the result
  send_voice_data(status, transcription);
}

static void timer_callback_start_dictation(void *data) {
  s_voice->timer = NULL;
  // The session can only be created while the phone is connected, so one that
  // failed at launch is tried again here
  if (!s_voice->session) {
    s_voice->session = dictation_session_create(SIMPLY_VOICE_BUFFER_LENGTH,
                                                dictation_session_callback, NULL);
  }
  if (!s_voice->session) {
    dictation_session_callback(NULL, DictationSessionStatusFailureConnectivityError, NULL, NULL);
    return;
  }
  dictation_session_enable_confirmation(s_voice->session, (bool)(uintptr_t) data);
  // A session that refuses to start never calls back, which would leave
  // in_progress set for good
  const DictationSessionStatus status = dictation_session_start(s_voice->session);
  if (status != DictationSessionStatusSuccess) {
    dictation_session_callback(s_voice->session, status, NULL, NULL);
  }
}

bool simply_voice_start(Simply *simply, bool enable_confirmation, bool for_assist) {
  if (!s_voice || s_voice->in_progress) {
    return false;
  }

  // Start on a timer so the caller can return as quickly as possible
  s_voice->in_progress = true;
  s_voice->for_assist = for_assist;
  s_voice->timer = app_timer_register(0, timer_callback_start_dictation,
                                      (void *)(uintptr_t) enable_confirmation);
  return true;
}

static void handle_voice_start_packet(Simply *simply, Packet *data) {
  // Send an immediate response if there's already a dictation session in progress
  // Status 64 = SessionAlreadyInProgress
  if (!s_voice || s_voice->in_progress) {
    send_voice_data(64, "");
    return;
  }

  VoiceStartPacket *packet = (VoiceStartPacket*) data;
  simply_voice_start(simply, packet->enable_confirmation, false);
}

static void handle_voice_stop_packet(Simply *simply, Packet *data) {
  if (!s_voice) { return; }
  // Stop the session and clear the in_progress flag
  if (s_voice->session) {
    dictation_session_stop(s_voice->session);
  }
  s_voice->in_progress = false;
}

bool simply_voice_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandVoiceStart:
      handle_voice_start_packet(simply, packet);
      return true;
    case CommandVoiceStop:
      handle_voice_stop_packet(simply, packet);
      return true;
  }

  return false;
}

SimplyVoice *simply_voice_create(Simply *simply) {
  if (s_voice) {
    return s_voice;
  }

  SimplyVoice *self = malloc(sizeof(*self));
  if (!self) {
    return NULL;
  }
  *self = (SimplyVoice) {
    .simply = simply,
    .in_progress = false,
    .for_assist = false,
  };

  self->session = dictation_session_create(SIMPLY_VOICE_BUFFER_LENGTH, dictation_session_callback, NULL);

  s_voice = self;
  return self;
}

void simply_voice_destroy(SimplyVoice *self) {
  if (!self) {
    return;
  }

  free(self);
  s_voice = NULL;
}

bool simply_voice_dictation_in_progress() {
  return s_voice && s_voice->in_progress;
}
#endif
