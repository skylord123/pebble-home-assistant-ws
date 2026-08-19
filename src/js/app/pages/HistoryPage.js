/**
 * HistoryPage - Entity history display
 *
 * Entities with numeric states get a line graph drawn by the native Polyline
 * stage element (one packet of pixel points; the watch renders the series).
 * Pressing select on the graph opens a time period picker (15 minutes to 12
 * hours) that refetches and redraws in place. Entities with string states
 * get a list of recent changes with when they happened and, when Home
 * Assistant attributes the change to a user, who made it.
 *
 * Not available on aplite: history data and the graph rendering don't fit
 * its memory constraints, and the Polyline element is compiled out there.
 * On round displays the graph is laid out inside the square inscribed in
 * the circle so nothing is clipped by the display corners.
 */
var UI = require('ui');
var Vector = require('vector2');
var Platform = require('platform');
var Feature = require('platform/feature');
var simply = require('ui/simply');
var AppState = require('app/AppState');
var HistoryService = require('app/HistoryService');
var helpers = require('app/helpers');

var PERIODS = [
    { label: 'Last 15 minutes', minutes: 15 },
    { label: 'Last 30 minutes', minutes: 30 },
    { label: 'Last hour', minutes: 60 },
    { label: 'Last 6 hours', minutes: 360 },
    { label: 'Last 12 hours', minutes: 720 },
    { label: 'Last 24 hours', minutes: 1440 },
    { label: 'Last 48 hours', minutes: 2880 }
];
var DEFAULT_PERIOD_INDEX = 2;

// Cap for the string state change list so large histories can't exhaust the
// phone-side JS or flood the watch with menu items
var MAX_CHANGE_ENTRIES = 40;

var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isSupported() {
    return Platform.version() !== 'aplite';
}

function entityName(entity) {
    return (entity.attributes && entity.attributes.friendly_name) || entity.entity_id;
}

function formatTime(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return hours + ':' + (minutes < 10 ? '0' : '') + minutes + ampm;
}

function formatValue(value) {
    if (!isFinite(value)) { return '-'; }
    if (Math.abs(value) >= 100) { return String(Math.round(value)); }
    return String(Math.round(value * 10) / 10);
}

/**
 * A "nice" axis step (1, 2, or 5 times a power of ten) that divides the
 * range into at most maxIntervals intervals
 */
function niceStep(range, maxIntervals) {
    var rough = range / maxIntervals;
    var magnitude = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var normalized = rough / magnitude;
    var factor = normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1;
    return factor * magnitude;
}

/**
 * Show history for an entity: a graph when the state is numeric, otherwise
 * a list of recent state changes
 */
function show(entity_id) {
    if (!isSupported()) {
        helpers.log_message('Entity history is not supported on aplite');
        return;
    }
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    if (!entity) {
        helpers.log_message('History: entity ' + entity_id + ' not found');
        return;
    }

    var isNumeric = isFinite(parseFloat(entity.state)) ||
        (entity.attributes && entity.attributes.unit_of_measurement !== undefined);
    if (isNumeric) {
        showHistoryGraph(entity_id);
    } else {
        showHistoryChanges(entity_id);
    }
}

/**
 * Numeric history graph: y axis values on the left, time labels along the
 * bottom, and the series drawn by the native Polyline element. Select opens
 * the time period picker.
 */
