#pragma once

#include "simply_msg.h"
#include "simply.h"
#include "util/compat.h"

#include <pebble.h>

#define SIMPLY_VOICE_BUFFER_LENGTH 512

#define MAX_VOICE_MESSAGES 6
#define MAX_VOICE_TEXT 128

typedef struct VoiceMessage VoiceMessage;

struct VoiceMessage {
  bool is_user;
  char text[MAX_VOICE_TEXT];
};

typedef struct SimplyVoice SimplyVoice;

struct SimplyVoice {
  Simply *simply;
  DictationSession *session;
  AppTimer *timer;

  // Voice window
  Window *voice_window;
  ScrollLayer *scroll_layer;
  Layer *content_layer;

  // Conversation
  VoiceMessage messages[MAX_VOICE_MESSAGES];
  uint8_t message_count;
  bool waiting;
  bool window_active;

  // Loading animation
  AppTimer *dot_timer;
  uint8_t dot_state;

  // Settings
  uint8_t font_size; // 0=14, 1=18, 2=24

  bool in_progress;
};

#if defined(PBL_PLATFORM_APLITE)

#define simply_voice_create(simply) NULL
#define simply_voice_destroy(self)

#define simply_voice_handle_packet(simply, packet) (false)

#define simply_voice_dictation_in_progress() (false)

#else

SimplyVoice *simply_voice_create(Simply *simply);
void simply_voice_destroy(SimplyVoice *self);

bool simply_voice_handle_packet(Simply *simply, Packet *packet);

bool simply_voice_dictation_in_progress();

#endif
