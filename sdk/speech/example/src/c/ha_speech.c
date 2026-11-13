// ha_speech: Home Assistant speech played through the watch's own speaker.
// MIT License, see LICENSE. Part of Home Assistant WS
// (github.com/skylord123/pebble-home-assistant-ws); copy it unchanged.

#include "ha_speech.h"

#include <pebble.h>

#include <string.h>

#if defined(PBL_SPEAKER)

// The compressed audio waits in a ring until the speaker is ready for it. A
// bigger ring rides out a slower Bluetooth link, so it takes as much of the
// heap as can be spared, leaving enough behind for the conversation to keep
// receiving messages: a long answer arrives in pieces that are all held at
// once before being joined. A Time 2 has around 99K of heap with this app
// loaded, a Core 2 Duo far less. An app can set either with -D.
#if defined(PBL_PLATFORM_FLINT)
#ifndef HA_SPEECH_RING_MAX
#define HA_SPEECH_RING_MAX 8192
#endif
#ifndef HA_SPEECH_HEAP_RESERVE
#define HA_SPEECH_HEAP_RESERVE 6144
#endif
#else
#ifndef HA_SPEECH_RING_MAX
#define HA_SPEECH_RING_MAX 32768
#endif
#ifndef HA_SPEECH_HEAP_RESERVE
#define HA_SPEECH_HEAP_RESERVE 12288
#endif
#endif
//! Less than this is not worth playing from: at 8 kHz it is half a second
#define RING_MIN 2048
#define PREBUFFER_MIN 1024

// The speaker's own buffer holds 8K of PCM, a quarter of a second at 16 kHz,
// so it is topped up well inside that
#define TICK_MS 50

//! Samples decoded at a time on their way into the speaker
#define PCM_CHUNK 256

// Closing one stream frees the speaker a moment later, not at once, so a new
// one opened straight after can be refused. It is asked again until this has
// passed rather than for a fixed number of tries, which a slow tick would use
// up before the speaker came free.
#define OPEN_RETRY_MS 1000

// The phone has stopped sending, with the clip unfinished. Most likely it has
// gone away; the speaker would otherwise play silence until the app closed.
// While it waits for the next sentence it sends empty pieces to say it is
// still there.
#define STALL_MS 10000

// Draining the speaker's buffer after the last sample takes a fraction of a
// second. Its finish callback says when, and this is how long to wait for it
// before deciding it is never coming.
#define DRAIN_MAX_MS 3000

//! Standard IMA ADPCM, which the phone encodes with the same tables
static const int8_t ADPCM_INDEX[16] = {
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
};

static const int16_t ADPCM_STEP[89] = {
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
};

typedef struct Speaker {
  uint8_t *ring;
  uint32_t capacity;
  //! Offsets into the clip. Everything between played and received is in the
  //! ring waiting to be heard.
  uint32_t received;
  uint32_t played;
  //! `played` as the phone was last told it
  uint32_t reported;
  uint32_t prebuffer;
  //! Where the last whole sentence received ends
  uint32_t phrase_end;
  AppTimer *timer;
  uint32_t last_data_ms;
  //! When the speaker was first asked for, or when the last sample went in
  uint32_t since_ms;
  int16_t pcm[PCM_CHUNK];
  uint16_t pcm_length;
  uint16_t pcm_sent;
  int32_t predictor;
  int8_t step_index;
  uint8_t clip;
  uint8_t rate;
  uint8_t volume;
  HaSpeechState state;
  bool active;
  bool final;
  //! The stream to the speaker is open
  bool open;
  //! Ran dry with more still to come, and waiting to have enough in hand again
  bool starved;
  //! The last sample has gone in, and the speaker is playing out what it holds
  bool draining;
} Speaker;

static Speaker s_speaker;

//! Where the phone hears about it
static HaSpeechReporter s_reporter;

static uint32_t prv_now_ms(void) {
  time_t seconds;
  uint16_t ms;
  time_ms(&seconds, &ms);
  return (uint32_t)seconds * 1000u + ms;
}

