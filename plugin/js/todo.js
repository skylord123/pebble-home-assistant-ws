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
 */
var ha = require('ha');
var options = require('options');
var entities = require('entities');

var PluginError = ha.PluginError;
var S = entities.shapes;

//! Home Assistant's own bits for what a to-do list can do
var FEATURE = { create_item: 1, due_date: 16, due_datetime: 32 };

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

/** One instance per shared to-do list, named as the watch app last saw it */
function lists(opts) {
    var names = options.sharedNames(opts);
    return listIds(opts).map(function(id) {
        return {
            instanceId: id,
            properties: { name: { shortText: S.shortText(names[id] || fallbackName(id)) } }
        };
    });
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