function showHistoryGraph(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    var unit = (entity.attributes && entity.attributes.unit_of_measurement) || '';

    var res = Feature.resolution();

    // On round displays lay everything out inside the square inscribed in
    // the circle so the corners of the graph aren't clipped
    var isRound = Feature.round(true, false);
    var roundInset = 0;
    if (isRound) {
        var diameter = Math.min(res.x, res.y);
        roundInset = Math.ceil((diameter - (diameter / Math.SQRT2)) / 2);
    }

    var titleString = entityName(entity) + (unit ? ' (' + unit + ')' : '');
    var titleWidth = res.x - roundInset * 2;

    // Measure the title on the watch first so the plot starts below it: long
    // entity names wrap onto multiple lines and the graph shrinks to make
    // room. (The measurement API uses hyphenated font keys while stage text
    // elements use underscores.)
    simply.impl.calculateTextSize(titleString, 'gothic-14-bold', titleWidth, 'wrap', 'center',
        function(titleSize) {
            buildGraph(titleSize.height);
        });

    function buildGraph(measuredTitleHeight) {
        // Keep a usable plot even for absurdly long names: cap the title at
        // roughly three lines and let it clip instead of squeezing the graph
        // out of existence
        var titleHeight = Math.min(measuredTitleHeight + 2, 56);

        var MARGIN_TOP = titleHeight + 2 + roundInset;  // measured title block
        var MARGIN_LEFT = 30 + roundInset;     // y axis labels
        var MARGIN_RIGHT = 4 + roundInset;
        var MARGIN_BOTTOM = 18 + roundInset;   // x axis labels

        var plotLeft = MARGIN_LEFT;
        var plotTop = MARGIN_TOP;
        var plotWidth = res.x - MARGIN_LEFT - MARGIN_RIGHT;
        var plotHeight = res.y - MARGIN_TOP - MARGIN_BOTTOM;

        var periodIndex = DEFAULT_PERIOD_INDEX;

        // How many periods back from now the window is panned (0 = latest).
        // Down pans further into the past, up pans back toward now.
        var periodOffset = 0;

        // Guards against out-of-order fetch responses when panning quickly
        var loadSequence = 0;

        var graphWindow = new UI.Window({
            backgroundColor: 'black',
            status: false,
            scrollable: false
        });

        var titleText = new UI.Text({
            text: titleString,
            color: 'white',
            font: 'gothic_14_bold',
            position: new Vector(roundInset, roundInset),
            size: new Vector(titleWidth, titleHeight),
            textOverflow: 'wrap',
            textAlign: 'center'
        });
        graphWindow.add(titleText);

        // Axes
        graphWindow.add(new UI.Line({
            position: new Vector(plotLeft, plotTop),
            position2: new Vector(plotLeft, plotTop + plotHeight),
            strokeColor: 'darkGray',
            strokeWidth: 1
        }));
        graphWindow.add(new UI.Line({
            position: new Vector(plotLeft, plotTop + plotHeight),
            position2: new Vector(plotLeft + plotWidth, plotTop + plotHeight),
            strokeColor: 'darkGray',
            strokeWidth: 1
        }));

        // Y axis ticks: a pool of gridlines spanning the plot with their value
        // labels on the left. Positions and values are set per data load (unused
        // ones are blanked and their lines made clear).
        var MAX_TICKS = 5;
        var tickLines = [];
        var tickTexts = [];
        for (var t = 0; t < MAX_TICKS; t++) {
            var tickLine = new UI.Line({
                position: new Vector(plotLeft, plotTop),
                position2: new Vector(plotLeft + plotWidth, plotTop),
                strokeColor: 'clear',
                strokeWidth: 1
            });
            graphWindow.add(tickLine);
            tickLines.push(tickLine);

            var tickText = new UI.Text({
                text: '',
                color: 'lightGray',
                font: 'gothic_14',
                position: new Vector(0, plotTop - 8),
                size: new Vector(plotLeft - 3, 16),
                textAlign: 'right'
            });
            graphWindow.add(tickText);
            tickTexts.push(tickText);
        }

        // X axis time labels: start, middle, end
        var X_LABEL_WIDTH = 46;
        var xStartText = new UI.Text({
            text: '',
            color: 'lightGray',
            font: 'gothic_14',
            position: new Vector(plotLeft - 4, plotTop + plotHeight + 2),
            size: new Vector(X_LABEL_WIDTH, 16),
            textAlign: 'left'
        });
        graphWindow.add(xStartText);
        var xMidText = new UI.Text({
            text: '',
            color: 'lightGray',
            font: 'gothic_14',
            position: new Vector(plotLeft + Math.round(plotWidth / 2) - Math.round(X_LABEL_WIDTH / 2),
                                 plotTop + plotHeight + 2),
            size: new Vector(X_LABEL_WIDTH, 16),
            textAlign: 'center'
        });
        graphWindow.add(xMidText);
        var xEndText = new UI.Text({
            text: '',
            color: 'lightGray',
            font: 'gothic_14',
            position: new Vector(plotLeft + plotWidth - X_LABEL_WIDTH, plotTop + plotHeight + 2),
            size: new Vector(X_LABEL_WIDTH, 16),
            textAlign: 'right'
        });
        graphWindow.add(xEndText);

        // Hide the middle time label when its box would collide with the
        // start or end labels (tight on smaller displays and round insets)
        var midLabelLeft = plotLeft + Math.round(plotWidth / 2) - Math.round(X_LABEL_WIDTH / 2);
        var showMidLabel = (midLabelLeft >= plotLeft - 4 + X_LABEL_WIDTH + 2) &&
            (midLabelLeft + X_LABEL_WIDTH <= plotLeft + plotWidth - X_LABEL_WIDTH - 2);

        // Status text used for loading / no data / errors, centered in the plot
        var statusText = new UI.Text({
            text: 'Loading...',
            color: 'white',
            font: 'gothic_18',
            position: new Vector(plotLeft, plotTop + Math.round(plotHeight / 2) - 10),
            size: new Vector(plotWidth, 20),
            textAlign: 'center'
        });
        graphWindow.add(statusText);

        // The data series: one native element, updated with a single packet
        var polyline = new UI.Polyline({
            position: new Vector(plotLeft + 1, plotTop),
            size: new Vector(plotWidth - 1, plotHeight),
            strokeColor: Feature.color('vividCerulean', 'white'),
            strokeWidth: 2,
            points: []
        });
        graphWindow.add(polyline);

        // Time labels include the day for periods of a day or longer, where a
        // bare clock time would be ambiguous
        function formatAxisTime(date) {
            if (PERIODS[periodIndex].minutes >= 1440) {
                var hours = date.getHours() % 12;
                if (hours === 0) hours = 12;
                return DAY_NAMES[date.getDay()] + ' ' + hours + (date.getHours() >= 12 ? 'PM' : 'AM');
            }
            return formatTime(date);
        }

        function loadData() {
            var periodMs = PERIODS[periodIndex].minutes * 60000;
            var endDate = new Date(Date.now() - periodOffset * periodMs);
            var startDate = new Date(endDate.getTime() - periodMs);
            var sequence = ++loadSequence;

            statusText.text('Loading...');
            polyline.points([]);

            HistoryService.fetchHistory(entity_id, startDate, endDate, function(rows) {
                if (sequence !== loadSequence) { return; }
                // Parse numeric samples; states like unavailable/unknown are gaps
                var samples = [];
                for (var i = 0; i < rows.length; i++) {
                    var value = parseFloat(rows[i].s);
                    if (isFinite(value) && rows[i].lu) {
                        samples.push({ t: rows[i].lu * 1000, v: value });
                    }
                }

                if (samples.length === 0) {
                    statusText.text('No data');
                    xStartText.text(formatAxisTime(startDate));
                    xMidText.text('');
                    xEndText.text(formatAxisTime(endDate));
                    return;
                }

                // Bucket the samples across the plot width (one bucket per two
                // pixels), holding the previous value through empty buckets so
                // sparsely-updating sensors draw as steps rather than gaps
                var bucketCount = Math.max(2, Math.floor(plotWidth / 2));
                var startMs = startDate.getTime();
                var spanMs = endDate.getTime() - startMs;
                var buckets = new Array(bucketCount);
                for (var j = 0; j < samples.length; j++) {
                    var index = Math.floor((samples[j].t - startMs) / spanMs * bucketCount);
                    if (index < 0) { index = 0; }
                    if (index >= bucketCount) { index = bucketCount - 1; }
                    if (buckets[index] === undefined) {
                        buckets[index] = { sum: samples[j].v, count: 1 };
                    } else {
                        buckets[index].sum += samples[j].v;
                        buckets[index].count++;
                    }
                }

                var values = new Array(bucketCount);
                var lastValue = samples[0].v;
                for (var k = 0; k < bucketCount; k++) {
                    if (buckets[k] !== undefined) {
                        lastValue = buckets[k].sum / buckets[k].count;
                    }
                    values[k] = lastValue;
                }

                var minValue = Math.min.apply(null, values);
                var maxValue = Math.max.apply(null, values);
                if (minValue === maxValue) {
                    // Flat series: pad the range so the line sits mid-plot
                    minValue -= 1;
                    maxValue += 1;
                }

                // Choose a "nice" tick step (1/2/5 times a power of ten) and
                // round the plot scale out to tick boundaries, so the gridlines
                // land on round values and the series maps to the same scale
                var step = niceStep(maxValue - minValue, MAX_TICKS - 1);
                var scaleMin = Math.floor(minValue / step) * step;
                var scaleMax = Math.ceil(maxValue / step) * step;
                while ((scaleMax - scaleMin) / step + 1 > MAX_TICKS) {
                    step *= 2;
                    scaleMin = Math.floor(minValue / step) * step;
                    scaleMax = Math.ceil(maxValue / step) * step;
                }
                var scaleRange = scaleMax - scaleMin;

                // Convert to pixel y offsets within the polyline frame
                var points = new Array(bucketCount);
                for (var m = 0; m < bucketCount; m++) {
                    var norm = (values[m] - scaleMin) / scaleRange;
                    points[m] = Math.round((1 - norm) * (plotHeight - 1));
                }

                // Lay out the tick gridlines and labels; blank the unused pool
                var tickCount = Math.round(scaleRange / step) + 1;
                for (var tick = 0; tick < MAX_TICKS; tick++) {
                    if (tick >= tickCount) {
                        tickLines[tick].strokeColor('clear');
                        tickTexts[tick].text('');
                        continue;
                    }
                    var tickValue = scaleMin + tick * step;
                    var tickY = plotTop + Math.round(
                        (1 - (tickValue - scaleMin) / scaleRange) * (plotHeight - 1));
                    tickLines[tick].strokeColor('darkGray');
                    tickLines[tick].position(new Vector(plotLeft, tickY));
                    tickLines[tick].position2(new Vector(plotLeft + plotWidth, tickY));
                    tickTexts[tick].position(new Vector(0, tickY - 8));
                    tickTexts[tick].text(formatValue(tickValue));
                }

                statusText.text('');
                polyline.points(points);
                xStartText.text(formatAxisTime(startDate));
                xMidText.text(showMidLabel ? formatAxisTime(new Date(startMs + spanMs / 2)) : '');
                xEndText.text(formatAxisTime(endDate));
            }, function(error) {
                if (sequence !== loadSequence) { return; }
                statusText.text('Failed to load');
            });
        }

        // Down pans back in time by one period; up pans forward again,
        // clamped at the present since future data doesn't exist
        graphWindow.on('click', 'down', function() {
            periodOffset++;
            loadData();
        });
        graphWindow.on('click', 'up', function() {
            if (periodOffset > 0) {
                periodOffset--;
                loadData();
            }
        });

        // Select opens the time period picker; picking refetches and redraws
        graphWindow.on('click', 'select', function() {
            var periodMenu = new UI.Menu({
                status: false,
                backgroundColor: 'black',
                textColor: 'white',
                highlightBackgroundColor: 'white',
                highlightTextColor: 'black',
                sections: [{
                    title: 'Time Period'
                }]
            });

            periodMenu.items(0, PERIODS.map(function(period, index) {
                return {
                    title: period.label,
                    subtitle: index === periodIndex ? 'Current' : '',
                    periodIndex: index
                };
            }));

            periodMenu.on('select', function(e) {
                periodIndex = e.item.periodIndex;
                // A new period re-anchors the window at the present
                periodOffset = 0;
                periodMenu.hide();
                loadData();
            });

            periodMenu.show();
        });

        graphWindow.on('show', function() {
            loadData();
        });

        graphWindow.show();
    }
}

