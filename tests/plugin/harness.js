/**
 * A test bench for the plugin: plugin/js loaded the way the bundle loads it,
 * a stand-in for the Pebble app's plugin runtime, and a fake Home Assistant
 * behind fetch and WebSocket.
 *
 * The Pebble app starts a fresh JS engine for every request, so every
 * harness.source(), harness.action() and harness.config() call loads the
 * modules afresh. localStorage, secure storage, the clock and the fake Home
 * Assistant carry over from one request to the next, as they do on a phone.
 *
 *     const h = harness.create();
 *     h.settings({ plugin_exposed_entities: ['light.kitchen'] });
 *     h.states([{ entity_id: 'light.kitchen', state: 'on', attributes: {} }]);
 *     const answer = await h.source('home', 'light');   // { data } or { error }
 */
'use strict';

// Fixed, and west of UTC, so day boundaries are the same on every machine and
// a forecast stamped at midnight UTC falls on the evening before
process.env.TZ = 'America/Denver';

const fs = require('fs');
const path = require('path');
const codecCases = require('./codec-cases');

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN_JS = path.join(ROOT, 'plugin', 'js');
//! Modules the plugin's bundle takes from outside plugin/js: name -> path from the repo root
const BUNDLE_MODULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'bundle.json'), 'utf8')).modules;

const URL = 'http://ha.test:8123';
const TOKEN = 'good-token';
//! A moment in the afternoon, so today still has hours ahead of it
const START = Date.parse('2026-06-15T15:00:00Z');
//! The phone ends a request after 20 seconds; nothing here should take long
const REQUEST_LIMIT_MS = 2000;

function listFiles(dir, out) {
    fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            listFiles(full, out);
        } else if (/\.(js|json)$/.test(entry.name)) {
            out.push(full);
        }
    });
    return out;
}

/**
 * The bundle as wscript's concat_javascript writes it: the app's module
 * loader, every file under plugin/js defined under its path relative to
 * that folder, the app's files plugin/bundle.json maps to module names,
 * appinfo.json as the `appinfo` module, then main required.
 */
function buildBundle() {
    const LOADER_TEMPLATE = (relpath, lineno, body) =>
        '__loader.define(' + JSON.stringify(relpath) + ', ' + lineno + ', ' +
        'function(exports, module, require) {\n' + body + '\n});';
    const sources = [fs.readFileSync(path.join(ROOT, 'src', 'js', 'loader.js'), 'utf8')];
    listFiles(PLUGIN_JS, []).forEach((file) => {
        let body = fs.readFileSync(file, 'utf8');
        if (file.endsWith('.json')) { body = 'module.exports = ' + body + ';'; }
        sources.push({ relpath: path.relative(PLUGIN_JS, file).split(path.sep).join('/'), body: body });
    });
    // The modules it takes from the app, as wscript adds them
    Object.keys(BUNDLE_MODULES).sort().forEach((name) => {
        sources.push({ relpath: name + '.js', body: fs.readFileSync(path.join(ROOT, BUNDLE_MODULES[name]), 'utf8') });
    });
    sources.push({
        relpath: 'appinfo.json',
        body: 'module.exports = ' + fs.readFileSync(path.join(ROOT, 'appinfo.json'), 'utf8') + ';'
    });
    sources.push('__loader.require("main");');

    let lineno = 1;
    return sources.map((source) => {
        const body = typeof source === 'string' ? source : LOADER_TEMPLATE(source.relpath, lineno, source.body);
        lineno += body.split('\n').length;
        return body;
    }).join('\n');
}

const BUNDLE = buildBundle();
const GLOBALS = ['Pebble', 'localStorage', 'fetch', 'WebSocket', 'Date', 'console'];
//! Compiled once; each call is a fresh engine with fresh modules
const ENGINE = new Function(GLOBALS.join(', '), BUNDLE + '\nreturn __loader;');

const APPINFO = JSON.parse(fs.readFileSync(path.join(ROOT, 'appinfo.json'), 'utf8'));
const MANIFEST_TEXT = fs.readFileSync(path.join(ROOT, 'plugin', 'manifest.json'), 'utf8');

