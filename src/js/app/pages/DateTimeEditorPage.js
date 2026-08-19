/**
 * DateTimeEditorPage - PebbleOS alarm-style date/time editor
 *
 * Shows the parts of a date (and optionally time) as a row of fields. The
 * selected field is highlighted; up/down adjust its value (hold for bigger
 * steps), select advances to the next field, and select on the last field
 * confirms. Back cancels without calling back.
 *
 * show({ title, date, includeTime, onSet })
 *   title       - heading shown at the top
 *   date        - initial Date
 *   includeTime - when true, hour/minute/AM-PM fields are included
 *   onSet       - called with the resulting Date after confirming
 */
var UI = require('ui');
var Vector = require('vector2');
var Feature = require('platform/feature');
var Vibe = require('ui/vibe');
var helpers = require('app/helpers');

var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

function show(opts) {
    var res = Feature.resolution();
    var initial = opts.date || new Date();

    // Working values; day is clamped whenever month/year changes
    var value = {
        year: initial.getFullYear(),
        month: initial.getMonth(),
        day: initial.getDate(),
        hour: initial.getHours(),
        minute: initial.getMinutes()
    };

    // Field definitions: label row, formatting, and step behavior
    var fields = [
        {
            key: 'month',
            format: function() { return MONTH_NAMES[value.month]; },
            adjust: function(delta) {
                value.month = (value.month + delta + 12) % 12;
                value.day = Math.min(value.day, daysInMonth(value.year, value.month));
            }
        },
        {
            key: 'day',
            format: function() { return String(value.day); },
            adjust: function(delta) {
                var count = daysInMonth(value.year, value.month);
                value.day = ((value.day - 1 + delta) % count + count) % count + 1;
            }
        },
        {
            key: 'year',
            format: function() { return String(value.year); },
            adjust: function(delta) {
                value.year = Math.max(1970, Math.min(2100, value.year + delta));
                value.day = Math.min(value.day, daysInMonth(value.year, value.month));
            }
        }
    ];

    if (opts.includeTime) {
        fields.push({
            key: 'hour',
            format: function() {
                var hour = value.hour % 12;
                return String(hour === 0 ? 12 : hour);
            },
            adjust: function(delta) {
                value.hour = (value.hour + delta + 24) % 24;
            }
        });
        fields.push({
            key: 'minute',
            format: function() {
                return (value.minute < 10 ? '0' : '') + value.minute;
            },
            adjust: function(delta) {
                value.minute = (value.minute + delta + 60) % 60;
            },
            bigStep: 15
        });
        fields.push({
            key: 'ampm',
            format: function() { return value.hour < 12 ? 'AM' : 'PM'; },
            adjust: function(delta) {
                value.hour = (value.hour + 12) % 24;
            }
        });
    }

    var selectedField = 0;

    var editorWindow = new UI.Window({
        backgroundColor: 'black',
        status: false,
        scrollable: false
    });

    // Title at the top
    editorWindow.add(new UI.Text({
        text: opts.title || 'Set Date',
        color: 'white',
        font: 'gothic_14_bold',
        position: new Vector(0, 4),
        size: new Vector(res.x, 18),
        textAlign: 'center'
    }));

    // Layout: date fields on one row, time fields on a second row. Field
    // boxes are fixed-width and centered as a group.
    var FIELD_H = 28;
    var DATE_WIDTHS = { month: 42, day: 30, year: 54 };
    var TIME_WIDTHS = { hour: 30, minute: 34, ampm: 34 };
    var GAP = 4;
    var dateY = opts.includeTime ? 34 : Math.round((res.y - FIELD_H) / 2) - 6;
    var timeY = dateY + FIELD_H + 14;

    function rowLayout(keys, widths, y) {
        var total = -GAP;
        keys.forEach(function(k) { total += widths[k] + GAP; });
        var x = Math.round((res.x - total) / 2);
        var boxes = {};
        keys.forEach(function(k) {
            boxes[k] = { x: x, y: y, w: widths[k], h: FIELD_H };
            x += widths[k] + GAP;
        });
        return boxes;
    }

    var boxes = rowLayout(['month', 'day', 'year'], DATE_WIDTHS, dateY);
    if (opts.includeTime) {
        var timeBoxes = rowLayout(['hour', 'minute', 'ampm'], TIME_WIDTHS, timeY);
        for (var k in timeBoxes) { boxes[k] = timeBoxes[k]; }
    }

    // Highlight rect behind the selected field (moved on selection change)
    var highlight = new UI.Rect({
        position: new Vector(0, 0),
        size: new Vector(10, 10),
        backgroundColor: 'white'
    });
    editorWindow.add(highlight);

    // One text element per field
    var fieldTexts = {};
    fields.forEach(function(field) {
        var box = boxes[field.key];
        var text = new UI.Text({
            text: field.format(),
            color: 'white',
            font: 'gothic_24_bold',
            position: new Vector(box.x, box.y - 6),
            size: new Vector(box.w, box.h),
            textAlign: 'center'
        });
        fieldTexts[field.key] = text;
        editorWindow.add(text);
    });

    // Hint at the bottom
    editorWindow.add(new UI.Text({
        text: 'UP/DOWN adjust\nSELECT next',
        color: 'white',
        font: 'gothic_14',
        position: new Vector(0, res.y - 44),
        size: new Vector(res.x, 40),
        textAlign: 'center'
    }));

    function updateFields() {
        fields.forEach(function(field) {
            fieldTexts[field.key].text(field.format());
            fieldTexts[field.key].color(field === fields[selectedField] ? 'black' : 'white');
        });
        var box = boxes[fields[selectedField].key];
        highlight.position(new Vector(box.x, box.y - 2));
        highlight.size(new Vector(box.w, box.h));
    }

    function adjust(delta) {
        var field = fields[selectedField];
        field.adjust(delta);
        updateFields();
    }

    editorWindow.on('click', 'up', function() { adjust(1); });
    editorWindow.on('click', 'down', function() { adjust(-1); });
    editorWindow.on('longClick', 'up', function() {
        adjust(fields[selectedField].bigStep || 1);
    });
    editorWindow.on('longClick', 'down', function() {
        adjust(-(fields[selectedField].bigStep || 1));
    });

    editorWindow.on('click', 'select', function() {
        if (selectedField < fields.length - 1) {
            selectedField++;
            updateFields();
            return;
        }
        // Last field confirmed
        var result = new Date(value.year, value.month, value.day,
                              opts.includeTime ? value.hour : 0,
                              opts.includeTime ? value.minute : 0, 0);
        Vibe.vibrate('short');
        editorWindow.hide();
        if (typeof opts.onSet === 'function') {
            opts.onSet(result);
        }
    });

    updateFields();
    editorWindow.show();
}

module.exports.show = show;
