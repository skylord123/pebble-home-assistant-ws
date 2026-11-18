#include "simply_speaker.h"

#if defined(SIMPLY_HAS_SPEAKER)

#include "simply_msg.h"

#include "../../sdk/speech/ha_speech.h"

#include <pebble.h>

// The speaker itself is sdk/speech/ha_speech.c, which other apps copy. This
// carries its messages as Simply packets instead of its own AppMessage key.

//! The phone telling the watch to get ready for a clip
typedef struct __attribute__((__packed__)) SpeakerPlayPacket {
  Packet packet;
  uint8_t clip;
  //! HaSpeechRate
  uint8_t rate;
  //! 0 to 100, on top of the watch's own speaker volume
  uint8_t volume;
  uint8_t flags;
  //! How much to have in hand before starting, so that at the speed the phone
  //! has been getting through, the rest arrives before it is needed
  uint32_t prebuffer;
  //! The whole clip in bytes, 0 when not known
  uint32_t total;
} SpeakerPlayPacket;

//! A piece of a clip, at its byte offset into it
typedef struct __attribute__((__packed__)) SpeakerDataPacket {
  Packet packet;
  uint8_t clip;
  //! HaSpeechFlag
  uint8_t flags;
  uint32_t offset;
  uint8_t data[];
} SpeakerDataPacket;

typedef struct __attribute__((__packed__)) SpeakerStopPacket {
  Packet packet;
  uint8_t clip;
} SpeakerStopPacket;

//! What the watch tells the phone about a clip
typedef struct __attribute__((__packed__)) SpeakerStatusPacket {
  Packet packet;
  uint8_t clip;
  //! HaSpeechState
  uint8_t state;
  //! Bytes of the clip played so far, which is what frees room in the ring
  uint32_t played;
  //! The size of the ring, which is how far ahead of `played` the phone may be
  uint32_t capacity;
} SpeakerStatusPacket;

static void prv_send_status(uint8_t clip, uint8_t state, uint32_t played, uint32_t capacity) {
  SpeakerStatusPacket packet = {
    .packet = { .type = CommandSpeakerStatus, .length = sizeof(packet) },
    .clip = clip,
    .state = state,
    .played = played,
    .capacity = capacity,
  };
  simply_msg_send_packet(&packet.packet);
}

static void prv_handle_play(SpeakerPlayPacket *packet) {
  if (packet->packet.length < sizeof(*packet)) { return; }
  ha_speech_set_reporter(prv_send_status);
  ha_speech_play(packet->clip, packet->rate, packet->volume, packet->flags,
                 packet->prebuffer, packet->total);
}

static void prv_handle_data(SpeakerDataPacket *packet) {
  if (packet->packet.length < sizeof(*packet)) { return; }
  ha_speech_data(packet->clip, packet->flags, packet->offset, packet->data,
                 packet->packet.length - sizeof(*packet));
}

static void prv_handle_stop(SpeakerStopPacket *packet) {
  ha_speech_stop_clip(packet->clip);
}

bool simply_speaker_is_active(void) {
  return ha_speech_is_playing();
}

void simply_speaker_stop(void) {
  ha_speech_stop();
}

bool simply_speaker_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandSpeakerPlay:
      prv_handle_play((SpeakerPlayPacket *)packet);
      return true;
    case CommandSpeakerData:
      prv_handle_data((SpeakerDataPacket *)packet);
      return true;
    case CommandSpeakerStop:
      prv_handle_stop((SpeakerStopPacket *)packet);
      return true;
  }
  return false;
}

#endif