function memoryStorage() {
    const items = new Map();
    return {
        items: items,
        getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
        setItem: (key, value) => { items.set(String(key), String(value)); },
        removeItem: (key) => { items.delete(String(key)); },
        clear: () => { items.clear(); },
        key: (i) => Array.from(items.keys())[i] || null,
        get length() { return items.size; }
    };
}

/**
 * A Response as the Pebble app's fetch hands it over. A binary body is only
 * readable with arrayBuffer() when the request asked for
 * `responseType: 'arraybuffer'`.
 */
function makeResponse(status, body, headers, init) {
    const lower = {};
    Object.keys(headers || {}).forEach((k) => { lower[k.toLowerCase()] = String(headers[k]); });
    let text;
    if (body === undefined || body === null) {
        text = '';
    } else if (typeof body === 'string') {
        text = body;
    } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        text = null;
    } else {
        text = JSON.stringify(body);
        if (!lower['content-type']) { lower['content-type'] = 'application/json'; }
    }
    return {
        status: status,
        ok: status >= 200 && status < 300,
        statusText: String(status),
        headers: { get: (name) => (lower[String(name).toLowerCase()] !== undefined ? lower[String(name).toLowerCase()] : null) },
        text: () => Promise.resolve(text === null ? Buffer.from(body).toString('latin1') : text),
        json: () => Promise.resolve().then(() => JSON.parse(text)),
        arrayBuffer: () => {
            if (init.responseType !== 'arraybuffer') {
                return Promise.reject(new Error('arrayBuffer() needs responseType: arraybuffer'));
            }
            const bytes = text === null ? Buffer.from(body) : Buffer.from(text, 'utf8');
            return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
        }
    };
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * A fake Home Assistant. It keeps states, answers the REST paths the plugin
 * uses and the WebSocket's login and assist commands, and records every
 * request. Routes added with on() are tried before the built-in ones.
 */
