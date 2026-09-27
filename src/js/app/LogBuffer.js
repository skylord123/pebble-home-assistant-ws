/**
 * LogBuffer - Keeps recent log lines so the settings page can show them
 *
 * Everything the app logs, and everything written to the console (haws, the
 * exception dumps from lib/safe), is kept here with a timestamp, whether or
 * not debug mode is on. Debug mode only decides whether app messages also go
 * to the console. The settings page asks for the text over the config bridge
 * so a user can read it or attach it to a bug report.
 *
 * Nothing that identifies the user's Home Assistant is kept: the instance URL
 * and access token are replaced with <redacted> in every line, both by exact
 * match on the values in use and by pattern, for anything logged before the
 * settings have been read.
 *
 * The tail of each session is written to localStorage so that the previous
 * session's lines are still there after a crash and a relaunch.
 */
var MAX_LINES = 1000;
var MAX_CHARS = 120000;
var PERSIST_LINES = 300;
var PERSIST_DELAY_MS = 3000;
var STORAGE_KEY = 'app_log_tail';
var REDACTED = '<redacted>';

// Patterns caught even when the exact values are not known yet
var PATTERNS = [
    // "token": "..." / token=... / access_token: ...
    [/((?:"|')?(?:access_)?token(?:"|')?\s*[:=]\s*(?:"|')?)([^"'\s,}&]+)/gi, '$1' + REDACTED],
    // Bearer <token>
    [/(Bearer\s+)[A-Za-z0-9._\-]+/g, '$1' + REDACTED],
    // A JWT, which is what a long-lived access token is
    [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, REDACTED],
    // Any URL that is not this project's own. Punctuation that ends the
    // sentence it sits in stays outside it.
    [/\b(?:https?|wss?):\/\/(?!skylord123\.github\.io)[^\s"'<>]*[^\s"'<>,.;:)\]]/gi, REDACTED]
];

var lines = [];
var chars = 0;
var previous = [];
var secrets = [];
var persistTimer = null;
var installed = false;
var original = {};

function pad(n, width) {
    var s = String(n);
    while (s.length < (width || 2)) { s = '0' + s; }
    return s;
}

function stamp(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
        '.' + pad(date.getMilliseconds(), 3);
}

function stringify(value) {
    if (typeof value === 'string') { return value; }
    if (value instanceof Error) { return value.stack || value.message || String(value); }
    try {
        return JSON.stringify(value);
    } catch (e) {
        return String(value);
    }
}

function replaceAll(text, needle, replacement) {
    return text.split(needle).join(replacement);
}

var LogBuffer = {
    /**
     * Take over console.log/warn/error so everything written there is kept.
     * Called once, as early as the app starts.
     */
    install: function() {
        if (installed) { return; }
        installed = true;

        try {
            var stored = localStorage.getItem(STORAGE_KEY);
            var parsed = stored ? JSON.parse(stored) : null;
            if (Array.isArray(parsed)) { previous = parsed.slice(-PERSIST_LINES); }
        } catch (e) { /* nothing worth keeping */ }

        ['log', 'warn', 'error'].forEach(function(level) {
            var fn = console[level];
            if (typeof fn !== 'function') { return; }
            original[level] = fn;
            console[level] = function() {
                var parts = [];
                for (var i = 0; i < arguments.length; i++) { parts.push(stringify(arguments[i])); }
                LogBuffer.record((level === 'log' ? '' : level.toUpperCase() + ' ') + parts.join(' '));
                try {
                    fn.apply(console, arguments);
                } catch (e) { /* the console is not essential */ }
            };
        });

        this.record('---- app started ----');
    },

    /**
     * Write to the real console, bypassing the capture. For messages that
     * have already been recorded.
     */
    console: function(message, extra) {
        var fn = original.log || console.log;
        try {
            if (extra !== undefined) {
                fn.call(console, message, extra);
            } else {
                fn.call(console, message);
            }
        } catch (e) { /* the console is not essential */ }
    },

    /**
     * Values that must never appear in a log line
     */
    setSecrets: function(values) {
        secrets = [];
        var self = this;
        (values || []).forEach(function(value) { self.addSecret(value); });
    },

    addSecret: function(value) {
        if (typeof value !== 'string') { return; }
        var trimmed = value.trim();
        if (trimmed.length < 4) { return; }
        var variants = [trimmed, trimmed.replace(/\/+$/, '')];
        // The URL is also used as a websocket address, and its host alone
        // still says where the instance is
        var url = trimmed.match(/^(https?):\/\/([^\/\s]+)/i);
        if (url) {
            variants.push(trimmed.replace(/^http/i, 'ws'));
            variants.push(url[2]);
        }
        variants.forEach(function(variant) {
            if (variant.length >= 4 && secrets.indexOf(variant) === -1) { secrets.push(variant); }
        });
        // Longest first, so a host is not blanked out of a URL before the
        // whole URL has had its turn
        secrets.sort(function(a, b) { return b.length - a.length; });
    },

    redact: function(text) {
        text = String(text);
        // Patterns first, so a whole URL goes rather than leaving its path
        // behind once the exact host has been blanked out of it
        for (var p = 0; p < PATTERNS.length; p++) {
            text = text.replace(PATTERNS[p][0], PATTERNS[p][1]);
        }
        for (var i = 0; i < secrets.length; i++) {
            if (text.indexOf(secrets[i]) !== -1) { text = replaceAll(text, secrets[i], REDACTED); }
        }
        return text;
    },

    /**
     * Keep one line, timestamped and redacted
     */
    record: function(message) {
        var line = stamp(new Date()) + ' ' + this.redact(message);
        lines.push(line);
        chars += line.length + 1;
        while (lines.length > MAX_LINES || (chars > MAX_CHARS && lines.length > 1)) {
            chars -= lines.shift().length + 1;
        }
        this.schedulePersist();
    },

    schedulePersist: function() {
        if (persistTimer) { return; }
        persistTimer = setTimeout(function() {
            persistTimer = null;
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(lines.slice(-PERSIST_LINES)));
            } catch (e) { /* out of room, or no storage */ }
        }, PERSIST_DELAY_MS);
    },

    lines: function() {
        return lines.slice();
    },

    previousLines: function() {
        return previous.slice();
    },

    /**
     * The whole log as one text: a header, what the previous session left
     * behind, then this session
     */
    text: function(headerLines) {
        var out = [];
        if (headerLines && headerLines.length) {
            out = out.concat(headerLines.map(function(l) { return LogBuffer.redact(l); }));
            out.push('');
        }
        if (previous.length) {
            out.push('==== Previous session (last ' + previous.length + ' lines) ====');
            out = out.concat(previous);
            out.push('');
        }
        out.push('==== This session (' + lines.length + ' lines) ====');
        out = out.concat(lines);
        return out.join('\n');
    },

    clear: function() {
        lines = [];
        chars = 0;
        previous = [];
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to remove */ }
        this.record('---- log cleared ----');
    }
};

module.exports = LogBuffer;
