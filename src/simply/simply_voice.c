#include "simply_voice.h"

#include "simply_msg.h"

#include "simply.h"

#include <pebble.h>

#if !defined(PBL_PLATFORM_APLITE)

// --- Packet structs ---

typedef struct VoiceStartPacket VoiceStartPacket;

struct __attribute__((__packed__)) VoiceStartPacket {
  Packet packet;
  bool enable_confirmation;
  uint8_t font_size; // pixel value: 14, 18, 24, 28
};

typedef struct VoiceDataPacket VoiceDataPacket;

struct __attribute__((__packed__)) VoiceDataPacket {
  Packet packet;
  int8_t status;
  char result[];
};

typedef struct VoiceResponsePacket VoiceResponsePacket;

struct __attribute__((__packed__)) VoiceResponsePacket {
  Packet packet;
  char response[];
};

static SimplyVoice *s_voice;

// --- Font helpers ---

static const char *get_bold_font_key(uint8_t size) {
  switch (size) {
    case 0: return FONT_KEY_GOTHIC_14_BOLD;
    case 2: return FONT_KEY_GOTHIC_24_BOLD;
    case 3: return FONT_KEY_GOTHIC_28_BOLD;
    default: return FONT_KEY_GOTHIC_18_BOLD;
  }
}

static const char *get_regular_font_key(uint8_t size) {
  switch (size) {
    case 0: return FONT_KEY_GOTHIC_14;
    case 2: return FONT_KEY_GOTHIC_24;
    case 3: return FONT_KEY_GOTHIC_28;
    default: return FONT_KEY_GOTHIC_18;
  }
}

static int get_font_height(uint8_t size) {
  switch (size) {
    case 0: return 14;
    case 2: return 24;
    case 3: return 28;
    default: return 18;
  }
}

// --- Forward declarations ---

static void voice_window_push(void);
static void voice_rebuild_display(void);
static void voice_start_dictation(void);
static void voice_start_loading_animation(void);
static void voice_stop_loading_animation(void);

// --- Conversation management ---

static void voice_add_message(bool is_user, const char *text) {
  if (s_voice->message_count >= MAX_VOICE_MESSAGES) {
    // Remove oldest exchange (2 messages: user + assistant)
    for (int i = 0; i < MAX_VOICE_MESSAGES - 2; i++) {
      s_voice->messages[i] = s_voice->messages[i + 2];
    }
    s_voice->message_count -= 2;
  }
  VoiceMessage *msg = &s_voice->messages[s_voice->message_count];
  msg->is_user = is_user;
  strncpy(msg->text, text, MAX_VOICE_TEXT - 1);
  msg->text[MAX_VOICE_TEXT - 1] = '\0';
  s_voice->message_count++;
}

// --- Display layout ---

static void get_text_margins(GRect bounds, int *left, int *width) {
#ifdef PBL_ROUND
  int radius = bounds.size.w / 2;
  int inset = radius - (int)(radius * 707 / 1000); // inscribed rect approximation
  *left = inset;
  *width = bounds.size.w - (inset * 2);
#else
  *left = 5;
  *width = bounds.size.w - 10;
#endif
}

static int calculate_text_height(const char *text, GFont font, int width) {
  GSize size = graphics_text_layout_get_content_size(
    text, font, GRect(0, 0, width, 2000),
    GTextOverflowModeWordWrap, GTextAlignmentLeft
  );
  return size.h;
}

// --- Drawing ---

#define TITLE_BAR_HEIGHT 24
#define MESSAGE_SPACING 4
#define DOT_RADIUS 4
#define DOT_SPACING 12

