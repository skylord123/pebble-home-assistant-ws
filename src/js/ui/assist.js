var simply = require('ui/simply');

/**
 * Assist - the native voice assistant conversation
 *
 * The screen itself lives on the watch (simply_assist.c). It opens the
 * microphone, draws the transcript the instant dictation returns, animates
 * while it waits, and owns its own scrolling and paging. Nothing here draws
 * anything: this side exists to carry the transcript to Home Assistant and
 * the answer back.
 *
 * Assist.show({ fontSize, confirm, backlight, dark, onTranscript, onPipeline,
 *               onClose })
 *   onTranscript(text) - the wearer said something. Run the pipeline and
 *                        answer with Assist.reply() or Assist.error(); the
 *                        watch is already showing its thinking animation and
 *                        stops as soon as either arrives.
 *   onPipeline()       - the wearer held select to change pipeline. The watch
 *                        has already given the screen back, so a JS window
 *                        can be pushed.
 *   onClose()          - the conversation left the screen.
 */
var Assist = {};

var state = {
  active: false,
  onTranscript: null,
  onPipeline: null,
  onClose: null,
};

// Must match AssistRole in simply_assist.h. The wearer's own turn is written
// by the watch as soon as dictation returns, so only the two answers are sent
// from here.
var RoleAssistant = 1;
var RoleError = 2;

// Must match TEXT_BOLD_ON/OFF in simply_assist.c. Home Assistant's
// conversation agents answer in markdown, and the watch has no business
// knowing what an asterisk means, so it is boiled down to two in-band markers
// here. Everything else is dropped to the words it was wrapping.
var BOLD_ON = '\u0001';
var BOLD_OFF = '\u0002';

// A conversation agent can answer with thousands of words, and every one of
// them costs the watch. It keeps only so much conversation, so the rest
// crosses Bluetooth purely to be dropped on arrival, and a long enough answer
// runs the watch out of memory reassembling the message before it is even
// read. Both problems end here, where memory is not scarce.
//
// How much is "so much" depends on the watch, and the watch is the one that
// knows: it sends its own limit alongside every transcript. Until it has said
// otherwise, assume the smallest.
var MIN_REPLY_BYTES = 1024;
var replyLimit = MIN_REPLY_BYTES;

function utf8Length(text) {
  return unescape(encodeURIComponent(text)).length;
}

function truncate(text) {
  if (utf8Length(text) <= replyLimit) {
    return text;
  }

  // Longest prefix that fits, leaving room for the ellipsis
  var lo = 0;
  var hi = text.length;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (utf8Length(text.substring(0, mid)) <= replyLimit - 4) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  var cut = text.substring(0, lo);

  // Land on a word boundary rather than part way through one
  var space = cut.search(/\s\S*$/);
  if (space > 0 && space > lo - 40) {
    cut = cut.substring(0, space);
  }

  // A cut inside an emphasised phrase would leave the rest of the answer bold
  var opens = cut.split(BOLD_ON).length;
  var closes = cut.split(BOLD_OFF).length;
  if (opens > closes) {
    cut += BOLD_OFF;
  }

  return cut + '…';
}

function toWatchText(markdown) {
    if (markdown === undefined || markdown === null) {
        return '';
    }

    // Markers are ours alone; anything arriving with them is not to be trusted
    var lines = String(markdown).replace(/[\u0001\u0002]/g, '').split('\n');

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\s+$/, '');

        // A heading is just a bold line on a screen this size
        var heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
        if (heading) {
            line = '**' + heading[1] + '**';
        }

        // Bullets become real ones. This runs before the emphasis pass so a
        // leading "*" is read as the bullet it is.
        line = line.replace(/^\s*[-*+]\s+/, '• ');

        line = line.replace(/`([^`]*)`/g, '$1');
        line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
        line = line.replace(/\*\*([^*]+)\*\*/g, BOLD_ON + '$1' + BOLD_OFF);
        line = line.replace(/__([^_]+)__/g, BOLD_ON + '$1' + BOLD_OFF);

        // Whatever syntax is left was never a pair, so it is literal text
        line = line.replace(/\*\*/g, '').replace(/__/g, '');

        lines[i] = line;
    }

    // One blank line is a paragraph break on the watch; more is just air
    return truncate(
        lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, ''));
}

// Must match AssistAction in simply_assist.c
var ActionClosed = 0;
var ActionPipeline = 1;

Assist.show = function(opts) {
  state.active = true;
  state.onTranscript = opts.onTranscript;
  state.onPipeline = opts.onPipeline;
  state.onClose = opts.onClose;
  simply.impl.assistShow({
    fontSize: opts.fontSize || 18,
    confirm: !!opts.confirm,
    backlight: !!opts.backlight,
    dark: !!opts.dark,
  });
};

Assist.hide = function() {
  if (!state.active) { return; }
  simply.impl.assistHide();
};

/**
 * Home Assistant answered. Ends the thinking animation. The text is whatever
 * the conversation agent wrote, markdown and all; it is reduced to plain words
 * and bold spans on the way down.
 */
Assist.reply = function(markdown) {
  if (!state.active) { return; }
  simply.impl.assistMessage(RoleAssistant, toWatchText(markdown));
};

/** Something went wrong. Also ends the thinking animation. */
Assist.error = function(text) {
  if (!state.active) { return; }
  simply.impl.assistMessage(RoleError, toWatchText(text));
};

/** The watch reporting how long an answer it can hold, in bytes. */
Assist.setReplyLimit = function(bytes) {
  replyLimit = bytes > MIN_REPLY_BYTES ? bytes : MIN_REPLY_BYTES;
};

Assist.emitTranscript = function(text) {
  if (state.onTranscript) {
    state.onTranscript(text);
  }
};

Assist.emitAction = function(action) {
  if (action === ActionPipeline) {
    if (state.onPipeline) {
      state.onPipeline();
    }
    return;
  }
  if (action === ActionClosed) {
    var onClose = state.onClose;
    state.active = false;
    state.onTranscript = null;
    state.onPipeline = null;
    state.onClose = null;
    if (onClose) {
      onClose();
    }
  }
};

module.exports = Assist;
