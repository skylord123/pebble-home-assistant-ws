/**
 * PinEntryPage - numeric code entry in the style of DateTimeEditorPage
 *
 * Shows a row of digit fields plus a cursor field. Up/down dial the
 * cursor digit, select commits it and moves on, and holding select
 * submits the code (so codes can be any length up to MAX_DIGITS). An
 * untouched cursor shows as '_' and is not part of the code, so
 * committing the last digit with select and then holding select sends
 * exactly the digits entered. Back clears the cursor digit, then removes
 * committed digits, then cancels.
 *
 * Submission is asynchronous: onSubmit receives a done callback so the
 * page can stay open while the service call is in flight and show the
 * error (clearing the digits for another attempt) if it fails.
 *
 * show({ title, subtitle, masked, error, onSubmit, onCancel })
 *   title    - heading shown at the top (e.g. the action name)
 *   subtitle - smaller line under the title (e.g. the entity name)
 *   masked   - show committed digits as * (default true)
 *   error    - error text shown in place of the hint initially (e.g. why
 *              a previously stored code was rejected)
 *   onSubmit - called with (code, done); call done(null) on success to
 *              close the page, or done(errorText) to show the error and
 *              let the user retry
 *   onCancel - called when the user backs out without submitting
 */
var UI = require('ui');
var Vector = require('vector2');
var Feature = require('platform/feature');
var helpers = require('app/helpers');
var Theme = require('app/ui/Theme');

var MAX_DIGITS = 8;

function show(opts) {
    var res = Feature.resolution();
    var masked = opts.masked !== false;
    var hintText = 'UP/DOWN digit, SELECT next\nhold SELECT to send';

    var digits = [];          // committed digits
    var current = 0;          // digit the cursor is dialing
    var currentDirty = false; // cursor touched since last commit (else it shows '_' and isn't sent)
    var busy = false;         // submission in flight; input ignored
    var closed = false;

    // Reached from a menu, so it wears the menu's colours
    var colors = Theme.menuColors();

    var pinWindow = new UI.Window({
        backgroundColor: colors.backgroundColor,
        status: false,
        scrollable: false
    });

    pinWindow.add(new UI.Text({
        text: opts.title || 'Enter Code',
        color: colors.textColor,
        font: 'gothic_14_bold',
        position: new Vector(0, 4),
        size: new Vector(res.x, 18),
        textAlign: 'center',
        // One line, with the subtitle immediately under it: wrapping would run
        // straight through it
        textOverflow: 'ellipsis'
    }));

    if (opts.subtitle) {
        pinWindow.add(new UI.Text({
            text: opts.subtitle,
            color: colors.textColor,
            font: 'gothic_14',
            position: new Vector(0, 22),
            size: new Vector(res.x, 18),
            textAlign: 'center',
            // This is the alarm panel's own name, which is routinely longer
            // than a line, and the code fields start right below it
            textOverflow: 'ellipsis'
        }));
    }

    var FIELD_H = 28;
    var GAP = 3;
    var fieldY = Math.round((res.y - FIELD_H) / 2) - 6;

    var highlight = new UI.Rect({
        position: new Vector(0, 0),
        size: new Vector(10, 10),
        backgroundColor: colors.textColor
    });
    pinWindow.add(highlight);

    // Fixed pool of text elements; unused ones are blanked. Boxes are
    // recomputed and recentered whenever the digit count changes.
    var fieldTexts = [];
    for (var i = 0; i < MAX_DIGITS; i++) {
        var text = new UI.Text({
            text: '',
            color: colors.textColor,
            font: 'gothic_24_bold',
            position: new Vector(0, fieldY - 6),
            size: new Vector(10, FIELD_H),
            textAlign: 'center'
        });
        fieldTexts.push(text);
        pinWindow.add(text);
    }

    var statusText = new UI.Text({
        text: opts.error || hintText,
        color: colors.textColor,
        font: 'gothic_14',
        position: new Vector(0, res.y - 44),
        size: new Vector(res.x, 40),
        textAlign: 'center'
    });
    pinWindow.add(statusText);

    function hasCursor() {
        return digits.length < MAX_DIGITS;
    }

    function cursorText() {
        return currentDirty ? String(current) : '_';
    }

    // Full layout pass; only needed when the field count changes
    function updateLayout() {
        var count = digits.length + (hasCursor() ? 1 : 0);
        var boxW = 18;
        if (count * (boxW + GAP) - GAP > res.x - 4) {
            boxW = Math.floor(((res.x - 4) + GAP) / count) - GAP;
        }
        var x = Math.round((res.x - (count * (boxW + GAP) - GAP)) / 2);

        for (var i = 0; i < MAX_DIGITS; i++) {
            if (i < count) {
                var isCursor = hasCursor() && i === digits.length;
                fieldTexts[i].position(new Vector(x, fieldY - 6));
                fieldTexts[i].size(new Vector(boxW, FIELD_H));
                fieldTexts[i].text(isCursor ? cursorText()
                    : (masked ? '*' : String(digits[i])));
                fieldTexts[i].color(isCursor ? colors.backgroundColor : colors.textColor);
                if (isCursor) {
                    highlight.position(new Vector(x, fieldY - 2));
                    highlight.size(new Vector(boxW, FIELD_H));
                }
                x += boxW + GAP;
            } else {
                fieldTexts[i].text('');
            }
        }

        if (!hasCursor()) {
            // Code is at max length; park the highlight offscreen
            highlight.position(new Vector(-50, -50));
        }
    }

    function submit(code) {
        busy = true;
        statusText.text('Sending...');
        helpers.log_message('PinEntryPage: submitting ' + code.length + '-digit code');
        opts.onSubmit(code, function(errorText) {
            if (closed) return;
            if (!errorText) {
                closed = true;
                pinWindow.hide();
                return;
            }
            // Failed; clear the code and let the user try again
            busy = false;
            digits = [];
            current = 0;
            currentDirty = false;
            statusText.text(errorText);
            updateLayout();
        });
    }

    pinWindow.on('click', 'up', function() {
        if (busy || !hasCursor()) return;
        current = currentDirty ? (current + 1) % 10 : 0;
        currentDirty = true;
        fieldTexts[digits.length].text(cursorText());
    });

    pinWindow.on('click', 'down', function() {
        if (busy || !hasCursor()) return;
        current = currentDirty ? (current + 9) % 10 : 0;
        currentDirty = true;
        fieldTexts[digits.length].text(cursorText());
    });

    pinWindow.on('click', 'select', function() {
        if (busy || !hasCursor()) return;
        digits.push(current);
        current = 0;
        currentDirty = false;
        updateLayout();
    });

    pinWindow.on('longClick', 'select', function() {
        if (busy) return;
        var code = digits.slice();
        if (hasCursor() && currentDirty) {
            code.push(current);
        }
        if (code.length === 0) return;
        submit(code.join(''));
    });

    pinWindow.on('click', 'back', function() {
        if (busy) {
            // Don't trap the user on "Sending..." if the call never
            // resolves; a late done() is ignored via the closed flag
            closed = true;
            pinWindow.hide();
            return;
        }
        if (currentDirty) {
            current = 0;
            currentDirty = false;
            statusText.text(hintText);
            fieldTexts[digits.length].text(cursorText());
            return;
        }
        if (digits.length > 0) {
            current = digits.pop();
            currentDirty = true;
            statusText.text(hintText);
            updateLayout();
            return;
        }
        closed = true;
        pinWindow.hide();
        if (typeof opts.onCancel === 'function') {
            opts.onCancel();
        }
    });

    updateLayout();
    pinWindow.show();
}

module.exports.show = show;
