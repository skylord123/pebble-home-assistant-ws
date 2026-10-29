#include "simply_assist.h"

#include "simply.h"

#include "simply_mic_stream.h"
#include "simply_msg.h"
#include "simply_scrollbar.h"
#include "simply_voice.h"

#include "util/graphics_text.h"
#include "util/noop.h"

#include <pebble.h>

#if defined(PBL_MICROPHONE)

// How much conversation the watch keeps, sized against the memory the watch
// actually has: a Pebble Time has around 36K of application heap once this app
// is loaded, while a Time 2 or Core Time 2 has nearly 99K. Past the arena the
// oldest messages fall off the top. It is one allocation that exists only
// while the screen is up, so a wearer who never opens Assist pays nothing.
//
// A single message is capped at half the arena so that one long answer can
// never evict the question that prompted it, and because receiving a message
// costs roughly twice its size in transit: it arrives in segments that are all
// held at once and then joined into one more buffer of the same size again.
#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_GABBRO)
#define ASSIST_ARENA_SIZE 24576
#define ASSIST_MAX_MESSAGES 32
#else
#define ASSIST_ARENA_SIZE 8192
#define ASSIST_MAX_MESSAGES 16
#endif

//! The most one message may be. PKJS is told this and cuts an answer down to
//! it, so the watch is never sent text it would only throw away, and never
//! asked to hold more of one at a time than it has room for.
#define ASSIST_MAX_MESSAGE_BYTES (ASSIST_ARENA_SIZE / 2)

// The thinking dots step one frame per tick. Slow enough to read as breathing
// rather than flickering, fast enough to look alive.
#define THINK_TICK_MS 90

// The pipeline is given a generous half minute plus change to answer. If the
// phone never comes back (the websocket died, the app was killed) the dots
// would otherwise pulse forever, so the watch gives up on its own and says so.
#define THINK_TIMEOUT_MS 45000

// How long the phone has to take the microphone stream before the turn goes
// to dictation instead. A phone app that knows about streams answers at once,
// yes or no; one that does not never answers at all, and the firmware's own
// wait for it runs eight seconds, which is a long time to stare at a watch
// that says it is listening.
#define STREAM_ANSWER_TIMEOUT_MS 5000

// The microphone takes a moment to come free after a stream ends, and
// dictation asked for before then is refused as busy
#define DICTATION_AFTER_STREAM_MS 300

// How often the screen is asked to stay lit while words are landing on it, for
// the wearer who has turned that on. Only while they are actually landing: an
// answer that arrives in one piece is lit once as it lands and needs no
// keeping alive, and neither does the silence before one starts.
//
// The system is left in charge of the backlight throughout. Rather than
// forcing the light on, which overrides the wearer's own backlight settings
// and blacks the screen the instant it is let go, this repeats the same
// interaction the system already sees from a button press: each one restarts
// the system's own fade-out timer. The shortest timeout the watch offers is
// three seconds, so ticking faster than that holds the light, and simply
// stopping hands it straight back - the last tick fades out on the wearer's
// own timeout, exactly as if they had pressed a button just then.
//
// It also means the light can never be left on by mistake. Nothing here holds
// it: whatever stops the ticks - the conversation closing, the phone
// vanishing, this app being killed outright - the light is already on its way
// out, with at most one timeout left to run.
#define BACKLIGHT_HOLD_TICK_MS 2000

// Space between the role label and its text, and between one message and the
// next
#define LABEL_GAP 1
#define MESSAGE_GAP 8
#define CONTENT_MARGIN_TOP 6
#define CONTENT_MARGIN_BOTTOM 10
//! Only rectangular displays need one: round insets each line to the glass
#define CONTENT_MARGIN_SIDE 4
//! Rectangular keeps a scrollbar up the right edge, and the words stop short
//! of it by the same margin they keep from the left
#define CONTENT_MARGIN_RIGHT (CONTENT_MARGIN_SIDE + SIMPLY_SCROLLBAR_INSET)

// How fast holding up or down keeps scrolling. Rectangular slides smoothly and
// can afford to repeat quickly; round moves a whole screen at a time, and
// needs long enough between pages to read one before the next arrives.
#define SCROLL_REPEAT_MS PBL_IF_ROUND_ELSE(400, 100)

// ...and how long the button has to be down before any of that starts. An
// ordinary press is a few hundred milliseconds, which is long enough to have
// collected repeats and turned one press into three pages. Nothing repeats
// until the press has clearly become a hold.
#define SCROLL_HOLD_MS PBL_IF_ROUND_ELSE(700, 400)

// Round draws its own up/down arrows in strips along the top and bottom of the
// screen, the same "there is more this way" language the system menus use. The
// conversation is inset by that much at both ends so a line of text is never
// hidden behind an arrow, which costs the narrowest slivers of the circle and
// nothing that was comfortable to read anyway.
#define INDICATOR_HEIGHT 14

//! The tallest the conversation may lay out to, kept clear of INT16_MAX with
//! room for round to pad the last page
#define ASSIST_MAX_CONTENT_H 30000

typedef struct AssistMessage AssistMessage;

//! One line of the conversation, pointing into the text arena. Messages are
//! stored back to back in the order they were said, so the oldest is always
//! at offset zero and dropping it is a single memmove.
struct AssistMessage {
  uint16_t offset;
  uint16_t length;
  //! Height the body last measured to. Measuring wrapped text is the
  //! expensive part of drawing this screen, and the thinking animation
  //! redraws it ten times a second, so it is measured when the conversation
  //! changes and remembered for every frame in between.
  uint16_t height;
  //! Where the last line of this turn begins, and how far down it sits. An
  //! answer arriving a few words at a time would otherwise be re-wrapped from
  //! its first word on every piece, which for a long one means measuring
  //! thousands of words several times a second: enough to stop the watch
  //! answering for itself and be killed for it. Adding to a turn resumes from
  //! here and lays out only the line that changed and whatever follows it.
  uint16_t wrap_offset;
  uint16_t wrap_height;
  //! The same for the last line the draw pass saw go by above the view. The
  //! firmware repaints the whole window for every frame of the thinking dots,
  //! so without this a turn scrolled deep into is placed from its first word
  //! about ten times a second.
  uint16_t draw_offset;
  uint16_t draw_height;
  uint8_t role;
  bool wrap_bold;
  bool draw_bold;
};

//! Everything measured about a turn stops being true when it moves, because a
//! round display wraps each line to the width the glass allows at that height
static void prv_forget_layout(AssistMessage *message) {
  message->height = 0;
  message->wrap_offset = 0;
  message->wrap_height = 0;
  message->wrap_bold = false;
  message->draw_offset = 0;
  message->draw_height = 0;
  message->draw_bold = false;
}

struct SimplyAssist {
  Simply *simply;
  Window *window;
  ScrollLayer *scroll_layer;
  Layer *content_layer;
  //! The thinking dots, kept apart from the words so the animation never
  //! costs a re-measure of the conversation. The firmware still repaints
  //! the words with every frame; see AssistMessage.draw_offset.
  Layer *dots_layer;
#if defined(PBL_ROUND)
  Layer *indicator_up_layer;
  Layer *indicator_down_layer;
#else
  //! Where the view is in the conversation, always on show: it says how much
  //! of an answer there is whichever way the wearer scrolls it. Round has its
  //! page arrows for that.
  Layer *scrollbar_layer;
#endif
  AppTimer *think_timer;
  AppTimer *timeout_timer;
  //! Ticks while an answer is streaming in, keeping the screen lit. See
  //! BACKLIGHT_HOLD_TICK_MS.
  AppTimer *backlight_timer;
  //! Waiting on the phone to answer a request to stream the microphone
  AppTimer *listen_timer;
  //! Dictation about to take over from a stream the phone would not take
  AppTimer *dictate_timer;
  char *arena;
  uint16_t arena_used;
  //! Content y of the last message, so a new one can be scrolled to its own
  //! first line rather than to the bottom of a wall of text
  int32_t last_message_y;
  //! Content y of the thinking dots, so the wait can be scrolled to as well.
  //! They sit past the end of what was just said, which on a round display is
  //! usually a page further on than the words themselves.
  int32_t thinking_y;
  uint8_t count;
  uint8_t tick;
  //! Chunk counter for vibration sampling during streaming
  uint8_t stream_chunk_count;
  uint8_t font_size;
  bool thinking;
  //! An answer is arriving a piece at a time, so the dots belong directly
  //! under the words rather than alone on a page of their own
  bool streaming;
  //! The wearer has scrolled this turn, by button or by finger, and the view
  //! is theirs until the next thing they say
  bool user_scrolled;
  //! The settings menu has taken the screen. It is a JS window, so this one
  //! has to leave the stack for it, but the conversation is not over.
  bool awaiting_settings;
  bool dictation_confirm;
  //! Where the microphone goes when the wearer speaks. See AssistListen.
  uint8_t listen;
  //! The phone has said the microphone may go to Home Assistant rather than to
  //! dictation, for as long as the watch and the phone both turn out able to
  bool stream_allowed;
  //! Keep listening until the wearer presses select, rather than until Home
  //! Assistant hears them stop talking
  bool stream_manual;
  bool backlight;
  //! Keep the screen lit for as long as an answer is streaming in, and light
  //! it once more as the last of it lands, rather than only flashing it up
  //! when the answer starts
  bool backlight_hold;
  //! Vibration feedback during streaming replies
  bool vibration_feedback;
  bool dark;
  bool destroying;
  //! A turn was started but the wearer walked away from the microphone with
  //! nothing said yet, so backing out should close the screen rather than
  //! leave them staring at an empty conversation
  bool ever_spoke;
  AssistMessage messages[ASSIST_MAX_MESSAGES];
};

typedef struct AssistShowPacket AssistShowPacket;

struct __attribute__((__packed__)) AssistShowPacket {
  Packet packet;
  uint8_t font_size;
  uint8_t flags;
  //! StreamFlag values. The first byte of flags is full.
  uint8_t stream_flags;
};

//! What a show packet is asking for. ShowFlagThemeOnly means the conversation
//! is already up and only its colors have changed, which happens when the
//! background follows the sun and the sun has just moved.
enum {
  ShowFlagConfirm = 1,
  ShowFlagBacklight = 2,
  ShowFlagDark = 4,
  ShowFlagListen = 8,
  ShowFlagThemeOnly = 16,
  //! Start the conversation over without leaving the screen. Backing out of
  //! Assist tears the window down, which is what usually empties it, but the
  //! settings menu comes back to the same window and the transcript has to be
  //! thrown away in place.
  ShowFlagReset = 32,
  ShowFlagBacklightHold = 64,
  ShowFlagVibrationFeedback = 128,
};

//! How the wearer is heard, from the show packet. Without StreamFlagAllowed
//! every turn uses dictation, exactly as before streaming existed.
enum {
  StreamFlagAllowed = 1,
  StreamFlagManual = 2,
};

typedef struct AssistMessagePacket AssistMessagePacket;

struct __attribute__((__packed__)) AssistMessagePacket {
  Packet packet;
  uint8_t role;
  uint8_t flags;
  char text[];
};