static void content_layer_update_proc(Layer *layer, GContext *ctx) {
  if (!s_voice) return;

  GRect bounds = layer_get_bounds(layer);
  int left_margin, text_width;
  get_text_margins(bounds, &left_margin, &text_width);

  GFont bold_font = fonts_get_system_font(get_bold_font_key(s_voice->font_size));
  GFont regular_font = fonts_get_system_font(get_regular_font_key(s_voice->font_size));
  int font_h = get_font_height(s_voice->font_size);

  // Background
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  int y = TITLE_BAR_HEIGHT + 4;

  // Title bar
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack));
  graphics_fill_rect(ctx, GRect(0, 0, bounds.size.w, TITLE_BAR_HEIGHT), 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, "Assistant",
    fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
    GRect(0, 0, bounds.size.w, TITLE_BAR_HEIGHT),
    GTextOverflowModeTrailingEllipsis,
    GTextAlignmentCenter, NULL);

  // Draw empty state
  if (s_voice->message_count == 0 && !s_voice->waiting) {
    graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    graphics_draw_text(ctx, "Press SELECT\nto speak.",
      regular_font, GRect(left_margin, y, text_width, 60),
      GTextOverflowModeWordWrap,
#ifdef PBL_ROUND
      GTextAlignmentCenter,
#else
      GTextAlignmentLeft,
#endif
      NULL);
    return;
  }

  // Draw messages
  for (uint8_t i = 0; i < s_voice->message_count; i++) {
    VoiceMessage *msg = &s_voice->messages[i];
    const char *speaker = msg->is_user ? "Me:" : "Assistant:";
    GColor speaker_color = PBL_IF_COLOR_ELSE(
      msg->is_user ? GColorBlack : GColorCobaltBlue,
      GColorBlack
    );

    // Speaker label
    graphics_context_set_text_color(ctx, speaker_color);
    int speaker_h = font_h + 2;
    graphics_draw_text(ctx, speaker, bold_font,
      GRect(left_margin, y, text_width, speaker_h),
      GTextOverflowModeTrailingEllipsis,
#ifdef PBL_ROUND
      GTextAlignmentCenter,
#else
      GTextAlignmentLeft,
#endif
      NULL);
    y += speaker_h;

    // Message text
    graphics_context_set_text_color(ctx, GColorBlack);
    int text_h = calculate_text_height(msg->text, regular_font, text_width);
    graphics_draw_text(ctx, msg->text, regular_font,
      GRect(left_margin, y, text_width, text_h + 4),
      GTextOverflowModeWordWrap,
#ifdef PBL_ROUND
      GTextAlignmentCenter,
#else
      GTextAlignmentLeft,
#endif
      NULL);
    y += text_h + MESSAGE_SPACING + 4;
  }

  // Loading dots
  if (s_voice->waiting) {
    int center_x = bounds.size.w / 2;
    int dot_y = y + DOT_RADIUS + 4;

    graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack));

    for (int i = 0; i < 3; i++) {
      int dot_x = center_x + (i - 1) * DOT_SPACING;
      bool visible = false;
      switch (s_voice->dot_state) {
        case 0: visible = (i == 0); break;
        case 1: visible = (i <= 1); break;
        case 2: visible = true; break;
        case 3: visible = (i >= 1); break;
        case 4: visible = (i == 2); break;
      }
      if (visible) {
        graphics_fill_circle(ctx, GPoint(dot_x, dot_y), DOT_RADIUS);
      }
    }
    y = dot_y + DOT_RADIUS + 8;
  }

  // Update content size for scrolling
  GSize content_size = GSize(bounds.size.w, y + 10);
  scroll_layer_set_content_size(s_voice->scroll_layer, content_size);
}

static int voice_calculate_content_height(void) {
  GRect bounds = layer_get_bounds(window_get_root_layer(s_voice->voice_window));
  int left_margin, text_width;
  get_text_margins(bounds, &left_margin, &text_width);
  GFont regular_font = fonts_get_system_font(get_regular_font_key(s_voice->font_size));
  int font_h = get_font_height(s_voice->font_size);

  int y = TITLE_BAR_HEIGHT + 4;

  for (uint8_t i = 0; i < s_voice->message_count; i++) {
    int speaker_h = font_h + 2;
    y += speaker_h;
    int text_h = calculate_text_height(s_voice->messages[i].text, regular_font, text_width);
    y += text_h + MESSAGE_SPACING + 4;
  }

  if (s_voice->waiting) {
    y += DOT_RADIUS * 2 + 12;
  }

  return y + 10;
}

