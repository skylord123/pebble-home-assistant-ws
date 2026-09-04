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
 * Assist.show({ fontSize, confirm, backlight, dark, listen, onTranscript,
 *               onSettings, onClose })
 *   onTranscript(text) - the wearer said something. Run the pipeline and
 *                        answer with Assist.reply(), or stream it in with
 *                        Assist.streamReply() and Assist.endReply(); the watch
 *                        is already showing its thinking animation and keeps
 *                        it running until the answer is finished.
 *   onSettings()       - the wearer held select, or a finger on the screen, to
 *                        change the assist settings. The watch has stepped
 *                        aside so a JS window can be pushed, and is still
 *                        holding the conversation: show() brings it back with
 *                        whatever was changed applied to it.
 *   onClose()          - the conversation left the screen.
 */
var Assist = {};

var state = {
  active: false,
  dark: true,
  onTranscript: null,
  onSettings: null,
  onClose: null,
};

// Must match AssistRole in simply_assist.h. The wearer's own turn is written
// by the watch as soon as dictation returns, so only the two answers are sent
// from here.
var RoleAssistant = 1;
var RoleError = 2;

// Must match the flags in simply_assist.c
var FlagAppend = 1;      // add to the answer already on screen
var FlagStreaming = 2;   // more is coming, keep the dots running

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

//! Whether `text` begins with `prefix`. indexOf would scan the whole string
//! looking for a later match it can never need, which on an answer of several
//! thousand characters is work squared for no reason.
function startsWith(text, prefix) {
  return prefix.length <= text.length &&
      text.substring(0, prefix.length) === prefix;
}

//! Longest prefix of `text` that fits in `budget` bytes
function prefixWithinBytes(text, budget) {
  if (utf8Length(text) <= budget) {
    return text;
  }
  var lo = 0;
  var hi = text.length;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (utf8Length(text.substring(0, mid)) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.substring(0, lo);
}

function truncate(text) {
  if (utf8Length(text) <= replyLimit) {
    return text;
  }

  var cut = prefixWithinBytes(text, replyLimit - 4);

  // Land on a word boundary rather than part way through one
  var space = cut.search(/\s\S*$/);
  if (space > 0 && space > cut.length - 40) {
    cut = cut.substring(0, space);
  }

  // A cut inside an emphasised phrase would leave the rest of the answer bold
  if (cut.split(BOLD_ON).length > cut.split(BOLD_OFF).length) {
    cut += BOLD_OFF;
  }

  return cut + '…';
}

// Syntax that has arrived but cannot be read yet: a lone asterisk that may be
// about to become a pair, a backtick with nothing behind it, or a line so far
// consisting only of the characters that introduce a heading or a bullet.
// Holding these back costs a character or two of punctuation and never a
// character of text, and it is what keeps a growing answer append-only.
function dropPendingSyntax(text) {
  // A run of emphasis or code marks with nothing behind it yet. The whole run
  // has to go: leaving half of a "**" behind would put a literal asterisk on
  // screen and then take it away again a moment later.
  var out = text.replace(/[`*_]+$/, '');
  // A line that so far consists only of what introduces a heading or a bullet
  return out.replace(/(^|\n)[ \t]*[#\-*+`]*[ \t]*$/, '$1');
}

/**
 * Convert an agent's markdown into the watch's inline weight markers.
 *
 * `open` says the answer is still arriving, so its last line is a sentence in
 * progress rather than a finished one. That single difference is what lets a
 * growing answer be sent as a series of appends: emphasis or a heading that
 * has opened but not yet closed emits its bold-on marker and nothing else, so
 * the words inside it show in bold the moment they arrive and the closing
 * marker is simply appended later when the agent gets there. Converting a
 * longer buffer therefore always begins with the conversion of the shorter
 * one, and the watch is only ever told what is new.
 */
function toWatchText(markdown, open) {
    if (markdown === undefined || markdown === null) {
        return '';
    }

    // Markers are ours alone; anything arriving with them is not to be trusted
    var source = String(markdown).replace(/[\u0001\u0002]/g, '');
    if (open) {
        source = dropPendingSyntax(source);
    }

    var lines = source.split('\n');

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\s+$/, '');
        // Only the very last line of a streaming answer is unfinished. Every
        // line above it has had its newline, so it is closed like any other.
        var unfinished = open && (i === lines.length - 1);

        // A heading is just a bold line on a screen this size. Its text goes
        // through everything below like any other line and is wrapped at the
        // end, rather than being handed back to the emphasis pass wearing a
        // pair of asterisks, which only worked while the heading contained no
        // asterisks of its own.
        var heading = /^\s*#{1,6}\s+([\s\S]*)$/.exec(line);
        if (heading) {
            line = heading[1];
        }

        // Bullets become real ones. This runs before the emphasis pass so a
        // leading "*" is read as the bullet it is.
        line = line.replace(/^\s*[-*+]\s+/, '• ');

        line = line.replace(/`([^`]*)`/g, '$1');
        line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

        // Bold, which the watch can draw. Non-greedy over anything, so a span
        // survives an asterisk of its own inside it; "anything but an
        // asterisk" used to give up on those and leave the pair to be read as
        // two unmatched openers. Triple markers are bold and italic at once,
        // and bold is the half we have.
        line = line.replace(/\*\*\*([\s\S]+?)\*\*\*/g, BOLD_ON + '$1' + BOLD_OFF);
        line = line.replace(/___([\s\S]+?)___/g, BOLD_ON + '$1' + BOLD_OFF);
        line = line.replace(/\*\*([\s\S]+?)\*\*/g, BOLD_ON + '$1' + BOLD_OFF);
        line = line.replace(/__([\s\S]+?)__/g, BOLD_ON + '$1' + BOLD_OFF);

        // A bold marker with no partner, which on the line still being written
        // only means the closer has not arrived yet: bold starts here and runs
        // to the end of what there is. This has to happen before italic is
        // considered, or the first two asterisks of an unclosed "***" read as
        // an italic pair, the words come out plain, and they would turn bold
        // later when the run closed, which is the one thing a growing answer
        // must never do.
        line = line.replace(/\*\*|__/g, BOLD_ON);

        // Italic, down to the words it was wrapping. There is one weight on
        // this screen and bold has it: drawing the weaker emphasis in the
        // strongest thing the display can do would leave the two saying the
        // same thing, and what bold marks in an answer, a reading or a term,
        // is worth more than the decoration italic usually carries.
        //
        // The content has to begin and end with something other than a space,
        // so "2 * 3" stays arithmetic. Underscores additionally have to sit at
        // the edge of a word, or entity ids would come apart.
        line = line.replace(/\*(\S|\S[\s\S]*?\S)\*/g, '$1');
        line = line.replace(/(^|\s)_(\S|\S[\s\S]*?\S)_(?=$|[\s.,;:!?)])/g, '$1$2');

        // Whatever is left never found a partner at all. An italic or code
        // marker goes altogether: markdown would call it a literal, but
        // showing it would mean taking it away again the moment its partner
        // arrives, and an answer being written has to only ever grow.
        line = line.replace(/\*(\S)/g, '$1').replace(/(\S)\*/g, '$1');
        line = line.replace(/(^|\s)_(\S)/g, '$1$2').replace(/(\S)_(\s|$)/g, '$1$2');
        line = line.replace(/`/g, '');

        if (heading && line) {
            // One clean run of bold, so emphasis inside a heading cannot close
            // it early
            line = BOLD_ON + line.split(BOLD_ON).join('').split(BOLD_OFF).join('') +
                (unfinished ? '' : BOLD_OFF);
        }

        if (!unfinished &&
            line.split(BOLD_ON).length > line.split(BOLD_OFF).length) {
            line += BOLD_OFF;
        }

        lines[i] = line;
    }

    // One blank line is a paragraph break on the watch; more is just air
    var out = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    return open ? out.replace(/\n+$/, '') : truncate(out.replace(/\n+$/, ''));
}