//! An answer can arrive a piece at a time as the agent writes it, so a message
//! either starts a new turn or adds to the one already on screen, and either
//! finishes that turn or leaves it open with more still coming.
enum {
  MessageFlagAppend = 1,
  MessageFlagStreaming = 2,
  //! Nothing to add: the phone is still waiting on Home Assistant. The clock
  //! that gives up on a silent phone starts again, and nothing else moves.
  //! Without this a conversation agent that does not stream would go quiet
  //! for the whole of its answer, and a slow one would be declared dead while
  //! it was still being written.
  MessageFlagKeepAlive = 4,
  //! What Home Assistant heard the wearer say, from audio streamed to it. It
  //! goes up as the wearer's turn, and the wait for the answer starts there.
  MessageFlagTranscript = 8,
};

typedef struct AssistListenPacket AssistListenPacket;

//! The phone steering a stream it is in the middle of
struct __attribute__((__packed__)) AssistListenPacket {
  Packet packet;
  uint8_t op;
};

enum {
  //! Home Assistant has heard the wearer stop talking, so the microphone can
  //! close and the wait for the transcript begins
  ListenOpStop = 0,
  //! Home Assistant cannot take audio after all, such as a pipeline with no
  //! speech-to-text: close the microphone and dictate this turn instead
  ListenOpDictate = 1,
};

//! Where the microphone is, when it is not with the system's dictation
typedef enum AssistListen {
  AssistListenIdle = 0,
  //! Asked the phone to take a stream and waiting to hear whether it will
  AssistListenAsking,
  //! The wearer is talking, and every word is on its way to Home Assistant
  AssistListenStreaming,
} AssistListen;

typedef struct AssistTranscriptPacket AssistTranscriptPacket;

struct __attribute__((__packed__)) AssistTranscriptPacket {
  Packet packet;
  //! How long an answer this watch can take, so the phone can cut a long one
  //! down before spending Bluetooth on text that would not fit anyway. Sent
  //! with every transcript rather than negotiated once, which keeps the size
  //! defined in exactly one place.
  uint16_t limit;
  char text[];
};

typedef struct AssistActionPacket AssistActionPacket;

struct __attribute__((__packed__)) AssistActionPacket {
  Packet packet;
  uint8_t action;
};

typedef enum AssistAction {
  AssistActionClosed = 0,
  //! The wearer asked for the assist settings. The conversation stays in
  //! memory while they are away, so it is still here when they come back.
  AssistActionSettings = 1,
  //! The microphone opened and closed within the conversation, however it
  //! closed, so the phone knows when not to push a dialog over it
  AssistActionDictationStarted = 2,
  AssistActionDictationEnded = 3,
  //! A turn is going to Home Assistant as audio: the phone should start a
  //! pipeline run for it, which is ready by the time the audio is flowing
  AssistActionStreamRequested = 4,
  //! The phone took the stream and the wearer is being heard
  AssistActionStreamStarted = 5,
  //! The wearer finished, by pressing select or by something taking the
  //! screen or the microphone: whatever was said so far is the turn
  AssistActionStreamFinished = 6,
  //! The wearer backed out, so the turn is dropped
  AssistActionStreamCancelled = 7,
  //! The phone refused the stream, and the turn went to dictation
  AssistActionStreamRefused = 8,
  //! The phone never answered, which is a phone app that does not know about
  //! streams, and the turn went to dictation
  AssistActionStreamNoAnswer = 9,
} AssistAction;

//! What the view should be looking at after the conversation changes
typedef enum AssistFocus {
  //! The first line of the newest turn
  AssistFocusMessage,
  //! The dots, while the phone is still working and there is nothing to read
  //! yet
  AssistFocusThinking,
  //! Nothing at all. An answer arrives far faster than anyone reads it, so
  //! once its first line is on screen the page belongs to whoever is reading
  //! it, and the rest piles up below for them to scroll to in their own time.
  AssistFocusHold,
  //! More of an answer landed. Hold, except that a rectangular display keeps
  //! the start of the answer in view until the wearer scrolls.
  AssistFocusStream,
} AssistFocus;

static void prv_reflow(SimplyAssist *self, AssistFocus want);
static void prv_close(SimplyAssist *self);

#ifdef SIMPLY_HAS_TOUCH
//! Defined with the rest of the touch handling, but the teardown up here has
//! to be able to call off a press that is still being timed
static void prv_cancel_long_press(void);
#endif

// MARK: - Conversation storage

static void prv_drop_oldest(SimplyAssist *self) {
  if (self->count == 0) { return; }
  const uint16_t drop = self->messages[0].length + 1;
  memmove(self->arena, self->arena + drop, self->arena_used - drop);
  self->arena_used -= drop;
  for (uint8_t i = 1; i < self->count; ++i) {
    self->messages[i].offset -= drop;
    self->messages[i - 1] = self->messages[i];
    // Everything still here has moved up the screen, so on a round display
    // none of it is the height it was
    prv_forget_layout(&self->messages[i - 1]);
  }
  self->count--;
}

static void prv_append(SimplyAssist *self, uint8_t role, const char *text) {
  if (!self->arena || !text) { return; }

  size_t length = strlen(text);
  if (length > ASSIST_ARENA_SIZE - 1) {
    length = ASSIST_ARENA_SIZE - 1;
    // Cutting between the bytes of a multi-byte character would leave a
    // fragment the text renderer cannot draw, so step back to a lead byte
    while (length > 0 && (text[length] & 0xC0) == 0x80) { length--; }
  }

  if (self->count >= ASSIST_MAX_MESSAGES) {
    prv_drop_oldest(self);
  }
  while (self->count > 0 && (size_t)(ASSIST_ARENA_SIZE - self->arena_used) < length + 1) {
    prv_drop_oldest(self);
  }
  // Ensure space is available after dropping messages
  if ((size_t)(ASSIST_ARENA_SIZE - self->arena_used) < length + 1) {
    return;
  }

  memcpy(self->arena + self->arena_used, text, length);
  self->arena[self->arena_used + length] = '\0';
  self->messages[self->count] = (AssistMessage) {
    .offset = self->arena_used,
    .length = length,
    .role = role,
  };
  self->arena_used += length + 1;
  self->count++;
}

//! Writable on purpose: the renderer terminates each word in place while it
//! measures and draws it, then puts the character back
static char *prv_text(SimplyAssist *self, uint8_t index) {
  return self->arena + self->messages[index].offset;
}

//! Forget every measured height. A round display wraps each line to the width
//! the glass allows at that height, so anything that moves a turn up or down
//! changes how tall it is, and the cached figure no longer describes it.
static void prv_invalidate_heights(SimplyAssist *self) {
  for (uint8_t i = 0; i < self->count; ++i) {
    prv_forget_layout(&self->messages[i]);
  }
}

//! Add to the answer already on screen, as it is being written. The turn being
//! extended is the last one in the arena, so its terminator is the last byte
//! in use and the new text simply writes over it.
static void prv_extend(SimplyAssist *self, const char *text) {
  if (!self->arena || !text || !*text || self->count == 0) { return; }

  AssistMessage *last = &self->messages[self->count - 1];
  size_t add = strlen(text);

  // One turn may not outgrow what this watch agreed to hold
  if (last->length + add > ASSIST_MAX_MESSAGE_BYTES) {
    add = (last->length >= ASSIST_MAX_MESSAGE_BYTES)
        ? 0 : ASSIST_MAX_MESSAGE_BYTES - last->length;
    while (add > 0 && (text[add] & 0xC0) == 0x80) { add--; }
  }
  if (add == 0) { return; }

  // Older turns give way to the one being written, but never the turn itself
  while (self->count > 1 && (size_t)(ASSIST_ARENA_SIZE - self->arena_used) < add) {
    prv_drop_oldest(self);
    last = &self->messages[self->count - 1];
  }
  if ((size_t)(ASSIST_ARENA_SIZE - self->arena_used) < add) { return; }

  memcpy(self->arena + self->arena_used - 1, text, add);
  self->arena[self->arena_used - 1 + add] = '\0';
  self->arena_used += add;
  last->length += add;
  // Its height is no longer right, but where its last line begins still is,
  // and that is what makes adding to it cheap
  last->height = 0;
}

static const char *prv_role_label(uint8_t role) {
  switch (role) {
    case AssistRoleUser: return "Me";
    case AssistRoleError: return "Error";
    default: return "Assistant";
  }
}

// MARK: - Fonts and colors

static GFont prv_body_font(SimplyAssist *self) {
  switch (self->font_size) {
    case 14: return fonts_get_system_font(FONT_KEY_GOTHIC_14);
    case 24: return fonts_get_system_font(FONT_KEY_GOTHIC_24);
    case 28: return fonts_get_system_font(FONT_KEY_GOTHIC_28);
    default: return fonts_get_system_font(FONT_KEY_GOTHIC_18);
  }
}

//! The same size as the body, in bold: an emphasised phrase should stand out
//! within its sentence without changing the line it sits on
static GFont prv_body_bold_font(SimplyAssist *self) {
  switch (self->font_size) {
    case 14: return fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
    case 24: return fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
    case 28: return fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
    default: return fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  }
}

static GFont prv_label_font(SimplyAssist *self) {
  return fonts_get_system_font(self->font_size >= 24 ? FONT_KEY_GOTHIC_18_BOLD
                                                     : FONT_KEY_GOTHIC_14_BOLD);
}

//! Role labels are always a single short line, so their height is the font's
//! and never needs measuring
static int16_t prv_label_height(SimplyAssist *self) {
  return self->font_size >= 24 ? 20 : 16;
}

static GColor prv_foreground(SimplyAssist *self) {
  return self->dark ? GColorWhite : GColorBlack;
}

static GColor prv_accent(SimplyAssist *self) {
  // The app's own highlight blue, which is exactly this color
  return PBL_IF_COLOR_ELSE(GColorVividCerulean, prv_foreground(self));
}

static GColor prv_role_color(SimplyAssist *self, uint8_t role) {
  switch (role) {
    case AssistRoleUser:
      return PBL_IF_COLOR_ELSE(self->dark ? GColorLightGray : GColorDarkGray,
                               prv_foreground(self));
    case AssistRoleError:
      // Red on black is muddy on the real displays, so the dark theme uses the
      // lighter of the two reds
      return PBL_IF_COLOR_ELSE(self->dark ? GColorSunsetOrange : GColorRed,
                               prv_foreground(self));
    default:
      return prv_accent(self);
  }
}

// MARK: - Inline weight text

// Home Assistant's conversation agents answer in markdown, and a watch has no
// business knowing what an asterisk means, so PKJS boils it down to two
// in-band markers before the text ever reaches here.
#define TEXT_BOLD_ON 0x01
#define TEXT_BOLD_OFF 0x02

// The most words one line can hold before it is broken early. A line of the
// smallest font on the widest display fits comfortably inside this.
#define MAX_LINE_WORDS 16

typedef struct LineWord LineWord;

struct LineWord {
  char *text;
  uint16_t length;
  int16_t width;
  //! Space to leave in front of this word. Zero where it butts straight up
  //! against the one before it, which is what a weight change mid-word looks
  //! like: the colon after a bold "Temperature" is its own word but no space
  //! ever separated them.
  int16_t gap;
  bool bold;
};

//! Wrapping state for one message body.
//!
//! Only one font can be drawn per graphics_draw_text call and nothing in the
//! SDK reports where its layout engine broke a line, so a sentence with a bold
//! phrase in the middle of it cannot be handed over as a single string. The
//! words are therefore measured and placed here, one draw call each, which
//! also means this has to do for itself the two things the text attributes
//! were doing for free: following the round display's edge, and keeping a line
//! from straddling a page boundary.
typedef struct Wrapper Wrapper;