static void prv_send_status(HaSpeechState state) {
  s_speaker.reported = s_speaker.played;
  if (s_reporter) {
    s_reporter(s_speaker.clip, state, s_speaker.played, s_speaker.capacity);
  }
}

//! Let go of the speaker and the ring. The phone hears about it from the
//! caller, if at all.
static void prv_release(void) {
  if (s_speaker.timer) {
    app_timer_cancel(s_speaker.timer);
    s_speaker.timer = NULL;
  }
  if (s_speaker.open) {
    // Cleared first: the stop reports itself through the finish callback,
    // and this is not news to anyone
    speaker_set_finish_callback(NULL, NULL);
    speaker_stop();
    s_speaker.open = false;
  }
  free(s_speaker.ring);
  s_speaker.ring = NULL;
  s_speaker.capacity = 0;
  s_speaker.active = false;
}

static void prv_end(HaSpeechState state) {
  prv_release();
  s_speaker.state = state;
  prv_send_status(state);
}

static void prv_finished(SpeakerFinishReason reason, void *context) {
  if (!s_speaker.active) { return; }
  s_speaker.open = false;
  switch (reason) {
    case SpeakerFinishReasonDone:
      prv_end(s_speaker.final && s_speaker.played >= s_speaker.received ?
              HaSpeechStateDone : HaSpeechStateFailed);
      return;
    case SpeakerFinishReasonPreempted:
      prv_end(HaSpeechStatePreempted);
      return;
    case SpeakerFinishReasonStopped:
      // Someone else stopped it. Nothing here does that without clearing the
      // callback first, so it was not the wearer.
    case SpeakerFinishReasonError:
    default:
      prv_end(HaSpeechStateFailed);
      return;
  }
}

static int16_t prv_decode_nibble(uint8_t code) {
  const int32_t step = ADPCM_STEP[s_speaker.step_index];
  int32_t diff = step >> 3;
  if (code & 4) { diff += step; }
  if (code & 2) { diff += step >> 1; }
  if (code & 1) { diff += step >> 2; }
  int32_t value = s_speaker.predictor + ((code & 8) ? -diff : diff);
  if (value > 32767) { value = 32767; }
  if (value < -32768) { value = -32768; }
  s_speaker.predictor = value;
  int8_t index = s_speaker.step_index + ADPCM_INDEX[code];
  if (index < 0) { index = 0; }
  if (index > 88) { index = 88; }
  s_speaker.step_index = index;
  return (int16_t)value;
}

//! Turn the next of what is in the ring into samples. False when it is empty.
static bool prv_decode(void) {
  uint32_t available = s_speaker.received - s_speaker.played;
  if (available == 0) { return false; }
  // Two samples a byte, low nibble first
  if (available > PCM_CHUNK / 2) { available = PCM_CHUNK / 2; }
  uint16_t n = 0;
  for (uint32_t i = 0; i < available; i++) {
    const uint8_t byte = s_speaker.ring[(s_speaker.played + i) % s_speaker.capacity];
    s_speaker.pcm[n++] = prv_decode_nibble(byte & 0x0F);
    s_speaker.pcm[n++] = prv_decode_nibble(byte >> 4);
  }
  s_speaker.played += available;
  s_speaker.pcm_length = n;
  s_speaker.pcm_sent = 0;
  return true;
}

//! Open the speaker. It may still be letting go of the last clip, in which
//! case the next tick asks again.
static bool prv_open(void) {
  const SpeakerPcmFormat format = s_speaker.rate == HaSpeechRate16k ?
      SpeakerPcmFormat_16kHz_16bit : SpeakerPcmFormat_8kHz_16bit;
  speaker_set_finish_callback(prv_finished, NULL);
  if (!speaker_stream_open(format, s_speaker.volume)) {
    speaker_set_finish_callback(NULL, NULL);
    return false;
  }
  s_speaker.open = true;
  s_speaker.state = HaSpeechStatePlaying;
  prv_send_status(HaSpeechStatePlaying);
  return true;
}