// Must match AssistAction in simply_assist.c
var ActionClosed = 0;
var ActionSettings = 1;

// The answer being streamed in: what the agent has written so far, and how
// much of the converted form the watch has already been told about.
var stream = {
  raw: '',
  sent: '',
  started: false,
  full: false,
};

function resetStream() {
  stream.raw = '';
  stream.sent = '';
  stream.started = false;
  stream.full = false;
}

/**
 * Put the conversation on screen.
 *
 * `listen` opens the microphone straight away, which is what starting a
 * conversation means. Leave it off to come back to one already in progress,
 * such as returning from the settings menu: the watch still has everything
 * that was said and will show it again with the new settings applied.
 */
Assist.show = function(opts) {
  state.active = true;
  state.onTranscript = opts.onTranscript;
  state.onSettings = opts.onSettings;
  state.onClose = opts.onClose;
  state.dark = !!opts.dark;
  resetStream();
  simply.impl.assistShow({
    fontSize: opts.fontSize || 18,
    confirm: !!opts.confirm,
    backlight: !!opts.backlight,
    dark: state.dark,
    listen: opts.listen !== false,
    reset: !!opts.reset,
  });
};

Assist.hide = function() {
  if (!state.active) { return; }
  simply.impl.assistHide();
};

/**
 * Repaint the conversation light or dark. Used when the background follows the
 * sun and the sun has just moved, so a conversation open at dusk turns dark
 * around the words already in it.
 */
Assist.setDark = function(dark) {
  if (!state.active || state.dark === !!dark) { return; }
  state.dark = !!dark;
  simply.impl.assistTheme(state.dark);
};

/** A new turn is starting, so nothing of the last answer carries into it. */
Assist.beginReply = function() {
  resetStream();
};

/**
 * The agent has written more of its answer. Pass everything it has written so
 * far, markdown and all; only what is new reaches the watch, and the thinking
 * dots stay running underneath it until endReply.
 *
 * @returns {boolean} false once the answer has filled the watch, so the caller
 *   can stop bothering to convert the rest of it
 */