function createHomeAssistant(clock) {
    const fake = {
        url: URL,
        token: TOKEN,
        //! false: every request fails as if the host were down
        reachable: true,
        //! true: fetch fails the way a Pebble app from 1.17 fails an address it does not allow
        notAllowed: false,
        config: { version: '2026.11.0', latitude: 40.0, longitude: -105.0, location_name: 'Home' },
        statesById: {},
        forecastsById: {},
        //! entity_id -> the to-do list's items, as todo.get_items gives them
        todoItemsById: {},
        //! entity_id -> its states over time, [{ state, last_changed }], oldest first
        history: {},
        //! calendar entity_id -> its events, as /api/calendars/<id> lists them
        calendars: {},
        //! entity_id -> the name of its area (its own, or its device's)
        areas: {},
        //! false: the token's user is not an admin, and may not render templates
        admin: true,
        pipelines: { pipelines: [{ id: 'p1', name: 'Home', stt_engine: 'stt.x' }], preferred_pipeline: 'p1' },
        //! What each template renders to, for POST /api/template: a string, or
        //! { error } for one Home Assistant cannot render. Text without any
        //! Jinja renders as itself; any other template is an error.
        templates: {},
        //! Text-to-speech engines /api/tts_get_url accepts
        ttsEngines: ['tts.piper'],
        //! What each /api/tts_get_url was asked, by the token in its path
        ttsTokens: new Map(),
        /**
         * The WAV the proxy serves for `message`: about 15 characters a
         * second at the rate asked for, a different voice-like signal for
         * every message, the same every time for one
         */
        speechFor: (message, options) => {
            const rate = options.preferred_sample_rate || 22050;
            let seed = 7;
            for (let i = 0; i < message.length; i++) { seed = (Math.imul(seed, 31) + message.charCodeAt(i)) >>> 0; }
            return codecCases.wav({ rate: rate, count: Math.round(rate * message.length / 15), peak: 8000, hum: 1500, seed: seed });
        },
        requests: [],
        sockets: [],
        routes: [],
        //! Answers assist_pipeline/run: (command) -> intent_output, or { error: { code, message } }
        assist: (command) => ({
            conversation_id: command.conversation_id || 'conv-1',
            response: {
                response_type: 'action_done',
                speech: { plain: { speech: 'Turned on the kitchen light.' } }
            }
        }),

        /**
         * Answers recorder/statistics_during_period (hourly means only), or
         * { error }. As Home Assistant keeps them: only for an entity with a
         * state_class, worked out from `history`, one row for each finished
         * hour with a number in it.
         */
        statistics: (command) => {
            const HOUR = 3600000;
            const from = Date.parse(command.start_time);
            const to = Math.min(command.end_time ? Date.parse(command.end_time) : clock.now(), clock.now());
            const out = {};
            command.statistic_ids.forEach((id) => {
                const state = fake.statesById[id];
                if (!state || !state.attributes || !state.attributes.state_class) { return; }
                const all = (fake.history[id] || []).map((e) => ({ value: Number(e.state), at: Date.parse(e.last_changed) }));
                const rows = [];
                for (let start = Math.ceil(from / HOUR) * HOUR; start + HOUR <= to; start += HOUR) {
                    let sum = 0;
                    let held = 0;
                    all.forEach((e, i) => {
                        if (isNaN(e.value)) { return; }
                        const begins = Math.max(e.at, start);
                        const ends = Math.min(i + 1 < all.length ? all[i + 1].at : to, start + HOUR);
                        if (ends > begins) { sum += e.value * (ends - begins); held += ends - begins; }
                    });
                    if (held > 0) { rows.push({ start: start, end: start + HOUR, mean: sum / held }); }
                }
                if (rows.length > 0) { out[id] = rows; }
            });
            return out;
        },

        on(method, pattern, handler) {
            fake.routes.unshift({ method: method, pattern: pattern, handler: handler });
            return fake;
        },

        /** Requests made so far, optionally only those whose "METHOD path" matches */
        calls(filter) {
            if (!filter) { return fake.requests.slice(); }
            return fake.requests.filter((r) => (filter instanceof RegExp ? filter.test(r.method + ' ' + r.path)
                : r.method + ' ' + r.path === filter));
        },

        serviceCalls() {
            return fake.requests.filter((r) => r.method === 'POST' && r.path.indexOf('/api/services/') === 0)
                .map((r) => ({ service: r.path.substring('/api/services/'.length).replace('/', '.'), data: r.body, query: r.query }));
        },

        commands() {
            const out = [];
            fake.sockets.forEach((s) => { s.received.forEach((m) => { if (m.type !== 'auth') { out.push(m); } }); });
            return out;
        }
    };

    function authorized(headers) {
        return headers.authorization === 'Bearer ' + fake.token;
    }

    /**
     * Enough Jinja for the plugin's templates: `{% set x %}...{% endset %}`
     * blocks, each a template looked up in fake.templates, then one
     * `{{ { "0": x, ... } | tojson }}`. Like Home Assistant, one template
     * that fails fails the whole render with a 400.
     */
    function renderTemplate(text) {
        text = String(text || '');
        const one = (template) => {
            if (Object.prototype.hasOwnProperty.call(fake.templates, template)) { return fake.templates[template]; }
            return /[{}]/.test(template) ? { error: 'TemplateSyntaxError: the fake does not know ' + template } : template;
        };
        const refuse = (error) => ({ status: 400, body: { message: 'Error rendering template: ' + error } });
        const blocks = /\{% set ([a-z_0-9]+) %\}([\s\S]*?)\{% endset %\}/g;
        const captured = {};
        let failed = null;
        let m;
        while ((m = blocks.exec(text)) !== null) {
            const out = one(m[2]);
            if (out && typeof out === 'object') { failed = failed || out.error; } else { captured[m[1]] = out; }
        }
        if (failed) { return refuse(failed); }
        const rest = text.replace(blocks, '');
        const tail = /^\{\{ \{(.*)\} \| tojson \}\}$/.exec(rest);
        if (!tail) {
            const out = one(rest);
            if (out && typeof out === 'object') { return refuse(out.error); }
            return { status: 200, body: out, headers: { 'content-type': 'text/plain' } };
        }
        const result = {};
        tail[1].split(', ').forEach((pair) => {
            const kv = /^"([^"]+)": ([a-z_0-9]+)$/.exec(pair);
            result[kv[1]] = captured[kv[2]];
        });
        return { status: 200, body: JSON.stringify(result), headers: { 'content-type': 'text/plain' } };
    }

    /**
     * POST /api/tts_get_url starts making the speech and answers where it
     * will be; GET /api/tts_proxy/<token> serves it to anyone who has the
     * token. The url names an address the phone cannot reach, as Home
     * Assistant's own idea of its address often is.
     */
    function tts(req) {
        if (req.method === 'POST' && req.path === '/api/tts_get_url') {
            const body = req.body || {};
            if (fake.ttsEngines.indexOf(body.engine_id) === -1) {
                return { status: 400, body: { message: 'Provider ' + body.engine_id + ' not found' } };
            }
            const token = 'tts' + (fake.ttsTokens.size + 1) + 'x' + Math.random().toString(36).slice(2, 10);
            fake.ttsTokens.set(token, clone(body));
            const path = '/api/tts_proxy/' + token + '.wav';
            return { status: 200, body: { url: 'http://homeassistant.local:8123' + path, path: path } };
        }
        const m = /^\/api\/tts_proxy\/([a-z0-9]+)\.wav$/.exec(req.path);
        if (req.method === 'GET' && m) {
            const asked = fake.ttsTokens.get(m[1]);
            if (!asked) { return { status: 404, body: '404: Not Found' }; }
            return { status: 200, body: fake.speechFor(asked.message, asked.options || {}), headers: { 'Content-Type': 'audio/wav' } };
        }
        return null;
    }

    function builtIn(req) {
        // The audio needs no token, only its address
        if (!authorized(req.headers) && !/^\/api\/tts_proxy\//.test(req.path)) {
            return { status: 401, body: '401: Unauthorized' };
        }
        // Core's fetch adds a Content-Type of its own to a request without a
        // body, and Home Assistant refuses a request with two
        if (req.headers['content-type'] !== undefined && req.rawBody === undefined) {
            return { status: 400, body: { message: 'Duplicate Content-Type header' } };
        }
        const speech = tts(req);
        if (speech) { return speech; }
        const p = req.path;
        if (req.method === 'GET' && p === '/api/') { return { status: 200, body: { message: 'API running.' } }; }
        if (req.method === 'GET' && p === '/api/config') { return { status: 200, body: fake.config }; }
        if (req.method === 'GET' && p === '/api/states') {
            return { status: 200, body: Object.keys(fake.statesById).map((id) => fake.statesById[id]) };
        }
        let m = /^\/api\/states\/(.+)$/.exec(p);
        if (req.method === 'GET' && m) {
            const state = fake.statesById[decodeURIComponent(m[1])];
            return state ? { status: 200, body: state } : { status: 404, body: { message: 'Entity not found.' } };
        }
        m = /^\/api\/calendars\/(.+)$/.exec(p);
        if (req.method === 'GET' && m) {
            const events = fake.calendars[decodeURIComponent(m[1])];
            if (!events) { return { status: 400, body: { message: 'Entity not found' } }; }
            const from = Date.parse(req.query.start);
            const to = Date.parse(req.query.end);
            if (isNaN(from) || isNaN(to)) { return { status: 400, body: { message: 'Invalid start or end' } }; }
            const at = (when) => Date.parse(when.dateTime || when.date + 'T00:00:00');
            return { status: 200, body: clone(events.filter((e) => at(e.end) > from && at(e.start) < to)) };
        }
        m = /^\/api\/history\/period\/(.+)$/.exec(p);
        if (req.method === 'GET' && m) {
            const from = Date.parse(decodeURIComponent(m[1]));
            const to = req.query.end_time ? Date.parse(req.query.end_time) : from + 86400000;
            if (isNaN(from) || isNaN(to)) { return { status: 400, body: { message: 'Invalid datetime' } }; }
            const minimal = 'minimal_response' in req.query;
            const ids = String(req.query.filter_entity_id || '').split(',').filter(Boolean);
            const lists = [];
            ids.forEach((id) => {
                const all = (fake.history[id] || []).map((e) => ({ state: e.state, at: Date.parse(e.last_changed) }));
                // The state it was in at the start, then every change up to the end
                const before = all.filter((e) => e.at <= from).pop();
                const shown = (before ? [{ state: before.state, at: from }] : []).concat(all.filter((e) => e.at > from && e.at <= to));
                if (shown.length === 0) { return; }
                lists.push(shown.map((e, i) => (minimal && i > 0
                    ? { state: e.state, last_changed: new Date(e.at).toISOString() }
                    : { entity_id: id, state: e.state, last_changed: new Date(e.at).toISOString(),
                        last_updated: new Date(e.at).toISOString() })));
            });
            return { status: 200, body: lists };
        }
        if (req.method === 'POST' && p === '/api/template') {
            if (!fake.admin) { return { status: 401, body: '401: Unauthorized' }; }
            // The rooms template (areas.js) is the one that passes ids as a
            // variable: the area of each id
            const ids = req.body && req.body.variables && req.body.variables.ids;
            if (ids) { return { status: 200, body: JSON.stringify(ids.map((id) => fake.areas[id] || null)) }; }
            return renderTemplate(req.body && req.body.template);
        }
        m = /^\/api\/services\/([a-z0-9_]+)\/([a-z0-9_]+)$/.exec(p);
        if (req.method === 'POST' && m) {
            if ('return_response' in req.query) {
                if (m[1] === 'weather' && m[2] === 'get_forecasts') {
                    const ids = [].concat((req.body && req.body.entity_id) || []);
                    const response = {};
                    ids.forEach((id) => {
                        response[id] = { forecast: clone(((fake.forecastsById[id] || {})[req.body.type]) || []) };
                    });
                    return { status: 200, body: { changed_states: [], service_response: response } };
                }
                if (m[1] === 'todo' && m[2] === 'get_items') {
                    const ids = [].concat((req.body && req.body.entity_id) || []);
                    const wanted = [].concat((req.body && req.body.status) || []);
                    const response = {};
                    ids.forEach((id) => {
                        const items = clone(fake.todoItemsById[id] || []);
                        response[id] = { items: wanted.length ? items.filter((i) => wanted.includes(i.status)) : items };
                    });
                    return { status: 200, body: { changed_states: [], service_response: response } };
                }
                return { status: 400, body: { message: 'Service does not support responses' } };
            }
            return { status: 200, body: [] };
        }
        return { status: 404, body: '404: Not Found' };
    }

    fake.fetch = function(url, init) {
        init = init || {};
        const parsed = new globalThis.URL(url);
        const headers = {};
        Object.keys(init.headers || {}).forEach((k) => { headers[k.toLowerCase()] = init.headers[k]; });
        let body;
        if (typeof init.body === 'string') {
            try { body = JSON.parse(init.body); } catch (e) { body = init.body; }
        }
        const query = {};
        parsed.searchParams.forEach((v, k) => { query[k] = v; });
        const req = {
            method: (init.method || 'GET').toUpperCase(),
            url: url,
            origin: parsed.origin,
            path: parsed.pathname,
            query: query,
            headers: headers,
            rawHeaders: Object.assign({}, init.headers || {}),
            body: body,
            rawBody: init.body,
            responseType: init.responseType,
            at: clock.now()
        };
        if (parsed.origin !== new globalThis.URL(fake.url).origin) {
            return Promise.reject(new TypeError('Network request failed'));
        }
        fake.requests.push(req);
        if (fake.notAllowed) {
            const err = new Error('Not allowed');
            err.name = 'NotAllowedError';
            return Promise.reject(err);
        }
        if (!fake.reachable) {
            return Promise.reject(new TypeError('Network request failed'));
        }
        let answer = null;
        for (const route of fake.routes) {
            if (route.method !== req.method) { continue; }
            const hit = route.pattern instanceof RegExp ? route.pattern.test(req.path) : route.pattern === req.path;
            if (!hit) { continue; }
            answer = route.handler(req, () => builtIn(req));
            if (answer !== undefined) { break; }
        }
        if (!answer) { answer = builtIn(req); }
        if (answer.status === undefined) { answer = { status: 200, body: answer }; }
        return Promise.resolve(makeResponse(answer.status, answer.body, answer.headers, init));
    };

    /** A WebSocket to the fake's /api/websocket, scripted as Home Assistant runs it */
    fake.WebSocket = function FakeWebSocket(url) {
        const socket = this;
        socket.url = url;
        socket.readyState = 0;
        socket.received = [];
        socket.sent = [];
        fake.sockets.push(socket);
        const expected = fake.url.replace(/^http/, 'ws') + '/api/websocket';

        function deliver(msg) {
            setImmediate(() => {
                if (socket.readyState !== 1) { return; }
                socket.sent.push(msg);
                if (socket.onmessage) { socket.onmessage({ data: JSON.stringify(msg) }); }
            });
        }
        function drop() {
            setImmediate(() => {
                if (socket.readyState === 3) { return; }
                socket.readyState = 3;
                if (socket.onerror) { socket.onerror({}); }
                if (socket.onclose) { socket.onclose({ code: 1006 }); }
            });
        }
        socket.serverClose = drop;

        socket.send = function(text) {
            if (socket.readyState !== 1) { throw new Error('WebSocket is not open'); }
            const msg = JSON.parse(text);
            socket.received.push(msg);
            if (msg.type === 'auth') {
                if (msg.access_token === fake.token) {
                    socket.authed = true;
                    deliver({ type: 'auth_ok', ha_version: fake.config.version });
                } else {
                    deliver({ type: 'auth_invalid', message: 'Invalid access token or password' });
                    drop();
                }
                return;
            }
            if (!socket.authed) { drop(); return; }
            const id = msg.id;
            if (msg.type === 'assist_pipeline/pipeline/list') {
                deliver({ id: id, type: 'result', success: true, result: clone(fake.pipelines) });
            } else if (msg.type === 'recorder/statistics_during_period') {
                const answer = fake.statistics(msg);
                if (answer && answer.error) {
                    deliver({ id: id, type: 'result', success: false, error: answer.error });
                    return;
                }
                deliver({ id: id, type: 'result', success: true, result: answer });
            } else if (msg.type === 'assist_pipeline/run') {
                const output = fake.assist(msg);
                if (output && output.error) {
                    deliver({ id: id, type: 'result', success: false, error: output.error });
                    return;
                }
                deliver({ id: id, type: 'result', success: true, result: null });
                deliver({ id: id, type: 'event', event: { type: 'run-start', data: { pipeline: msg.pipeline || 'p1' } } });
                deliver({ id: id, type: 'event', event: { type: 'intent-start', data: {} } });
                if (output && output.event) {
                    deliver({ id: id, type: 'event', event: output.event });
                } else {
                    deliver({ id: id, type: 'event', event: { type: 'intent-end', data: { intent_output: output } } });
                }
                deliver({ id: id, type: 'event', event: { type: 'run-end', data: null } });
            } else {
                deliver({ id: id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } });
            }
        };

        socket.close = function() {
            socket.readyState = 3;
        };

        setImmediate(() => {
            if (!fake.reachable || url !== expected) { drop(); return; }
            socket.readyState = 1;
            if (socket.onopen) { socket.onopen({}); }
            deliver({ type: 'auth_required', ha_version: fake.config.version });
        });
    };

    return fake;
}

