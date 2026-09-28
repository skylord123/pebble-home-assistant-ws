/**
 * The watch app's settings, read from the localStorage this plugin shares
 * with the app's own JS. Read only: the app keeps its own copy of these in
 * memory and would write over anything changed here on its next save.
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
    }
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
 * Weather entities the app has seen, or null when it has not published any
 * yet and the plugin has to look for itself
 */
function weatherIds(options) {
    return Array.isArray(options.plugin_weather_entities) ? options.plugin_weather_entities.slice() : null;
}

module.exports = {
    read: read,
    connection: connection,
    exposedIds: exposedIds,
    weatherIds: weatherIds
};