//! Keep the speaker fed for as long as it takes what is offered
static void prv_feed(void) {
  while (true) {
    if (s_speaker.pcm_sent >= s_speaker.pcm_length && !prv_decode()) { return; }
    const uint32_t bytes = (uint32_t)(s_speaker.pcm_length - s_speaker.pcm_sent) * sizeof(int16_t);
    const uint32_t written = speaker_stream_write(&s_speaker.pcm[s_speaker.pcm_sent], bytes);
    s_speaker.pcm_sent += written / sizeof(int16_t);
    if (written < bytes) { return; }
  }
}

static uint32_t prv_buffered(void) {
  return s_speaker.received - s_speaker.played;
}

//! A whole sentence is in hand, which can be played through without a gap
static bool prv_phrase_ready(void) {
  return s_speaker.phrase_end > s_speaker.played;
}

static void prv_tick(void *data) {
  s_speaker.timer = NULL;
  if (!s_speaker.active) { return; }
  const uint32_t now = prv_now_ms();

  if (s_speaker.draining) {
    // The finish callback ends this. Should it never come, the speaker has
    // had more than long enough to play out its buffer.
    if (now - s_speaker.since_ms > DRAIN_MAX_MS ||
        speaker_get_status() == SpeakerStatusIdle) {
      s_speaker.open = false;
      prv_end(HaSpeechStateDone);
      return;
    }
    s_speaker.timer = app_timer_register(TICK_MS, prv_tick, NULL);
    return;
  }

  if (!s_speaker.final && now - s_speaker.last_data_ms > STALL_MS) {
    prv_end(HaSpeechStateFailed);
    return;
  }

  if (!s_speaker.open) {
    // Waiting until enough is in hand that the rest will arrive in time
    if (s_speaker.final || prv_buffered() >= s_speaker.prebuffer || prv_phrase_ready()) {
      // since_ms has been following the clock until now, so it marks the
      // first time the speaker was asked for
      if (!prv_open() && now - s_speaker.since_ms > OPEN_RETRY_MS) {
        prv_end(HaSpeechStateFailed);
        return;
      }
    } else {
      s_speaker.since_ms = now;
    }
  } else if (s_speaker.starved) {
    // Ran dry part way, which between sentences is only a pause while the
    // phone gets the next one. The speaker plays silence meanwhile, and
    // starting again on the first scrap to arrive would only stutter, so it
    // waits for the whole sentence or a decent run of it.
    const uint32_t resume = s_speaker.prebuffer < s_speaker.capacity / 2 ?
        s_speaker.prebuffer : s_speaker.capacity / 2;
    if (s_speaker.final || prv_buffered() >= resume || prv_phrase_ready()) {
      s_speaker.starved = false;
    }
  }

  if (s_speaker.open && !s_speaker.starved) {
    prv_feed();
    const bool empty = prv_buffered() == 0 && s_speaker.pcm_sent >= s_speaker.pcm_length;
    if (empty && s_speaker.final) {
      speaker_stream_close();
      s_speaker.draining = true;
      s_speaker.since_ms = now;
    } else if (empty) {
      s_speaker.starved = true;
    }
  }

  // The phone needs to hear about room freeing up often enough to keep the
  // ring full, but not about every byte
  const uint32_t step = s_speaker.capacity / 4;
  if (s_speaker.played - s_speaker.reported >= step) {
    prv_send_status(s_speaker.state);
  }

  if (s_speaker.active) {
    s_speaker.timer = app_timer_register(TICK_MS, prv_tick, NULL);
  }
}

//! The biggest ring the heap can spare, up to what the clip needs
static uint32_t prv_ring_size(uint32_t total) {
  uint32_t want = HA_SPEECH_RING_MAX;
  if (total > 0 && total < want) {
    want = total < RING_MIN ? RING_MIN : total;
  }
  const size_t free_bytes = heap_bytes_free();
  const uint32_t spare = free_bytes > HA_SPEECH_HEAP_RESERVE ? free_bytes - HA_SPEECH_HEAP_RESERVE : 0;
  while (want > spare && want > RING_MIN) {
    want /= 2;
  }
  return want <= spare ? want : 0;
}

