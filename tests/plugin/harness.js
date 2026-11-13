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

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN_JS = path.join(ROOT, 'plugin', 'js');

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
 * that folder, appinfo.json as the `appinfo` module, then main required.
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
        //! calendar entity_id -> its events, as /api/calendars/<id> lists them
        calendars: {},
        //! entity_id -> the name of its area (its own, or its device's)
        areas: {},
        //! false: the token's user is not an admin, and may not render templates
        admin: true,
        pipelines: { pipelines: [{ id: 'p1', name: 'Home', stt_engine: 'stt.x' }], preferred_pipeline: 'p1' },
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

    function builtIn(req) {
        if (!authorized(req.headers)) {
            return { status: 401, body: '401: Unauthorized' };
        }
        // Core's fetch adds a Content-Type of its own to a request without a
        // body, and Home Assistant refuses a request with two
        if (req.headers['content-type'] !== undefined && req.rawBody === undefined) {
            return { status: 400, body: { message: 'Duplicate Content-Type header' } };
        }
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
        if (req.method === 'POST' && p === '/api/template') {
            if (!fake.admin) { return { status: 401, body: '401: Unauthorized' }; }
            // Only the one template the plugin renders: the area of each id
            const ids = (req.body && req.body.variables && req.body.variables.ids) || [];
            return { status: 200, body: JSON.stringify(ids.map((id) => fake.areas[id] || null)) };
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

        /** Call an action: resolves { ok } or { error: { code, message } } */
        action(name, args) {
            return run('action', { action: name, args: clone(args || {}) }, (settle) => ({
                ok: (result) => settle({ ok: clone(result) }),
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
