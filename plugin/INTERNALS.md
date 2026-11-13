# Plugin internals

This page is for people working on the plugin itself: how it is built, how
it runs on the phone, what it caches, and the details behind each source and
action. To use the plugin from a watchface or app, start with the
[developer guide](README.md).

The plugin lets other watchfaces and apps read Home Assistant through this
app, and control it, using the Core Devices plugin system. That system is a
preview: the Pebble app only runs plugins with **Plugins / permissions
preview** turned on (Settings → Plugins), and only from pbws whose
`appinfo.json` has `"manifestVersion": 2`.

The plugin serves three things:

- the entities the wearer chooses to share, through **Expose to Plugins** on an
  entity's page on the watch or **Shared with Other Apps** in the settings page,
  and the upcoming events of the calendars among them;
- values the wearer writes as Home Assistant templates under **Custom values**
  in the settings page;
- every `weather.*` entity, which is always shared.

Anything that has not been shared is left out of every source, and an action
on it is refused with `PERMISSION_DENIED`.

## How it is built

- `plugin/js/` is a separate bundle. It is built with the same module loader as
  the app (`wscript`, `concat_javascript`) and written to
  `build/plugin/plugin.js`.
- `plugin/bundle.json` names files from the app that the bundle also takes,
  each as a module: `speech-codec` is `src/js/app/speech-codec.js`, so the
  plugin speaks with the same code as the app. The tests read the same file.
- `plugin/manifest.json` becomes the `plugin` block of the pbw's
  `appinfo.json`.
- The permissions are those the whole app declares in `appinfo.json`
  (`usesPermissions`), since the plugin shares the app's UUID. A
  `usesPermissions` inside the plugin block is ignored. `Internet` is
  declared without domains because the Home Assistant address is the
  wearer's own; an address on the local network needs `LocalNetwork`.
- `waftools/bundle_config_page.py` adds the script and the manifest to the pbw
  after `pebble build` has zipped it. The build log says
  `Bundled the plugin into build/…pbw as plugin.js`.
- Phone apps that do not know about plugins ignore both.

The phone starts a fresh JS engine for every request and stops it once the
plugin answers, or after 20 seconds. There are no timers, and a WebSocket
closes when the request that opened it ends, so nothing can stay connected to
Home Assistant between requests. Everything goes over the REST API, which
reuses the phone's open connection, except `ask_assistant`, `transcribe`
and the hourly statistics behind `history`: REST cannot reach them, so those
open a WebSocket, log in, send one command and close (`js/ws.js`). Speech does the
same once an hour to look up the pipeline's voice. The plugin reads the same
`localStorage` as the watch app (same
UUID):

| What it reads | Where it comes from |
| --- | --- |
| URL, token, shared list, assistant switch | the `options:<uuid>` object the settings page saves, through the watch app or, when it is not running, through the plugin |
| Weather entity list | `plugin_weather_entities`, which the watch app writes once it has the states |

Before the watch app has written the weather list, the plugin finds the
weather entities itself and caches them for an hour.

Everything the plugin caches is stored under a `plugin:` prefix:

- entity states, for 10 s each;
- rendered custom values, for 15 s;
- forecasts, for 15 min, per weather entity;
- calendar events, for 5 min, per calendar;
- sensor history, for 5 min;
- the entities' areas, for an hour;
- the engine, voice and language of each pipeline speech was asked in, for
  an hour (see [Speech](#speech));
- a marker for a token Home Assistant refused, so a bad token is not retried
  on every poll. Every refused attempt counts towards Home Assistant's IP ban.
  - While the marker is set, the plugin answers `AUTH_REQUIRED` without asking
    Home Assistant.
  - The token is tried again after 30 minutes, when it changes, or when the
    settings page checks the plugin.
  - Only a 401 from `/api/`, or `auth_invalid` on the WebSocket, sets the
    marker. A 401 on a service call (an admin-only service, for example)
    comes back as `PERMISSION_DENIED`.
  - A poll that has to fetch several entities fetches one first, so a bad
    token is refused once and not once per entity.
- a marker for a Home Assistant that could not be reached. For 30 seconds
  after, the plugin answers `PLUGIN_UNAVAILABLE` without trying: the phone
  runs one request at a time, and a host that never answers would hold each
  poll, and any action behind them, for the full 20 seconds. The settings
  page checking the plugin clears it.

An address the wearer has not allowed is answered with `PERMISSION_DENIED`
and a line saying to allow it, on Pebble apps from 1.17. Earlier ones fail
it the same way as a host that is down, so `PLUGIN_UNAVAILABLE` names both.

On Android the Pebble app rewrites this `localStorage` from the watch app's
own copy when the watch app's JS stops, so anything cached here while the
watch app was running can be lost. The caches only cost a fetch when that
happens. The token marker is also kept in `Pebble.secureStorage`, which the
rewrite does not touch, and put back from there.

The plugin never logs the URL or the token. It never uses the lock and alarm
codes the watch app remembers; a code has to come from the caller.

## Sources

Every source requires `Location` of the app reading it, as explained under
[The watch's own weather](#the-watchs-own-weather).

In the `home/*` sources, every entity is an instance whose `instanceId` is
its `entity_id`, in the order the wearer shared them. Every instance
includes these properties:

- `name`;
- `last_changed` and `last_updated`, as timestamps;
- `supported_features`, Home Assistant's own bits for what the entity can do
  (for a cover, 1 open, 2 close, 4 set position, 8 stop), when it has them;
- `room`, the name of the entity's area in Home Assistant, or of its
  device's when the entity has none of its own, as short text. The Google
  Home plugin uses the same name. An entity in no area has no `room`.

The areas of every entity a source serves come from one template, kept for
an hour, and only for a request that names `room` in its `properties` or
names no properties at all. Home Assistant only renders templates for an
administrator's token; with any other, or if the template fails, the
instances come without `room` and the template is not tried again for ten
minutes.

| Source | Domains | Other properties |
| --- | --- | --- |
| `home/entity` | everything shared, plus weather | `state`, `on`, `domain`, `history` (see below) |
| `home/light` | light | `on`, `brightness`, `color_temp`, `color_modes` (comma separated; `onoff` alone means it cannot dim) |
| `home/switch` | switch, input_boolean, fan, automation, siren, humidifier, remote | `on`, `speed` |
| `home/sensor` | sensor, number, input_number, counter | `value`, `device_class`, `history` (see below) |
| `home/binary_sensor` | binary_sensor | `on`, `state` (e.g. Open/Closed by device class), `device_class` |
| `home/climate` | climate, water_heater | `current_temperature`, `target_temperature` (their `numericValue` in Home Assistant's temperature unit, read from its configuration once a day), `target_temp_low` and `target_temp_high` (heat_cool), `temperature_step`, `on`, `hvac_mode`, `hvac_modes` (comma separated, as Home Assistant names them), `hvac_action`, `summary` |
| `home/cover` | cover, valve | `open`, `position`, `state` |
| `home/lock` | lock | `locked`, `state` |
| `home/media_player` | media_player | `on`, `playing`, `state`, `title`, `artist`, `volume` |
| `home/person` | person, device_tracker | `home`, `zone`, `since` (never coordinates) |
| `home/scene` | scene, script, button, input_button | `running`, `last_run` |
| `home/alarm` | alarm_control_panel | `armed`, `state` |
| `calendar/event` | calendar | `location`, `starts_at`, `ends_at`, `all_day`, `calendar`: the upcoming events of the shared calendars, as the phone's own calendar gives them (see below). |
| `home/value` | none: the wearer's custom values | `state`, `unit`, `error` (see below) |
| `agent/configured` | none | `configured`: whether `send_to_agent` would work (see below). One instance, `assistant`. |
| `agent/pipeline` | none: the pipelines the watch app saved (`available_pipelines`) | `name`, `listens` and `speaks` (whether it has speech-to-text and text-to-speech; left out when the saved entry does not say), `preferred`, `selected` (the watch app's choice, or the preferred one). One instance per pipeline, its id the pipeline's. |
| `reminders/configured` | none | `configured`: whether `create_reminder` would work (see below). One instance, `todo`. |
| `reminders/list` | todo | `name`, `count` (open items) and `items` (the first five open ones, one a line). The shared to-do lists, for `create_reminder`. |
| `weather/location` | weather | `temperature`, `feels_like`, `high`, `low`, `condition`, `condition_code`, `uv_index`, `precipitation`, `humidity`, `wind_speed`, `wind_direction`, and the series below; the wearer's locations also `sunrise`, `sunset` |

`history` is the last day of a number, for drawing a graph: a series
`{ start, stepSec, numericValue: { values, unit, min?, max? } }` of 24
values, one an hour, oldest first. The last value is the hour under way,
and `start` is the beginning of the hour 23 hours before it. The unit and
range are those of `value` (or `state`).

- Each value is the hour's average, weighted by how long each state held,
  so a sensor that did not change all hour still has its value there.
  States that are not numbers (unavailable, unknown) are left out of the
  average, and an hour with nothing else is `null`.
- Only instances whose `value` (or `state`) is a number right now have it,
  and only when Home Assistant's recorder has some of their history.
- It is only built for a request that names `history` in its `properties`.
  A request that names no properties (Index reads everything) does not get
  it, to keep its answer small and save Home Assistant the work.
- A sensor with a `state_class` gets its hours from Home Assistant's
  long-term statistics, a few numbers an hour however often it changes.
  Statistics only cover finished hours, so its last value is its value now.
  One WebSocket command covers every such sensor the source serves.
- Any other sensor gets its hours from its state changes, in one REST
  history call. A sensor that changes every second has tens of thousands of
  those in a day, so one call asks for at most 5 sensors, and the rest get
  theirs on the polls after.
- The values are kept 5 minutes, or until the hour turns. If Home Assistant
  cannot give the statistics or the history, the sensors are served without
  them (the statistics fall back to the history), and that call is not tried
  again for 5 minutes. A WebSocket that cannot connect, as behind a proxy
  that refuses them, does not make the plugin count Home Assistant as down.

### Custom values

`home/value` serves the values the wearer writes in the settings page, each
a name, a Home Assistant template and an optional unit, such as "Doors open"
from `{{ states.binary_sensor | selectattr('attributes.device_class', 'eq',
'door') | selectattr('state', 'eq', 'on') | list | count }}`. Callers cannot
send templates of their own.

- There is one instance for each value, in the wearer's order, so a slot
  that reads the third instance keeps reading the same value. Its
  `instanceId` is an id the settings page gave the value, which stays the
  same when the value is renamed or edited. `name` is the wearer's name for
  it. Values have none of the entity properties.
- `state` is what the template rendered, with the unit after it when it is a
  number. A number also comes as a `numericValue` in that unit, from 0 to 100
  for `%`. `shortText` is cut to 24 characters; `longText` has it all.
- `unit` is there when the wearer gave one.
- A template Home Assistant cannot render reads `Error`, and `error` says
  why. The other values are not affected.
- All of them are rendered in one `POST /api/template`, each in a
  `{% set %}` block of its own, and handed back as JSON. When one fails the
  whole render fails, so each is then rendered on its own to find which; a
  failing one is rendered on its own after that, until it renders again.
- Home Assistant only renders templates for an administrator. With a token
  of a user who is not one, the source answers `PERMISSION_DENIED`.
- With no values defined the source answers no instances, without asking
  Home Assistant.

Notes on the weather source:

- `weather/location` has one instance per weather entity, after one for each
  of the wearer's weather locations near the home (see below).
- Like the phone's own weather, it also has series, each `{ start, stepSec,
  <shape>: { values: [...] } }` with `null` for a missing point:
  - `hourly_temperature`, `hourly_condition`, `hourly_condition_code`: today's
    and tomorrow's hours, one an hour, from today's local midnight. Hours
    already gone are `null`, since Home Assistant only forecasts ahead;
  - `daily_high`, `daily_low`, `daily_condition`, `daily_condition_code`,
    `daily_precipitation`: up to 7 days, starting at today's local midnight.
- Series are only built when the request asks for them by name in
  `properties`, or names no properties at all. Hourly forecasts are only
  fetched when an `hourly_*` property is asked for, and daily ones only when
  something comes from them.
- Forecasts are asked for one entity at a time, and only for the types the
  entity says it has. An entity with only twice-daily forecasts (the US
  National Weather Service) gets its high from the daytime half and its low
  from the night after.
- Temperatures follow the wearer's choice in the Pebble app
  (`preferences/units`) in their text. The `numericValue` stays in Home
  Assistant's own unit, which its `unit` names.
- `condition_code` uses the same words as the phone's own weather: `sun`,
  `partly_cloudy`, `light_rain` and so on.
- When the request gives an `iconPixelSize`, `condition` also comes as an
  `icon` (a black picture on a transparent ground) and an `image` (a white
  picture on a disc coloured for the weather), and `hourly_condition` and
  `daily_condition` as series of them. They are square, as large as fits the
  size asked for, and drawn by `js/icons.js`. A night hour gets the moon.
  Without `iconPixelSize` nothing is drawn.

The phone's built-in weather plugin also answers `weather/location`, and it
is asked first unless the wearer picks this app under **Preferred sources**
in the Pebble app. To get Home Assistant's weather either way, name this
app's UUID in the request:

```js
{ category: 'weather', item: 'location', plugin: '61ae3254-ce00-49db-aad8-23143f649b90' }
```

Notes on the calendar source:

- `calendar/event` serves the calendars the wearer shared (any `calendar.*`
  entity among the shared ones) the way the phone's own calendar source
  serves the phone's calendars, so a face or app made for that one shows
  Home Assistant's events instead when it asks for this plugin:
  - one instance per event, at most 10, from the next 7 days, soonest first.
    An event under way counts until it ends. Events starting at the same
    moment keep the order the calendars were shared in;
  - the `instanceId` is the event's place in that list, as there: `"0"` is
    always the next event;
  - `name` (the event's summary) and `location` as short and long text,
    `location` only when there is one;
  - `starts_at` as short and long text and a timestamp, `ends_at` as short
    text and a timestamp. The text is the time in the phone's time zone
    (`09:30`), or `All day`. A whole day runs from the phone's midnight to
    the next;
  - `all_day` as a boolean, and `calendar`, the calendar's name, as short
    text.
- Each calendar's events are fetched from Home Assistant at most every 5
  minutes. A calendar Home Assistant cannot read is left out, and the rest
  are still served.
- Like the phone's own calendar source, this one requires `Calendar` of the
  app reading it as well as `Location`. An app that reads calendars already
  declares it. The phone's own calendar is asked first, unless the wearer
  picks this app under **Preferred sources**; to get Home Assistant's
  calendars either way, name this app's UUID in the request:

```js
{ category: 'calendar', item: 'event', plugin: '61ae3254-ce00-49db-aad8-23143f649b90' }
```

Shared calendars are also plain entities under `home/entity`, whose `on`
says whether an event is under way.

### The watch's own weather

The plugin can also be the watch's own weather provider, for its Weather
app and timeline pins: pick this app under **Weather provider** in the
watch's settings in the Pebble app (Settings → Weather). The watch then
asks for an instance named after each of the wearer's weather locations.

- The plugin reads the wearer's weather locations
  (`preferences/weather_location`) and serves Home Assistant's weather for
  those within 25 km of the home, as Home Assistant's own settings place
  it. Anywhere further is left to the phone's own weather, so travelling
  still shows the right place.
- Each of those gets the weather of `weather.home`, or of the first weather
  entity when there is none, under the location's id and name. They come
  before the entities' own instances, as faces show the first instance.
- Each also has `sunrise` and `sunset` for today, and `daily_sunrise` and
  `daily_sunset`, worked out from the location's coordinates (`js/sun.js`),
  since Home Assistant's forecasts have neither.
- The watch takes nothing without a complete today and tomorrow. Where the
  daily forecast leaves out today, its high, low and condition come from the
  hours left in it and the current conditions.
- Locations are only read once the wearer has allowed this app their
  location, which the Pebble app asks at install. Until then, or on Pebble
  apps before 1.17, the plugin serves only the entities.

The Pebble app only lets a plugin read the wearer's locations if every one
of its sources and actions requires `Location` of its callers in turn, so
that nothing passes a location on to an app that was not allowed it. So
every app that reads or controls anything through this plugin needs
`Location` as well, and declares it in its `usesPermissions`:

```json
"Location"
```

The Pebble app's own callers (the watch's weather, Index) are not asked.

## Actions

Because the plugin can send data off the phone, the Pebble app asks the
wearer before any other app may call its actions at all. An app that calls
them declares that it will in its `usesPermissions`, along with `Location`
(see [The watch's own weather](#the-watchs-own-weather)), or its first call
waits for the wearer and is refused until they answer:

```json
"Location",
{ "name": "InvokeAction", "plugin": "61ae3254-ce00-49db-aad8-23143f649b90" }
```

Every entity action takes `instanceId`. Each action returns a line saying what
happened, and asks the sources that show that entity to refresh.

| Action | Does |
| --- | --- |
| `set_on` `{ on }` | On or off. For covers and valves, opens or closes them, and for media players plays or pauses (their `on` is whether they are playing). Locks only lock and alarm panels only arm (in `away`); turning them off is refused, as only `unlock` and `alarm_disarm` do that. Scenes and buttons can only be turned on (run, press); off stops a script. Takes the same arguments as the Hue plugin's action, whose `item` is accepted and not needed. |
| `toggle` | Toggles. A locked lock is refused (use `unlock`), and a closed garage door, gate or door is refused (use `open`). |
| `activate` | Runs a scene or script, presses a button, or triggers an automation. |
| `set_brightness` `{ percent }` | Sets a light's brightness. Like `set_on`, also takes the Hue plugin's `item`, which is not needed. |
| `set_temperature` `{ temperature }` or `{ target_temp_low, target_temp_high }` | Sets the target temperature, or the range for a thermostat that keeps one (heat_cool). |
| `set_hvac_mode` `{ hvac_mode }` | Sets the heating or cooling mode. |
| `set_position` `{ position }` | Sets a cover's position. A garage door, gate or door can only be closed (position 0). |
| `open` `{ code? }`, `close`, `stop` | Covers and valves. `open` also unlatches a lock. |
| `lock` `{ code? }`, `unlock` `{ code? }` | Locks and unlocks. |
| `alarm_arm` `{ mode?, code? }`, `alarm_disarm` `{ code? }` | Alarm panels. `mode` is `home`, `away` (the default), `night`, `vacation` or `custom_bypass`. |
| `set_playing` `{ playing }`, `next_track`, `previous_track`, `set_volume` `{ percent }` | Media players. |
| `call_service` `{ service, data? }` | Other services of the entity's own domain, called on that entity only. See below. |
| `ask_assistant` `{ text, new_conversation?, json?, conversation_id?, speak?, rate?, pipeline? }` | Asks Home Assistant's assistant and returns what it said. With `json`, returns JSON and keeps the caller's own conversation. With `speak`, also starts reading it out (see [Speech](#speech)). See below. |
| `send_to_agent` `{ message, chat_id? }` | The same, under the name Index looks for. `chat_id` is ignored. |
| `create_reminder` `{ title, due_iso?, timezone?, notify_before_ms?, instanceId? }` | Adds an item to a shared to-do list. See below. |
| `speak` `{ text, format, rate?, pipeline? }` | Says `text` in the assistant's voice, as audio for a watch app to play. Returns the first slice of it. See below. |
| `speak_next` `{ text, next, format, pipeline? }` | The next slice of that audio. |
| `transcribe` `{ audio, format, sample_rate?, pipeline? }` | What was said in a recording, as plain text. See [Hearing what was said](#hearing-what-was-said). |

Actions check the entity's `supported_features` first. Asking a window
that cannot be positioned to move to 40%, or a player that cannot skip to
skip, is refused with `INVALID_ARGS` and a line saying so. Otherwise Home
Assistant answers 500, which would look like an outage.

Three actions are marked `requiresConfirmation`: `unlock`, `alarm_disarm`
and `open`. The Pebble app does not ask the wearer before them yet (as of
1.16 only its own assistant does). Until it does, the plugin refuses
the following with `PERMISSION_DENIED` unless the wearer has turned on
**Apps Can Unlock** (watch: Settings → Entity Settings; settings page: "Let
other apps unlock and open doors"):

- `unlock`;
- `alarm_disarm`;
- `open` on a lock or on a garage door, gate or door.

The same three actions also need the plugin's own `Unlock` permission, which
is `dangerous`: the Pebble app asks the wearer for each app that wants it, in
every permission mode. An app calling them declares it in its
`usesPermissions`:

```json
{ "name": "Unlock", "plugin": "61ae3254-ce00-49db-aad8-23143f649b90" }
```

The permission goes with the action, so `open` needs it for a blind or a
valve too. `set_on` and `set_position` open those without it.

The **Apps Can Unlock** switch stays, because the Pebble app's own callers
(Index and its assistant) are not asked for an action's permissions.

None of these actions can be done another way, short of asking the
assistant (see `ask_assistant` below):

- `toggle` and `set_on` never unlock a lock, and `set_on` never disarms.
- A garage door, gate or door (a cover with that device class) never opens
  through `set_on`, `toggle`, `set_position` or `call_service`.
- `call_service` refuses `lock.unlock`, `lock.open` and
  `alarm_control_panel.alarm_disarm`.

`call_service` only calls services from a list per domain (`CALLABLE` in
`js/actions.js`): services that act on the entity they are given, such as
`fan.set_percentage`, `input_select.select_option` and `vacuum.return_to_base`.
It is a list and not "anything in the domain" for these reasons:

- Every script is also a service of its own (`script.<name>`). Sharing one
  script would otherwise run any of them.
- Some services name other entities in their data, such as
  `media_player.join`.

`call_service` also drops any target (`entity_id`, `device_id`, `area_id`,
`floor_id`, `label_id`) from `data`.

`ask_assistant` is off until the wearer turns on **Share with Apps** (watch:
Settings → Assistant; settings page: "Share with other apps" under Voice
Assistant Settings). It runs the pipeline chosen in the app (or Home Assistant's preferred
one), with that pipeline's agent and language, and it continues the same
conversation if asked again within five minutes. Keep these in mind before
turning it on:

- It can do whatever Home Assistant exposes to Assist (Settings → Voice
  assistants → Expose), not only what is shared here, unlocking an exposed
  lock included.
- It does not ask on the watch first. The Pebble app does ask the wearer
  once for each app that wants it: `ask_assistant` needs the plugin's own
  `Assistant` permission, which is `dangerous` like `Unlock`.
- Every app that asks shares the one conversation, since the plugin cannot
  tell callers apart, unless it asks with `json` (below).

With `json: true`, the answer is JSON: `reply`, `conversation_id`,
`response_type`, and `continue_conversation` when Home Assistant sends one.
The caller keeps the conversation by sending `conversation_id` back, and
the shared `plugin:conversation` is neither read nor written, so Index or
another app cannot join or take over a watch app's conversation, and the
watch app's turns do not end up in theirs. `new_conversation` is ignored,
and a `conversation_id` that is not a string of at most 200 characters is
`INVALID_ARGS`. An `error` response is still `UNKNOWN` with the agent's
words. With `speak` as well, `next` or `speech_error` is added to the same
JSON. Without `json`, nothing changes, so Index and the toasts get plain
text.

`ask_assistant`, `transcribe`, `speak` and `speak_next` take a `pipeline`,
for a watch app with a picker of its own: the id of one the watch app saved
(`agent/pipeline`, `js/pipelines.js`), checked against that list, so a
caller can only pick among the wearer's own pipelines. Without it they use
the watch app's choice. A speech cursor made with a `pipeline` carries a
fingerprint of it with that of the text, so `speak_next` refuses it with
another pipeline or none, and the voice cannot change part way through.

`send_to_agent` is `ask_assistant` under the name Index looks for. A plugin
with that action and an `agent/configured` source is offered in Index as a
destination for a ring gesture (Hold & Talk, Click & Hold) and for messages
typed into the Index feed. `agent/configured` says `true` once Home Assistant
is set up and **Share with Apps** is on, and Index only offers the assistant
while it does. Index is not asked for the `Assistant` permission, as with
any of the Pebble app's own callers, so **Share with Apps** is what keeps it
out. Nothing on the watch goes through these destinations; watch apps call
`ask_assistant` or `send_to_agent` directly.

Shared to-do lists (`todo.*`, such as the Shopping List) are offered to
Index the same way, as a place for reminders and list items. Index looks
for a `create_reminder` action and a `reminders/configured` source, and
reads the lists to choose from in `reminders/list`:

- `reminders/configured` says `true` once Home Assistant is set up and at
  least one to-do list is shared. Index gives it three seconds, so it is
  answered from the settings alone, as is `reminders/list` when only
  names are asked for (the names the watch app saved when the lists were
  shared). `count` comes from the list's state, and `items` from one
  `todo.get_items` call for all the lists, made only when `items` is asked
  for. Home Assistant before 2024.8 cannot answer that over REST, so
  there the lists come without `items`, as they do when one list cannot
  be read. Every shared list is an instance, in the same order, whatever
  is asked for; one Home Assistant no longer has comes with its name alone.
- The wearer picks Home Assistant WS as the place for reminders in Index's
  settings; with a ring paired, the Pebble app also offers once to make
  it the default when the settings page closes with a list shared.
  For "add milk to the shopping list", Index matches "shopping" against the
  list names and passes the list it found as `instanceId`. Anything else,
  such as "remind me to call the plumber", has no list and goes on the
  first list shared, so share the list for those first.
- `due_iso` becomes the item's due date and time on a list that keeps
  them (Local To-do), only its date on one that keeps dates (Google Tasks),
  and is left off on one that keeps neither (the Shopping List). The reply
  says which. Home Assistant's lists have no reminders of their own, so
  `notify_before_ms` is ignored.
- A list that is not shared is refused with `PERMISSION_DENIED`, like any
  entity.

Index shows its own "Sent to" line with the app's name for these. The
reply, such as "Added Milk to Shopping List.", goes to Index's assistant,
or to the watch app that called `create_reminder` itself. Notes are not
offered: Index would send every note there once the wearer made it the
default, and a to-do list is a poor home for a long note.

### Speech

`speak` and `speak_next` are for watch apps that play speech on a watch with
a speaker (Pebble Time 2, Core 2 Duo). They read `text` out in the voice of
the pipeline chosen in the watch app (or Home Assistant's preferred one):
its text-to-speech engine, voice and language. They answer with audio, not
words, so an app that wants something said to the wearer on screen, or an
assistant that wants to talk to them, uses `ask_assistant` instead.

- `text` is up to 20000 characters. Markdown is read as the words it
  shows, and only about the first 1200 characters are spoken, ending at a
  sentence, as in the watch app.
- `format` must be `ima_adpcm`. It is required, so that nothing asks for
  audio without meaning to.
- `rate` is `8000` (the default) or `16000` samples a second. Only the
  caller knows how fast its link to the watch is: 16000 needs twice the
  bytes.

An action can only answer with text, so each result is JSON in `text`:

```json
{ "v": 1, "format": "ima_adpcm", "rate": 8000, "offset": 0,
  "audio": "<base64>", "phrase": true, "last": false, "next": "<cursor>" }
```

- `audio` is 4-bit IMA ADPCM, mono, two samples a byte, low nibble first.
  The encoder starts from silence (predictor 0, index 0) at the start of
  the text and carries on from one slice into the next, so the slices
  joined are one stream, decoded as the watch app's own speaker decodes it.
- `offset` is where `audio` starts in that stream, in bytes.
- `phrase` says the slice ends at the end of a sentence, where a pause
  sounds natural if the next slice is late.
- `last` says nothing follows. Otherwise `next` is a cursor: call
  `speak_next` with the same `text`, that `next` and `format` for the
  following slice.

The voice is looked up over the WebSocket (`assist_pipeline/pipeline/list`)
and kept for an hour under `plugin:voice:<pipeline id>` (`voice:` alone for
Home Assistant's preferred one), so moving between pipelines does not look
each up again.

The text is split into pieces of a sentence or a few, about 200 characters
at most, and the first piece is kept short so the first word comes soon.
Each result is one piece, or a slice of at most 32 KB of audio (8 seconds
at 8000, about 43 KB of base64) when a piece is longer. Each call has Home
Assistant start on the piece after its own, so that piece is being made
while this one is sent to the watch and played; calling `speak_next` as
soon as a result arrives keeps ahead of the speaker.

The plugin keeps nothing between calls. The cursor carries all it needs,
so the same cursor always gives the same audio: a call that failed or
timed out can simply be made again, and several apps can speak at once. A
cursor also carries a fingerprint of the words it was made for, so one sent
with other text is refused. Home Assistant
keeps the speech it has made for five minutes, so asking again for a piece
it has already made costs little.

Errors:

- `INVALID_ARGS`: no `text`, too long, or nothing in it to say; a missing
  or other `format`; another `rate`; a `next` that is not a cursor from
  these actions or does not fit `text`.
- `PLUGIN_UNAVAILABLE`: the pipeline has no text-to-speech, or Home
  Assistant cannot be reached.
- `UNKNOWN`: Home Assistant could not make the speech, or sent audio that
  is not PCM WAV. Also when it made a piece again (once it had dropped it,
  or after a restart) and made it differently, so that the rest of it would
  not follow on from the slices already sent: start again with `speak`.
- `AUTH_REQUIRED` and `PERMISSION_DENIED` as for every action.

To have the assistant's reply read out, call `ask_assistant` with
`speak: true` (and `rate`, as for `speak`). It runs the assistant as
usual and answers with JSON instead of plain text:

```json
{ "reply": "The garage door is closed.", "next": "<cursor>" }
```

Call `speak_next` with `reply` as `text` and that `next` for the audio.
`ask_assistant` waits for nothing that could keep it past the 20 seconds a
request has, since running out of them would lose the reply to something
already done: the assistant can take most of them. It does not wait for the
audio, and it only has Home Assistant start on the first piece when it
already knows the pipeline's voice from a call in the last hour. Otherwise
the first `speak_next` looks the voice up and starts the speech. When the
reply cannot be spoken, `next` is left out and `speech_error` says why;
when there is nothing in it to say, both are left out. A reply too long for
`speak_next` (over 20000 characters) gets a `speech_error`. With `speak`,
`ask_assistant` still needs the `Assistant` permission and **Share with
Apps**.

`speak` and `speak_next` need `Location` and `InvokeAction` like every
action, and nothing else: no entity has to be shared, and **Share with
Apps** does not apply, since they only say what the caller gives them.
Speech made with a paid cloud engine is paid for by the wearer, and the
Pebble app asking before an app first calls an action is what lets them
say no.

Speech needs a Home Assistant recent enough to convert speech to WAV at
the rate asked for (the `preferred_format` and `preferred_sample_rate`
options of `/api/tts_get_url`), which the watch app's own spoken answers
need too. Recent versions start making the speech as soon as they are
asked for its address and answer at once, which is what lets each call
start on the next piece while it answers. Older ones may make the speech
before answering that request; speech then still works, but each call also
waits for the next piece to be made, and `ask_assistant` waits for the
first piece when it starts it. Which release changed this has not been checked.

Index offers its agent every action, and the plugin cannot tell who is
calling. The descriptions of `speak` and `speak_next` say they return
audio and are not for talking to the user, and the required `format`
means a call has to ask for audio on purpose.

### Hearing what was said

`transcribe` is for watch apps that record the wearer's voice themselves.
`audio` is the whole recording in base64, 16 kHz mono and at most 30
seconds, as `ima_adpcm` (4-bit, from silence, low nibble first, decoded
with `decodeAdpcm` in `speech-codec`, the inverse of the encoder speech
uses) or `pcm16le`. `sample_rate` may only be 16000. The size is checked
on the base64 before anything is decoded.

It runs `assist_pipeline/run` from `stt` to `stt` in the pipeline chosen in
the watch app, with `no_vad: true`: the recording is already over, and Home
Assistant's end-of-speech detection would otherwise end it at the first
pause. The audio goes the way the watch app sends its own (`haws.sendAudio`):

- `run-start` names the handler (`runner_data.stt_binary_handler_id`), and
  the plugin waits for `stt-start` before sending anything.
- Binary frames of the handler byte and up to 8 KB of 16-bit PCM, each a
  `Uint8Array` of its own and never a bare `ArrayBuffer`, which the
  emulator sends empty. Home Assistant drops the connection for an empty
  frame.
- A frame with only the handler byte ends the audio, and `stt-end` brings
  the text, which is the whole answer.

`stt-no-text-recognized` is an answer with no text, not an error. A
pipeline without speech-to-text (`validation-error`), or whose engine is
missing or cannot take the audio (`stt-provider-missing`,
`stt-provider-unsupported-metadata`), is `PLUGIN_UNAVAILABLE`; any other
error event, `stt-stream-failed` among them, is `UNKNOWN`. A WebSocket that
cannot connect does not mark Home Assistant unreachable, as for speech.

It needs `Location` and `InvokeAction` and nothing else, like `speak`: it
only turns audio into words, and does nothing with them. The answer is the
wearer's own words, which are safe to show and for Index to read. The
description and the required `audio` and `format` keep Index's agent from
calling it to answer anyone.

## Trying it

1. Build and sideload the pbw.
2. Turn on **Plugins / permissions preview** in the Pebble app (Settings →
   Plugins). When the app is installed, the Pebble app asks to let it connect
   to the internet and the local network, use the location, add timeline
   pins, use the watch microphone and, with the Android companion app,
   exchange messages with it. The plugin needs the internet and the local
   network.
3. Open the settings page from the Pebble app and share a few entities. When
   the settings page can reach the plugin, the status line under
   **Shared with Other Apps** says so.
4. Any consumer can then read and control them, for example the Core Devices
   Dashboard demo.

The phone registers the plugin's manifest when it starts, and again only when
`versionLabel` changes. After changing `manifest.json`, bump `versionLabel`
in `appinfo.json` so the phone reads it again; Core also keeps the old watch
binary for a sideload of the same version.

## Tests

`node --test tests/plugin` (Node 22, nothing to install) runs the plugin
against a fake Home Assistant. `tests/plugin/harness.js` loads `plugin/js`
the way the bundle does, in a fresh engine for every request with
`localStorage` kept between them, and stands in for the Pebble app's plugin
runtime, `fetch` and the WebSocket. The tests check that every property the
plugin sends is declared in `manifest.json`, the sources and actions end to
end, the unlock and sharing rules, the assistant and speech. They also hold
the speech encoder to what the watch app made before it was shared, and its
decoder to the one the watch's speaker uses. They run on every push.

## Settings page messages

The settings page (v1.8 and later) sends messages to the plugin with
`Pebble.sendMessage('plugin', …)`:

| Request | Reply |
| --- | --- |
| `{ type: 'status' }` | `{ ok, shared, weather, values, assistant }`, or `{ ok: false, error: { code, message } }`. Checks that the plugin can reach Home Assistant. |
| `{ type: 'refresh' }` | `{ ok }`. Asks every source to refresh. The page sends it after a save. |
| `{ type: 'get_settings' }` | `{ ok, settings, status }`, as the watch app answers it. Then pushes `{ type: 'status', status, settings }` once the states, calendars and pipelines have been fetched. |
| `{ type: 'save_settings', settings }` | `{ ok }`. Merges `settings` into the stored ones, keeping the previous copy as the backup, and asks every source to refresh. |
| `{ type: 'connect', ha_url, token }` | `{ ok, ha_version }`. Saves the URL and token only once Home Assistant accepts them. |
| `{ type: 'search_entities', query, limit }` | `{ ok, results, total }`, ranked as the watch app ranks them. |
| `{ type: 'list_areas' }` | `{ ok, areas: [{ id, name, entities }] }`: every area with something in it, by name, its entities as `search_entities` gives them. One `POST /api/template`, since REST has no other way to the areas. The page offers them under **Share a whole area**. |
| `{ type: 'preview_template', template, unit }` | `{ ok, result, text }`: what the template rendered, and the `state` text `home/value` would serve with that unit. A template Home Assistant cannot render answers `{ ok: false, error: { code: 'template_error', message } }`. |

The page always sends `list_areas` and `preview_template` here, even with
the watch app answering everything else: sharing and the values are only for
other apps, which reach them through the plugin, so the page has no use for
them without it. A preview from anywhere else would not show what they get
either. Without the plugin the page still saves values, and says the
preview is not available.

`get_settings`, `save_settings`, `connect` and `search_entities` are what
the page sends the watch app's JS. It sends them here instead when the phone
opened it with only the plugin behind it, from the Plugins tab for example,
so the settings can be changed without the watch app running. The plugin only writes the settings then: the watch
app's JS keeps them in memory while it runs and would write over them, but
reads them afresh when it starts.