void ha_speech_play(uint8_t clip, uint8_t rate, uint8_t volume, uint8_t flags,
                    uint32_t prebuffer, uint32_t total) {
  // A new clip takes over from whatever was playing, without a word to the
  // phone about the old one, which it has already given up on
  if (s_speaker.active) {
    prv_release();
  }
  s_speaker = (Speaker) {
    .clip = clip,
    .rate = rate,
    .volume = volume > 100 ? 100 : volume,
    .state = HaSpeechStateBuffering,
  };

  // Muted means the wearer does not want to hear it, so it is not sent at all
  if (speaker_is_muted()) {
    prv_send_status(HaSpeechStateMuted);
    return;
  }

  const uint32_t size = prv_ring_size(total);
  s_speaker.ring = size ? malloc(size) : NULL;
  if (!s_speaker.ring) {
    prv_send_status(HaSpeechStateNoMemory);
    return;
  }
  s_speaker.capacity = size;
  // Starting on a scrap would only stutter: a quarter of a second at 8 kHz
  // at the least, unless the whole clip is smaller than that
  if (prebuffer < PREBUFFER_MIN) { prebuffer = PREBUFFER_MIN; }
  s_speaker.prebuffer = prebuffer < size ? prebuffer : size;
  s_speaker.active = true;
  s_speaker.last_data_ms = s_speaker.since_ms = prv_now_ms();
  prv_send_status(HaSpeechStateBuffering);
  s_speaker.timer = app_timer_register(TICK_MS, prv_tick, NULL);
}

void ha_speech_data(uint8_t clip, uint8_t flags, uint32_t offset,
                    const uint8_t *bytes, size_t size) {
  if (!s_speaker.active || clip != s_speaker.clip || s_speaker.final) {
    return;
  }
  const uint32_t length = size;
  // Anything at all for this clip says the phone is still there, an empty
  // piece included
  s_speaker.last_data_ms = prv_now_ms();
  // A message the phone sent again because the watch's answer to it went
  // missing, whose audio is already here, or an empty one to keep in touch
  if (offset + length <= s_speaker.received && !(flags & HaSpeechFlagLast)) {
    return;
  }
  if (offset != s_speaker.received ||
      s_speaker.received + length - s_speaker.played > s_speaker.capacity) {
    // A gap or an overrun, which the phone never sends on purpose. Going on
    // would play noise.
    prv_end(HaSpeechStateFailed);
    return;
  }
  for (uint32_t i = 0; i < length; i++) {
    s_speaker.ring[(s_speaker.received + i) % s_speaker.capacity] = bytes[i];
  }
  s_speaker.received += length;
  s_speaker.final = (flags & HaSpeechFlagLast);
  if (flags & HaSpeechFlagPhrase) {
    s_speaker.phrase_end = s_speaker.received;
  }
}

void ha_speech_stop_clip(uint8_t clip) {
  if (!s_speaker.active || clip != s_speaker.clip) { return; }
  // The phone asked, so it needs no telling
  prv_release();
  s_speaker.state = HaSpeechStateStopped;
}

bool ha_speech_is_playing(void) {
  return s_speaker.active;
}

void ha_speech_stop(void) {
  if (!s_speaker.active) { return; }
  prv_end(HaSpeechStateStopped);
}

void ha_speech_set_reporter(HaSpeechReporter reporter) {
  s_reporter = reporter;
}

// Over AppMessage every message is a byte array under the app's one key: an
// op, then the fields of the call it stands for, integers little-endian.
//
//   PLAY    clip, rate, volume, flags, prebuffer u32, total u32
//   DATA    clip, flags, offset u32, the audio
//   STOP    clip
//   STATUS  clip, state, played u32, capacity u32  (to the phone)
enum {
  OpPlay = 1,
  OpData = 2,
  OpStop = 3,
  OpStatus = 4,
};

