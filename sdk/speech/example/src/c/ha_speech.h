// ha_speech: Home Assistant speech played through the watch's own speaker.
// MIT License, see LICENSE. Part of Home Assistant WS
// (github.com/skylord123/pebble-home-assistant-ws); copy it unchanged.
//
// The phone asks Home Assistant to say something, compresses the audio to
// 4-bit IMA ADPCM and sends it down a piece at a time; this decodes it into
// the speaker's PCM stream as it plays, and tells the phone how much it has
// played so the phone never sends more than there is room for.
//
// Only the Pebble Time 2 and Core 2 Duo have a speaker. PBL_SPEAKER is the
// SDK's own name for that, and everywhere else this does nothing.

#pragma once

#include <pebble.h>

//! The most audio one DATA message carries. The phone sends no more.
#define HA_SPEECH_DATA_MAX 1800

//! What app_message_open needs for its inbox at the least: one tuple holding
//! a DATA message (op, clip, flags, offset, then the audio), as
//! dict_calc_buffer_size works it out
#define HA_SPEECH_INBOX_SIZE (1 + 7 + 7 + HA_SPEECH_DATA_MAX)

//! And for its outbox: one tuple holding a STATUS message
#define HA_SPEECH_OUTBOX_SIZE (1 + 7 + 11)

//! Must match the phone: ha_speech.js, and Home Assistant WS's src/js/ui/speaker.js
enum {
  HaSpeechRate8k = 0,
  HaSpeechRate16k = 1,
};

enum {
  //! The last piece of the clip
  HaSpeechFlagLast = 1,
  //! The last piece of a sentence. Everything up to here can be played
  //! without running dry in the middle of a word.
  HaSpeechFlagPhrase = 2,
};

//! Must match the phone: ha_speech.js, and Home Assistant WS's src/js/ui/speaker.js
typedef enum HaSpeechState {
  //! Ready and filling up, with `capacity` room to fill
  HaSpeechStateBuffering = 0,
  HaSpeechStatePlaying = 1,
  HaSpeechStateDone = 2,
  //! The wearer stopped it, by speaking again or by backing out
  HaSpeechStateStopped = 3,
  //! The speaker is muted, from the Sounds settings or for Quiet Time
  HaSpeechStateMuted = 4,
  HaSpeechStateNoMemory = 5,
  HaSpeechStateFailed = 6,
  //! Something more important took the speaker, such as an alarm
  HaSpeechStatePreempted = 7,
} HaSpeechState;

//! Start taking messages under `message_key`, the app's MESSAGE_KEY_HA_SPEECH.
//! 0 for none, when something else (see ha_speech_set_reporter) carries them.
void ha_speech_init(uint32_t message_key);

//! Stop anything playing, without telling the phone, and let go of everything
void ha_speech_deinit(void);

//! Call first thing from the app's inbox handler. True when the message was
//! for this, and the app has nothing more to do with it.
bool ha_speech_handle_message(DictionaryIterator *iter);

//! Stop at once and tell the phone the wearer stopped it. Safe when silent.
void ha_speech_stop(void);

//! Whether something is being said, or is about to be
bool ha_speech_is_playing(void);

// The core, for an app that carries the messages its own way. Each call is
// one message from the phone, its fields as the wire format has them.

//! Get ready for a clip, taking over from any other. `rate` is HaSpeechRate,
//! `volume` 0 to 100 on top of the watch's own speaker volume. `prebuffer` is
//! how much to have in hand before starting, so that at the speed the phone
//! has been getting through, the rest arrives before it is needed. `total` is
//! the whole clip in bytes, 0 when not known.
void ha_speech_play(uint8_t clip, uint8_t rate, uint8_t volume, uint8_t flags,
                    uint32_t prebuffer, uint32_t total);

//! A piece of a clip, at its byte offset into it. `flags` are HaSpeechFlag.
void ha_speech_data(uint8_t clip, uint8_t flags, uint32_t offset,
                    const uint8_t *bytes, size_t length);

//! The phone has given up on `clip`
void ha_speech_stop_clip(uint8_t clip);

//! What the watch tells the phone about a clip. `played` is the bytes of it
//! played so far, which is what frees room in the ring, and `capacity` the
//! size of the ring, which is how far ahead of `played` the phone may be.
typedef void (*HaSpeechReporter)(uint8_t clip, uint8_t state, uint32_t played,
                                 uint32_t capacity);

//! Send reports this way instead of as AppMessage
void ha_speech_set_reporter(HaSpeechReporter reporter);
