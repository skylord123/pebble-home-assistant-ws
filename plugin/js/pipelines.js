/**
 * The assistant's pipelines, for a watch app with a picker of its own: the
 * agent/pipeline source lists them, and the `pipeline` argument of the
 * assistant and speech actions picks one for a call.
 *
 * Both come from the list the watch app saves when it reads the pipelines
 * from Home Assistant (its id, name, whether it is Home Assistant's
 * preferred one, and whether it has speech-to-text and text-to-speech), so
 * nothing here asks Home Assistant. A call can only name a pipeline on that
 * list.
 */
var ha = require('ha');
var options = require('options');
var entities = require('entities');

var PluginError = ha.PluginError;
var S = entities.shapes;

//! The pipelines the watch app saw, in Home Assistant's order
function listed(opts) {
    var list = Array.isArray(opts.available_pipelines) ? opts.available_pipelines : [];
    var seen = {};
    return list.filter(function(p) {
        if (!p || typeof p.id !== 'string' || !p.id || seen[p.id]) { return false; }
        seen[p.id] = true;
        return true;
    });
}

/** The agent/pipeline instances: one per pipeline, its id the pipeline's */
function instances(opts) {
    var list = listed(opts);
    var selected = options.pipeline(opts);
    // With none chosen, the watch app talks to Home Assistant's preferred one
    if (!selected) {
        list.forEach(function(p) { if (p.preferred === true && !selected) { selected = p.id; } });
    }
    return list.map(function(p) {
        var name = typeof p.name === 'string' && p.name ? p.name : p.id;
        var properties = {
            name: { shortText: S.shortText(name) },
            preferred: { boolean: S.bool(p.preferred === true) },
            selected: { boolean: S.bool(p.id === selected) }
        };
        // An app from before the watch app kept these leaves them out
        if (typeof p.stt === 'boolean') { properties.listens = { boolean: S.bool(p.stt) }; }
        if (typeof p.tts === 'boolean') { properties.speaks = { boolean: S.bool(p.tts) }; }
        return { instanceId: p.id, properties: properties };
    });
}

/**
 * The pipeline a call runs in: `id`, the one its `pipeline` argument names,
 * or else the watch app's own choice (undefined for Home Assistant's
 * preferred one); and `named`, the argument itself, or '' without one. A
 * name not on the list is an INVALID_ARGS error.
 */
function choose(opts, args) {
    var named = args.pipeline;
    if (named === undefined || named === null || named === '') {
        return { id: options.pipeline(opts), named: '' };
    }
    var known = typeof named === 'string' && listed(opts).some(function(p) { return p.id === named; });
    if (!known) {
        throw new PluginError('INVALID_ARGS', 'pipeline must be the instanceId of one from agent/pipeline');
    }
    return { id: named, named: named };
}

module.exports = {
    instances: instances,
    choose: choose
};
