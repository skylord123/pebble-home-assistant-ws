/**
 * Values the wearer writes in the settings page: a name, a Home Assistant
 * template and, if they like, a unit. Each is an instance of `home/value`,
 * whose id the page gave it, in the wearer's order.
 *
 * Callers never send a template; only the ones saved in the settings are
 * rendered. They are rendered together in one POST /api/template, each
 * captured in a block of its own and handed back as JSON. One template that
 * fails fails the whole render, so then each is rendered on its own to find
 * which, and one found failing is rendered on its own from then on, until
 * it renders again.
 */
var ha = require('ha');
var store = require('store');
var options = require('options');
var entities = require('entities');

//! How long rendered values are reused. Polls of several faces in a row
//! share one render.
var CACHE_MS = 15000;
//! Complication faces show 16 to 24 characters; the rest is in longText
var SHORT_MAX = 24;

var shapes = entities.shapes;

/**
 * One template that renders every one of `templates`, each in a block of its
 * own so a `set` in one cannot reach another, as a JSON object by position
 */
function wrap(templates) {
    var blocks = templates.map(function(template, i) {
        return '{% set pebble_value_' + i + ' %}' + template + '{% endset %}';
    });
    var keys = templates.map(function(template, i) {
        return '"' + i + '": pebble_value_' + i;
    });
    return blocks.join('') + '{{ {' + keys.join(', ') + '} | tojson }}';
}

/** Render them in one request: resolves their texts, trimmed, in order */
function renderTogether(conn, templates) {
    return ha.request(conn, 'POST', '/api/template', { template: wrap(templates) }).then(function(out) {
        if (!out || typeof out !== 'object') {
            throw new ha.PluginError('UNKNOWN', 'Home Assistant did not render the values');
        }
        return templates.map(function(template, i) {
            var text = out[i];
            return text === undefined || text === null ? '' : String(text).trim();
        });
    });
}

//! What Home Assistant said was wrong with a template, without its preamble
function reasonOf(err) {
    var reason = String(err.reason || err.message || '').replace(/^Error rendering template:\s*/i, '');
    return reason || 'Home Assistant could not render it';
}

/**
 * Render one template: resolves `{ text }`, or `{ error }` when Home
 * Assistant could not render it. Anything else (a refused token, an
 * unreachable host) rejects.
 */
function renderOne(conn, template) {
    return renderTogether(conn, [template]).then(function(texts) {
        return { text: texts[0] };
    }, function(err) {
        if (err && err.code === 'INVALID_ARGS') { return { error: reasonOf(err) }; }
        throw err;
    });
}

/**
 * Render the templates, reusing a render of the same templates from the last
 * few seconds.
 * @returns {Promise<Array>} `{ text }` or `{ error }` for each, in order
 */
function render(conn, templates) {
    var print = ha.fingerprint(JSON.stringify(templates));
    var cached = store.fresh('values', CACHE_MS);
    if (cached && cached.print === print) { return Promise.resolve(cached.results); }

    var broken = store.get('values_broken') || {};
    var together = [];
    var alone = [];
    templates.forEach(function(template, i) {
        (broken[ha.fingerprint(template)] ? alone : together).push(i);
    });

    var results = [];
    var combined = together.length < 2 ? Promise.resolve(together)
        : renderTogether(conn, together.map(function(i) { return templates[i]; })).then(function(texts) {
            together.forEach(function(index, k) { results[index] = { text: texts[k] }; });
            return [];
        }, function(err) {
            // One of them failed the lot; each on its own finds which
            if (!err || err.code !== 'INVALID_ARGS') { throw err; }
            return together;
        });

    return combined.then(function(rest) {
        var each = alone.concat(rest);
        if (each.length === 0) { return; }
        var one = function(index) {
            return renderOne(conn, templates[index]).then(function(result) { results[index] = result; });
        };
        // One first and the rest after, as getStates does: a bad token is
        // then refused once, not once for every value
        return one(each[0]).then(function() {
            return Promise.all(each.slice(1).map(one));
        });
    }).then(function() {
        var failing = {};
        var anyFailing = false;
        templates.forEach(function(template, i) {
            if (results[i].error !== undefined) {
                failing[ha.fingerprint(template)] = true;
                anyFailing = true;
            }
        });
        store.set('values_broken', anyFailing ? failing : null);
        store.remember('values', { print: print, results: results });
        return results;
    });
}

function shortened(text) {
    return text.length > SHORT_MAX ? text.slice(0, SHORT_MAX - 1) + '…' : text;
}

/** The instance for one value, from what its template rendered */
function toInstance(def, result) {
    var props = { name: { shortText: shapes.shortText(def.name), longText: shapes.longText(def.name) } };
    if (def.unit) { props.unit = { shortText: shapes.shortText(def.unit) }; }
    if (result.error !== undefined) {
        props.state = { shortText: shapes.shortText('Error'), longText: shapes.longText('Error') };
        props.error = { longText: shapes.longText(result.error) };
        return { instanceId: def.id, properties: props };
    }
    var value = entities.parseNumber(result.text);
    var text = value !== null && def.unit ? entities.withUnit(result.text, def.unit) : result.text;
    props.state = { shortText: shapes.shortText(shortened(text)), longText: shapes.longText(text) };
    if (value !== null) {
        // A percentage fills a gauge; anything else has no range to fill
        props.state.numericValue = def.unit === '%'
            ? shapes.numeric(value, '%', 0, 100) : shapes.numeric(value, def.unit);
    }
    return { instanceId: def.id, properties: props };
}

/** Every value the wearer defined, rendered; none at all asks nothing */
function instances(conn, opts) {
    var defs = options.values(opts);
    if (defs.length === 0) { return Promise.resolve([]); }
    var templates = defs.map(function(def) { return def.template; });
    return render(conn, templates).then(function(results) {
        return defs.map(function(def, i) { return toInstance(def, results[i]); });
    });
}

/**
 * One template rendered for the settings page, exactly as `home/value`
 * would serve it: resolves `{ result, text }` (the rendered text, and the
 * state other apps get), or `{ error }`
 */
function preview(conn, template, unit) {
    return renderOne(conn, template).then(function(result) {
        if (result.error !== undefined) { return result; }
        var instance = toInstance({ id: 'preview', name: 'preview', unit: unit || '' }, result);
        return { result: result.text, text: instance.properties.state.longText.text };
    });
}

/** Drop the rendered values, so the next read renders them again */
function forget() {
    store.set('values', null);
}

module.exports = {
    instances: instances,
    preview: preview,
    forget: forget,
    wrap: wrap
};
