/**
 * NavRoute - remembers which pages are open, so a new JS can open them again
 *
 * The phone app throws this JS away whenever the watch loses it, even for a
 * moment, and starts a new copy once the watch is back. The app never closed
 * on the watch, but every page the wearer had open was only ever known here,
 * so the new copy could only start again from the main menu.
 *
 * Each page that can be opened from plain data (an entity id, an area, a
 * list of ids) is wrapped here under a name. The window it puts up is tagged
 * with that name and the arguments, and the open windows' tags are kept in
 * localStorage, which survives the restart. Opening them again is calling
 * the same functions with the same arguments, in order.
 *
 * A window nobody tagged, such as a dialog or an editor, ends the route: what
 * was opened on top of it depended on more than its tag could say.
 */
var WindowStack = require('ui/windowstack');
var Menu = require('ui/menu');
var helpers = require('app/helpers');

var NavRoute = {};

var STORAGE_KEY = 'nav_route';
// How long a page that loads before it shows anything may take
var PENDING_MS = 10000;

var openers = {};
// The page being opened whose window has not come up yet. The outermost one
// wins: favourites opening an entity list is still favourites.
var pending = null;
var depth = 0;
var restoring = false;
var saveTimer = null;
// Scrolling moves the highlight many times a second
var SELECTION_SAVE_DELAY_MS = 1000;
var selectionTimer = null;

function serialize(args) {
    for (var i = 0; i < args.length; i++) {
        if (typeof args[i] === 'function') { return null; }
    }
    try {
        return JSON.parse(JSON.stringify(args));
    } catch (e) {
        return null;
    }
}

function save() {
    saveTimer = null;
    if (restoring) { return; }
    var routes = [];
    var items = WindowStack._items;
    for (var i = 0; i < items.length; i++) {
        var route = items[i]._navRoute;
        if (!route || !route.name) { break; }
        var kept = { name: route.name, args: route.args };
        var selection = items[i] instanceof Menu ? items[i]._selection : null;
        if (selection && (selection.sectionIndex || selection.itemIndex)) {
            kept.selection = [selection.sectionIndex || 0, selection.itemIndex || 0];
        }
        routes.push(kept);
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now(), routes: routes }));
    } catch (e) {
        helpers.log_message('NavRoute: could not save: ' + e);
    }
}

function scheduleSave() {
    if (saveTimer) { return; }
    saveTimer = setTimeout(save, 0);
}

WindowStack.on('show', function(e) {
    var window = e && e.window;
    // Only a window pushed on top is the one being opened: going back
    // shows the one underneath again. Windows are reused, so a window opened
    // again for something else takes the new tag.
    if (pending && window && window === WindowStack.top() &&
        WindowStack.length() > pending.height) {
        if (Date.now() - pending.at <= PENDING_MS) {
            window._navRoute = pending.route;
        }
        pending = null;
    }
    scheduleSave();
});
WindowStack.on('hide', scheduleSave);
Menu.onSelectionChange = function() {
    if (selectionTimer) { clearTimeout(selectionTimer); }
    selectionTimer = setTimeout(function() {
        selectionTimer = null;
        scheduleSave();
    }, SELECTION_SAVE_DELAY_MS);
};

/**
 * Wrap a page's open function so the window it puts up is tagged with
 * `name` and the arguments it was called with. Arguments that cannot be kept
 * (callbacks) mark the window as one that cannot be opened again.
 */
NavRoute.wrap = function(name, fn) {
    var wrapped = function() {
        var outer = depth === 0;
        if (outer) {
            // Whatever an earlier page was still loading has been left behind
            var kept = serialize(Array.prototype.slice.call(arguments));
            pending = {
                at: Date.now(),
                height: WindowStack.length(),
                route: kept ? { name: name, args: kept } : { name: null }
            };
        }
        depth++;
        try {
            return fn.apply(this, arguments);
        } finally {
            depth--;
        }
    };
    openers[name] = wrapped;
    return wrapped;
};

function load() {
    try {
        var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        // A new JS taking over is the only thing that reads this, and the
        // first window anything opens saves over what came before, so the
        // route is always from the app as it is open on the watch now
        if (saved && Array.isArray(saved.routes) && saved.routes.length) {
            return saved.routes;
        }
    } catch (e) { /* nothing usable */ }
    return null;
}

/** Whether there is anything to open again. */
NavRoute.available = function() {
    return !!load();
};

/**
 * Open the remembered pages again, one after the other, each once the one
 * before has come up. `done(count)` gets how many came back; anything that
 * fails or no longer exists ends it there, on the page before.
 */
NavRoute.restore = function(done) {
    var routes = load() || [];
    var index = 0;
    var timer = null;
    var waiting = null;
    restoring = true;

    function stopWaiting() {
        if (waiting) { WindowStack.off('show', waiting); waiting = null; }
        if (timer) { clearTimeout(timer); timer = null; }
    }

    function finish() {
        stopWaiting();
        restoring = false;
        pending = null;
        helpers.log_message('NavRoute: reopened ' + index + ' of ' + routes.length + ' pages');
        save();
        done(index);
    }

    // Put the highlight back where it was on a page that came up
    function reselect(route) {
        var window = WindowStack.top();
        if (route.selection && window instanceof Menu) {
            window.selection(route.selection[0], route.selection[1]);
        }
    }

    function next() {
        if (index > 0) { reselect(routes[index - 1]); }
        if (index >= routes.length) { return finish(); }
        var route = routes[index];
        var opener = openers[route.name];
        if (!opener) { return finish(); }
        var height = WindowStack.length();
        try {
            opener.apply(null, route.args || []);
        } catch (e) {
            helpers.log_message('NavRoute: could not reopen ' + route.name + ': ' + ((e && e.message) || e));
            return finish();
        }
        if (WindowStack.length() > height) {
            index++;
            return setTimeout(next, 0);
        }
        // A page that loads first comes up later, or not at all
        waiting = function() {
            if (WindowStack.length() > height) {
                stopWaiting();
                index++;
                setTimeout(next, 0);
            }
        };
        WindowStack.on('show', waiting);
        timer = setTimeout(finish, PENDING_MS);
    }

    next();
};

module.exports = NavRoute;
