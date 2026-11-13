// Just enough of the Pebble SDK for sdk/speech/ha_speech.c to build on a
// computer. tests/sdk/speech_host.c fakes what is declared here.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <time.h>

#if !defined(STUB_NO_SPEAKER)
#define PBL_SPEAKER
#endif

typedef struct AppTimer AppTimer;
typedef void (*AppTimerCallback)(void *data);
AppTimer *app_timer_register(uint32_t timeout_ms, AppTimerCallback callback, void *callback_data);
void app_timer_cancel(AppTimer *timer_handle);

size_t heap_bytes_free(void);
uint16_t time_ms(time_t *tloc, uint16_t *out_ms);
bool connection_service_peek_pebble_app_connection(void);

typedef enum {
  SpeakerPcmFormat_8kHz_8bit = 0,
  SpeakerPcmFormat_16kHz_8bit = 1,
  SpeakerPcmFormat_8kHz_16bit = 2,
  SpeakerPcmFormat_16kHz_16bit = 3,
  SpeakerPcmFormatCount
} SpeakerPcmFormat;

typedef enum {
  SpeakerStatusIdle = 0,
  SpeakerStatusPlaying,
  SpeakerStatusDraining,
} SpeakerStatus;

typedef enum {
  SpeakerFinishReasonDone = 0,
  SpeakerFinishReasonStopped,
  SpeakerFinishReasonPreempted,
  SpeakerFinishReasonError,
} SpeakerFinishReason;

typedef void (*SpeakerFinishedCallback)(SpeakerFinishReason reason, void *ctx);

bool speaker_stream_open(SpeakerPcmFormat format, uint8_t volume);
uint32_t speaker_stream_write(const void *data, uint32_t num_bytes);
void speaker_stream_close(void);
void speaker_stop(void);
SpeakerStatus speaker_get_status(void);
void speaker_set_finish_callback(SpeakerFinishedCallback cb, void *ctx);
bool speaker_is_muted(void);

typedef enum {
  TUPLE_BYTE_ARRAY = 0,
  TUPLE_CSTRING = 1,
  TUPLE_UINT = 2,
  TUPLE_INT = 3,
} TupleType;

typedef struct __attribute__((__packed__)) {
  uint32_t key;
  TupleType type:8;
  uint16_t length;
  union {
    uint8_t data[0];
    char cstring[0];
    uint8_t uint8;
    uint16_t uint16;
    uint32_t uint32;
    int8_t int8;
    int16_t int16;
    int32_t int32;
  } value[];
} Tuple;

typedef struct DictionaryIterator DictionaryIterator;

typedef enum {
  DICT_OK = 0,
  DICT_NOT_ENOUGH_STORAGE = 1 << 1,
} DictionaryResult;

Tuple *dict_find(const DictionaryIterator *iter, const uint32_t key);
DictionaryResult dict_write_data(DictionaryIterator *iter, const uint32_t key,
                                 const uint8_t * const data, const uint16_t size);

typedef enum {
  APP_MSG_OK = 0,
  APP_MSG_BUSY = 1 << 6,
} AppMessageResult;

AppMessageResult app_message_outbox_begin(DictionaryIterator **iterator);
AppMessageResult app_message_outbox_send(void);
