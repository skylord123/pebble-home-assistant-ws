#include "simply_assist.h"

#include "simply.h"

#include "simply_msg.h"
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

// Space between the role label and its text, and between one message and the
// next
#define LABEL_GAP 1
#define MESSAGE_GAP 8
#define CONTENT_MARGIN_TOP 6
#define CONTENT_MARGIN_BOTTOM 10
//! Only rectangular displays need one: round insets each line to the glass
#define CONTENT_MARGIN_SIDE 4

// How fast holding up or down keeps scrolling. Rectangular slides smoothly and
// can afford to repeat quickly; round moves a whole screen at a time, and
// needs long enough between pages to read one before the next arrives.
#define SCROLL_REPEAT_MS PBL_IF_ROUND_ELSE(400, 100)

// Round draws its own up/down arrows in strips along the top and bottom of the
// screen, the same "there is more this way" language the system menus use. The
// conversation is inset by that much at both ends so a line of text is never
// hidden behind an arrow, which costs the narrowest slivers of the circle and
// nothing that was comfortable to read anyway.
#define INDICATOR_HEIGHT 14

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
  uint8_t role;
};

struct SimplyAssist {
  Simply *simply;
  Window *window;
  ScrollLayer *scroll_layer;
  Layer *content_layer;
  //! The thinking dots, kept apart from the words so the animation never
  //! costs a re-wrap of the conversation
  Layer *dots_layer;
#if defined(PBL_ROUND)
  Layer *indicator_up_layer;
  Layer *indicator_down_layer;
#endif
  AppTimer *think_timer;
  AppTimer *timeout_timer;
  char *arena;
  uint16_t arena_used;
  //! Content y of the last message, so a new one can be scrolled to its own
  //! first line rather than to the bottom of a wall of text
  int16_t last_message_y;
  //! Content y of the thinking dots, so the wait can be scrolled to as well.
  //! They sit past the end of what was just said, which on a round display is
  //! usually a page further on than the words themselves.
  int16_t thinking_y;
  uint8_t count;
  uint8_t tick;
  uint8_t font_size;
  bool thinking;
  bool dictation_confirm;
  bool backlight;
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
};

typedef struct AssistMessagePacket AssistMessagePacket;

struct __attribute__((__packed__)) AssistMessagePacket {
  Packet packet;
  uint8_t role;
  char text[];
};

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
  AssistActionPipeline = 1,
} AssistAction;

static void prv_reflow(SimplyAssist *self, bool show_thinking);

// MARK: - Conversation storage