Assist.streamReply = function(accumulatedMarkdown) {
  if (!state.active || stream.full) { return false; }

  stream.raw = accumulatedMarkdown;
  var text = toWatchText(accumulatedMarkdown, true);

  // Converting a longer answer always yields a longer version of the same
  // text, so this only ever has something new on the end. If some markdown
  // ever manages to break that, replacing what is on screen is still correct,
  // just less tidy, and it must never be allowed to send a retraction as if
  // it were an addition.
  var append = startsWith(text, stream.sent);
  var addition = append ? text.substring(stream.sent.length) : text;
  if (!addition && append) { return true; }

  // Room left for this answer, keeping back enough for the ellipsis that says
  // it was cut short
  var budget = replyLimit - utf8Length(append ? stream.sent : '') - 4;
  if (budget <= 0) {
    stream.full = true;
    return false;
  }
  if (utf8Length(addition) > budget) {
    var cut = prefixWithinBytes(addition, budget);
    var space = cut.search(/\s\S*$/);
    if (space > 0 && space > cut.length - 40) {
      cut = cut.substring(0, space);
    }
    addition = cut + '…';
    stream.full = true;
  }

  // Filling the watch ends the answer as far as it is concerned: the rest is
  // never going to be shown, so the dots stop here rather than waiting on a
  // phone that has stopped talking to it.
  var flags = (stream.full ? 0 : FlagStreaming) |
      ((stream.started && append) ? FlagAppend : 0);
  simply.impl.assistMessage(RoleAssistant, addition, flags);
  stream.started = true;
  stream.sent = append ? stream.sent + addition : addition;
  return !stream.full;
};

//! A match of a character or two at the seam is far more likely to be a
//! coincidence than a real overlap that short, and acting on one eats the
//! start of the answer. Anything below this counts as no overlap at all,
//! unless it is the whole of what is being matched.
var MIN_OVERLAP = 4;

//! How much of the end of `sent` is also the start of `text`, so an answer
//! that was partly streamed is finished off rather than sent twice
function commonOverlap(sent, text) {
  var max = sent.length < text.length ? sent.length : text.length;
  for (var n = max; n > 0; n--) {
    if (sent.substring(sent.length - n) === text.substring(0, n)) { return n; }
  }
  return 0;
}

/**
 * The agent has finished. Ends the thinking animation, and sends the answer in
 * one piece if none of it was streamed.
 */
Assist.endReply = function(markdown) {
  if (!state.active) { return; }

  if (!stream.started) {
    simply.impl.assistMessage(RoleAssistant, toWatchText(markdown), 0);
    return;
  }

  // An answer that already filled the watch was finished off when it did, and
  // saying so twice would only start a second empty turn
  if (stream.full) {
    resetStream();
    return;
  }

  // Usually what is on screen was built from the same text the agent has just
  // finished writing, so all that is left is the last scrap of it: the closed
  // conversion can differ from the open one by a trailing marker.
  var text = toWatchText(markdown);
  var addition;
  if (startsWith(text, stream.sent)) {
    addition = text.substring(stream.sent.length);
  } else {
    // An agent that calls a tool writes twice in one turn: a line saying what
    // it is about to go and look up, then the answer once it has. Home
    // Assistant reports only the last of those as the speech, so what arrives
    // here is not a continuation of what was streamed. Appending nothing,
    // which is what used to happen, left the watch holding the preamble and
    // none of the answer whenever the last pieces had not been flushed yet.
    // Send whatever of the answer has not already gone down.
    var overlap = commonOverlap(stream.sent, text);
    if (overlap < MIN_OVERLAP && overlap < text.length) { overlap = 0; }
    addition = text.substring(overlap);
    if (overlap === 0 && addition && stream.sent && !/\s$/.test(stream.sent)) {
      // Two separate messages rather than one sentence, so they do not run
      // together as "...areas:Here are the temperatures"
      addition = '\n' + addition;
    }
  }
  simply.impl.assistMessage(RoleAssistant, addition, FlagAppend);
  resetStream();
};

/**
 * Home Assistant answered in one piece. Ends the thinking animation. The text
 * is whatever the conversation agent wrote, markdown and all; it is reduced to
 * plain words and bold spans on the way down.
 */
Assist.reply = function(markdown) {
  if (!state.active) { return; }
  resetStream();
  simply.impl.assistMessage(RoleAssistant, toWatchText(markdown), 0);
};

/** Something went wrong. Also ends the thinking animation. */
Assist.error = function(text) {
  if (!state.active) { return; }
  resetStream();
  simply.impl.assistMessage(RoleError, toWatchText(text), 0);
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
  if (action === ActionSettings) {
    if (state.onSettings) {
      state.onSettings();
    }
    return;
  }
  if (action === ActionClosed) {
    var onClose = state.onClose;
    state.active = false;
    resetStream();
    state.onTranscript = null;
    state.onSettings = null;
    state.onClose = null;
    if (onClose) {
      onClose();
    }
  }
};

module.exports = Assist;