static void voice_rebuild_display(void) {
  if (!s_voice || !s_voice->content_layer || !s_voice->window_active) return;

  // Calculate content height before redraw
  int content_h = voice_calculate_content_height();
  GRect bounds = layer_get_bounds(window_get_root_layer(s_voice->voice_window));

  // Update scroll content size
  scroll_layer_set_content_size(s_voice->scroll_layer, GSize(bounds.size.w, content_h));

  // Mark dirty to trigger redraw
  layer_mark_dirty(s_voice->content_layer);

  // Auto-scroll to bottom
  if (content_h > bounds.size.h) {
    scroll_layer_set_content_offset(s_voice->scroll_layer,
      GPoint(0, -(content_h - bounds.size.h)), true);
  }
}

// --- Loading animation ---

static void dot_timer_callback(void *data) {
  if (!s_voice || !s_voice->waiting) return;
  s_voice->dot_state = (s_voice->dot_state + 1) % 5;
  if (s_voice->content_layer) {
    layer_mark_dirty(s_voice->content_layer);
  }
  s_voice->dot_timer = app_timer_register(300, dot_timer_callback, NULL);
}

static void voice_start_loading_animation(void) {
  s_voice->dot_state = 0;
  s_voice->dot_timer = app_timer_register(300, dot_timer_callback, NULL);
}

static void voice_stop_loading_animation(void) {
  if (s_voice->dot_timer) {
    app_timer_cancel(s_voice->dot_timer);
    s_voice->dot_timer = NULL;
  }
}

// --- Send transcription to JS ---

static bool send_voice_data(int status, char *transcription) {
  if (transcription == NULL) {
    return send_voice_data(DictationSessionStatusFailureSystemAborted, "");
  }

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

// --- Dictation ---

static void dictation_session_callback(DictationSession *session, DictationSessionStatus status,
                                       char *transcription, void *context) {
  s_voice->in_progress = false;

  if (status == DictationSessionStatusSuccess) {
    // Add user message and show loading
    voice_add_message(true, transcription);
    s_voice->waiting = true;
    voice_rebuild_display();
    voice_start_loading_animation();

    // Send transcription to JS for HA pipeline call
    send_voice_data(status, transcription);
  } else {
    // Send error status to JS
    send_voice_data(status, transcription);

    // If no messages yet and user cancelled, pop the window
    if (s_voice->message_count == 0 && s_voice->window_active) {
      window_stack_remove(s_voice->voice_window, true);
    }
  }
}

static void timer_callback_start_dictation(void *data) {
  dictation_session_start(s_voice->session);
}

static void voice_start_dictation(void) {
  if (s_voice->waiting || s_voice->in_progress) return;

  if (heap_bytes_free() < 6000) {
    voice_add_message(false, "Not enough memory for voice.");
    voice_rebuild_display();
    return;
  }

  s_voice->in_progress = true;
  dictation_session_enable_confirmation(s_voice->session, true);
  s_voice->timer = app_timer_register(0, timer_callback_start_dictation, NULL);
}

// --- Voice window ---

static void voice_select_click_handler(ClickRecognizerRef recognizer, void *context) {
  voice_start_dictation();
}

static void voice_back_click_handler(ClickRecognizerRef recognizer, void *context) {
  voice_stop_loading_animation();
  if (s_voice->in_progress) {
    dictation_session_stop(s_voice->session);
    s_voice->in_progress = false;
  }
  window_stack_pop(true);
}

static void voice_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, voice_select_click_handler);
  window_single_click_subscribe(BUTTON_ID_BACK, voice_back_click_handler);
}

static void voice_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_voice->scroll_layer = scroll_layer_create(bounds);
  scroll_layer_set_click_config_onto_window(s_voice->scroll_layer, window);
  scroll_layer_set_callbacks(s_voice->scroll_layer, (ScrollLayerCallbacks) {
    .click_config_provider = voice_click_config_provider,
  });
  layer_add_child(root, scroll_layer_get_layer(s_voice->scroll_layer));

  // Content layer sized large for scrolling
  s_voice->content_layer = layer_create(GRect(0, 0, bounds.size.w, 2000));
  layer_set_update_proc(s_voice->content_layer, content_layer_update_proc);
  scroll_layer_add_child(s_voice->scroll_layer, s_voice->content_layer);

  s_voice->message_count = 0;
  s_voice->waiting = false;
  s_voice->window_active = true;
  s_voice->dot_state = 0;

  voice_rebuild_display();

  // Auto-start dictation
  s_voice->timer = app_timer_register(300, timer_callback_start_dictation, NULL);
  s_voice->in_progress = true;
  dictation_session_enable_confirmation(s_voice->session, true);
}