static void prv_drop_oldest(SimplyAssist *self) {
  if (self->count == 0) { return; }
  const uint16_t drop = self->messages[0].length + 1;
  memmove(self->arena, self->arena + drop, self->arena_used - drop);
  self->arena_used -= drop;
  for (uint8_t i = 1; i < self->count; ++i) {
    self->messages[i].offset -= drop;
    self->messages[i - 1] = self->messages[i];
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
  int16_t y;                //!< content y of the line being filled
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
  w->span = w->frame.size.w - 2 * CONTENT_MARGIN_SIDE;
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
      // A single word wider than the line gets ellipsised rather than run off
      // the edge of the screen
      const int16_t box_w = word->width + 4 > w->span ? w->span : word->width + 4;
      graphics_draw_text(w->ctx, word->text, w->fonts[word->bold],
                         GRect(x, w->y, box_w, w->line_height + 4),
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
//! how tall it turned out
static int16_t prv_wrap_body(SimplyAssist *self, GContext *ctx, char *text,
                             int16_t top, GRect frame) {
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

  prv_begin_line(&w);

  bool bold = false;
  bool spaced = false;
  char *p = text;
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
    const uint16_t length = p - word;
    const int16_t width = prv_slice_width(word, length, w.fonts[bold]);
    int16_t gap = (w.count > 0 && spaced) ? w.space_width[bold] : 0;
    spaced = false;

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

    w.words[w.count] = (LineWord) {
      .text = word, .length = length, .width = width, .gap = gap, .bold = bold,
    };
    w.width += gap + width;
    w.count++;
  }

  prv_flush_line(&w);
  return w.y - top;
}

// MARK: - Layout

//! Walk the conversation, and when a context is given draw it. Laying out and
//! drawing share one pass so the height the scroll layer is told about can
//! never disagree with what lands on the screen. Returns the content height.
//!
//! Without a context this also re-measures every message and caches the
//! result; with one it trusts that cache, so a redraw costs only the drawing.
static int16_t prv_layout(SimplyAssist *self, GContext *ctx) {
  const GRect frame = layer_get_frame(scroll_layer_get_layer(self->scroll_layer));

  if (self->count == 0 && !self->thinking) {
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
  const int16_t width = frame.size.w - 2 * margin;
  const GTextAlignment align = PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft);
  const GFont label_font = prv_label_font(self);
  const int16_t label_h = prv_label_height(self);

  // Placing words costs real work, so a redraw only does it for the turns the
  // wearer can actually see. Everything above and below is stepped over using
  // the height the measuring pass already worked out.
  const GPoint offset = scroll_layer_get_content_offset(self->scroll_layer);
  const int16_t view_top = -offset.y - frame.size.h / 2;
  const int16_t view_bottom = -offset.y + frame.size.h + frame.size.h / 2;

  int16_t y = CONTENT_MARGIN_TOP;
  // Where the last thing drawn actually ends, as opposed to where the cursor
  // has been left. The gap trailing the final turn is not content, and on a
  // round display counting it would buy a whole extra page of nothing to page
  // down into.
  int16_t bottom = y;
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
    // position, since its height is what everything below it stands on
    const bool known = (self->messages[i].height > 0);
    const bool onscreen = !ctx || !known ||
        (y < view_bottom && y + label_h + self->messages[i].height > view_top);

    if (ctx && onscreen) {
      graphics_context_set_text_color(ctx, prv_role_color(self, role));
      graphics_draw_text(ctx, prv_role_label(role), label_font,
                         GRect(margin, y, width, label_h),
                         GTextOverflowModeTrailingEllipsis, align, NULL);
    }
    y += label_h + LABEL_GAP;

    if (onscreen) {
      if (ctx) {
        graphics_context_set_text_color(ctx, role == AssistRoleError ?
            prv_role_color(self, role) : prv_foreground(self));
      }
      self->messages[i].height = prv_wrap_body(self, ctx, text, y, frame);
    }
    y += self->messages[i].height;
    bottom = y;
    y += MESSAGE_GAP;
  }

  if (self->thinking) {
    // The dots themselves live in their own layer, so that the animation can
    // repaint ten times a second without putting the conversation's words
    // through the wrapper again. All that happens here is reserving the room
    // they need and remembering where it ended up.
    const int16_t dot_max = prv_dot_size(frame);

#if defined(PBL_ROUND)
    // Keep the wait whole on its own page, the same as a turn: half a dot
    // peeking over a page edge is worse than none at all. Having claimed a
    // page it sits in the middle of it, rather than clinging to the top edge
    // under the arrow.
    const int16_t page = frame.size.h;
    const int16_t used = y % page;
    if (used > 0 && page - used < 2 * dot_max + MESSAGE_GAP) {
      y += (page - used) + page / 2 - dot_max;
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

//! The waiting animation, on its own layer above the conversation
static void prv_dots_update(Layer *layer, GContext *ctx) {
  SimplyAssist *self = window_get_user_data(layer_get_window(layer));
  if (!self || !self->thinking) { return; }

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
    const int16_t r = dot_min + WAVE[(self->tick + 2 * i) % 6];
    graphics_fill_circle(ctx, GPoint(cx + (i - 1) * spacing, dot_max), r);
  }
}

static void prv_content_update(Layer *layer, GContext *ctx) {
  SimplyAssist *self = window_get_user_data(layer_get_window(layer));
  if (!self) { return; }
  prv_layout(self, ctx);
}

//! Re-measure the conversation, resize the scrollable content to match, and
//! move the view to whatever the wearer is waiting on: the dots while the
//! phone is working, and the first line of the answer once it lands. Round
//! shows the page that thing begins on; rectangular puts it at the top of the
//! view, or as close to it as the end of the conversation allows.
static void prv_reflow(SimplyAssist *self, bool show_thinking) {
  if (!self->window || !window_is_loaded(self->window)) { return; }

  const GRect frame = layer_get_frame(scroll_layer_get_layer(self->scroll_layer));
  const int16_t page = frame.size.h;
  const int16_t drawn_h = prv_layout(self, NULL);

  // Round moves a whole screen at a time, so the content is rounded up to a
  // whole number of them: the last page is then reachable and every offset
  // the wearer can land on is one the text was laid out against
  const int16_t content_h =
      PBL_IF_ROUND_ELSE(((drawn_h + page - 1) / page) * page, drawn_h);

  layer_set_frame(self->content_layer, GRect(0, 0, frame.size.w, content_h));
  scroll_layer_set_content_size(self->scroll_layer, GSize(frame.size.w, content_h));

  const int16_t dot_max = prv_dot_size(frame);
  layer_set_frame(self->dots_layer,
                  GRect(0, self->thinking_y, frame.size.w, 2 * dot_max));
  layer_set_hidden(self->dots_layer, !self->thinking);

  const int16_t focus = (show_thinking && self->thinking) ? self->thinking_y
                                                          : self->last_message_y;
  const int16_t last = content_h - page;

  // Round rests only on page boundaries, so show the page the focus begins
  // on. Rectangular scrolls freely and puts it at the top of the view, unless
  // the conversation runs out before that fills the screen.
  int16_t target = PBL_IF_ROUND_ELSE((focus / page) * page,
                                     focus < last ? focus : last);
  if (target > last) { target = last; }
  if (target < 0) { target = 0; }

  scroll_layer_set_content_offset(self->scroll_layer, GPoint(0, -target), true);
  layer_mark_dirty(self->content_layer);
}

// MARK: - Thinking state

static void prv_think_tick(void *data) {
  SimplyAssist *self = data;
  self->think_timer = NULL;
  if (!self->thinking) { return; }
  // Wrapped to the wave's own length, so the phase cannot jump when a plain
  // counter would have rolled over
  self->tick = (self->tick + 1) % 6;
  layer_mark_dirty(self->dots_layer);
  self->think_timer = app_timer_register(THINK_TICK_MS, prv_think_tick, self);
}

static void prv_stop_thinking(SimplyAssist *self) {
  self->thinking = false;
  if (self->think_timer) {
    app_timer_cancel(self->think_timer);
    self->think_timer = NULL;
  }
  if (self->timeout_timer) {
    app_timer_cancel(self->timeout_timer);
    self->timeout_timer = NULL;
  }
}

static void prv_think_timeout(void *data) {
  SimplyAssist *self = data;
  self->timeout_timer = NULL;
  prv_stop_thinking(self);
  prv_append(self, AssistRoleError, "No response from Home Assistant");
  prv_reflow(self, false);
}

static void prv_start_thinking(SimplyAssist *self) {
  prv_stop_thinking(self);
  self->thinking = true;
  self->tick = 0;
  self->think_timer = app_timer_register(THINK_TICK_MS, prv_think_tick, self);
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
  simply_voice_start(self->simply, self->dictation_confirm, true);
}

bool simply_assist_handle_dictation(Simply *simply, int status, const char *transcription) {
  SimplyAssist *self = simply->assist;
  if (!self || self->destroying) { return false; }

  if (status == DictationSessionStatusSuccess && transcription && transcription[0]) {
    self->ever_spoke = true;
    prv_append(self, AssistRoleUser, transcription);
    prv_start_thinking(self);
    prv_reflow(self, true);
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
        window_stack_remove(self->window, false);
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
  prv_reflow(self, false);
  return true;
}

// MARK: - Buttons

static void prv_select_click(ClickRecognizerRef recognizer, void *context) {
  prv_start_dictation(context);
}

static void prv_select_long_click(ClickRecognizerRef recognizer, void *context) {
  SimplyAssist *self = context;
  // The pipeline picker is a JS menu, and JS windows cannot be pushed over a
  // native one, so hand the screen back before asking for it
  prv_send_action(AssistActionPipeline);
  window_stack_remove(self->window, false);
}

static void prv_click_config_provider(void *context) {
  SimplyAssist *self = context;
  window_set_click_context(BUTTON_ID_UP, self->scroll_layer);
  window_set_click_context(BUTTON_ID_DOWN, self->scroll_layer);
  window_set_click_context(BUTTON_ID_SELECT, self);
  // Repeating, so holding a button keeps going the way it does everywhere
  // else on the watch, rather than needing a press per line
  window_single_repeating_click_subscribe(BUTTON_ID_UP, SCROLL_REPEAT_MS,
                                          scroll_layer_scroll_up_click_handler);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, SCROLL_REPEAT_MS,
                                          scroll_layer_scroll_down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, prv_select_long_click, NULL);
}

// MARK: - Window

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

#if defined(PBL_ROUND)
  // The system's own up/down arrows say "there is more this way" in the
  // language the round menus already use
  self->indicator_up_layer = layer_create(GRect(0, 0, bounds.size.w, INDICATOR_HEIGHT));
  self->indicator_down_layer = layer_create(
      GRect(0, bounds.size.h - INDICATOR_HEIGHT, bounds.size.w, INDICATOR_HEIGHT));
  layer_add_child(root_layer, self->indicator_up_layer);
  layer_add_child(root_layer, self->indicator_down_layer);

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
#endif
}

static void prv_window_unload(Window *window) {
  SimplyAssist *self = window_get_user_data(window);
#if defined(PBL_ROUND)
  layer_destroy(self->indicator_up_layer);
  self->indicator_up_layer = NULL;
  layer_destroy(self->indicator_down_layer);
  self->indicator_down_layer = NULL;
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
  prv_reflow(self, self->thinking);
}

static void prv_destroy(SimplyAssist *self) {
  prv_stop_thinking(self);
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

static void prv_window_disappear(Window *window) {
  SimplyAssist *self = window_get_user_data(window);
  // The system dictation UI covers this window for the length of a session.
  // That is not the conversation ending, so hold everything and wait for it
  // to come back.
  if (simply_voice_dictation_in_progress()) { return; }
  if (self->destroying) { return; }
  self->destroying = true;
  prv_stop_thinking(self);
  prv_send_action(AssistActionClosed);
  // Defer the teardown: destroying a window from inside its own disappear
  // handler is unsafe while the window stack is mid-transition
  app_timer_register(0, prv_destroy_later, self);
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

static void prv_handle_show(Simply *simply, Packet *data) {
  AssistShowPacket *packet = (AssistShowPacket *)data;
  SimplyAssist *self = simply->assist;
  if (!self) {
    self = prv_create(simply);
    if (!self) { return; }
    simply->assist = self;
  }

  self->font_size = packet->font_size ? packet->font_size : 18;
  self->dictation_confirm = (packet->flags & 1);
  self->backlight = (packet->flags & 2);
  self->dark = (packet->flags & 4);
  window_set_background_color(self->window, self->dark ? GColorBlack : GColorWhite);

  if (!window_stack_contains_window(self->window)) {
    window_stack_push(self->window, false);
  }
  prv_reflow(self, false);
  // Opening Assist means the wearer wants to say something, so go straight to
  // the microphone rather than making them press select first
  prv_start_dictation(self);
}

static void prv_handle_message(Simply *simply, Packet *data) {
  SimplyAssist *self = simply->assist;
  if (!self || self->destroying) { return; }
  AssistMessagePacket *packet = (AssistMessagePacket *)data;

  // An answer, however it turned out, ends the wait
  prv_stop_thinking(self);
  prv_append(self, packet->role, packet->text);
  self->ever_spoke = true;
  prv_reflow(self, false);

  if (self->backlight) {
    light_enable_interaction();
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
        // disappear tears the conversation down
        window_stack_remove(simply->assist->window, false);
      }
      return true;
    case CommandAssistMessage:
      prv_handle_message(simply, packet);
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

typedef enum {
  AssistTouchIdle = 0,
  AssistTouchPending,   // finger down, gesture undecided
  AssistTouchDrag,      // finger is carrying the conversation
} AssistTouchMode;

static AssistTouchMode s_touch_mode = AssistTouchIdle;
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
      if (event->non_navigational) {
        s_touch_mode = AssistTouchIdle;
        return true;
      }
      s_touch_mode = AssistTouchPending;
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
        const int16_t y = prv_clamp_offset(
            self, s_touch_down_offset.y + (event->y - s_touch_down_y));
        scroll_layer_set_content_offset(self->scroll_layer, GPoint(0, y), false);
      }
#endif
      return true;

    case TouchEvent_Liftoff: {
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
        prv_start_dictation(self);
        return true;
      }

      // Swipe right leaves, the same as the back button and the same as
      // everywhere else on the watch
      if (adx >= TOUCH_SWIPE_MIN && adx > ady && dx > 0) {
        window_stack_remove(self->window, false);
        return true;
      }

      // A flick quick enough to arrive without any movement in between still
      // scrolls, so a fast swipe is never swallowed
      if (ady >= TOUCH_SWIPE_MIN && ady > adx) {
        prv_swipe_scroll(self, prv_position(self), dy);
      }
      return true;
    }
  }

  return true;
}

#endif  // SIMPLY_HAS_TOUCH

#endif  // PBL_MICROPHONE