/**
 * A fresh phone: empty storage, a fake Home Assistant, the clock at START.
 * @param {Object} [opts] phone: { location: 'granted', units: {...},
 *     locations: [{ id, name, latitude, longitude }], noPhoneSources: true }
 */
function create(opts) {
    opts = opts || {};
    let now = START;
    const clock = { now: () => now };

    // The plugin's Date: the harness clock for "now", the real Date otherwise
    class PhoneDate extends Date {
        constructor(...args) {
            if (args.length === 0) { super(now); } else { super(...args); }
        }
        static now() { return now; }
    }

    const ha = createHomeAssistant(clock);
    const localStorage = memoryStorage();
    const secure = memoryStorage();
    const phone = Object.assign({
        location: 'granted',
        units: { temperature: '°C', wind_speed: 'km/h' },
        locations: [],
        noPhoneSources: false
    }, opts.phone || {});

    const h = {
        ha: ha,
        localStorage: localStorage,
        secureStorage: secure,
        phone: phone,
        uuid: APPINFO.uuid,
        logs: [],
        refreshed: [],
        configMessages: [],
        subscribed: [],

        now: () => now,
        advance(ms) { now += ms; return h; },

        /** Save the watch app's settings, with the fake's URL and token unless given */
        settings(values) {
            const data = Object.assign({ ha_url: ha.url, token: ha.token }, values || {});
            localStorage.setItem('options:' + APPINFO.uuid, JSON.stringify(data));
            return h;
        },

        readSettings() {
            const text = localStorage.getItem('options:' + APPINFO.uuid);
            return text ? JSON.parse(text) : null;
        },

        /** Replace Home Assistant's states. Times default to a minute ago. */
        states(list) {
            ha.statesById = {};
            const stamp = new Date(now - 60000).toISOString();
            list.forEach((s) => {
                ha.statesById[s.entity_id] = Object.assign({
                    attributes: {}, last_changed: stamp, last_updated: stamp, context: { id: 'c' }
                }, clone(s));
            });
            return h;
        },

        /** Forecasts Home Assistant gives for one weather entity: { daily: [...], hourly: [...] } */
        forecasts(entityId, byType) {
            ha.forecastsById[entityId] = clone(byType);
            return h;
        },

        /** The items of one to-do list: [{ uid, summary, status, due?, description? }] */
        todoItems(entityId, items) {
            ha.todoItemsById[entityId] = clone(items);
            return h;
        },

        /** The plugin's own cached value under `key`, as store.js keeps it */
        stored(key) {
            const text = localStorage.getItem('plugin:' + key);
            return text ? JSON.parse(text) : null;
        },

        /** Load the bundle in a new engine; returns its handlers and module loader */
        engine() {
            const handlers = {};
            const engineSockets = [];
            function Socket(url) {
                const s = new ha.WebSocket(url);
                engineSockets.push(s);
                return s;
            }
            const Pebble = {
                registerSourceHandler: (fn) => { handlers.source = fn; },
                registerActionHandler: (fn) => { handlers.action = fn; },
                registerConfigHandler: (fn) => { handlers.config = fn; },
                refreshSources: (keys) => { h.refreshed.push(keys); },
                sendConfigMessage: (msg) => { h.configMessages.push(clone(msg)); },
                sendMessage: (target, msg) => { h.configMessages.push({ target: target, message: clone(msg) }); },
                secureStorage: {
                    getItem: (k) => Promise.resolve(secure.getItem(k)),
                    setItem: (k, v) => Promise.resolve(secure.setItem(k, v)),
                    removeItem: (k) => Promise.resolve(secure.removeItem(k))
                },
                permissions: {
                    query: (name) => Promise.resolve(name === 'Location' ? phone.location : 'granted')
                }
            };
            if (!phone.noPhoneSources) {
                Pebble.subscribeSource = (req) => { h.subscribed.push(clone(req)); };
                Pebble.readSource = (req) => Promise.resolve(phoneSource(req));
            }
            const consoleStub = {};
            ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
                consoleStub[level] = (...args) => { h.logs.push(args.map(String).join(' ')); };
            });
            const loader = ENGINE(Pebble, localStorage, ha.fetch, Socket, PhoneDate, consoleStub);
            return {
                handlers: handlers,
                Pebble: Pebble,
                require: (name) => loader.require(name),
                // The phone tears the engine down once it has answered, and
                // its sockets with it
                end: () => { engineSockets.forEach((s) => { s.readyState = 3; }); }
            };
        },

        /** Read a source: resolves { data } or { error: { code, message } } */
        source(category, item, request) {
            const req = Object.assign({ category: category, item: item }, request || {});
            return run('source', clone(req), (settle) => ({
                data: (data) => settle({ data: clone(data) }),
                error: (code, message) => settle({ error: { code: code, message: message } })
            }));
        },

        /**
         * Call an action: resolves { ok: { text, refreshed } } or { error: { code, message } }.
         * Only `text` and `refreshed` reach the caller, as the Pebble app's
         * host passes them on (PluginHostJs respond.ok); anything else the
         * plugin puts in its result is dropped here too.
         */
        action(name, args) {
            return run('action', { action: name, args: clone(args || {}) }, (settle) => ({
                ok: (result) => {
                    result = result || {};
                    settle({ ok: clone({ text: result.text || null, refreshed: result.refreshed || [] }) });
                },
                error: (code, message) => settle({ error: { code: code, message: message } })
            }));
        },

        /** Send a settings page message: resolves what the plugin answered */
        config(message) {
            return run('config', clone(message), (settle) => (reply) => settle(clone(reply)));
        }
    };

    function phoneSource(req) {
        if (req.category === 'preferences' && req.item === 'units') {
            const props = {};
            Object.keys(phone.units).forEach((k) => { props[k] = { shortText: { text: phone.units[k] } }; });
            return { instances: [{ instanceId: 'units', properties: props }] };
        }
        if (req.category === 'preferences' && req.item === 'weather_location') {
            return {
                instances: phone.locations.map((loc) => ({
                    instanceId: loc.id,
                    properties: {
                        name: { shortText: { text: loc.name } },
                        latitude: { numericValue: { value: loc.latitude } },
                        longitude: { numericValue: { value: loc.longitude } }
                    }
                }))
            };
        }
        return { instances: [] };
    }

    /**
     * One request in a fresh engine. Settles once the plugin has answered
     * and whatever its handler returned has settled, so nothing it is still
     * doing runs into the next request. Answering twice, or not at all, fails.
     */
    function run(kind, request, makeRespond) {
        const engine = h.engine();
        return new Promise((resolve, reject) => {
            let answer;
            let answered = false;
            let handlerDone = false;
            const timer = setTimeout(() => {
                engine.end();
                reject(new Error(kind + ' request took too long' + (answered ? ' after answering' : ' and never answered')));
            }, REQUEST_LIMIT_MS);
            timer.unref();
            function finish() {
                if (!answered || !handlerDone) { return; }
                clearTimeout(timer);
                engine.end();
                resolve(answer);
            }
            const respond = makeRespond((value) => {
                if (answered) {
                    clearTimeout(timer);
                    reject(new Error(kind + ' answered twice: ' + JSON.stringify(answer) + ' then ' + JSON.stringify(value)));
                    return;
                }
                answered = true;
                answer = value;
                finish();
            });
            const handler = engine.handlers[kind];
            if (!handler) { reject(new Error('no ' + kind + ' handler registered')); return; }
            Promise.resolve().then(() => handler(request, respond)).then(() => {
                handlerDone = true;
                if (!answered) {
                    clearTimeout(timer);
                    reject(new Error(kind + ' handler finished without answering'));
                    return;
                }
                finish();
            }, (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    return h;
}

/** The manifest, parsed */
function manifest() {
    return JSON.parse(MANIFEST_TEXT);
}

module.exports = {
    create: create,
    manifest: manifest,
    manifestText: MANIFEST_TEXT,
    appinfo: APPINFO,
    bundle: BUNDLE,
    URL: URL,
    TOKEN: TOKEN,
    START: START
};
