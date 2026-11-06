# Settings page

The watch app's settings page lives in this folder, one file per version
(`v1.8.html` is current; `src/js/app/Constants.js` names the version in
`confVersion`). Each file is self-contained: no scripts, stylesheets or images
are loaded from anywhere else. That is what lets one file serve two very
different homes.

## Two ways the page is opened

**Hosted.** Pushes to `master` and `dev` deploy this folder to GitHub Pages,
and the classic Pebble/Rebble phone apps open the page from there when the gear
icon is tapped (`Constants.configPageUrl`). The settings arrive in the URL hash as a JSON
object, and Save hands the edited object back through `pebblejs://close#…`,
which closes the page. Nothing about this flow changed with v1.6.

**Bundled.** Newer Core Devices Pebble apps read `configPage` from the pbw's
`appinfo.json` and open that file straight from the pbw, without any network.
The build puts the current page there as `config.html`
(`waftools/bundle_config_page.py`, run after `pebble build` zips the pbw).
While the page is open it can talk to the watch app's JS, so it can test a
connection, search entities and save without closing. The phone runs the page
from a `data:` URL, so `localStorage` is unavailable and relative paths do not
resolve. As of app 1.16 this only happens with **Plugins / permissions
preview** turned on (Settings → Plugins); otherwise the phone opens the
hosted page.

The page decides which mode it is in by whether the phone injected a `Pebble`
object with `sendMessage`. A phone app that does not know about bundled pages
ignores the `configPage` key and the extra file, and everything works as
before.

## Protocol between the page and the watch app

The page sends `Pebble.sendMessage('pkjs', request)` and awaits the reply. On
the watch app side `src/js/app/ConfigBridge.js` receives it as a
`configmessage` event and answers with `e.respond(reply)`. Every request is an
object with a `type`; every reply is `{ ok: true, … }` or
`{ ok: false, error: { code, message } }`. When the watch app is not reachable
the phone answers instead with a bare `{ error: "…" }`, which the page treats
the same way.

| Request | Reply |
| --- | --- |
| `{ type: 'get_settings' }` | `{ ok, app_version, conf_version, settings, status }`. `settings` is the whole options object, the same shape the hosted page reads from its hash. |
| `{ type: 'get_status' }` | `{ ok, status }` |
| `{ type: 'save_settings', settings }` | `{ ok }`. Merges `settings` into the stored options and applies them, exactly as closing the hosted page does. Needs `ha_url` and `token`. |
| `{ type: 'connect', ha_url, token }` | `{ ok, ha_version }` or an error. Tries the pair on a throwaway connection and only saves them, and reconnects the app, once Home Assistant has accepted them. Error codes: `bad_url`, `missing_token`, `auth_invalid`, `unreachable`, `timeout`. |
| `{ type: 'get_logs' }` | `{ ok, text, lines, previous_lines }`. The app's recent log as one text: a header with versions and platforms, the tail of the previous run, then this run. The instance URL and token are already replaced with `<redacted>`. The page shows it and copies it to the clipboard; the phone's WebView cannot save files. |
| `{ type: 'clear_logs' }` | `{ ok }` |
| `{ type: 'search_entities', query, limit }` | `{ ok, results: [{ entity_id, name, state, domain }], total }`. Every word of `query` must appear in the name or id. `limit` defaults to 30 and is capped at 100. `not_loaded` until the states have arrived from Home Assistant. |

Any request can also fail with `unknown_type`, `bad_request` or `internal` (the
handler threw; the message says what).

The watch app also pushes at the page, without being asked, with
`Pebble.sendConfigMessage(…)`; the page receives it as a `message` event:

```js
{ type: 'status', status, settings }
```

`status` is `{ phase, connected, ha_url, ha_version, states_loaded,
entity_count, error }`, where `phase` is one of `unconfigured`, `connecting`,
`connected` or `auth_failed`, and `error` is `null` or `{ code, message }` for
the last thing that went wrong (`auth_invalid`, `unreachable`, `disconnected`),
cleared when a connection authenticates. `settings` carries only the values the watch app
fills in itself and the page needs while open: `ha_connected`,
`available_pipelines`, `available_calendars` and `selected_pipeline`. A push
goes out whenever the connection changes state and when the states, pipelines
and calendars have been fetched, so a page opened before the first connection
fills its dropdowns as soon as Connect succeeds.

From v1.8 the page also talks to the plugin (`plugin/`), when the phone has
plugins turned on: `Pebble.sendMessage('plugin', { type: 'status' })` to show
whether other apps can reach Home Assistant, and `{ type: 'refresh' }` after a
save so they pick up a changed list of shared entities. The phone fires
`ready` with `{ target: 'plugin' }` once the plugin can be reached. See
`plugin/README.md`.

The phone can also open the bundled page with no watch app behind it, from
its Plugins tab or from an Index destination. `Pebble.targets()` then lists
only `plugin`, and the page sends `get_settings`, `save_settings`, `connect`
and `search_entities` to the plugin instead, which answers them from the
stored settings and Home Assistant's REST API (`plugin/js/page.js`). The
watch app reads the saved settings the next time it starts. The app log is
the watch app's own, so it is hidden in this mode. If the watch app starts
while the page is open, the page sends everything after that to the watch
app.

## Releasing a new version

GitHub Pages serves every page that is on `master` from `master`, and takes
only the pages `master` does not have yet from `dev`. Once a page has shipped
it is frozen, because every installed copy of that release keeps opening it by
name: an option added to it would show up for apps that cannot use it (#104).
So the first change to the page after a release copies it to the next version,
points `confVersion` and `configPageUrl` at the new file, and makes the changes
there. The deploy warns when a released page differs on `dev`.

## Working on the page

Open `config/v1.8.html` in a browser with the settings in the hash to work on
the hosted mode, e.g.

```
file:///…/config/v1.8.html#%7B%22ha_url%22%3A%22https%3A%2F%2Fha.example.com%22%7D
```

Save then navigates to `pebblejs://close#…`, which a browser cannot open;
`?return_to=<url>#` in the query string sends it to that URL instead, which is
also what `pebble emu-app-config` does.

For the bundled mode, define a `window.Pebble` before the page's script runs
that offers `sendMessage(target, message)` returning a Promise,
`addEventListener('ready' | 'message', cb)`, and fires `ready` with
`{ target: 'pkjs' }`. The page then behaves exactly as it does on the phone.