/**
 * String state change list: one row per change, newest first, with the time
 * and the person who caused it when Home Assistant knows
 */
function showHistoryChanges(entity_id) {
    var appState = AppState.getInstance();
    var entity = appState.ha_state_dict[entity_id];
    var title = entityName(entity);

    var changesMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: title + ' - updating ...'
        }]
    });

    function formatWhen(whenMs) {
        var date = new Date(whenMs);
        var now = new Date();
        var label = formatTime(date);
        if (date.getFullYear() !== now.getFullYear() ||
            date.getMonth() !== now.getMonth() ||
            date.getDate() !== now.getDate()) {
            label = DAY_NAMES[date.getDay()] + ' ' +
                MONTH_NAMES[date.getMonth()] + ' ' + date.getDate() + ' ' + label;
        }
        return label;
    }

    changesMenu.on('show', function() {
        var endDate = new Date();
        var startDate = new Date(endDate.getTime() - 24 * 3600000);

        HistoryService.fetchLogbook(entity_id, startDate, endDate, function(rows) {
            changesMenu.section(0, { title: title });

            var userNames = HistoryService.getUserNames();

            // Newest first, capped so huge histories can't flood the watch
            var items = [];
            for (var i = rows.length - 1; i >= 0 && items.length < MAX_CHANGE_ENTRIES; i--) {
                var row = rows[i];
                if (!row.when) { continue; }
                var state = row.state !== undefined && row.state !== null
                    ? helpers.ucwords(String(row.state).replace(/_/g, ' '))
                    : (row.message || 'Changed');
                var subtitle = formatWhen(row.when * 1000);
                var who = row.context_user_id && userNames[row.context_user_id];
                if (who) {
                    subtitle += ' by ' + who;
                }
                items.push({ title: state, subtitle: subtitle });
            }

            if (items.length === 0) {
                items.push({
                    title: 'No changes',
                    subtitle: 'Last 24 hours'
                });
            }

            changesMenu.items(0, items);
        }, function(error) {
            changesMenu.section(0, { title: title });
            changesMenu.items(0, [{
                title: 'Failed to load',
                subtitle: 'Check connection and try again'
            }]);
        });
    });

    changesMenu.show();
}

module.exports.show = show;
module.exports.isSupported = isSupported;