struct Wrapper {
  GContext *ctx;            //!< NULL while only measuring
  GRect frame;              //!< the scroll layer's frame, in window coordinates
  GFont fonts[2];           //!< [0] regular, [1] bold
  int16_t space_width[2];
  int16_t line_height;
  int32_t y;                //!< content y of the line being filled
  int16_t span;             //!< usable width of that line
  int16_t x0;               //!< where that width starts
  LineWord words[MAX_LINE_WORDS];
  uint8_t count;
  int16_t width;            //!< what those words occupy, spaces included
};

//! Radius of the largest thinking dot, scaled so the wait reads the same on a
//! 144 pixel Pebble as it does on a 260 pixel one
static int16_t prv_dot_size(GRect frame) {
  return frame.size.w / 40 < 4 ? 4 : frame.size.w / 40;
}

//! The line under the level meter saying what the microphone is doing
#define LISTEN_CAPTION_HEIGHT 20

//! Height of the level meter, which stands where the wearer's words will be
static int16_t prv_meter_height(GRect frame) {
  return 4 * prv_dot_size(frame);
}

//! How much room the animation layer needs: the dots, or the meter and its
//! caption while the wearer is talking
static int16_t prv_indicator_height(SimplyAssist *self, GRect frame) {
  if (self->listen != AssistListenIdle) {
    return prv_meter_height(frame) + LISTEN_CAPTION_HEIGHT;
  }
  return 2 * prv_dot_size(frame);
}

#if defined(PBL_ROUND)
//! Only the round layout needs this, to ask the circle how wide a line at a
//! given height is allowed to be
static int16_t prv_isqrt(int32_t v) {
  int32_t r = 0;
  while ((r + 1) * (r + 1) <= v) { r++; }
  return r;
}
#endif

static int16_t prv_text_width(const char *text, GFont font) {
  return graphics_text_layout_get_content_size(
      text, font, GRect(0, 0, 2000, 200), GTextOverflowModeWordWrap,
      GTextAlignmentLeft).w;
}

//! Measure a slice of the conversation without copying it out. The arena is
//! ours and writable, so the slice is terminated in place and put back.
static int16_t prv_slice_width(char *text, uint16_t length, GFont font) {
  const char save = text[length];
  text[length] = '\0';
  const int16_t width = prv_text_width(text, font);
  text[length] = save;
  return width;
}

//! The end of the UTF-8 sequence starting at `i`, so a word is never broken
//! part way through a character
static uint16_t prv_utf8_next(const char *text, uint16_t length, uint16_t i) {
  if (i >= length) { return length; }
  i++;
  while (i < length && ((unsigned char)text[i] & 0xC0) == 0x80) { i++; }
  return i;
}

//! The longest prefix of a word that fits `max` pixels, never shorter than one
//! character so breaking a word always makes progress. The caller has already
//! established that the whole of it does not fit.
static uint16_t prv_fit_prefix(char *text, uint16_t length, GFont font, int16_t max) {
  const uint16_t first = prv_utf8_next(text, length, 0);
  if (first >= length) { return length; }
  uint16_t lo = first;      //!< a boundary that fits, or the one character minimum
  uint16_t hi = length;     //!< a length known not to fit
  while (true) {
    uint16_t mid = (uint16_t)(lo + (hi - lo) / 2);
    while (mid > lo && ((unsigned char)text[mid] & 0xC0) == 0x80) { mid--; }
    if (mid == lo) { break; }
    if (prv_slice_width(text, mid, font) <= max) { lo = mid; } else { hi = mid; }
  }
  return lo;
}

//! A space on its own measures as nothing, so take it as the difference two
//! letters make with and without one between them
static int16_t prv_space_width(GFont font) {
  return prv_text_width("n n", font) - prv_text_width("nn", font);
}

//! How much of the line at this height is usable, and where it starts. On a
//! round display that follows the glass: a line near the top or bottom of a
//! page has less of it to write on than one across the middle.
static void prv_line_span(Wrapper *w) {
#if defined(PBL_ROUND)
  // The display is square and the scroll layer spans its full width, so the
  // circle is the one inscribed in it. Pages are whole screens, so a line's
  // position within its page is its position on the glass.
  const int16_t page = w->frame.size.h;
  const int16_t radius = w->frame.size.w / 2;
  const int16_t top = w->frame.origin.y + (w->y % page) - radius;
  const int16_t bottom = top + w->line_height;
  const int16_t far = (top < 0 ? -top : top) > (bottom < 0 ? -bottom : bottom)
      ? (top < 0 ? -top : top) : (bottom < 0 ? -bottom : bottom);

  int16_t half = 0;
  if (far < radius) {
    half = prv_isqrt((int32_t)radius * radius - (int32_t)far * far) -
        TEXT_FLOW_DEFAULT_INSET;
  }
  if (half < 12) { half = 12; }
  w->x0 = radius - half;
  w->span = 2 * half;
#else
  w->x0 = CONTENT_MARGIN_SIDE;
  w->span = w->frame.size.w - CONTENT_MARGIN_SIDE - CONTENT_MARGIN_RIGHT;
#endif
}

//! Start a fresh line, first pushing it past a page boundary it would
//! otherwise have straddled
static void prv_begin_line(Wrapper *w) {
#if defined(PBL_ROUND)
  const int16_t page = w->frame.size.h;
  if ((w->y % page) + w->line_height > page) {
    w->y += page - (w->y % page);
  }
#endif
  prv_line_span(w);
}

