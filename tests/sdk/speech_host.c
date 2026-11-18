// sdk/speech/ha_speech.c on a computer, with a fake watch around it.
//
// speech.test.js builds this with sdk/speech/ha_speech.c and the stub
// pebble.h, writes commands to it a line at a time, and reads back what the
// watch did, also a line at a time:
//
//   report C S P N   the core's reporter (after `reporter`)
//   sent K HEX       an AppMessage sent under key K
//   open F V         the speaker stream opened in format F at volume V
//   close / halt     speaker_stream_close / speaker_stop
//   handled B        what ha_speech_handle_message answered
//   playing B        what ha_speech_is_playing answered
//   pcm N S,S,...    the samples written to the speaker since the last `pcm`
//   ok               the end of every command's output

#include <pebble.h>

#include "../../sdk/speech/ha_speech.h"

#include <stdio.h>
#include <string.h>

// The clock, in milliseconds, and the timers waiting on it
static uint64_t s_now = 1000000;

struct AppTimer {
  bool active;
  uint64_t due;
  AppTimerCallback callback;
  void *data;
};

#define TIMER_COUNT 16
static struct AppTimer s_timers[TIMER_COUNT];

AppTimer *app_timer_register(uint32_t timeout_ms, AppTimerCallback callback, void *callback_data) {
  for (int i = 0; i < TIMER_COUNT; i++) {
    if (!s_timers[i].active) {
      s_timers[i] = (struct AppTimer) { true, s_now + timeout_ms, callback, callback_data };
      return &s_timers[i];
    }
  }
  fprintf(stderr, "out of timers\n");
  exit(2);
}

void app_timer_cancel(AppTimer *timer) {
  timer->active = false;
}

//! Run every timer that falls due in the next `ms`, in order
static void prv_advance(uint64_t ms) {
  const uint64_t until = s_now + ms;
  while (true) {
    struct AppTimer *next = NULL;
    for (int i = 0; i < TIMER_COUNT; i++) {
      if (s_timers[i].active && s_timers[i].due <= until && (!next || s_timers[i].due < next->due)) {
        next = &s_timers[i];
      }
    }
    if (!next) { break; }
    s_now = next->due;
    next->active = false;
    next->callback(next->data);
  }
  s_now = until;
}

uint16_t time_ms(time_t *tloc, uint16_t *out_ms) {
  *tloc = (time_t)(s_now / 1000);
  *out_ms = (uint16_t)(s_now % 1000);
  return *out_ms;
}

static size_t s_heap = 100000;
size_t heap_bytes_free(void) { return s_heap; }

static bool s_connected = true;
bool connection_service_peek_pebble_app_connection(void) { return s_connected; }

// The speaker: what it was given, and how much more it will take before the
// clock next moves (-1 for no limit)
static bool s_muted;
static int s_open_failures;
static long s_room = -1;
static long s_room_per_ms = -1;
static SpeakerStatus s_status = SpeakerStatusIdle;
static SpeakerFinishedCallback s_finish;
static void *s_finish_context;
static int16_t *s_pcm;
static size_t s_pcm_count;
static size_t s_pcm_size;

bool speaker_is_muted(void) { return s_muted; }

bool speaker_stream_open(SpeakerPcmFormat format, uint8_t volume) {
  if (s_open_failures > 0) {
    s_open_failures--;
    return false;
  }
  printf("open %d %d\n", format, volume);
  return true;
}

uint32_t speaker_stream_write(const void *data, uint32_t num_bytes) {
  uint32_t take = num_bytes;
  if (s_room >= 0 && take > (uint32_t)s_room) { take = (uint32_t)s_room; }
  take &= ~1u;
  if (s_room >= 0) { s_room -= take; }
  const size_t samples = take / 2;
  if (s_pcm_count + samples > s_pcm_size) {
    s_pcm_size = (s_pcm_count + samples) * 2;
    s_pcm = realloc(s_pcm, s_pcm_size * sizeof(int16_t));
  }
  memcpy(&s_pcm[s_pcm_count], data, take);
  s_pcm_count += samples;
  return take;
}

void speaker_stream_close(void) { printf("close\n"); }
void speaker_stop(void) { printf("halt\n"); }
SpeakerStatus speaker_get_status(void) { return s_status; }

void speaker_set_finish_callback(SpeakerFinishedCallback cb, void *ctx) {
  s_finish = cb;
  s_finish_context = ctx;
}

// AppMessage: one message in at a time, and an outbox that may be busy
struct DictionaryIterator {
  uint8_t buffer[4096];
  size_t length;
};

static DictionaryIterator s_inbox;
static DictionaryIterator s_outbox;
static bool s_outbox_busy;
// AppMessage was never opened
static bool s_outbox_closed;
static bool s_outbox_open;

Tuple *dict_find(const DictionaryIterator *iter, const uint32_t key) {
  size_t at = 0;
  while (at + sizeof(Tuple) <= iter->length) {
    Tuple *tuple = (Tuple *)&iter->buffer[at];
    if (tuple->key == key) { return tuple; }
    at += sizeof(Tuple) + tuple->length;
  }
  return NULL;
}

static void prv_dict_add(DictionaryIterator *iter, uint32_t key, TupleType type,
                         const uint8_t *data, uint16_t size) {
  Tuple *tuple = (Tuple *)&iter->buffer[iter->length];
  tuple->key = key;
  tuple->type = type;
  tuple->length = size;
  memcpy(tuple->value->data, data, size);
  iter->length += sizeof(Tuple) + size;
}

DictionaryResult dict_write_data(DictionaryIterator *iter, const uint32_t key,
                                 const uint8_t * const data, const uint16_t size) {
  prv_dict_add(iter, key, TUPLE_BYTE_ARRAY, data, size);
  return DICT_OK;
}

