// HA Speech Example: press Select to ask Home Assistant's assistant the
// time, and hear the answer on the watch speaker. Back stops it talking.
//
// The speech kit is the two ha_speech files next to this one (and
// ha_speech.js on the phone), copied unchanged from Home Assistant WS's
// sdk/speech. Everything it needs from the app is marked "speech kit" below.
// On a watch without a speaker the kit does nothing and the answer is only
// shown.

#include <pebble.h>

#include "ha_speech.h"

static Window *s_window;
static TextLayer *s_text_layer;

// The answer is shown here, so it is kept until the next one replaces it
static char s_text[512];

static void prv_show(const char *text) {
  strncpy(s_text, text, sizeof(s_text) - 1);
  text_layer_set_text(s_text_layer, s_text);
}

// MARK: - Messages from the phone

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  // speech kit: the audio and its control messages are the kit's to handle
  if (ha_speech_handle_message(iter)) {
    return;
  }
  // Anything else is the app's own: here, the answer to show
  Tuple *reply = dict_find(iter, MESSAGE_KEY_REPLY);
  if (reply) {
    prv_show(reply->value->cstring);
  }
}

// MARK: - Buttons

static void prv_select_click(ClickRecognizerRef recognizer, void *context) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    return;
  }
  dict_write_uint8(iter, MESSAGE_KEY_ASK, 1);
  app_message_outbox_send();
  prv_show("Asking...");
}

static void prv_back_click(ClickRecognizerRef recognizer, void *context) {
  // speech kit: Back stops the speech first, and leaves the app after that
  if (ha_speech_is_playing()) {
    ha_speech_stop();
    return;
  }
  window_stack_pop(true);
}

static void prv_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  window_single_click_subscribe(BUTTON_ID_BACK, prv_back_click);
}

// MARK: - The window

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  s_text_layer = text_layer_create(grect_inset(bounds, GEdgeInsets(PBL_IF_ROUND_ELSE(24, 8))));
  text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_text_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  layer_add_child(root, text_layer_get_layer(s_text_layer));
  prv_show("Press Select to ask Home Assistant the time");
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_text_layer);
}

// MARK: - The app

static void prv_init(void) {
  // speech kit: listen for its messages under the HA_SPEECH message key
  ha_speech_init(MESSAGE_KEY_HA_SPEECH);

  app_message_register_inbox_received(prv_inbox_received);
  // speech kit: the inbox must hold one piece of audio and the outbox one
  // report on how far it has played. That is room enough for the app's own
  // messages too: the answer's text, which the phone keeps short, and ASK.
  app_message_open(HA_SPEECH_INBOX_SIZE, HA_SPEECH_OUTBOX_SIZE);

  s_window = window_create();
  window_set_click_config_provider(s_window, prv_click_config);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);
}

static void prv_deinit(void) {
  // speech kit: stop the speaker and let go of its memory
  ha_speech_deinit();
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
