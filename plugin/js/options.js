/**
 * The watch app's settings, read from the localStorage this plugin shares
 * with the app's own JS. Only written by the settings page while the watch
 * app's JS is not running: the app keeps its own copy of these in memory and
 * would write over anything changed here on its next save, but it reads them
 * afresh whenever it starts.
 *
 * Mirrors src/js/settings/settings.js, including falling back to the backup
 * copy when a write was torn half way.
 */
var appinfo = require('appinfo');

var KEY = 'options:' + appinfo.uuid;

function parse(value) {
    if (!value) { return undefined; }
    try {
        return JSON.parse(value);
    } catch (e) {
        return undefined;
    }
}

function read() {
    var data = parse(localStorage.getItem(KEY));
    if (!data || typeof data !== 'object') {
        var backup = parse(localStorage.getItem(KEY + '.bak'));
        data = (backup && typeof backup === 'object') ? backup : {};
        // The backup is the save before last, and on Android the main copy
        // is also missing for a moment while the Pebble app rewrites
        // localStorage. A switch the wearer just turned off must not come
        // back on from it.
        data.plugin_allow_unlock = false;
        data.plugin_share_assistant = false;
    }
    return data;
}

/**
 * Merge `changes` into the settings, as Settings.option(object) does in the
 * watch app: the copy being replaced becomes the backup first, so a write
 * torn half way still leaves one that parses.
 * @returns {Object} the settings as saved
 */
function save(changes) {
    var data = read();
    Object.keys(changes).forEach(function(key) { data[key] = changes[key]; });
    var serialized = JSON.stringify(data);
    var previous = localStorage.getItem(KEY);
    if (previous && previous !== serialized && parse(previous)) {
        localStorage.setItem(KEY + '.bak', previous);
    }
    localStorage.setItem(KEY, serialized);
    return data;
}

/** The Home Assistant address and token, or null until both are set */
function connection(options) {
    var url = typeof options.ha_url === 'string' ? options.ha_url.trim().replace(/\/+$/, '') : '';
    var token = typeof options.token === 'string' ? options.token.trim() : '';
    if (!/^https?:\/\/\S+/i.test(url) || !token) {
        return null;
    }
    return { url: url, token: token };
}

/** Entity ids the user chose to share, in the order they chose them */
function exposedIds(options) {
    var list = Array.isArray(options.plugin_exposed_entities) ? options.plugin_exposed_entities : [];
    var ids = [];
    for (var i = 0; i < list.length; i++) {
        var id = typeof list[i] === 'string' ? list[i] : (list[i] && list[i].entity_id);
        if (typeof id === 'string' && ids.indexOf(id) === -1) {
            ids.push(id);
        }
    }
    return ids;
}

/**
 * The names shared entities had when they were shared, by entity_id. The
 * watch app keeps them in step with Home Assistant; an entry saved as a bare
 * id has none.
 */
function sharedNames(options) {
    var list = Array.isArray(options.plugin_exposed_entities) ? options.plugin_exposed_entities : [];
    var names = {};
    list.forEach(function(entry) {
        if (entry && typeof entry.entity_id === 'string' && typeof entry.name === 'string' && entry.name) {
            names[entry.entity_id] = entry.name;
        }
    });
    return names;
}

/**
 * Weather entities the app has seen, or null when it has not published any
 * yet and the plugin has to look for itself
 */
function weatherIds(options) {
    return Array.isArray(options.plugin_weather_entities) ? options.plugin_weather_entities.slice() : null;
}

/**
 * The values the wearer wrote templates for, in their order, each with an
 * id the settings page gave it. Entries without an id or a template are
 * left out.
 */
function values(options) {
    var list = Array.isArray(options.plugin_values) ? options.plugin_values : [];
    var out = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
        var entry = list[i];
        if (!entry || typeof entry.id !== 'string' || !entry.id || seen[entry.id]) { continue; }
        if (typeof entry.template !== 'string' || !entry.template.trim()) { continue; }
        seen[entry.id] = true;
        var name = typeof entry.name === 'string' ? entry.name.trim() : '';
        out.push({
            id: entry.id,
            name: name || entry.id,
            template: entry.template,
            unit: typeof entry.unit === 'string' ? entry.unit.trim() : ''
        });
    }
    return out;
}

/**
 * The pipeline the watch app would talk to, or undefined for Home Assistant's
 * preferred one. A pipeline the app no longer lists has been deleted, and
 * gives way to the preferred one as it does in the app.
 */
function pipeline(options) {
    var chosen = options.selected_pipeline;
    if (typeof chosen !== 'string' || !chosen) { return undefined; }
    var pipelines = Array.isArray(options.available_pipelines) ? options.available_pipelines : [];
    if (pipelines.length === 0) { return chosen; }
    for (var i = 0; i < pipelines.length; i++) {
        if (pipelines[i] && pipelines[i].id === chosen) { return chosen; }
    }
    return undefined;
}

module.exports = {
    read: read,
    pipeline: pipeline,
    save: save,
    connection: connection,
    exposedIds: exposedIds,
    sharedNames: sharedNames,
    weatherIds: weatherIds,
    values: values
};