static bool send_voice_stop_notification(void) {
  // Tell JS the native voice window closed so it can re-show the menu
  VoiceDataPacket packet = {
    .packet.type = CommandVoiceStop,
    .packet.length = sizeof(Packet),
  };
  return simply_msg_send_packet(&packet.packet);
}

static void voice_window_unload(Window *window) {
  s_voice->window_active = false;
  voice_stop_loading_animation();

  if (s_voice->timer) {
    app_timer_cancel(s_voice->timer);
    s_voice->timer = NULL;
  }

  if (s_voice->content_layer) {
    layer_destroy(s_voice->content_layer);
    s_voice->content_layer = NULL;
  }
  if (s_voice->scroll_layer) {
    scroll_layer_destroy(s_voice->scroll_layer);
    s_voice->scroll_layer = NULL;
  }

  // Notify JS to re-show the menu
  send_voice_stop_notification();
}

static void voice_window_push(void) {
  if (!s_voice->voice_window) {
    s_voice->voice_window = window_create();
    window_set_window_handlers(s_voice->voice_window, (WindowHandlers) {
      .load = voice_window_load,
      .unload = voice_window_unload,
    });
  }
  window_stack_push(s_voice->voice_window, true);
}

// --- Packet handlers ---

static uint8_t pixel_to_font_index(uint8_t px) {
  switch (px) {
    case 14: return 0;
    case 24: return 2;
    case 28: return 3;
    default: return 1; // 18 or anything else
  }
}

static void handle_voice_start_packet(Simply *simply, Packet *data) {
  if (s_voice->in_progress) {
    send_voice_data(64, "");
    return;
  }

  VoiceStartPacket *packet = (VoiceStartPacket *)data;
  s_voice->font_size = pixel_to_font_index(packet->font_size);

  voice_window_push();
}

static void handle_voice_stop_packet(Simply *simply, Packet *data) {
  dictation_session_stop(s_voice->session);
  s_voice->in_progress = false;
}

static void handle_voice_response_packet(Simply *simply, Packet *data) {
  VoiceResponsePacket *packet = (VoiceResponsePacket *)data;

  // Stop loading state
  s_voice->waiting = false;
  voice_stop_loading_animation();

  if (!s_voice->window_active) return;

  // Add assistant message
  voice_add_message(false, packet->response);
  voice_rebuild_display();

  // Haptic feedback
  vibes_short_pulse();
}

bool simply_voice_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandVoiceStart:
      handle_voice_start_packet(simply, packet);
      return true;
    case CommandVoiceStop:
      handle_voice_stop_packet(simply, packet);
      return true;
    case CommandVoiceResponse:
      handle_voice_response_packet(simply, packet);
      return true;
  }

  return false;
}

SimplyVoice *simply_voice_create(Simply *simply) {
  if (s_voice) {
    return s_voice;
  }

  SimplyVoice *self = malloc(sizeof(*self));
  *self = (SimplyVoice) {
    .simply = simply,
    .in_progress = false,
    .window_active = false,
    .message_count = 0,
    .waiting = false,
    .font_size = 1,
    .dot_state = 0,
  };

  self->session = dictation_session_create(SIMPLY_VOICE_BUFFER_LENGTH, dictation_session_callback, NULL);

  s_voice = self;
  return self;
}

void simply_voice_destroy(SimplyVoice *self) {
  if (!self) {
    return;
  }

  voice_stop_loading_animation();

  if (self->voice_window) {
    window_destroy(self->voice_window);
    self->voice_window = NULL;
  }

  if (self->session) {
    dictation_session_destroy(self->session);
    self->session = NULL;
  }

  free(self);
  s_voice = NULL;
}

bool simply_voice_dictation_in_progress() {
  return s_voice && s_voice->in_progress;
}
#endif
