/**
 * The room each entity is in, as `room` on every home/* instance, under the
 * name the Google Home plugin gives it. Home Assistant calls rooms areas: an
 * entity's own area, or else its device's.
 *
 * The REST API has no area registry, so one template asks for the areas of
 * every served entity at once. Areas hardly ever change, so the answer is
 * kept an hour. A room is only a nicety: when the template fails (it needs
 * an admin's token) the instances simply go without.
 */
var ha = require('ha');
var store = require('store');

var AREAS_TTL_MS = 60 * 60 * 1000;
//! Not asked again for a while after a failure, which every poll would repeat
var FAILED_TTL_MS = 10 * 60 * 1000;

//! The ids come in as a variable, never written into the template
var TEMPLATE = '{{ ids | map("area_name") | list | tojson }}';

/**
 * Whether the caller wants a property. A caller that names no properties
 * wants them all.
 */
function wants(request, name) {
    var names = request && request.properties;
    return !Array.isArray(names) || names.indexOf(name) !== -1;
}

/**
 * The area name of each of `ids` that has one.
 * @returns {Promise<Object>} entity_id -> area name; never rejects
 */
function rooms(conn, ids) {
    if (ids.length === 0 || store.fresh('areas_failed', FAILED_TTL_MS)) { return Promise.resolve({}); }
    // One map for every source, so home/light and home/switch do not push
    // each other's areas out. It is kept an hour from when it was started.
    var entry = store.get('areas');
    var fresh = !!entry && typeof entry.at === 'number' && Date.now() - entry.at < AREAS_TTL_MS;
    var known = fresh && entry.value ? entry.value : {};
    var missing = ids.filter(function(id) { return !(id in known); });
    if (missing.length === 0) { return Promise.resolve(named(known, ids)); }
    return ha.request(conn, 'POST', '/api/template', { template: TEMPLATE, variables: { ids: missing } })
        .then(function(names) {
            if (!Array.isArray(names) || names.length !== missing.length) { throw new Error('unexpected answer'); }
            missing.forEach(function(id, i) {
                known[id] = typeof names[i] === 'string' && names[i] ? names[i] : null;
            });
            store.set('areas', { at: fresh ? entry.at : Date.now(), value: known });
            return named(known, ids);
        })
        .catch(function() {
            store.remember('areas_failed', true);
            return {};
        });
}

/** Try the template again on the next poll, as after the settings change */
function forgetFailure() {
    store.set('areas_failed', null);
}

function named(byId, ids) {
    var out = {};
    ids.forEach(function(id) {
        if (byId[id]) { out[id] = byId[id]; }
    });
    return out;
}

module.exports = {
    rooms: rooms,
    wants: wants,
    forgetFailure: forgetFailure
};