//! Draw what has accumulated and move down a line. Round centres the line in
//! the width the glass allows it; rectangular hangs it off the left margin.
static void prv_flush_line(Wrapper *w) {
  if (w->count > 0 && w->ctx) {
    int16_t x = PBL_IF_ROUND_ELSE(w->x0 + (w->span - w->width) / 2, w->x0);
    for (uint8_t i = 0; i < w->count; ++i) {
      LineWord *word = &w->words[i];
      x += word->gap;
      const char save = word->text[word->length];
      word->text[word->length] = '\0';
      // Words are broken to fit before they get here, so the box is whatever
      // the word measured. Clamping it to the line was what used to cut a
      // spelled out word short and end it in an ellipsis.
      graphics_draw_text(w->ctx, word->text, w->fonts[word->bold],
                         GRect(x, w->y, word->width + 4, w->line_height + 4),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
      word->text[word->length] = save;
      x += word->width;
    }
  }
  w->y += w->line_height;
  w->count = 0;
  w->width = 0;
}

//! Lay out one message body, drawing it when a context is given, and return
//! how tall it turned out.
//!
//! `resume` is the turn being laid out, when the whole of it is wanted: it is
//! picked up from wherever its last line began rather than from its first
//! word, and left holding the new one. Pass NULL to lay out from the top and
//! leave the turn's record alone.
//!
//! `stop_y` ends the pass once the lines have gone past it. Drawing only needs
//! what the screen can show, and a long answer is mostly not on it.
//!
//! `skip` is the turn being drawn, when only drawing: lines wholly above
//! `view_top` are skipped using where it last saw one begin.
static int16_t prv_wrap_body(SimplyAssist *self, GContext *ctx, char *text,
                             int32_t top, GRect frame,
                             AssistMessage *resume, int32_t stop_y,
                             AssistMessage *skip, int32_t view_top) {
  Wrapper w = {
    .ctx = ctx,
    .frame = frame,
    .fonts = { prv_body_font(self), prv_body_bold_font(self) },
    .y = top,
  };
  w.space_width[0] = prv_space_width(w.fonts[0]);
  w.space_width[1] = prv_space_width(w.fonts[1]);
  w.line_height = graphics_text_layout_get_content_size(
      "Ag", w.fonts[0], GRect(0, 0, 2000, 200), GTextOverflowModeWordWrap,
      GTextAlignmentLeft).h;
  if (w.line_height < 8) { w.line_height = self->font_size + 2; }

  bool bold = false;
  bool spaced = false;
  char *p = text;

  // Where the line currently being filled began, which is where a later
  // append will pick the work up from
  uint16_t line_offset = 0;
  int16_t line_height = 0;
  bool line_bold = false;

  if (resume && resume->wrap_height > 0 && resume->wrap_offset <= resume->length) {
    p = text + resume->wrap_offset;
    w.y = top + resume->wrap_height;
    bold = resume->wrap_bold;
    line_offset = resume->wrap_offset;
    line_height = resume->wrap_height;
    line_bold = bold;
  } else if (skip && skip->draw_height > 0 && skip->draw_offset <= skip->wrap_offset &&
             top + skip->draw_height + w.line_height <= view_top) {
    // Only lines before the one measuring resumes from are sure not to move
    p = text + skip->draw_offset;
    w.y = top + skip->draw_height;
    bold = skip->draw_bold;
  }

  prv_begin_line(&w);

  while (*p) {
    if (*p == TEXT_BOLD_ON) { bold = true; p++; continue; }
    if (*p == TEXT_BOLD_OFF) { bold = false; p++; continue; }

    if (*p == '\n') {
      prv_flush_line(&w);
      spaced = false;
      p++;
      // A blank line is a paragraph break. The flush above already moved down
      // one line, so half of another is enough air to separate them without
      // spending a whole empty line on it.
      if (*p == '\n') {
        w.y += w.line_height / 2;
        while (*p == '\n') { p++; }
      }
      prv_begin_line(&w);
      continue;
    }

    if (*p == ' ') { spaced = true; p++; continue; }

    char *word = p;
    while (*p && *p != ' ' && *p != '\n' && *p != TEXT_BOLD_ON && *p != TEXT_BOLD_OFF) {
      p++;
    }
    uint16_t length = p - word;
    int16_t width = prv_slice_width(word, length, w.fonts[bold]);
    int16_t gap = (w.count > 0 && spaced) ? w.space_width[bold] : 0;
    spaced = false;

    // A word wider than a whole line cannot be made to fit by moving it down,
    // so it is broken across lines here. A spelled out answer, B-A-S-S-I-N-E-T,
    // and a long URL are both one word to the splitter below: neither has a
    // space in it and neither breaks at a hyphen. The rest of the word is
    // picked up as the next word on the next turn of the loop, and broken
    // again if it is still too long.
    if (width > w.span) {
      if (w.count > 0) {
        // Start it on a line of its own, which on a round display may be a
        // wider one than the line it was going to share
        prv_flush_line(&w);
        prv_begin_line(&w);
        gap = 0;
      }
      if (width > w.span) {
        const uint16_t fit = prv_fit_prefix(word, length, w.fonts[bold], w.span);
        if (fit > 0 && fit < length) {
          length = fit;
          width = prv_slice_width(word, length, w.fonts[bold]);
          p = word + length;
        }
      }
    }

    if ((w.count > 0 && w.width + gap + width > w.span) ||
        w.count >= MAX_LINE_WORDS) {
      if (gap == 0 && w.count > 1) {
        // Nothing separated this piece from the one before it, so they read as
        // a single word and must not be split across the break. Carry that
        // piece down with it.
        LineWord carry = w.words[--w.count];
        w.width -= carry.gap + carry.width;
        prv_flush_line(&w);
        prv_begin_line(&w);
        carry.gap = 0;
        w.words[w.count++] = carry;
        w.width = carry.width;
      } else {
        prv_flush_line(&w);
        prv_begin_line(&w);
        gap = 0;
      }
    }

    if (w.count == 0) {
      // The first word of a line marks where that line starts
      line_offset = (uint16_t)(word - text);
      line_height = w.y - top;
      line_bold = bold;
      if (skip && w.y + w.line_height <= view_top) {
        skip->draw_offset = line_offset;
        skip->draw_height = line_height;
        skip->draw_bold = bold;
      }
      if (w.y > stop_y) {
        // Everything from here down is off the bottom of the screen
        return w.y - top;
      }
    }

    w.words[w.count] = (LineWord) {
      .text = word, .length = length, .width = width, .gap = gap, .bold = bold,
    };
    w.width += gap + width;
    w.count++;
  }

  prv_flush_line(&w);

  if (resume) {
    resume->wrap_offset = line_offset;
    resume->wrap_height = line_height;
    resume->wrap_bold = line_bold;
  }
  return w.y - top;
}

// MARK: - Layout

//! Walk the conversation, and when a context is given draw it. Laying out and
//! drawing share one pass so the height the scroll layer is told about can
//! never disagree with what lands on the screen. Returns the content height.
//!
//! Without a context this also re-measures every message and caches the
//! result; with one it trusts that cache, so a redraw costs only the drawing.
static int32_t prv_layout(SimplyAssist *self, GContext *ctx) {
  const GRect frame = layer_get_frame(scroll_layer_get_layer(self->scroll_layer));

  if (self->count == 0 && !self->thinking && self->listen == AssistListenIdle) {
    // Nothing said yet: an invitation rather than an empty screen. This is
    // what the wearer sees when the microphone could not be opened at all.
    if (ctx) {
      const int16_t inset = PBL_IF_ROUND_ELSE(20, 6);
      const int16_t hint_w = frame.size.w - 2 * inset;
      graphics_context_set_text_color(ctx, prv_accent(self));
      graphics_draw_text(ctx, "Assistant", fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                         GRect(inset, frame.size.h / 2 - 34, hint_w, 32),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
      graphics_context_set_text_color(ctx, prv_foreground(self));
      graphics_draw_text(ctx, "Press SELECT\nto speak",
                         fonts_get_system_font(FONT_KEY_GOTHIC_18),
                         GRect(inset, frame.size.h / 2, hint_w, 48),
                         GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    }
    self->last_message_y = 0;
    return frame.size.h;
  }

  const int16_t margin = PBL_IF_ROUND_ELSE(0, CONTENT_MARGIN_SIDE);
  const int16_t width = frame.size.w - margin - PBL_IF_ROUND_ELSE(0, CONTENT_MARGIN_RIGHT);
  const GTextAlignment align = PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft);
  const GFont label_font = prv_label_font(self);
  const int16_t label_h = prv_label_height(self);

  // Placing words costs real work, so a redraw only does it for the turns the
  // wearer can actually see. Everything above and below is stepped over using
  // the height the measuring pass already worked out.
  const GPoint offset = scroll_layer_get_content_offset(self->scroll_layer);
  const int16_t view_top = -offset.y - frame.size.h / 2;
  const int16_t view_bottom = -offset.y + frame.size.h + frame.size.h / 2;

  int32_t y = CONTENT_MARGIN_TOP;
  // Where the last thing drawn actually ends, as opposed to where the cursor
  // has been left. The gap trailing the final turn is not content, and on a
  // round display counting it would buy a whole extra page of nothing to page
  // down into.
  int32_t bottom = y;
  self->last_message_y = 0;
  self->thinking_y = 0;

  for (uint8_t i = 0; i < self->count; ++i) {
    const uint8_t role = self->messages[i].role;
    char *text = prv_text(self, i);

#if defined(PBL_ROUND)
    // The body text pages itself, but its label does not, so a turn starting
    // in the last sliver of a page would leave a lonely "Assistant" at the
    // bottom with its answer on the page after. Move the whole turn to the
    // next page when its label and first line will not fit here.
    const int16_t page = frame.size.h;
    const int16_t used = y % page;
    if (used > 0 && page - used < label_h + LABEL_GAP + self->font_size + 4) {
      y += page - used;
    }
#endif

    self->last_message_y = y;

    // A turn never measured yet has to be laid out whatever the scroll
    // position, since its height is what everything below it stands on. Once
    // it is known, only drawing needs it again, and only if it is on screen:
    // an answer growing a word at a time must not re-wrap the whole
    // conversation behind it every time a few more characters land.
    const bool known = (self->messages[i].height > 0);
    const bool visible = (y < view_bottom &&
                          y + label_h + self->messages[i].height > view_top);

    if (ctx && (visible || !known)) {
      graphics_context_set_text_color(ctx, prv_role_color(self, role));
      graphics_draw_text(ctx, prv_role_label(role), label_font,
                         GRect(margin, y, width, label_h),
                         GTextOverflowModeTrailingEllipsis, align, NULL);
    }
    y += label_h + LABEL_GAP;

    if (ctx) {
      graphics_context_set_text_color(ctx, role == AssistRoleError ?
          prv_role_color(self, role) : prv_foreground(self));
    }

    if (!known) {
      // Its height is what everything below it stands on, so it has to be laid
      // out in full, picking up from its last line if only that has changed
      self->messages[i].height =
          prv_wrap_body(self, ctx, text, y, frame, &self->messages[i], INT16_MAX, NULL, 0);
    } else if (ctx && visible) {
      // Height already known: place only as far down as the screen reaches
      prv_wrap_body(self, ctx, text, y, frame, NULL, view_bottom, &self->messages[i], view_top);
    }
    y += self->messages[i].height;
    bottom = y;
    y += MESSAGE_GAP;
  }

  if (self->listen != AssistListenIdle) {
    // The wearer's turn, still being spoken. It takes the place their words
    // will fill once Home Assistant says what it heard: the label they will
    // sit under, and a meter where the text will go.
    const int16_t needed = label_h + LABEL_GAP + prv_indicator_height(self, frame);
    if (self->count == 0) {
      // The first thing said in the conversation has the screen to itself,
      // the way dictation's own screen would have had it
      const int16_t centered = (frame.size.h - needed) / 2;
      if (centered > y) { y = centered; }
    }
#if defined(PBL_ROUND)
    const int16_t page = frame.size.h;
    const int16_t used = y % page;
    if (used > 0 && page - used < needed) {
      y += page - used;
    }
#endif
    self->last_message_y = y;
    if (ctx) {
      graphics_context_set_text_color(ctx, prv_role_color(self, AssistRoleUser));
      graphics_draw_text(ctx, prv_role_label(AssistRoleUser), label_font,
                         GRect(margin, y, width, label_h),
                         GTextOverflowModeTrailingEllipsis, align, NULL);
    }
    self->thinking_y = y + label_h + LABEL_GAP;
    y += needed;
    bottom = y;
    y += MESSAGE_GAP;
  } else if (self->thinking) {
    // The dots themselves live in their own layer, so that the animation can
    // repaint ten times a second without measuring the conversation's words
    // again. All that happens here is reserving the room
    // they need and remembering where it ended up.
    const int16_t dot_max = prv_dot_size(frame);

#if defined(PBL_ROUND)
    // Keep the wait whole on its own page, the same as a turn: half a dot
    // peeking over a page edge is worse than none at all. Having claimed a
    // page it sits in the middle of it, rather than clinging to the top edge
    // under the arrow.
    //
    // None of that applies once an answer has started arriving. The dots are
    // then saying "this sentence is not finished", and belong directly under
    // the words they are about, wherever those happen to have reached.
    if (!self->streaming) {
      const int16_t page = frame.size.h;
      const int16_t used = y % page;
      if (used > 0 && page - used < 2 * dot_max + MESSAGE_GAP) {
        y += (page - used) + page / 2 - dot_max;
      }
    }
#endif

    self->thinking_y = y;
    y += 2 * dot_max;
    bottom = y;
    y += MESSAGE_GAP;
  }

  // Round pads up to whole pages of its own accord, which is all the room the
  // last line needs; rectangular wants a little air under it.
  return PBL_IF_ROUND_ELSE(bottom, bottom + CONTENT_MARGIN_BOTTOM);
}

//! The microphone open to Home Assistant: bars rising and falling where the
//! wearer's words will appear, and a line saying how the turn ends. There is
//! no level to show, as the audio never passes through this app, so the bars
//! only say that it is listening, the way the dots only say it is waiting.
static void prv_draw_listening(SimplyAssist *self, Layer *layer, GContext *ctx) {
  static const uint8_t WAVE[8] = { 1, 2, 4, 6, 7, 6, 4, 2 };
  const GRect bounds = layer_get_bounds(layer);
  const GRect frame = layer_get_frame(scroll_layer_get_layer(self->scroll_layer));
  const int16_t meter_h = prv_meter_height(frame);
  const int16_t bar_w = prv_dot_size(frame);
  const int16_t gap = bar_w;
  const int16_t bars = 5;
  const int16_t left = (bounds.size.w - (bars * bar_w + (bars - 1) * gap)) / 2;
  const bool asking = (self->listen == AssistListenAsking);

  graphics_context_set_fill_color(ctx, asking ?
      PBL_IF_COLOR_ELSE(GColorDarkGray, prv_foreground(self)) : prv_accent(self));
  for (int16_t i = 0; i < bars; ++i) {
    // Until the phone takes the stream the bars sit low and still: nothing is
    // being heard yet, and moving them would say otherwise
    const int16_t level = asking ? 1 : WAVE[(self->tick + 3 * i) % 8];
    const int16_t h = bar_w + (meter_h - bar_w) * level / 7;
    graphics_fill_rect(ctx, GRect(left + i * (bar_w + gap), (meter_h - h) / 2, bar_w, h),
                       bar_w / 2, GCornersAll);
  }

  const char *caption = asking ? "Starting microphone" :
      (self->stream_manual ? "SELECT when done" : "Listening");
  graphics_context_set_text_color(ctx, prv_foreground(self));
  graphics_draw_text(ctx, caption, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(0, meter_h, bounds.size.w, LISTEN_CAPTION_HEIGHT),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

//! The waiting animation, on its own layer above the conversation
static void prv_dots_update(Layer *layer, GContext *ctx) {
  SimplyAssist *self = window_get_user_data(layer_get_window(layer));
  if (!self) { return; }
  if (self->listen != AssistListenIdle) {
    prv_draw_listening(self, layer, ctx);
    return;
  }
  if (!self->thinking) { return; }

  // Three dots breathing in a wave. The wearer is watching this while the
  // phone works, so it is the one moment on this screen worth animating.
  static const uint8_t WAVE[6] = { 0, 1, 2, 2, 1, 0 };
  const GRect bounds = layer_get_bounds(layer);
  const int16_t dot_max = prv_dot_size(
      layer_get_frame(scroll_layer_get_layer(self->scroll_layer)));
  const int16_t dot_min = dot_max - 2;
  const int16_t spacing = dot_max * 3;
  const int16_t cx = bounds.size.w / 2;

  graphics_context_set_fill_color(ctx, prv_accent(self));
  graphics_context_set_antialiased(ctx, true);
  for (uint8_t i = 0; i < 3; ++i) {
    // Each dot to the right lags the one before it, so the swell starts on
    // the left and travels right, the way the words underneath it do
    const int16_t r = dot_min + WAVE[(self->tick + 2 * (2 - i)) % 6];
    graphics_fill_circle(ctx, GPoint(cx + (i - 1) * spacing, dot_max), r);
  }
}

static void prv_content_update(Layer *layer, GContext *ctx) {
  SimplyAssist *self = window_get_user_data(layer_get_window(layer));
  if (!self) { return; }
  prv_layout(self, ctx);
}

#if !defined(PBL_ROUND)
//! The scrollbar, on its own layer over the conversation. It is redrawn with
//! every frame the scroll layer moves, so it needs no telling.
static void prv_scrollbar_update(Layer *layer, GContext *ctx) {
  SimplyAssist *self = window_get_user_data(layer_get_window(layer));
  if (!self || !self->scroll_layer) { return; }
  simply_scrollbar_draw(ctx, layer, self->scroll_layer, prv_foreground(self),
                        self->dark ? GColorBlack : GColorWhite);
}
#endif

//! Re-measure the conversation, resize the scrollable content to match, and
//! move the view to whatever the wearer is waiting on: the dots while the
//! phone is working, and the first line of the answer once it lands. Round
//! shows the page that thing begins on; rectangular puts it at the top of the
//! view, or as close to it as the end of the conversation allows.
static void prv_reflow(SimplyAssist *self, AssistFocus want) {
  if (!self->window || !window_is_loaded(self->window)) { return; }

  const GRect frame = layer_get_frame(scroll_layer_get_layer(self->scroll_layer));
  const int16_t page = frame.size.h;
  int32_t drawn_h = prv_layout(self, NULL);
  // Layer coordinates are 16 bit, so a conversation taller than that gives up
  // its oldest turns. Only long answers in a large font get anywhere near it.
  while (drawn_h > ASSIST_MAX_CONTENT_H && self->count > 1) {
    prv_drop_oldest(self);
    drawn_h = prv_layout(self, NULL);
  }

  // Round moves a whole screen at a time, so the content is rounded up to a
  // whole number of them: the last page is then reachable and every offset
  // the wearer can land on is one the text was laid out against
  const int16_t content_h =
      PBL_IF_ROUND_ELSE(((drawn_h + page - 1) / page) * page, drawn_h);

  layer_set_frame(self->content_layer, GRect(0, 0, frame.size.w, content_h));
  scroll_layer_set_content_size(self->scroll_layer, GSize(frame.size.w, content_h));

  layer_set_frame(self->dots_layer,
                  GRect(0, self->thinking_y, frame.size.w, prv_indicator_height(self, frame)));
  layer_set_hidden(self->dots_layer, !self->thinking && self->listen == AssistListenIdle);
  layer_mark_dirty(self->dots_layer);

  // Text landing below the bottom of the screen changes nothing anyone can
  // see, and redrawing for it would place the words of every visible line
  // again for nothing
  const int16_t view_bottom = -scroll_layer_get_content_offset(
      self->scroll_layer).y + page;
  const bool holding = (want == AssistFocusHold || want == AssistFocusStream);
  if (!holding || self->last_message_y <= view_bottom) {
    layer_mark_dirty(self->content_layer);
  }

  // While streaming, auto-scroll to keep the message start visible on rectangular
  // displays. Round displays paginate and don't need this - they already show the
  // page the reply starts on.
  if (holding) {
    // User scroll takes priority: once they scroll, they control the view
    if (want == AssistFocusHold || self->user_scrolled) {
      return;
    }
    // Auto-scroll on rectangular displays only: rectangular watches benefit from
    // smooth scrolling to keep the message visible while it's being written.
    // Round watches paginate, so they don't need auto-scroll.
#if !defined(PBL_ROUND)
    int16_t target = self->last_message_y;
    const int16_t last = content_h - page;
    if (target > last) { target = last; }
    if (target < 0) { target = 0; }
    scroll_layer_set_content_offset(self->scroll_layer, GPoint(0, -target), true);
#endif
    return;
  }

  // And the moment the wearer scrolls anywhere themselves, the view is theirs
  // for the rest of the turn. Nothing that arrives afterwards takes it back.
  if (self->user_scrolled) {
    return;
  }

  const int16_t focus = (want == AssistFocusThinking && self->thinking)
      ? self->thinking_y : self->last_message_y;
  const int16_t last = content_h - page;

  // Round rests only on page boundaries, so show the page the focus begins
  // on. Rectangular scrolls freely and puts it at the top of the view, unless
  // the conversation runs out before that fills the screen.
  int16_t target = PBL_IF_ROUND_ELSE((focus / page) * page,
                                     focus < last ? focus : last);
  if (target > last) { target = last; }
  if (target < 0) { target = 0; }

  scroll_layer_set_content_offset(self->scroll_layer, GPoint(0, -target), true);
}

// MARK: - Vibration

// ChatGPT Android vibration pattern (original): { 80, 100, 80 } (80ms vibrate, 100ms gap, 80ms vibrate)
// Further reduced for even lighter, more subtle feedback
static const uint32_t s_vibration_pattern[] = { 20, 100, 20 };
static const VibePattern s_stream_vibe = {
  .durations = s_vibration_pattern,
  .num_segments = ARRAY_LENGTH(s_vibration_pattern),
};

// MARK: - Thinking state

static void prv_think_tick(void *data) {
  SimplyAssist *self = data;
  self->think_timer = NULL;
  // The layers are gone while the settings menu has the screen, but the
  // answer being waited on is not; the animation picks up again on the way
  // back in rather than being torn down and restarted
  if ((!self->thinking && self->listen == AssistListenIdle) || !self->dots_layer) { return; }
  // Wrapped to a length both waves divide, the dots' six steps and the
  // meter's eight, so neither phase can jump when a plain counter would have
  // rolled over
  self->tick = (self->tick + 1) % 24;
  layer_mark_dirty(self->dots_layer);
  self->think_timer = app_timer_register(THINK_TICK_MS, prv_think_tick, self);
}

//! Give the backlight back to the system. There is nothing to undo: the ticks
//! simply stop, and the last one fades out on the wearer's own timeout.
static void prv_stop_backlight_hold(SimplyAssist *self) {
  if (self->backlight_timer) {
    app_timer_cancel(self->backlight_timer);
    self->backlight_timer = NULL;
  }
}

static void prv_backlight_tick(void *data) {
  SimplyAssist *self = data;
  self->backlight_timer = NULL;
  // The answer stopped arriving, or the screen went away, between one tick and
  // the next. Either way this is where the holding stops; the last piece to
  // land lights the screen on its own way past.
  if (!self->streaming || !self->backlight_hold) { return; }
  light_enable_interaction();
  self->backlight_timer = app_timer_register(BACKLIGHT_HOLD_TICK_MS,
                                             prv_backlight_tick, self);
}

//! Start keeping the screen lit, if the wearer asked for that. Lighting it
//! here as well as on the tick means the answer is readable from the piece
//! that started it rather than a couple of seconds into it.
static void prv_start_backlight_hold(SimplyAssist *self) {
  if (!self->backlight_hold || self->backlight_timer) { return; }
  light_enable_interaction();
  self->backlight_timer = app_timer_register(BACKLIGHT_HOLD_TICK_MS,
                                             prv_backlight_tick, self);
}

static void prv_stop_thinking(SimplyAssist *self) {
  self->thinking = false;
  // Nothing is arriving any more, whichever way the wait ended. Saying so
  // matters for the phone that simply stopped talking, where no last piece
  // ever comes to settle it: the dots are gone, and the screen must not be
  // held for an answer that is not being written.
  self->streaming = false;
  if (self->think_timer) {
    app_timer_cancel(self->think_timer);
    self->think_timer = NULL;
  }
  if (self->timeout_timer) {
    app_timer_cancel(self->timeout_timer);
    self->timeout_timer = NULL;
  }
  prv_stop_backlight_hold(self);
}

static void prv_think_timeout(void *data) {
  SimplyAssist *self = data;
  self->timeout_timer = NULL;
  prv_stop_thinking(self);
  self->stream_chunk_count = 0;
  prv_append(self, AssistRoleError, "No response from Home Assistant");
  prv_reflow(self, AssistFocusMessage);
}

static void prv_start_thinking(SimplyAssist *self) {
  prv_stop_thinking(self);
  self->thinking = true;
  self->tick = 0;
  self->think_timer = app_timer_register(THINK_TICK_MS, prv_think_tick, self);
  self->timeout_timer = app_timer_register(THINK_TIMEOUT_MS, prv_think_timeout, self);
}

//! Something arrived, and more is still coming. The animation carries on from
//! wherever it had got to rather than jumping back to the start, and the wait
//! for the phone begins again: an answer that takes a minute to write is not
//! the same as a phone that has stopped answering.
static void prv_keep_thinking(SimplyAssist *self) {
  if (!self->thinking) {
    prv_start_thinking(self);
    return;
  }
  if (self->timeout_timer && app_timer_reschedule(self->timeout_timer, THINK_TIMEOUT_MS)) {
    return;
  }
  self->timeout_timer = app_timer_register(THINK_TIMEOUT_MS, prv_think_timeout, self);
}

// MARK: - Messages to JS

static void prv_send_transcript(const char *text) {
  const size_t text_length = strlen(text) + 1;
  const size_t packet_length = sizeof(AssistTranscriptPacket) + text_length;
  uint8_t buffer[packet_length];
  AssistTranscriptPacket *packet = (AssistTranscriptPacket *)buffer;
  *packet = (AssistTranscriptPacket) {
    .packet = { .type = CommandAssistTranscript, .length = packet_length },
    .limit = ASSIST_MAX_MESSAGE_BYTES,
  };
  memcpy(packet->text, text, text_length);
  simply_msg_send_packet(&packet->packet);
}

static void prv_send_action(uint8_t action) {
  AssistActionPacket packet = {
    .packet = { .type = CommandAssistAction, .length = sizeof(packet) },
    .action = action,
  };
  simply_msg_send_packet(&packet.packet);
}

// MARK: - Dictation

static void prv_start_dictation(SimplyAssist *self) {
  if (self->thinking) { return; }
  if (simply_voice_start(self->simply, self->dictation_confirm, true)) {
    prv_send_action(AssistActionDictationStarted);
  }
}

static bool prv_listening(SimplyAssist *self) {
  return self->listen != AssistListenIdle;
}

//! Keep the animation running. Listening and thinking share it: it is the
//! dots while the phone works, and a level meter while the wearer talks.
static void prv_start_ticking(SimplyAssist *self) {
  if (!self->think_timer) {
    self->think_timer = app_timer_register(THINK_TICK_MS, prv_think_tick, self);
  }
}

static void prv_cancel_listen_timer(SimplyAssist *self) {
  if (self->listen_timer) {
    app_timer_cancel(self->listen_timer);
    self->listen_timer = NULL;
  }
}

//! Close the microphone and forget the stream, without telling anyone. Every
//! way a stream ends goes through here; the callers say what it meant.
static void prv_end_stream(SimplyAssist *self) {
  prv_cancel_listen_timer(self);
  if (self->listen != AssistListenIdle) {
    simply_mic_stream_stop();
    self->listen = AssistListenIdle;
  }
}

static void prv_dictate_now(void *data) {
  SimplyAssist *self = data;
  self->dictate_timer = NULL;
  if (self->destroying) { return; }
  prv_start_dictation(self);
}

//! Hand this turn to dictation, once the microphone has had a moment to come
//! free of the stream that was meant to have it
static void prv_dictate_instead(SimplyAssist *self) {
  prv_end_stream(self);
  prv_reflow(self, AssistFocusMessage);
  if (!self->dictate_timer) {
    self->dictate_timer = app_timer_register(DICTATION_AFTER_STREAM_MS, prv_dictate_now, self);
  }
}

//! The wearer has said all they are going to. The audio already sent is the
//! turn, and the dots stand in for it until Home Assistant says what it heard.
static void prv_finish_stream(SimplyAssist *self) {
  prv_end_stream(self);
  self->ever_spoke = true;
  self->user_scrolled = false;
  prv_start_thinking(self);
  prv_reflow(self, AssistFocusThinking);
}

//! Back out of a turn that is listening. With nothing said yet this leaves
//! the screen, the same as backing out of dictation.
static void prv_cancel_stream(SimplyAssist *self) {
  prv_end_stream(self);
  prv_send_action(AssistActionStreamCancelled);
  if (!self->ever_spoke) {
    prv_close(self);
    return;
  }
  prv_reflow(self, AssistFocusMessage);
}

static void prv_stream_started(void *context) {
  SimplyAssist *self = context;
  if (self->listen != AssistListenAsking) { return; }
  prv_cancel_listen_timer(self);
  self->listen = AssistListenStreaming;
  prv_send_action(AssistActionStreamStarted);
  if (self->dots_layer) {
    layer_mark_dirty(self->dots_layer);
  }
  // There is no system screen to say the microphone is open, only a banner
  // sliding in at the bottom, so it is said here as well
  if (self->vibration_feedback) {
    vibes_short_pulse();
  }
}

static void prv_stream_stopped(SimplyMicStreamStop reason, void *context) {
  SimplyAssist *self = context;
  if (self->listen == AssistListenAsking) {
    // The phone said no, or never said anything and the firmware stopped
    // waiting. Either way the wearer is still waiting to talk.
    prv_cancel_listen_timer(self);
    self->listen = AssistListenIdle;
    // The answer will not change before the next turn, so the rest of this
    // conversation goes straight to dictation rather than asking again
    self->stream_allowed = false;
    prv_send_action(AssistActionStreamRefused);
    prv_dictate_instead(self);
    return;
  }
  if (self->listen == AssistListenStreaming) {
    // A notification, the system taking the microphone or the phone going
    // away. What was said up to here is still the wearer's turn.
    self->listen = AssistListenIdle;
    prv_send_action(AssistActionStreamFinished);
    prv_finish_stream(self);
  }
}

static void prv_stream_no_answer(void *data) {
  SimplyAssist *self = data;
  self->listen_timer = NULL;
  if (self->listen != AssistListenAsking) { return; }
  prv_end_stream(self);
  self->stream_allowed = false;
  prv_send_action(AssistActionStreamNoAnswer);
  prv_dictate_instead(self);
}

//! Open the microphone for a new turn: to Home Assistant where the phone has
//! allowed it and this firmware can, and to dictation everywhere else
static void prv_start_listening(SimplyAssist *self) {
  if (self->thinking || prv_listening(self) || self->dictate_timer) { return; }
  if (self->stream_allowed && !simply_voice_dictation_in_progress() &&
      simply_mic_stream_available() &&
      simply_mic_stream_start(prv_stream_started, prv_stream_stopped, self) ==
          SimplyMicStreamStartOk) {
    self->listen = AssistListenAsking;
    self->user_scrolled = false;
    self->listen_timer = app_timer_register(STREAM_ANSWER_TIMEOUT_MS, prv_stream_no_answer, self);
    prv_send_action(AssistActionStreamRequested);
    prv_start_ticking(self);
    prv_reflow(self, AssistFocusThinking);
    return;
  }
  // Busy, no phone, an older watch: dictation is what always happened before
  prv_start_dictation(self);
}

//! Select, or a tap: start talking, or say that talking is done
static void prv_speak(SimplyAssist *self) {
  switch (self->listen) {
    case AssistListenStreaming:
      prv_send_action(AssistActionStreamFinished);
      prv_finish_stream(self);
      return;
    case AssistListenAsking:
      // Nothing has been heard yet, so there is nothing to finish
      return;
    default:
      prv_start_listening(self);
      return;
  }
}

bool simply_assist_handle_dictation(Simply *simply, int status, const char *transcription) {
  SimplyAssist *self = simply->assist;
  if (!self || self->destroying) { return false; }

  prv_send_action(AssistActionDictationEnded);

  if (status == DictationSessionStatusSuccess && transcription && transcription[0]) {
    self->ever_spoke = true;
    self->user_scrolled = false;
    self->stream_chunk_count = 0;
    prv_append(self, AssistRoleUser, transcription);
    prv_start_thinking(self);
    prv_reflow(self, AssistFocusThinking);
    prv_send_transcript(transcription);
    return true;
  }

  switch (status) {
    case DictationSessionStatusFailureTranscriptionRejected:
    case DictationSessionStatusFailureTranscriptionRejectedWithError:
    case DictationSessionStatusFailureSystemAborted:
      // The wearer backed out of the microphone. Leaving them on an empty
      // conversation would be a dead end, so the screen goes with them; with
      // something already said it stays put so they can read it again.
      if (!self->ever_spoke) {
        prv_close(self);
      }
      return true;
    case DictationSessionStatusFailureNoSpeechDetected:
      prv_append(self, AssistRoleError, "Nothing heard");
      break;
    case DictationSessionStatusFailureConnectivityError:
      prv_append(self, AssistRoleError, "No connection for dictation");
      break;
    case DictationSessionStatusFailureDisabled:
      prv_append(self, AssistRoleError, "Dictation is turned off for this account");
      break;
    default:
      prv_append(self, AssistRoleError, "Dictation failed");
      break;
  }

  self->ever_spoke = true;
  prv_reflow(self, AssistFocusMessage);
  return true;
}

// MARK: - Buttons

static void prv_select_click(ClickRecognizerRef recognizer, void *context) {
  prv_speak(context);
}

//! Back leaves the conversation, except while it is listening, when it only
//! drops what is being said. Leaving takes the window off the stack exactly as
//! the system's own back would, and disappear does the rest.
static void prv_back_click(ClickRecognizerRef recognizer, void *context) {
  SimplyAssist *self = context;
  if (prv_listening(self)) {
    prv_cancel_stream(self);
    return;
  }
  window_stack_remove(self->window, true);
}

//! Hand the screen to the settings menu. That menu is drawn by JS, and a JS
//! window replaces whatever is on the stack rather than sitting on top of it,
//! so this window has to step aside. It keeps everything it is holding: the
//! conversation is still here when the wearer comes back to it, with whatever
//! they changed applied to it.
static void prv_open_settings(SimplyAssist *self) {
  self->awaiting_settings = true;
  prv_send_action(AssistActionSettings);
  window_stack_remove(self->window, false);
}

static void prv_select_long_click(ClickRecognizerRef recognizer, void *context) {
  // The microphone is open, and the settings would take the screen from under
  // it. Holding select is far more likely the wearer pressing to finish.
  if (prv_listening(context)) { return; }
  prv_open_settings(context);
}

//! The press itself always counts. After that the recognizer reports how many
//! times it has fired, which is how long the button has been held, and nothing
//! moves until that adds up to a deliberate hold.
static bool prv_scroll_now(ClickRecognizerRef recognizer) {
  const uint8_t fired = click_number_of_clicks_counted(recognizer);
  if (fired <= 1) {
    return true;
  }
  return (uint32_t)(fired - 1) * SCROLL_REPEAT_MS >= SCROLL_HOLD_MS;
}

// The scroll layer's own handlers do the moving; these only decide when, and
// note that it was the wearer who asked for it, which is what stops an answer
// still arriving from taking the view back off them.
static void prv_scroll_up_click(ClickRecognizerRef recognizer, void *context) {
  SimplyAssist *self = context;
  if (!prv_scroll_now(recognizer)) { return; }
  self->user_scrolled = true;
  scroll_layer_scroll_up_click_handler(recognizer, self->scroll_layer);
}

static void prv_scroll_down_click(ClickRecognizerRef recognizer, void *context) {
  SimplyAssist *self = context;
  if (!prv_scroll_now(recognizer)) { return; }
  self->user_scrolled = true;
  scroll_layer_scroll_down_click_handler(recognizer, self->scroll_layer);
}

static void prv_click_config_provider(void *context) {
  SimplyAssist *self = context;
  window_set_click_context(BUTTON_ID_UP, self);
  window_set_click_context(BUTTON_ID_DOWN, self);
  window_set_click_context(BUTTON_ID_SELECT, self);
  window_set_click_context(BUTTON_ID_BACK, self);
  // Repeating, so holding a button keeps going the way it does everywhere
  // else on the watch, rather than needing a press per line
  window_single_repeating_click_subscribe(BUTTON_ID_UP, SCROLL_REPEAT_MS,
                                          prv_scroll_up_click);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, SCROLL_REPEAT_MS,
                                          prv_scroll_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, prv_select_long_click, NULL);
  window_single_click_subscribe(BUTTON_ID_BACK, prv_back_click);
}

// MARK: - Window

//! Paint everything the theme decides. Called when the window is built and
//! again whenever the background changes under a conversation already on
//! screen, so both go through exactly the same code.
static void prv_apply_theme(SimplyAssist *self) {
  window_set_background_color(self->window, self->dark ? GColorBlack : GColorWhite);

#if defined(PBL_ROUND)
  // The system's own up/down arrows say "there is more this way" in the
  // language the round menus already use
  if (self->scroll_layer && self->indicator_up_layer && self->indicator_down_layer) {
    ContentIndicator *indicator = scroll_layer_get_content_indicator(self->scroll_layer);
    const GColor background = self->dark ? GColorBlack : GColorWhite;
    const ContentIndicatorConfig up_config = {
      .layer = self->indicator_up_layer,
      .times_out = false,
      .alignment = GAlignCenter,
      .colors = { .foreground = prv_accent(self), .background = background },
    };
    const ContentIndicatorConfig down_config = {
      .layer = self->indicator_down_layer,
      .times_out = false,
      .alignment = GAlignCenter,
      .colors = { .foreground = prv_accent(self), .background = background },
    };
    content_indicator_configure_direction(indicator, ContentIndicatorDirectionUp, &up_config);
    content_indicator_configure_direction(indicator, ContentIndicatorDirectionDown, &down_config);
  }
#endif

  if (self->content_layer) {
    layer_mark_dirty(self->content_layer);
  }
  if (self->dots_layer) {
    layer_mark_dirty(self->dots_layer);
  }
}

static void prv_window_load(Window *window) {
  SimplyAssist *self = window_get_user_data(window);
  Layer *root_layer = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(root_layer);

  const GRect scroll_frame = PBL_IF_ROUND_ELSE(
      GRect(0, INDICATOR_HEIGHT, bounds.size.w, bounds.size.h - 2 * INDICATOR_HEIGHT),
      bounds);

  self->scroll_layer = scroll_layer_create(scroll_frame);
  scroll_layer_set_shadow_hidden(self->scroll_layer, PBL_IF_ROUND_ELSE(true, false));
  // Round pages a screen at a time: sliding round text a pixel at a time
  // re-wraps every line under the reader, which is what makes it hard to
  // follow. Rectangular keeps the scrolling it has always had.
  scroll_layer_set_paging(self->scroll_layer, PBL_IF_ROUND_ELSE(true, false));

  self->content_layer = layer_create(GRect(0, 0, scroll_frame.size.w, scroll_frame.size.h));
  layer_set_update_proc(self->content_layer, prv_content_update);
  scroll_layer_add_child(self->scroll_layer, self->content_layer);

  self->dots_layer = layer_create(GRect(0, 0, scroll_frame.size.w, 0));
  layer_set_update_proc(self->dots_layer, prv_dots_update);
  layer_set_hidden(self->dots_layer, true);
  scroll_layer_add_child(self->scroll_layer, self->dots_layer);
  layer_add_child(root_layer, scroll_layer_get_layer(self->scroll_layer));

  window_set_click_config_provider_with_context(window, prv_click_config_provider, self);

  // Coming back to an answer that is still being written: the dots pick up
  // where they left off
  if (self->thinking || prv_listening(self)) {
    prv_start_ticking(self);
  }

#if defined(PBL_ROUND)
  self->indicator_up_layer = layer_create(GRect(0, 0, bounds.size.w, INDICATOR_HEIGHT));
  self->indicator_down_layer = layer_create(
      GRect(0, bounds.size.h - INDICATOR_HEIGHT, bounds.size.w, INDICATOR_HEIGHT));
  layer_add_child(root_layer, self->indicator_up_layer);
  layer_add_child(root_layer, self->indicator_down_layer);
#else
  // Added after the scroll layer so it paints over the words, which stop
  // short of it (CONTENT_MARGIN_RIGHT)
  self->scrollbar_layer = layer_create(bounds);
  layer_set_update_proc(self->scrollbar_layer, prv_scrollbar_update);
  layer_add_child(root_layer, self->scrollbar_layer);
#endif

  prv_apply_theme(self);
}

static void prv_window_unload(Window *window) {
  SimplyAssist *self = window_get_user_data(window);
  // Nothing may be left pointing at layers that are about to go
  if (self->think_timer) {
    app_timer_cancel(self->think_timer);
    self->think_timer = NULL;
  }
#if defined(PBL_ROUND)
  layer_destroy(self->indicator_up_layer);
  self->indicator_up_layer = NULL;
  layer_destroy(self->indicator_down_layer);
  self->indicator_down_layer = NULL;
#else
  layer_destroy(self->scrollbar_layer);
  self->scrollbar_layer = NULL;
#endif
  layer_destroy(self->dots_layer);
  self->dots_layer = NULL;
  layer_destroy(self->content_layer);
  self->content_layer = NULL;
  scroll_layer_destroy(self->scroll_layer);
  self->scroll_layer = NULL;
}

static void prv_window_appear(Window *window) {
  SimplyAssist *self = window_get_user_data(window);
  // Whatever was covering the conversation has gone and an answer may still
  // be arriving underneath it, so take the screen back up again
  if (self->streaming) {
    prv_start_backlight_hold(self);
  }
  // The conversation is coming back from under the dictation window, which
  // can be dismissing long after an answer has started arriving. Nothing
  // moved while it was covered, so this only has to measure and draw what is
  // there: deciding where to look again here would drag the view off
  // whatever the wearer is in the middle of reading.
  prv_reflow(self, AssistFocusHold);
}

static void prv_destroy(SimplyAssist *self) {
#ifdef SIMPLY_HAS_TOUCH
  prv_cancel_long_press();
#endif
  prv_stop_thinking(self);
  prv_end_stream(self);
  if (self->dictate_timer) {
    app_timer_cancel(self->dictate_timer);
    self->dictate_timer = NULL;
  }
  window_destroy(self->window);
  self->simply->assist = NULL;
  free(self->arena);
  free(self);
}

static void prv_destroy_later(void *data) {
  SimplyAssist *self = data;
  bool animated = false;
  window_stack_remove(self->window, animated);
  prv_destroy(self);
}

//! End the conversation. Disappear does this for a window leaving the screen,
//! but one covered by the dictation UI is no longer on screen, and removing it
//! from there never calls disappear at all.
static void prv_close(SimplyAssist *self) {
  if (self->destroying) { return; }
  self->destroying = true;
  prv_stop_thinking(self);
  // The microphone closes with the conversation. The phone hears about it
  // through the close, which drops whatever turn was in flight.
  prv_end_stream(self);
  prv_send_action(AssistActionClosed);
  // Defer the teardown: destroying a window from inside its own disappear
  // handler is unsafe while the window stack is mid-transition. This also
  // takes the window off the stack.
  app_timer_register(0, prv_destroy_later, self);
}

static void prv_window_disappear(Window *window) {
  SimplyAssist *self = window_get_user_data(window);
  // Nothing off screen has any business holding the backlight, whether the
  // conversation is over or only stepping aside for a moment. This is ahead of
  // every early return below on purpose: the answer may well still be coming,
  // and the wait resumes in appear.
  prv_stop_backlight_hold(self);
  // The system dictation UI covers this window for the length of a session.
  // That is not the conversation ending, so hold everything and wait for it
  // to come back.
  if (simply_voice_dictation_in_progress()) { return; }
  // Nor is stepping aside for the settings menu
  if (self->awaiting_settings) {
    self->awaiting_settings = false;
    return;
  }
  prv_close(self);
}

static SimplyAssist *prv_create(Simply *simply) {
  SimplyAssist *self = malloc(sizeof(*self));
  if (!self) { return NULL; }
  *self = (SimplyAssist) { .simply = simply, .font_size = 18 };

  self->arena = malloc(ASSIST_ARENA_SIZE);
  if (!self->arena) {
    free(self);
    return NULL;
  }

  self->window = window_create();
  if (!self->window) {
    free(self->arena);
    free(self);
    return NULL;
  }
  window_set_user_data(self->window, self);
  window_set_window_handlers(self->window, (WindowHandlers) {
    .load = prv_window_load,
    .appear = prv_window_appear,
    .disappear = prv_window_disappear,
    .unload = prv_window_unload,
  });

  return self;
}

// MARK: - Packets

//! Throw the conversation away, leaving the screen itself alone
static void prv_clear_conversation(SimplyAssist *self) {
  prv_stop_thinking(self);
  prv_end_stream(self);
  self->count = 0;
  self->arena_used = 0;
  self->last_message_y = 0;
  self->thinking_y = 0;
  self->streaming = false;
  self->user_scrolled = false;
  self->ever_spoke = false;
  self->stream_chunk_count = 0;
}

//! The phone steering a stream it is in the middle of
static void prv_handle_listen(Simply *simply, Packet *data) {
  SimplyAssist *self = simply->assist;
  if (!self || self->destroying) { return; }
  AssistListenPacket *packet = (AssistListenPacket *)data;
  switch (packet->op) {
    case ListenOpStop:
      if (prv_listening(self)) {
        prv_finish_stream(self);
      }
      return;
    case ListenOpDictate:
      if (prv_listening(self)) {
        prv_dictate_instead(self);
      }
      return;
  }
}

static void prv_handle_show(Simply *simply, Packet *data) {
  AssistShowPacket *packet = (AssistShowPacket *)data;
  SimplyAssist *self = simply->assist;

  // Only the colors have changed. There is nothing to do unless a conversation
  // is already up, and everything it holds stays exactly where it is: the
  // words, the scroll position and the answer still being written.
  if (packet->flags & ShowFlagThemeOnly) {
    if (!self || self->destroying) { return; }
    self->dark = (packet->flags & ShowFlagDark);
    prv_apply_theme(self);
    return;
  }

  if (!self) {
    self = prv_create(simply);
    if (!self) { return; }
    simply->assist = self;
  }

  // A different size means every turn wraps differently, so nothing measured
  // under the old one still describes it
  if (self->font_size != (packet->font_size ? packet->font_size : 18)) {
    prv_invalidate_heights(self);
  }
  self->font_size = packet->font_size ? packet->font_size : 18;
  self->streaming = false;
  self->user_scrolled = false;
  self->dictation_confirm = (packet->flags & ShowFlagConfirm);
  self->backlight = (packet->flags & ShowFlagBacklight);
  self->backlight_hold = (packet->flags & ShowFlagBacklightHold);
  self->vibration_feedback = (packet->flags & ShowFlagVibrationFeedback);
  self->dark = (packet->flags & ShowFlagDark);
  self->stream_allowed = (packet->stream_flags & StreamFlagAllowed);
  self->stream_manual = (packet->stream_flags & StreamFlagManual);
  //! Whether to open the microphone straight away. Coming back from the
  //! settings menu should land on the conversation, not on the dictation UI.
  const bool open_mic = (packet->flags & ShowFlagListen);
  if (packet->flags & ShowFlagReset) {
    prv_clear_conversation(self);
  }
  prv_apply_theme(self);

  if (!window_stack_contains_window(self->window)) {
    window_stack_push(self->window, false);
  }
  // A show packet always puts the dots back on their own line (self->streaming
  // was cleared above), so as far as this screen is concerned nothing is
  // arriving just now. An answer that is in fact still being written takes the
  // screen back up on its next piece, which is also how the setting being
  // turned on from the settings menu starts applying to a turn already in
  // flight.
  prv_stop_backlight_hold(self);
  prv_reflow(self, AssistFocusMessage);
  // Opening Assist means the wearer wants to say something, so go straight to
  // the microphone rather than making them press select first
  if (open_mic) {
    prv_start_listening(self);
  }
}

static void prv_handle_message(Simply *simply, Packet *data) {
  SimplyAssist *self = simply->assist;
  if (!self || self->destroying) { return; }
  AssistMessagePacket *packet = (AssistMessagePacket *)data;
  // The text is used as a C string, so it has to end inside the packet
  if (data->length <= sizeof(*packet) ||
      !memchr(packet->text, '\0', data->length - sizeof(*packet))) {
    return;
  }

  if (packet->flags & MessageFlagKeepAlive) {
    // Only a wait still under way is kept going. One that already ended, by
    // an answer or by giving up, must not come back hidden and block the mic.
    if (self->thinking) {
      prv_keep_thinking(self);
    }
    return;
  }

  // Anything else that arrives settles the turn, so a microphone still open
  // for it closes. An error part way through a stream is the usual case.
  prv_end_stream(self);

  if (packet->flags & MessageFlagTranscript) {
    // What Home Assistant heard. It is the wearer's turn, shown as if they had
    // dictated it, and the answer is still to come.
    self->ever_spoke = true;
    self->user_scrolled = false;
    self->stream_chunk_count = 0;
    prv_append(self, AssistRoleUser, packet->text);
    prv_start_thinking(self);
    prv_reflow(self, AssistFocusThinking);
    return;
  }

  const bool streaming = (packet->flags & MessageFlagStreaming);
  // Only a turn of the same voice can be added to, so a message that arrives
  // late from an answer already finished with cannot graft itself onto the
  // wrong speaker
  const bool append = (packet->flags & MessageFlagAppend) && self->count > 0 &&
      self->messages[self->count - 1].role == packet->role;

  if (streaming) {
    // Still writing. The dots carry on underneath, and the clock that gives up
    // on a silent phone starts again from this piece rather than from the
    // question, so a long answer is never mistaken for a dead one.
    prv_keep_thinking(self);
  } else {
    prv_stop_thinking(self);
  }
  self->streaming = streaming;

  if (append) {
    prv_extend(self, packet->text);
  } else {
    prv_append(self, packet->role, packet->text);
  }
  self->ever_spoke = true;

  // The first line of an answer is worth moving to. Everything after it is
  // landing under the reader's eyes at several words a second, so the page
  // stays where they left it and the arrow at the edge says there is more.
  prv_reflow(self, append ? AssistFocusStream : AssistFocusMessage);

  // Pieces still land while the settings menu is up, and a conversation that
  // is not on screen has no business lighting or buzzing the watch
  const bool on_screen = (window_stack_get_top_window() == self->window);

  if (on_screen && self->backlight_hold) {
    if (streaming) {
      // Words are still landing. Keep the screen lit under them rather than
      // letting it time out part way through an answer being written.
      prv_start_backlight_hold(self);
    } else {
      // The last of the answer, whether it streamed in or arrived whole. Stop
      // holding and light the screen one final time, so the wearer gets a full
      // backlight timeout to read the finished answer counted from here rather
      // than from whichever piece of it happened to land last.
      prv_stop_backlight_hold(self);
      light_enable_interaction();
    }
  } else if (on_screen && self->backlight && !append) {
    // Light up for an answer arriving, but not for every piece of one
    light_enable_interaction();
  }

  // Vibration feedback: a pulse when a reply starts arriving, another on every
  // other piece while it streams, and one when it finishes. Errors are not
  // replies, and keep-alives returned above.
  if (packet->role == AssistRoleAssistant) {
    bool vibe;
    if (streaming) {
      // Pieces 1, 3, 5... so the first piece of an answer is felt
      vibe = (++self->stream_chunk_count % 2 == 1);
    } else if (self->stream_chunk_count > 0) {
      // The end of a streamed reply. One that came as a single piece was
      // already felt when that piece landed.
      vibe = (self->stream_chunk_count > 1);
    } else {
      // A whole reply at once
      vibe = (packet->text[0] != '\0');
    }
    if (vibe && on_screen && self->vibration_feedback) {
      vibes_enqueue_custom_pattern(s_stream_vibe);
    }
  }
  if (!streaming) {
    self->stream_chunk_count = 0;
  }
}

bool simply_assist_is_covering(Simply *simply) {
  return (simply->assist && window_stack_contains_window(simply->assist->window));
}

bool simply_assist_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandAssistShow:
      prv_handle_show(simply, packet);
      return true;
    case CommandAssistHide:
      if (simply->assist) {
        prv_close(simply->assist);
      }
      return true;
    case CommandAssistMessage:
      prv_handle_message(simply, packet);
      return true;
    case CommandAssistListen:
      prv_handle_listen(simply, packet);
      return true;
  }
  return false;
}

// MARK: - Touch

#ifdef SIMPLY_HAS_TOUCH

// Kept in step with simply_touch.c and simply_number.c so gestures feel the
// same here as everywhere else on the watch
#define TOUCH_TAP_SLOP 10
#define TOUCH_SWIPE_MIN 30
#define TOUCH_DRAG_START 8
#define TOUCH_GESTURE_MAX_MS 2000

//! How far a fling carries: the liftoff speed projected this far forward
#define TOUCH_FLING_MS 300

//! Holding a finger still this long asks for the settings, the same as
//! holding the select button. Kept in step with simply_touch.c.
#define TOUCH_LONG_PRESS_MS 500

typedef enum {
  AssistTouchIdle = 0,
  AssistTouchPending,   // finger down, gesture undecided
  AssistTouchDrag,      // finger is carrying the conversation
} AssistTouchMode;

static AssistTouchMode s_touch_mode = AssistTouchIdle;
static AppTimer *s_touch_long_press = NULL;
static int16_t s_touch_down_x, s_touch_down_y;
#if !defined(PBL_ROUND)
//! Where the conversation stood when the finger landed, so a slide can be
//! measured from it. Round turns whole pages and never needs it.
static GPoint s_touch_down_offset;
#endif
static uint32_t s_touch_down_ms;

#if !defined(PBL_ROUND)
//! The last two positions the finger reported, for the throw at liftoff.
//! Round has no throw to measure: a page either turns or it does not.
static int16_t s_touch_last_y, s_touch_prev_y;
static uint32_t s_touch_last_ms, s_touch_prev_ms;
#endif

static uint32_t prv_now_ms(void) {
  return (uint32_t)time(NULL) * 1000u + (uint32_t)time_ms(NULL, NULL);
}

static int16_t prv_clamp_offset(SimplyAssist *self, int16_t y) {
  const GSize content = scroll_layer_get_content_size(self->scroll_layer);
  const GRect frame = layer_get_frame(scroll_layer_get_layer(self->scroll_layer));
  int16_t min = frame.size.h - content.h;
  if (min > 0) { min = 0; }
  if (y > 0) { y = 0; }
  if (y < min) { y = min; }
  return y;
}

//! Where the conversation is scrolled to, counted downwards from the top so
//! it reads the same way the layout does
static int16_t prv_position(SimplyAssist *self) {
  return -scroll_layer_get_content_offset(self->scroll_layer).y;
}

static void prv_scroll_to(SimplyAssist *self, int16_t position, bool animated) {
  scroll_layer_set_content_offset(
      self->scroll_layer, GPoint(0, prv_clamp_offset(self, -position)), animated);
}

//! One screen in the direction the finger threw it. Content follows the
//! finger, so pushing the page up brings what is below it into view, which is
//! the same thing the down button does.
static void prv_swipe_scroll(SimplyAssist *self, int16_t from, int dy) {
  const int16_t page = layer_get_frame(scroll_layer_get_layer(self->scroll_layer)).size.h;
  prv_scroll_to(self, dy < 0 ? from + page : from - page, true);
}

#if !defined(PBL_ROUND)
//! Let go mid-slide and the conversation carries on for a moment, the same as
//! a menu does. The liftoff velocity is projected forward and animated to.
static void prv_fling(SimplyAssist *self) {
  const uint32_t dt = s_touch_last_ms - s_touch_prev_ms;
  if (dt == 0 || dt > 100) { return; }   // stale samples: the finger had stopped
  const int dy = s_touch_last_y - s_touch_prev_y;
  const int carry = dy * (int) TOUCH_FLING_MS / (int) dt;
  if (carry == 0) { return; }
  prv_scroll_to(self, prv_position(self) - carry, true);
}
#endif

static void prv_cancel_long_press(void) {
  if (s_touch_long_press) {
    app_timer_cancel(s_touch_long_press);
    s_touch_long_press = NULL;
  }
}

static void prv_long_press_timeout(void *data) {
  SimplyAssist *self = data;
  s_touch_long_press = NULL;
  // Still holding still on the conversation, having not turned into a drag or
  // a swipe: the same thing holding select does
  if (s_touch_mode != AssistTouchPending) { return; }
  s_touch_mode = AssistTouchIdle;
  if (prv_listening(self)) { return; }
  prv_open_settings(self);
}

bool simply_assist_handle_touch(Simply *simply, const TouchEvent *event) {
  SimplyAssist *self = simply->assist;
  // Only while the conversation is the window actually on screen. Without this
  // the swipe back in simply_touch would act on the JS window underneath,
  // dismissing the page behind the conversation while it stayed up.
  if (!self || !self->scroll_layer || window_stack_get_top_window() != self->window) {
    return false;
  }

  switch (event->type) {
    case TouchEvent_Touchdown:
      prv_cancel_long_press();
      if (event->non_navigational) {
        s_touch_mode = AssistTouchIdle;
        return true;
      }
      s_touch_mode = AssistTouchPending;
      s_touch_long_press =
          app_timer_register(TOUCH_LONG_PRESS_MS, prv_long_press_timeout, self);
      s_touch_down_x = event->x;
      s_touch_down_y = event->y;
      s_touch_down_ms = prv_now_ms();
#if !defined(PBL_ROUND)
      s_touch_down_offset = scroll_layer_get_content_offset(self->scroll_layer);
      s_touch_last_y = s_touch_prev_y = event->y;
      s_touch_last_ms = s_touch_prev_ms = s_touch_down_ms;
#endif
      return true;

    case TouchEvent_PositionUpdate:
      if (abs(event->x - s_touch_down_x) >= TOUCH_TAP_SLOP ||
          abs(event->y - s_touch_down_y) >= TOUCH_TAP_SLOP) {
        // Too much travel to still be a finger held in one place
        prv_cancel_long_press();
      }
      if (s_touch_mode == AssistTouchPending &&
          abs(event->y - s_touch_down_y) >= TOUCH_DRAG_START) {
        s_touch_mode = AssistTouchDrag;
      }
#if defined(PBL_ROUND)
      // Round turns pages; it does not slide. Following the finger would drag
      // the conversation to positions it was never laid out for: every line's
      // width comes from where the circle is widest at that height, worked out
      // on the assumption that a page starts at the top of the screen. Part
      // way between two pages, every one of those lines is fitted to the wrong
      // part of the glass. So the finger is tracked and the page turns when it
      // lifts.
#else
      // Kept for the fling: the last two samples are what the throw is
      // measured from
      s_touch_prev_y = s_touch_last_y;
      s_touch_prev_ms = s_touch_last_ms;
      s_touch_last_y = event->y;
      s_touch_last_ms = prv_now_ms();

      if (s_touch_mode == AssistTouchDrag) {
        self->user_scrolled = true;
        const int16_t y = prv_clamp_offset(
            self, s_touch_down_offset.y + (event->y - s_touch_down_y));
        scroll_layer_set_content_offset(self->scroll_layer, GPoint(0, y), false);
      }
#endif
      return true;

    case TouchEvent_Liftoff: {
      prv_cancel_long_press();
      const AssistTouchMode mode = s_touch_mode;
      s_touch_mode = AssistTouchIdle;

      const int dx = event->x - s_touch_down_x;
      const int dy = event->y - s_touch_down_y;
      const int adx = abs(dx);
      const int ady = abs(dy);
      const uint32_t elapsed = prv_now_ms() - s_touch_down_ms;

      if (mode == AssistTouchDrag) {
#if defined(PBL_ROUND)
        // One drag, one page, however far the finger actually went. Anything
        // shorter than a deliberate swipe leaves the page where it was.
        if (ady >= TOUCH_SWIPE_MIN && ady > adx) {
          self->user_scrolled = true;
          prv_swipe_scroll(self, prv_position(self), dy);
        }
#else
        prv_fling(self);
#endif
        return true;
      }
      if (mode != AssistTouchPending || elapsed > TOUCH_GESTURE_MAX_MS) {
        return true;
      }

      if (adx < TOUCH_TAP_SLOP && ady < TOUCH_TAP_SLOP) {
        prv_speak(self);
        return true;
      }

      // Swipe right leaves, the same as the back button and the same as
      // everywhere else on the watch, and the same as back it only drops the
      // turn while the microphone is open
      if (adx >= TOUCH_SWIPE_MIN && adx > ady && dx > 0) {
        if (prv_listening(self)) {
          prv_cancel_stream(self);
        } else {
          window_stack_remove(self->window, false);
        }
        return true;
      }

      // A flick quick enough to arrive without any movement in between still
      // scrolls, so a fast swipe is never swallowed
      if (ady >= TOUCH_SWIPE_MIN && ady > adx) {
        self->user_scrolled = true;
        prv_swipe_scroll(self, prv_position(self), dy);
      }
      return true;
    }
  }

  return true;
}

#endif  // SIMPLY_HAS_TOUCH

#endif  // PBL_MICROPHONE