AppMessageResult app_message_outbox_begin(DictionaryIterator **iterator) {
  if (s_outbox_closed) { return APP_MSG_INVALID_STATE; }
  if (s_outbox_busy || s_outbox_open) { return APP_MSG_BUSY; }
  s_outbox.length = 0;
  s_outbox_open = true;
  *iterator = &s_outbox;
  return APP_MSG_OK;
}

AppMessageResult app_message_outbox_send(void) {
  s_outbox_open = false;
  size_t at = 0;
  while (at < s_outbox.length) {
    Tuple *tuple = (Tuple *)&s_outbox.buffer[at];
    printf("sent %u ", tuple->key);
    for (uint16_t i = 0; i < tuple->length; i++) { printf("%02x", tuple->value->data[i]); }
    printf("\n");
    at += sizeof(Tuple) + tuple->length;
  }
  return APP_MSG_OK;
}

static void prv_report(uint8_t clip, uint8_t state, uint32_t played, uint32_t capacity) {
  printf("report %u %u %u %u\n", clip, state, played, capacity);
}

static size_t prv_hex(const char *hex, uint8_t *out) {
  size_t n = 0;
  while (hex[0] && hex[1] && hex[0] != '\n') {
    unsigned int byte;
    sscanf(hex, "%2x", &byte);
    out[n++] = (uint8_t)byte;
    hex += 2;
  }
  return n;
}

static char s_line[65536];
static uint8_t s_bytes[32768];

int main(void) {
  // The test waits on each answer, so it cannot sit in a buffer
  setvbuf(stdout, NULL, _IOLBF, 0);
  while (fgets(s_line, sizeof(s_line), stdin)) {
    char command[32] = "";
    int at = 0;
    sscanf(s_line, "%31s %n", command, &at);
    const char *args = s_line + at;
    unsigned long a = 0, b = 0, c = 0, d = 0, e = 0, f = 0;

    if (!strcmp(command, "reporter")) {
      ha_speech_set_reporter(prv_report);
    } else if (!strcmp(command, "init")) {
      sscanf(args, "%lu", &a);
      ha_speech_init(a);
    } else if (!strcmp(command, "deinit")) {
      ha_speech_deinit();
    } else if (!strcmp(command, "play")) {
      sscanf(args, "%lu %lu %lu %lu %lu %lu", &a, &b, &c, &d, &e, &f);
      ha_speech_play(a, b, c, d, e, f);
    } else if (!strcmp(command, "data")) {
      // data CLIP FLAGS OFFSET [HEX]
      char hex[sizeof(s_line)] = "";
      sscanf(args, "%lu %lu %lu %s", &a, &b, &c, hex);
      ha_speech_data(a, b, c, s_bytes, prv_hex(hex, s_bytes));
    } else if (!strcmp(command, "stop_clip")) {
      sscanf(args, "%lu", &a);
      ha_speech_stop_clip(a);
    } else if (!strcmp(command, "stop")) {
      ha_speech_stop();
    } else if (!strcmp(command, "playing")) {
      printf("playing %d\n", ha_speech_is_playing());
    } else if (!strcmp(command, "message")) {
      // message KEY TYPE [HEX]: an inbox message holding one tuple
      char hex[sizeof(s_line)] = "";
      sscanf(args, "%lu %lu %s", &a, &b, hex);
      s_inbox.length = 0;
      prv_dict_add(&s_inbox, a, (TupleType)b, s_bytes, prv_hex(hex, s_bytes));
      printf("handled %d\n", ha_speech_handle_message(&s_inbox));
    } else if (!strcmp(command, "advance")) {
      // advance MS [STEP]: the clock moves in steps, the speaker taking
      // `room_per_ms` worth of samples over each
      sscanf(args, "%lu %lu", &a, &b);
      if (!b) { b = a; }
      for (unsigned long done = 0; done < a; done += b) {
        if (s_room_per_ms >= 0) { s_room = s_room_per_ms * (long)b; }
        prv_advance(b);
      }
    } else if (!strcmp(command, "heap")) {
      sscanf(args, "%lu", &a);
      s_heap = a;
    } else if (!strcmp(command, "muted")) {
      sscanf(args, "%lu", &a);
      s_muted = a;
    } else if (!strcmp(command, "open_failures")) {
      sscanf(args, "%lu", &a);
      s_open_failures = a;
    } else if (!strcmp(command, "room_per_ms")) {
      long room = -1;
      sscanf(args, "%ld", &room);
      s_room_per_ms = room;
      s_room = room < 0 ? -1 : 0;
    } else if (!strcmp(command, "status")) {
      sscanf(args, "%lu", &a);
      s_status = (SpeakerStatus)a;
    } else if (!strcmp(command, "finish")) {
      sscanf(args, "%lu", &a);
      if (s_finish) { s_finish((SpeakerFinishReason)a, s_finish_context); }
    } else if (!strcmp(command, "outbox_busy")) {
      sscanf(args, "%lu", &a);
      s_outbox_busy = a;
    } else if (!strcmp(command, "outbox_closed")) {
      sscanf(args, "%lu", &a);
      s_outbox_closed = a;
    } else if (!strcmp(command, "connected")) {
      sscanf(args, "%lu", &a);
      s_connected = a;
    } else if (!strcmp(command, "pcm")) {
      printf("pcm %zu ", s_pcm_count);
      for (size_t i = 0; i < s_pcm_count; i++) { printf(i ? ",%d" : "%d", s_pcm[i]); }
      printf("\n");
      s_pcm_count = 0;
    } else if (command[0]) {
      fprintf(stderr, "unknown command %s\n", command);
      return 2;
    }
    printf("ok\n");
  }
  return 0;
}
