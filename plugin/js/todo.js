/**
 * Shared to-do lists as reminder lists for Index, the Pebble app's
 * assistant.
 *
 * Index offers a plugin as a place for reminders and list items when it has
 * a create_reminder action and a reminders/configured source. It asks
 * reminders/configured whether the plugin is ready, and reminders/list for
 * the lists to pick from by name, with only three seconds for each answer,
 * so both are answered from what is stored on the phone. Only the to-do
 * lists the wearer shared are offered, in the order they were shared.
 *
 * A face or app can also read how many items are open on each list, and
 * the first few of them, which do need Home Assistant.
 */
var ha = require('ha');
var options = require('options');
var entities = require('entities');

var PluginError = ha.PluginError;
var S = entities.shapes;

//! Home Assistant's own bits for what a to-do list can do
var FEATURE = { create_item: 1, due_date: 16, due_datetime: 32 };
//! How many open items `items` lists
var ITEMS_SHOWN = 5;

function invalid(message) {
    return new PluginError('INVALID_ARGS', message);
}

/** The shared to-do lists, in the order they were shared */
function listIds(opts) {
    return options.exposedIds(opts).filter(function(id) { return entities.domainOf(id) === 'todo'; });
}

/**
 * Whether create_reminder would work: Home Assistant is set up and a to-do
 * list is shared. Like agent/configured, it answers before set up.
 */
function configured(conn, opts) {
    return {
        validUntilMs: Date.now() + 300000,
        instances: [{
            instanceId: 'todo',
            properties: {
                configured: { boolean: S.bool(!!conn && listIds(opts).length > 0) },
                name: { shortText: S.shortText('To-do lists') }
            }
        }]
    };
}

//! "todo.shopping_list" -> "Shopping list", for a list shared without a name
function fallbackName(id) {
    return entities.humanize(id.split('.')[1]);
}

//! Whether the caller wants `name`. A caller that names no properties wants them all.
function wants(request, name) {
    var names = request && request.properties;
    return !Array.isArray(names) || names.indexOf(name) !== -1;
}

/**
 * The first few open items of each list, by entity_id, in one call for all
 * of them. Home Assistant before 2024.8 cannot answer a service over REST
 * and refuses the call, and one list it cannot reach (Google Tasks offline)
 * fails it for all of them; the lists are then served without their items.
 * Only a refused token fails the source.
 */
function openItems(conn, ids) {
    return ha.callServiceForResponse(conn, 'todo', 'get_items', { entity_id: ids, status: 'needs_action' })
        .then(function(response) {
            var byId = {};
            ids.forEach(function(id) {
                var items = response[id] && Array.isArray(response[id].items) ? response[id].items : [];
                byId[id] = items.map(function(item) { return item && item.summary; })
                    .filter(function(summary) { return typeof summary === 'string' && summary; });
            });
            return byId;
        }, function(err) {
            if (err instanceof PluginError && err.code === 'AUTH_REQUIRED') { throw err; }
            return {};
        });
}

/**
 * One instance per shared to-do list. Names alone, all Index asks for, come
 * from the settings as the watch app last saw them; the open items need
 * Home Assistant, and a list it no longer has is then left out.
 */
function lists(conn, opts, request) {
    var ids = listIds(opts);
    if (!wants(request, 'count') && !wants(request, 'items')) {
        var names = options.sharedNames(opts);
        return Promise.resolve(ids.map(function(id) {
            return {
                instanceId: id,
                properties: { name: { shortText: S.shortText(names[id] || fallbackName(id)) } }
            };
        }));
    }
    if (ids.length === 0) { return Promise.resolve([]); }
    return ha.getStates(conn, ids).then(function(states) {
        var found = ids.filter(function(id) { return states[id]; });
        // The state is the number of open items, so only the items themselves are asked for
        // An unavailable list would fail the call for all of them
        var readable = found.filter(function(id) {
            return states[id].state !== 'unavailable' && states[id].state !== 'unknown';
        });
        var reading = wants(request, 'items') && readable.length > 0 ? openItems(conn, readable) : Promise.resolve({});
        return reading.then(function(itemsById) {
            return found.map(function(id) { return toInstance(states[id], itemsById[id]); });
        });
    });
}

function toInstance(entity, items) {
    var props = { name: { shortText: S.shortText(entities.nameOf(entity)) } };
    var count = Number(entity.state);
    if (/^\d+$/.test(String(entity.state)) && isFinite(count)) {
        props.count = { numericValue: S.numeric(count), shortText: S.shortText(String(count)) };
    }
    if (items) {
        props.items = { longText: S.longText(items.slice(0, ITEMS_SHOWN).join('\n')) };
    }
    return { instanceId: entity.entity_id, properties: props };
}

function hasFeature(entity, bit) {
    var features = (entity.attributes || {}).supported_features;
    return typeof features === 'number' && (features & bit) !== 0;
}

/**
 * Add an item to a shared to-do list. A due time is kept as the list
 * allows: with its time, as a date only, or not at all. Home Assistant
 * refuses the whole item when a list is given a due date it cannot keep,
 * so one it cannot keep is left off and the reply says so. Home Assistant's
 * lists have no reminders of their own, so notify_before_ms is ignored.
 */
function createReminder(conn, opts, args) {
    var title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title) { return Promise.reject(invalid('title is required')); }

    var due = null;
    if (args.due_iso !== undefined && args.due_iso !== null) {
        var parts = typeof args.due_iso === 'string' &&
            /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(args.due_iso);
        if (!parts || isNaN(Date.parse(args.due_iso))) {
            return Promise.reject(invalid('due_iso must be an ISO 8601 date and time'));
        }
        due = { iso: args.due_iso, date: parts[1], time: parts[2] };
    }

    var shared = listIds(opts);
    var id = args.instanceId;
    if (id === undefined || id === null || id === '') {
        if (shared.length === 0) {
            return Promise.reject(new PluginError('PERMISSION_DENIED', 'No to-do list is shared with other apps'));
        }
        id = shared[0];
    } else if (typeof id !== 'string' || !/^todo\.[a-z0-9_]+$/.test(id)) {
        return Promise.reject(invalid('instanceId must be a to-do list from reminders/list'));
    } else if (shared.indexOf(id) === -1) {
        return Promise.reject(new PluginError('PERMISSION_DENIED', id + ' is not shared with other apps'));
    }

    return ha.getStates(conn, [id]).then(function(states) {
        var entity = states[id];
        if (!entity) {
            throw new PluginError('PLUGIN_UNAVAILABLE', id + ' is not in Home Assistant');
        }
        var name = entities.nameOf(entity);
        if (!hasFeature(entity, FEATURE.create_item)) {
            throw invalid(name + ' cannot take new items');
        }
        var data = { entity_id: id, item: title };
        var text = 'Added ' + title + ' to ' + name + '.';
        if (due && hasFeature(entity, FEATURE.due_datetime)) {
            data.due_datetime = due.iso;
            text = 'Added ' + title + ' to ' + name + ', due ' + due.date + ' ' + due.time + '.';
        } else if (due && hasFeature(entity, FEATURE.due_date)) {
            data.due_date = due.date;
            text = 'Added ' + title + ' to ' + name + ', due ' + due.date + '.';
        } else if (due) {
            text = 'Added ' + title + ' to ' + name + ', without a due date: the list cannot keep one.';
        }
        return ha.callService(conn, 'todo', 'add_item', data).then(function() {
            return { text: text, refreshed: ['reminders/list', 'home/entity'] };
        });
    });
}

module.exports = {
    configured: configured,
    lists: lists,
    createReminder: createReminder
};