#define STATUS_LENGTH 11

// The outbox is the app's too, and may be busy with its own message. A report
// says where the clip is now, so only the newest is kept, and it is tried
// again this soon.
#define STATUS_RETRY_MS 100

static uint32_t s_key;
static uint8_t s_status[STATUS_LENGTH];
static bool s_status_waiting;
static AppTimer *s_status_timer;

static uint32_t prv_read_u32(const uint8_t *bytes) {
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static void prv_write_u32(uint8_t *bytes, uint32_t value) {
  bytes[0] = value;
  bytes[1] = value >> 8;
  bytes[2] = value >> 16;
  bytes[3] = value >> 24;
}

static void prv_flush_status(void *data) {
  s_status_timer = NULL;
  if (!s_status_waiting) { return; }
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) == APP_MSG_OK) {
    dict_write_data(iter, s_key, s_status, STATUS_LENGTH);
    app_message_outbox_send();
    s_status_waiting = false;
    return;
  }
  // With the phone gone there is nobody to tell
  if (!connection_service_peek_pebble_app_connection()) {
    s_status_waiting = false;
    return;
  }
  s_status_timer = app_timer_register(STATUS_RETRY_MS, prv_flush_status, NULL);
}

static void prv_report(uint8_t clip, uint8_t state, uint32_t played, uint32_t capacity) {
  s_status[0] = OpStatus;
  s_status[1] = clip;
  s_status[2] = state;
  prv_write_u32(&s_status[3], played);
  prv_write_u32(&s_status[7], capacity);
  s_status_waiting = true;
  // A retry already waiting sends this one instead
  if (!s_status_timer) {
    prv_flush_status(NULL);
  }
}

void ha_speech_init(uint32_t message_key) {
  s_key = message_key;
  if (message_key) {
    s_reporter = prv_report;
  } else if (s_reporter == prv_report) {
    s_reporter = NULL;
  }
}

void ha_speech_deinit(void) {
  if (s_speaker.active) {
    prv_release();
  }
  if (s_status_timer) {
    app_timer_cancel(s_status_timer);
    s_status_timer = NULL;
  }
  s_status_waiting = false;
  s_reporter = NULL;
  s_key = 0;
}

bool ha_speech_handle_message(DictionaryIterator *iter) {
  Tuple *tuple = s_key ? dict_find(iter, s_key) : NULL;
  if (!tuple) { return false; }
  const uint8_t *value = tuple->value->data;
  const uint16_t length = tuple->length;
  // Anything else under this key is not for anyone else either
  if (tuple->type != TUPLE_BYTE_ARRAY || length < 2) { return true; }
  switch (value[0]) {
    case OpPlay:
      if (length >= 13) {
        ha_speech_play(value[1], value[2], value[3], value[4],
                       prv_read_u32(&value[5]), prv_read_u32(&value[9]));
      }
      break;
    case OpData:
      if (length >= 7) {
        ha_speech_data(value[1], value[2], prv_read_u32(&value[3]), &value[7], length - 7);
      }
      break;
    case OpStop:
      ha_speech_stop_clip(value[1]);
      break;
  }
  return true;
}

#else

// Without a speaker the messages are still claimed, so that the app does not
// take them for its own
static uint32_t s_key;

void ha_speech_init(uint32_t message_key) { s_key = message_key; }
void ha_speech_deinit(void) { s_key = 0; }
bool ha_speech_handle_message(DictionaryIterator *iter) {
  return s_key && dict_find(iter, s_key);
}

void ha_speech_play(uint8_t clip, uint8_t rate, uint8_t volume, uint8_t flags,
                    uint32_t prebuffer, uint32_t total) {}
void ha_speech_data(uint8_t clip, uint8_t flags, uint32_t offset,
                    const uint8_t *bytes, size_t size) {}
void ha_speech_stop_clip(uint8_t clip) {}
bool ha_speech_is_playing(void) { return false; }
void ha_speech_stop(void) {}
void ha_speech_set_reporter(HaSpeechReporter reporter) {}

#endif
