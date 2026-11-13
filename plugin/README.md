# Home Assistant for your Pebble app

Home Assistant WS comes with a plugin for the Core Devices Pebble app. With
it, any watchface or watch app can show the wearer's Home Assistant
entities, weather, calendars, to-do lists and their own custom values, and
control their lights, switches, thermostats, covers, locks and media
players, without asking for a Home Assistant address or token. The wearer
sets Home Assistant up once in Home Assistant WS and chooses what to share.
Your app reads typed, ready-to-draw values from PebbleKit JS and calls
simple actions such as `toggle` or `set_brightness`.

Contents:

- [Quick start](#quick-start)
- [Reading a source](#reading-a-source)
- [What you can read](#what-you-can-read)
- [What you can do](#what-you-can-do)
- [Index and the phone](#index-and-the-phone)
- [Speech](#speech)
- [Errors](#errors)
- [Limits and good manners](#limits-and-good-manners)
- [Testing your app](#testing-your-app)

## Quick start

The wearer needs:

- the Core Devices Pebble app, with **Plugins / permissions preview** turned
  on (Settings → Plugins);
- Home Assistant WS installed and connected to their Home Assistant;
- some entities shared with other apps. [Use your Home Assistant in other
  watch apps](../README.md#use-your-home-assistant-in-other-watch-apps)
  explains how, if you want to send them there.

### 1. Declare the permissions

The plugin's UUID is `61ae3254-ce00-49db-aad8-23143f649b90`. Add what you
use to `usesPermissions` in your `appinfo.json`, or under `pebble` in
`package.json`:

```json
"usesPermissions": [
  { "name": "Location", "reason": "To show your Home Assistant" },
  { "name": "InvokeAction", "plugin": "61ae3254-ce00-49db-aad8-23143f649b90" }
]
```

| Entry | You need it for |
| --- | --- |
| `Location` | Everything: every source and every action. |
| `{ "name": "InvokeAction", "plugin": "61ae…9b90" }` | Calling any action. |
| `{ "name": "Unlock", "plugin": "61ae…9b90" }` | `unlock`, `alarm_disarm` and `open`. |
| `{ "name": "Assistant", "plugin": "61ae…9b90" }` | `ask_assistant` and `send_to_agent`. |
| `Calendar` | Reading `calendar/event`. |

Write the UUID out in full; it is shortened in the table only to fit.

Why `Location`: the plugin can be the watch's own weather provider, so it
reads the wearer's weather locations. The Pebble app only allows that when
the plugin asks `Location` of everything that reads or calls it in turn,
so that no location reaches an app that was not allowed one. Your app never
receives a location from the plugin. The `reason` is optional; it tells the
wearer why you ask.

`Unlock` and `Assistant` are the plugin's own `dangerous` permissions: the
Pebble app asks the wearer for each app that wants one, whatever their
permission mode. Only declare them if you call those actions.

The Pebble app only lets an app use plugins when the `appinfo.json` inside
its pbw has `"manifestVersion": 2`. With an `appinfo.json` project, add it
there. With a `package.json` project, `pebble build` leaves it out; the
[test apps](#testing-your-app) have a small script,
`scripts/manifest_v2.py`, that adds it to a built pbw.

### 2. Read and control

This PebbleKit JS logs every shared light and toggles one:

```js
var HA = '61ae3254-ce00-49db-aad8-23143f649b90';

Pebble.addEventListener('ready', function() {
  Pebble.subscribeToSource({
    plugin: HA,
    category: 'home',
    item: 'light',
    properties: ['name', 'on', 'brightness'],
    onData: function(envelope) {
      envelope.instances.forEach(function(light) {
        var p = light.properties;
        console.log(light.instanceId + ': ' + p.name.shortText.text + ' ' +
          p.on.shortText.text + ', ' + p.brightness.shortText.text);
      });
    },
    onError: function(err) { console.log(err.code + ': ' + err.message); }
  });
});

function toggle(entityId) {
  Pebble.invokeAction({ plugin: HA, action: 'toggle', args: { instanceId: entityId } })
    .then(function(result) {
      console.log(result.ok ? result.text : result.code + ': ' + result.message);
    });
}
```

`onData` runs with the lights straight away and again whenever they change:
the source is polled while you are subscribed, and an action asks it to
refresh. `toggle('light.kitchen')` logs `Toggled Kitchen.`, and the lights
come in again with the new state.

## Reading a source

`Pebble.subscribeToSource(config)` takes:

| Field | |
| --- | --- |
| `plugin` | The plugin's UUID. Always give it: the Hue and Google Home plugins also serve `home/light`, and the phone serves `weather/location` and `calendar/event` itself and is asked first. |
| `category`, `item` | The source, such as `home` and `light`. |
| `properties` | The property names you draw. Leave it out for every property, but some cost Home Assistant work and only come when named (see below). |
| `iconPixelSize` | `{ w, h }`, for sources that draw pictures (weather). |
| `onData(envelope)` | Called with each answer. |
| `onError(error)` | Called with `{ code, message }`. See [Errors](#errors). |

It returns an object with `unsubscribe()`. Call it when the screen that
needs the data closes.

An answer looks like this:

```json
{
  "pluginUuid": "61ae3254-ce00-49db-aad8-23143f649b90",
  "validUntilMs": 1763025630000,
  "instances": [
    { "instanceId": "light.kitchen", "properties": { "name": { "shortText": { "text": "Kitchen" } } } }
  ]
}
```

Each property comes in one or more shapes, so you can pick the one you can
draw:

| Shape | Payload |
| --- | --- |
| `shortText` | `{ text }`, short enough for a label. |
| `longText` | `{ text }`, the whole thing. |
| `numericValue` | `{ value, unit?, min?, max? }`. With `min` and `max` it can fill a gauge. |
| `boolean` | `{ value }` |
| `timestamp` | `{ value }`, in whole seconds since 1970. |
| `icon`, `image` | `{ width, height, palette, pixels }`: 4 bits a pixel, two pixels a byte with the even column in the high nibble, each row padded to a whole byte, the palette Pebble colours. `pixels` and `palette` are base64. |
| `series` | `{ start, stepSec, <shape>: { values } }`: evenly spaced points from `start` (seconds), `null` where there is none. |

A property the entity has no value for is left out. An entity that is
unavailable keeps its `name`, and its `on` (or `open`, `locked`, ...) comes
only as `shortText`, such as `Unavailable`, so check for `boolean` before
you use it.

Entities are instances whose `instanceId` is the `entity_id`, in the order
the wearer shared them. Only what the wearer shared is ever served. Weather
entities are always shared.

To see whether the plugin is installed, look for its UUID in
`Pebble.enumeratePlugins()`, which lists each plugin with its `uuid`,
`name`, `sources` and `actions`. Another plugin reading this one uses
`Pebble.readSource(request)` instead, which answers once with a promise of
the envelope.

## What you can read

### Every entity

Every instance of a `home/*` source has these:

| Property | Shapes | |
| --- | --- | --- |
| `name` | shortText, longText | The entity's name in Home Assistant. |
| `room` | shortText | Its area in Home Assistant, or its device's. Left out when it has none, or when Home Assistant's token is not an administrator's. |
| `last_changed`, `last_updated` | timestamp | |
| `supported_features` | numericValue | Home Assistant's own bits for what the entity can do, such as 1 open, 2 close, 4 set position and 8 stop for a cover. |

The examples below leave these out after the first.

### `home/light`

Lights.

| Property | Shapes | |
| --- | --- | --- |
| `on` | boolean, shortText | `On`, `Off`. |
| `brightness` | numericValue (`%`, 0 to 100), shortText | 0 while off. |
| `color_temp` | numericValue (`K`, with the light's range), shortText | When it has a colour temperature. |
| `color_modes` | longText | Comma separated, as Home Assistant names them. `onoff` alone means it cannot dim. |

```json
{
  "instanceId": "light.kitchen",
  "properties": {
    "name": { "shortText": { "text": "Kitchen" }, "longText": { "text": "Kitchen" } },
    "room": { "shortText": { "text": "Kitchen" } },
    "on": { "boolean": { "value": true }, "shortText": { "text": "On" } },
    "brightness": { "numericValue": { "value": 60, "unit": "%", "min": 0, "max": 100 }, "shortText": { "text": "60%" } },
    "color_temp": { "numericValue": { "value": 2700, "unit": "K", "min": 2000, "max": 6535 }, "shortText": { "text": "2700K" } },
    "color_modes": { "longText": { "text": "color_temp,xy" } },
    "last_changed": { "timestamp": { "value": 1763020800 } },
    "last_updated": { "timestamp": { "value": 1763021400 } },
    "supported_features": { "numericValue": { "value": 44 } }
  }
}
```

### `home/switch`

Switches, input booleans, fans, automations, sirens, humidifiers and
remotes.

| Property | Shapes | |
| --- | --- | --- |
| `on` | boolean, shortText | |
| `speed` | numericValue (`%`, 0 to 100), shortText | Fans that have a speed. |

```json
{ "instanceId": "fan.bedroom", "properties": {
  "on": { "boolean": { "value": true }, "shortText": { "text": "On" } },
  "speed": { "numericValue": { "value": 33, "unit": "%", "min": 0, "max": 100 }, "shortText": { "text": "33%" } } } }
```

### `home/sensor`

Sensors, numbers, input numbers and counters.

| Property | Shapes | |
| --- | --- | --- |
| `value` | shortText, longText, numericValue, timestamp | The text is rounded with its unit. `numericValue` has the exact number and unit, with 0 to 100 for percentages (battery, humidity, moisture or `%`) and the entity's own range for numbers. A sensor of class `timestamp` comes as a timestamp. |
| `device_class` | shortText | Such as `temperature`. |
| `history` | series of numericValue | The last day, one value an hour. Only when named in `properties`. |

```json
{ "instanceId": "sensor.living_room_temperature", "properties": {
  "value": { "shortText": { "text": "21.5°C" }, "longText": { "text": "21.5°C" }, "numericValue": { "value": 21.46, "unit": "°C" } },
  "device_class": { "shortText": { "text": "temperature" } } } }
```

`history` is made for drawing a graph: 24 values, oldest first, each the
average over its hour, the last one the hour under way. An hour with no
number in it is `null`. It has the same unit and range as `value`, and only
instances that are numbers right now have it. A sensor with a `state_class`
gets its hours from Home Assistant's long-term statistics, and its last
value is its value now. Other sensors are read from their state changes, at
most five on one poll, so with many of them some get their `history` a poll
or two later:

```json
"history": { "series": { "start": 1762941600, "stepSec": 3600, "numericValue": { "unit": "°C", "values": [
  20.1, 20, 19.8, 19.6, 19.5, 19.4, 19.4, 19.6, 20.2, 20.8, 21.1, 21.3,
  21.4, 21.6, 21.8, 21.9, 21.7, 21.5, 21.4, 21.2, 21.3, 21.4, 21.5, 21.5 ] } } }
```

### `home/binary_sensor`

| Property | Shapes | |
| --- | --- | --- |
| `on` | boolean, shortText | The text follows the device class: `Open`/`Closed` for doors and windows, `Detected`/`Clear` for motion, `Wet`/`Dry` for moisture, and so on. |
| `state` | shortText, longText | The same text. |
| `device_class` | shortText | |

```json
{ "instanceId": "binary_sensor.front_door", "properties": {
  "on": { "boolean": { "value": false }, "shortText": { "text": "Closed" } },
  "state": { "shortText": { "text": "Closed" }, "longText": { "text": "Closed" } },
  "device_class": { "shortText": { "text": "door" } } } }
```

### `home/climate`

Thermostats and water heaters. Temperatures are in Home Assistant's own
unit, which their `numericValue` names (`°C` or `°F`), or just `°` in the
rare case Home Assistant does not say.

| Property | Shapes | |
| --- | --- | --- |
| `current_temperature` | numericValue, shortText | |
| `target_temperature` | numericValue (with the thermostat's range), shortText | Thermostats keeping one temperature. |
| `target_temp_low`, `target_temp_high` | numericValue, shortText | A thermostat keeping a range (`heat_cool`). |
| `temperature_step` | numericValue | How far one press should move the target. |
| `on` | boolean, shortText | Anything but `off` is on. |
| `hvac_mode` | shortText | Such as `Heat`. |
| `hvac_modes` | longText | The modes it offers, comma separated, as Home Assistant names them: `off,heat,cool`. Pass one of these to `set_hvac_mode`. |
| `hvac_action` | shortText | What it is doing now, such as `Heating`. |
| `summary` | shortText, longText | The mode, the target and the reading: `Heat 21°/20.5°`. |

```json
{ "instanceId": "climate.hallway", "properties": {
  "current_temperature": { "numericValue": { "value": 20.5, "unit": "°C" }, "shortText": { "text": "20.5°" } },
  "target_temperature": { "numericValue": { "value": 21, "unit": "°C", "min": 7, "max": 35 }, "shortText": { "text": "21°" } },
  "temperature_step": { "numericValue": { "value": 0.5, "unit": "°C" } },
  "on": { "boolean": { "value": true }, "shortText": { "text": "On" } },
  "hvac_mode": { "shortText": { "text": "Heat" } },
  "hvac_modes": { "longText": { "text": "off,heat" } },
  "hvac_action": { "shortText": { "text": "Heating" } },
  "summary": { "shortText": { "text": "Heat 21°/20.5°" }, "longText": { "text": "Heat 21°/20.5°" } } } }
```

### `home/cover`

Covers (blinds, garage doors, gates) and valves.

| Property | Shapes | |
| --- | --- | --- |
| `open` | boolean, shortText | `Open` (opening counts) or `Closed`. |
| `position` | numericValue (`%`, 0 closed to 100 open), shortText | When it reports one. |
| `state` | shortText | `Open`, `Opening`, `Closed`, `Closing`. |

```json
{ "instanceId": "cover.living_room_blinds", "properties": {
  "open": { "boolean": { "value": true }, "shortText": { "text": "Open" } },
  "position": { "numericValue": { "value": 40, "unit": "%", "min": 0, "max": 100 }, "shortText": { "text": "40%" } },
  "state": { "shortText": { "text": "Open" } },
  "supported_features": { "numericValue": { "value": 15 } } } }
```

### `home/lock`

| Property | Shapes | |
| --- | --- | --- |
| `locked` | boolean, shortText | `Locked` or `Unlocked`. |
| `state` | shortText | Such as `Locked`, `Unlocking`, `Jammed`. |

```json
{ "instanceId": "lock.front_door", "properties": {
  "locked": { "boolean": { "value": true }, "shortText": { "text": "Locked" } },
  "state": { "shortText": { "text": "Locked" } } } }
```

### `home/media_player`

| Property | Shapes | |
| --- | --- | --- |
| `on` | boolean, shortText | Whether it is playing: `Playing` or `Paused`. |
| `playing` | boolean | The same. |
| `state` | shortText | `Playing`, `Paused`, `Idle`, `Off`, ... |
| `title`, `artist` | shortText, longText | What is playing, when it says. |
| `volume` | numericValue (`%`, 0 to 100), shortText | |

```json
{ "instanceId": "media_player.kitchen_speaker", "properties": {
  "on": { "boolean": { "value": true }, "shortText": { "text": "Playing" } },
  "playing": { "boolean": { "value": true } },
  "state": { "shortText": { "text": "Playing" } },
  "title": { "shortText": { "text": "Clair de Lune" }, "longText": { "text": "Clair de Lune" } },
  "artist": { "shortText": { "text": "Debussy" }, "longText": { "text": "Debussy" } },
  "volume": { "numericValue": { "value": 35, "unit": "%", "min": 0, "max": 100 }, "shortText": { "text": "35%" } } } }
```

### `home/person`

People and device trackers. Never coordinates.

| Property | Shapes | |
| --- | --- | --- |
| `home` | boolean, shortText | `Home` or `Away`. |
| `zone` | shortText, longText | `Home`, `Away`, or the zone's name, such as `Work`. |
| `since` | timestamp | When that last changed. |

```json
{ "instanceId": "person.alex", "properties": {
  "home": { "boolean": { "value": false }, "shortText": { "text": "Away" } },
  "zone": { "shortText": { "text": "Work" }, "longText": { "text": "Work" } },
  "since": { "timestamp": { "value": 1763017200 } } } }
```

### `home/scene`

Scenes, scripts, buttons and input buttons. Run any of them with
`activate`, or `set_on` with `on: true`. `set_on` with `on: false` stops a
running script.

| Property | Shapes | |
| --- | --- | --- |
| `running` | boolean | Scripts only. |
| `last_run` | timestamp | When it last ran or was pressed. |

```json
{ "instanceId": "scene.movie_night", "properties": {
  "last_run": { "timestamp": { "value": 1762974000 } } } }
```

### `home/alarm`

Alarm panels.

| Property | Shapes | |
| --- | --- | --- |
| `armed` | boolean, shortText | Anything but disarmed counts as armed. |
| `state` | shortText, longText | Such as `Armed away`, `Arming`, `Triggered`. |

```json
{ "instanceId": "alarm_control_panel.house", "properties": {
  "armed": { "boolean": { "value": true }, "shortText": { "text": "Armed" } },
  "state": { "shortText": { "text": "Armed away" }, "longText": { "text": "Armed away" } } } }
```

### `home/entity`

Everything shared, of every kind, plus every weather entity. Use it for a
picker or a list of everything.

| Property | Shapes | |
| --- | --- | --- |
| `state` | shortText, longText, numericValue, timestamp | The state as the watch app shows it, and as a number or a time when it is one. |
| `on` | boolean | For anything with an on and off in its own sense: on, open, locked, playing, home, armed, or a calendar with an event under way. |
| `domain` | shortText | Such as `light`. |
| `history` | series of numericValue | As for `home/sensor`, for numeric states. Only when named. |

```json
{ "instanceId": "input_select.house_mode", "properties": {
  "state": { "shortText": { "text": "Night" }, "longText": { "text": "Night" } },
  "domain": { "shortText": { "text": "input_select" } } } }
```

### `home/value`

The wearer's custom values: anything a Home Assistant template can work
out, such as how many doors are open, written by the wearer on the settings
page. One instance per value, in their order. The `instanceId` is an id the
settings page gave the value, which stays the same when they rename or
edit it. Values have none of the entity properties above.

| Property | Shapes | |
| --- | --- | --- |
| `name` | shortText, longText | The wearer's name for it. |
| `state` | shortText, longText, numericValue | What it rendered, with the unit after a number. `shortText` is at most 24 characters. A number also comes as `numericValue`, from 0 to 100 for `%`. A template that fails reads `Error`. |
| `unit` | shortText | When the wearer gave one. |
| `error` | longText | Why the template failed. |

```json
{ "instanceId": "vmhx3k2ab1c", "properties": {
  "name": { "shortText": { "text": "Doors open" }, "longText": { "text": "Doors open" } },
  "state": { "shortText": { "text": "2" }, "longText": { "text": "2" }, "numericValue": { "value": 2 } } } }
```

Home Assistant only renders templates for an administrator, so with any
other token this source answers `PERMISSION_DENIED`.

### `calendar/event`

The next events across the calendars the wearer shared, under the same
names and shapes as the phone's own calendar source, so a face made for
that one works with Home Assistant's calendars too. Needs `Calendar` as
well as `Location`. At most 10 events from the next 7 days, soonest first.
An event under way counts until it ends. The `instanceId` is the event's
place in the list: `"0"` is always the next one.

| Property | Shapes | |
| --- | --- | --- |
| `name` | shortText, longText | The event's summary. |
| `location` | shortText, longText | When it has one. |
| `starts_at` | shortText, longText, timestamp | The text is the time on the phone's clock (`09:30`), or `All day`. |
| `ends_at` | shortText, timestamp | |
| `all_day` | boolean | An all-day event runs from the phone's midnight to the next. |
| `calendar` | shortText | The calendar's name. |

```json
{ "instanceId": "0", "properties": {
  "name": { "shortText": { "text": "Dentist" }, "longText": { "text": "Dentist" } },
  "location": { "shortText": { "text": "12 High St" }, "longText": { "text": "12 High St" } },
  "starts_at": { "shortText": { "text": "09:30" }, "longText": { "text": "09:30" }, "timestamp": { "value": 1763112600 } },
  "ends_at": { "shortText": { "text": "10:15" }, "timestamp": { "value": 1763115300 } },
  "all_day": { "boolean": { "value": false } },
  "calendar": { "shortText": { "text": "Family" } } } }
```

### `weather/location`

Home Assistant's weather, under the same names and shapes as the phone's
own weather. One instance for each of the wearer's weather locations near
home (its id is the location's id), then one per weather entity (its id is
the `entity_id`). A face that shows the first instance shows the wearer's
own place.

| Property | Shapes | |
| --- | --- | --- |
| `name` | shortText | The place, or the entity's name. |
| `temperature`, `feels_like`, `high`, `low` | shortText, longText, numericValue | The text follows the wearer's °C or °F in the Pebble app; `numericValue` stays in Home Assistant's unit, which it names. |
| `condition` | shortText, longText, icon, image | Such as `Partly cloudy`. The pictures only with `iconPixelSize`: `icon` is black on transparent, `image` white on a disc coloured for the weather. |
| `condition_code` | longText | `sun`, `partly_cloudy`, `cloudy`, `light_rain`, `heavy_rain`, `light_snow`, `rain_and_snow` or `unknown`. |
| `uv_index` | numericValue (0 to 11), shortText | |
| `precipitation` | numericValue (`%`, 0 to 100), shortText | The chance of rain today. |
| `humidity` | numericValue (`%`, 0 to 100), shortText | |
| `wind_speed` | numericValue, shortText | The text in the wearer's unit. |
| `wind_direction` | numericValue (`°`, 0 to 360) | |
| `last_changed` | timestamp | |
| `sunrise`, `sunset` | timestamp | Today's, for the wearer's locations only. |
| `hourly_temperature` | series of numericValue, shortText | Today's and tomorrow's hours from local midnight. Hours gone by are `null`. |
| `hourly_condition` | series of shortText, longText, icon, image | |
| `hourly_condition_code` | series of longText | |
| `daily_high`, `daily_low`, `daily_precipitation` | series of numericValue, shortText | Up to 7 days from today's local midnight. |
| `daily_condition` | series of shortText, longText, icon, image | |
| `daily_condition_code` | series of longText | |
| `daily_sunrise`, `daily_sunset` | series of timestamp | The wearer's locations only. |

```json
{ "instanceId": "weather.home", "properties": {
  "name": { "shortText": { "text": "Home" } },
  "temperature": { "shortText": { "text": "12°C" }, "longText": { "text": "12°C" }, "numericValue": { "value": 11.8, "unit": "°C" } },
  "high": { "shortText": { "text": "14°C" }, "longText": { "text": "14°C" }, "numericValue": { "value": 14.2, "unit": "°C" } },
  "condition": { "shortText": { "text": "Partly cloudy" }, "longText": { "text": "Partly cloudy" } },
  "condition_code": { "longText": { "text": "partly_cloudy" } },
  "humidity": { "numericValue": { "value": 72, "unit": "%", "min": 0, "max": 100 }, "shortText": { "text": "72%" } } } }
```

Ask for the series and pictures you draw by name: they are only built when
`properties` names them, or names nothing at all.

### `reminders/list`

The shared to-do lists, such as the Shopping List, in the wearer's order.
The `instanceId` is the list's `entity_id`. Every shared list is always an
instance, in the same place, whatever you ask for: one Home Assistant no
longer has comes with its `name` alone, and when the lists' items cannot be
read they come without `items`.

| Property | Shapes | |
| --- | --- | --- |
| `name` | shortText | |
| `count` | numericValue, shortText | How many items are open. |
| `items` | longText | The first five open items, one a line. Not on Home Assistant before 2024.8. |

```json
{ "instanceId": "todo.shopping_list", "properties": {
  "name": { "shortText": { "text": "Shopping List" } },
  "count": { "numericValue": { "value": 3 }, "shortText": { "text": "3" } },
  "items": { "longText": { "text": "Milk\nEggs\nCoffee" } } } }
```

### `agent/configured` and `reminders/configured`

One instance each, with a `configured` boolean and a `name`, for Index (see
[Index and the phone](#index-and-the-phone)). `agent/configured`
(instance `assistant`) is `true` when `ask_assistant` would work: Home
Assistant is set up and the wearer turned on sharing the assistant.
`reminders/configured` (instance `todo`) is `true` when Home Assistant is
set up and a to-do list is shared. Both answer without asking Home
Assistant, so they are a cheap way to see whether to show a feature.

## What you can do

Call an action with `Pebble.invokeAction({ plugin, action, args })`. It
returns a promise that always resolves, never rejects:

```json
{ "ok": true, "text": "Set Kitchen to 40%.", "refreshed": ["home/entity", "home/light"] }
```

```json
{ "ok": false, "code": "PERMISSION_DENIED", "message": "light.garage is not shared with other apps" }
```

`text` is a short sentence you can show as it is. `refreshed` names the
sources that will send new data. Every action needs `InvokeAction` and
`Location`. The first call waits for the wearer to answer the Pebble app's
question, if they have not yet.

Every entity action takes `instanceId`, the `entity_id` from any `home/*`
source, and is refused unless the entity is shared. The plugin checks
`supported_features` first, so asking a blind that cannot be positioned to
move to 40% is refused with `INVALID_ARGS` and a sentence saying why.

### Anything that turns on and off

| Action | Arguments | Does |
| --- | --- | --- |
| `set_on` | `on` (boolean) | Turns on or off lights, switches, fans, automations, sirens, humidifiers, remotes and thermostats. Plays or pauses media players. Opens or closes covers and valves. Locks a lock and arms an alarm panel (in `away`); `false` is refused for those, since only `unlock` and `alarm_disarm` undo them. Runs a scene or script or presses a button (`true`), or stops a script (`false`). |
| `toggle` | | Toggles. Media players play or pause, thermostats turn on or off, scenes, scripts, buttons and automations run, covers and valves open or close, a lock locks. |
| `activate` | | Runs a scene or script, presses a button, or triggers an automation. |

```js
Pebble.invokeAction({ plugin: HA, action: 'set_on', args: { instanceId: 'switch.coffee_maker', on: true } });
// { ok: true, text: 'Turned on Coffee maker.', ... }
```

`set_on` and `toggle` follow the same `on` (or `open`, `locked`,
`armed`, `playing`, `running`) the sources show, so a tile can send
`on: !current`. Neither ever unlocks or disarms: `toggle` on a locked lock,
and `set_on` with `on: false` on a lock or alarm panel, answer
`INVALID_ARGS`. On a garage door, gate or door that is closed both answer
`PERMISSION_DENIED`, since those only open with `open`. `set_on` and
`set_brightness` also accept the Hue plugin's `item` argument, which is
not needed.

### Lights

| Action | Arguments | Does |
| --- | --- | --- |
| `set_brightness` | `percent` (0 to 100) | Sets the brightness. 0 turns it off. A light that cannot dim is refused. |

### Thermostats and water heaters

| Action | Arguments | Does |
| --- | --- | --- |
| `set_temperature` | `temperature`, or `target_temp_low` and `target_temp_high` | Sets the target, or the range for a thermostat keeping one (`heat_cool`). |
| `set_hvac_mode` | `hvac_mode` | Sets the mode, one of the thermostat's `hvac_modes`. Thermostats only. |

```js
Pebble.invokeAction({ plugin: HA, action: 'set_temperature', args: { instanceId: 'climate.hallway', temperature: 21.5 } });
// { ok: true, text: 'Set Hallway to 21.5°.', ... }
```

### Covers and valves

| Action | Arguments | Does |
| --- | --- | --- |
| `open` | | Opens it. Needs `Unlock`, and on a garage door, gate or door the wearer's unlocking switch too (see below). For a blind, `set_on` with `on: true` opens it without either. |
| `close`, `stop` | | Closes it, or stops it moving. |
| `set_position` | `position` (0 closed to 100 open) | Moves it. A garage door, gate or door only goes to 0. |

### Locks

| Action | Arguments | Does |
| --- | --- | --- |
| `lock` | `code`? | Locks. |
| `unlock` | `code`? | Unlocks. Needs `Unlock` and the unlocking switch. |
| `open` | `code`? | Unlatches a lock that can. Needs `Unlock` and the unlocking switch. |

Codes come from your app, for locks and alarm panels that need one. The
plugin never uses the codes the watch app remembers.

### Alarm panels

| Action | Arguments | Does |
| --- | --- | --- |
| `alarm_arm` | `mode`?, `code`? | Arms it. `mode` is `home`, `away` (the default), `night`, `vacation` or `custom_bypass`. |
| `alarm_disarm` | `code`? | Disarms it. Needs `Unlock` and the unlocking switch. |

### Media players

| Action | Arguments | Does |
| --- | --- | --- |
| `set_playing` | `playing` (boolean) | Plays or pauses. |
| `next_track`, `previous_track` | | Skips. |
| `set_volume` | `percent` (0 to 100) | Sets the volume. |

### Anything else: `call_service`

`call_service` `{ instanceId, service, data? }` calls a service of the
entity's own domain on that entity, with `data` as the service data. Any
target in `data` (`entity_id`, `device_id`, `area_id`, `floor_id`,
`label_id`) is dropped, so it only ever acts on the entity named. Only
these services can be called:

| Domain | Services |
| --- | --- |
| `light`, `switch`, `input_boolean`, `siren`, `remote`, `script` | `turn_on`, `turn_off`, `toggle` |
| `fan` | those, `set_percentage`, `increase_speed`, `decrease_speed`, `set_preset_mode`, `oscillate`, `set_direction` |
| `automation` | `turn_on`, `turn_off`, `toggle`, `trigger` |
| `humidifier` | `turn_on`, `turn_off`, `toggle`, `set_humidity`, `set_mode` |
| `scene` | `turn_on` |
| `button`, `input_button` | `press` |
| `number`, `text`, `input_text` | `set_value` |
| `input_number` | `set_value`, `increment`, `decrement` |
| `counter` | `increment`, `decrement`, `reset`, `set_value` |
| `select`, `input_select` | `select_option`, `select_next`, `select_previous`, `select_first`, `select_last` |
| `input_datetime` | `set_datetime` |
| `climate` | `turn_on`, `turn_off`, `toggle`, `set_temperature`, `set_hvac_mode`, `set_preset_mode`, `set_fan_mode`, `set_humidity`, `set_swing_mode` |
| `water_heater` | `turn_on`, `turn_off`, `set_temperature`, `set_operation_mode`, `set_away_mode` |
| `cover` | `open_cover`, `close_cover`, `stop_cover`, `toggle`, `set_cover_position`, `open_cover_tilt`, `close_cover_tilt`, `stop_cover_tilt`, `set_cover_tilt_position`, `toggle_cover_tilt` |
| `valve` | `open_valve`, `close_valve`, `stop_valve`, `toggle`, `set_valve_position` |
| `lock` | `lock` |
| `alarm_control_panel` | `alarm_arm_home`, `alarm_arm_away`, `alarm_arm_night`, `alarm_arm_vacation`, `alarm_arm_custom_bypass` |
| `media_player` | `turn_on`, `turn_off`, `toggle`, `media_play`, `media_pause`, `media_play_pause`, `media_stop`, `media_next_track`, `media_previous_track`, `media_seek`, `volume_set`, `volume_up`, `volume_down`, `volume_mute`, `select_source`, `select_sound_mode`, `shuffle_set`, `repeat_set` |
| `vacuum` | `start`, `pause`, `stop`, `return_to_base`, `locate`, `clean_spot`, `set_fan_speed` |
| `lawn_mower` | `start_mowing`, `pause`, `dock` |

Anything else is refused with `PERMISSION_DENIED`, and so is opening a
garage door, gate or door this way.

```js
Pebble.invokeAction({ plugin: HA, action: 'call_service', args: {
  instanceId: 'input_select.house_mode', service: 'select_option', data: { option: 'Away' } } });
// { ok: true, text: 'Called input_select.select_option on House mode.', ... }
```

### To-do lists

| Action | Arguments | Does |
| --- | --- | --- |
| `create_reminder` | `title`, `instanceId`?, `due_iso`?, `timezone`?, `notify_before_ms`? | Adds `title` to the shared list `instanceId` (from `reminders/list`), or to the first shared list. |

`due_iso` is an ISO 8601 date and time with its offset. It becomes the
item's due date and time on a list that keeps them, only its date on one
that keeps dates, and is left off on one that keeps neither; the reply says
which. `notify_before_ms` is ignored, since Home Assistant's lists have no
reminders of their own.

```js
Pebble.invokeAction({ plugin: HA, action: 'create_reminder', args: { title: 'Milk', instanceId: 'todo.shopping_list' } });
// { ok: true, text: 'Added Milk to Shopping List.', refreshed: ['reminders/list', 'home/entity'] }
```

### The assistant

| Action | Arguments | Does |
| --- | --- | --- |
| `ask_assistant` | `text`, `new_conversation`?, `speak`?, `rate`? | Asks Home Assistant's assistant, in the wearer's own pipeline and language, and answers with its reply as `text`. |
| `send_to_agent` | `message`, `chat_id`? | The same, under the name Index looks for. `chat_id` is ignored. |

Both need `Assistant`, and only work while the wearer has turned on sharing
the assistant. The conversation carries on if you ask again within five
minutes; pass `new_conversation: true` to start afresh. Every app that asks
shares that one conversation. The assistant can do whatever the wearer
exposed to Assist in Home Assistant, not only what they shared here, and it
does not ask on the watch first.

```js
Pebble.invokeAction({ plugin: HA, action: 'ask_assistant', args: { text: 'Is the garage door closed?' } });
// { ok: true, text: 'The garage door is closed.', refreshed: [...] }
```

For `speak` and `rate`, see [Speech](#speech).

### What needs more than `InvokeAction`

| Action | Needs |
| --- | --- |
| `unlock`, `alarm_disarm` | `Unlock`, and the wearer's **Apps Can Unlock** switch. |
| `open` | `Unlock`, and on a lock, garage door, gate or door the switch too. |
| `ask_assistant`, `send_to_agent` | `Assistant`, and the wearer's **Share with Apps** switch. |

The switches are in Home Assistant WS. While one is off the action answers
`PERMISSION_DENIED` with a sentence saying so, which you can show the
wearer.

## Index and the phone

The plugin also works with the Pebble app's own features. You do not have
to do anything for these, but they explain what the wearer may see.

- **Index destinations.** A plugin with `send_to_agent` and an
  `agent/configured` source can be where Index sends a ring gesture or a
  typed message. Home Assistant's assistant is offered while sharing the
  assistant is on. The same goes for reminders: with `create_reminder`,
  `reminders/configured` and `reminders/list`, the wearer can pick Home
  Assistant WS for "add milk to the shopping list" in Index's settings.
- **The watch's own weather.** The wearer can pick Home Assistant WS under
  **Weather provider** in the Pebble app (Settings → Weather). The watch's
  Weather app and timeline pins then show Home Assistant's weather for
  their weather locations within 25 km of home, with sunrise and sunset
  worked out for each.
- **Calendar and weather in other apps.** The phone's own `calendar/event`
  and `weather/location` are asked first, unless the wearer picks this app
  under **Preferred sources**. Naming the plugin in your request, as every
  example here does, always gets Home Assistant's.
- **Complications and the Dashboard.** Both pick an instance by its place
  in the list, not by its id. The plugin keeps the wearer's order, so a
  slot that shows the third shared entity keeps showing it until the
  wearer reorders their list. The Dashboard draws a `numericValue` with
  `min` and `max` as a gauge, and can bind a tap to `set_on` for an `on`, `open` or `running`
  property and to actions that only need `instanceId`, such as `toggle`.

## Speech

`speak` and `speak_next` are for watch apps that play speech on a watch
with a speaker (Pebble Time 2, Core 2 Duo). They say any text in the voice
of the wearer's assistant, as audio ready for the watch. They answer with
audio, not words: to show the wearer an answer, use `ask_assistant`.

| Action | Arguments | Does |
| --- | --- | --- |
| `speak` | `text`, `format`, `rate`? | The first slice of `text` as audio. |
| `speak_next` | `text`, `next`, `format` | The slice the cursor `next` names. Send the same `text` again. |

- `text` is up to 20000 characters. Markdown is read as the words it
  shows. About the first 1200 characters are spoken, ending at a sentence.
- `format` must be `ima_adpcm`. It is required so nothing asks for audio
  by accident.
- `rate` is `8000` (the default) or `16000` samples a second. 16000 needs
  twice the bytes, so pick it only if your link to the watch keeps up.

Each result is JSON in `text`:

```json
{ "v": 1, "format": "ima_adpcm", "rate": 8000, "offset": 0,
  "audio": "<base64>", "phrase": true, "last": false, "next": "<cursor>" }
```

| Field | |
| --- | --- |
| `audio` | 4-bit IMA ADPCM, mono, two samples a byte, low nibble first, base64. The encoder starts from silence (predictor 0, index 0) and carries on from slice to slice, so the slices joined are one stream. At most 32 KB a slice, 8 seconds at 8000. |
| `offset` | Where `audio` starts in that stream, in bytes. |
| `phrase` | The slice ends at the end of a sentence, where a pause sounds natural if the next is late. |
| `last` | Nothing follows. Otherwise call `speak_next` with `next`. |

Ask for the next slice as soon as one arrives: the plugin has Home
Assistant start on the following piece before it answers, so it is being
made while you send this one to the watch.

```js
function say(text) {
  function play(result) {
    if (!result.ok) { return console.log(result.code + ': ' + result.message); }
    var slice = JSON.parse(result.text);
    sendToWatch(slice.audio, slice.offset);   // your own code
    if (!slice.last) {
      Pebble.invokeAction({ plugin: HA, action: 'speak_next',
        args: { text: text, next: slice.next, format: 'ima_adpcm' } }).then(play);
    }
  }
  Pebble.invokeAction({ plugin: HA, action: 'speak',
    args: { text: text, format: 'ima_adpcm' } }).then(play);
}
```

The plugin keeps nothing between calls. The same cursor always gives the
same audio, so a call that failed or timed out can simply be made again,
and several apps can speak at once. A cursor belongs to the text it was
made for: sent with any other text it is refused with `INVALID_ARGS` (`next
does not belong to this text`). If Home Assistant has to make a piece again
(after a restart, say) and makes it differently, the rest would not follow
on from what you already played, so you get `UNKNOWN` (`The speech changed
in Home Assistant; start again with speak`): start again with `speak`.

To hear the assistant's answer, call `ask_assistant` with `speak: true`
(and `rate` if you want 16000). Its `text` is then JSON:

```json
{ "reply": "The garage door is closed.", "next": "<cursor>" }
```

Show `reply`, and call `speak_next` with `reply` as `text` and that `next`
for the audio. `ask_assistant` does not wait for any audio, so the reply
never runs out of time behind it; the first `speak_next` may take a little
longer while Home Assistant starts on the speech. When the reply cannot be
spoken, `next` is missing and `speech_error` says why; when there is
nothing in it to say, both are missing.

`speak` and `speak_next` need only `Location` and `InvokeAction`: no entity
has to be shared, and the assistant switch does not apply. The voice comes
from the wearer's pipeline, so speech from a paid cloud engine is paid for
by the wearer. Speech needs a Home Assistant recent enough to make WAV at
the rate asked for, as the watch app's own spoken answers do.

A small library for the watch side, to play these slices through the
speaker, is on its way. Until then, the format above is all you need, and
the watch app's own player (`src/simply/simply_speaker.c`) decodes the same
stream.

## Errors

A failed action resolves `{ ok: false, code, message }`, and a failed source
calls `onError({ code, message })`. The `message` is a plain sentence, fine
to show the wearer.

| Code | When | What to do |
| --- | --- | --- |
| `AUTH_REQUIRED` | Home Assistant is not set up in Home Assistant WS yet, or Home Assistant refused its token. | Ask the wearer to open Home Assistant WS's settings. A refused token is not tried again for 30 minutes, or until it changes. |
| `PERMISSION_DENIED` | Your app lacks a permission, or the wearer said no. The entity is not shared. The wearer's unlocking or assistant switch is off. A service `call_service` does not allow. The Home Assistant user may not do that, or Home Assistant answered 403. The Pebble app does not allow Home Assistant WS the network. | Show the message. Do not retry until something changes. |
| `INVALID_ARGS` | A missing or wrong argument, such as a speech cursor sent with other text. The entity cannot do that (a light that cannot dim, a player that cannot skip, `set_on` with `false` on a lock). Home Assistant did not accept the call. | Fix the call, or hide the control. `supported_features` and `color_modes` tell you beforehand. |
| `PLUGIN_UNAVAILABLE` | Home Assistant cannot be reached, or the entity is no longer in Home Assistant. Also from the Pebble app when the plugin is not installed or has no such source or action. | Show it and try later. After a failure to connect, the plugin answers this at once for 30 seconds without trying. |
| `TIMEOUT` | No answer in time. The Pebble app gives each request 20 seconds. | Try again later. |
| `UNKNOWN` | Home Assistant failed to do it (a service that errored), the assistant could not answer, or the speech could not be made (`Home Assistant could not say that`). Also `The speech changed in Home Assistant; start again with speak`. | Show the message. For the speech change, start again with `speak`. |

## Limits and good manners

- **One request at a time.** The phone runs the plugin's requests one
  after another, each in a fresh JS engine, and stops each after 20
  seconds. A burst of actions waits in line, so send one per press, not
  one per frame.
- **Refreshing.** While you are subscribed, each source is polled at its
  own pace: every 30 seconds for lights, switches, binary sensors, covers,
  locks, media players, alarms and `home/entity`; 60 for sensors,
  thermostats and custom values; 120 for people and scenes; 5 minutes for
  calendars and to-do lists; 15 minutes for weather. Each answer's
  `validUntilMs` is the time of the next poll. An action that changes
  something refreshes its sources at once, and so does the wearer saving
  their settings. Unsubscribe when you are not showing the data.
- **Caching.** States are kept for 10 seconds, so several apps or sources
  read together share one fetch. Custom values are kept 15 seconds,
  calendars 5 minutes, history 5 minutes, forecasts 15 minutes, rooms an
  hour and Home Assistant's temperature unit a day. When Home Assistant
  cannot give the history, it is not asked again for 5 minutes.
- **Ask for what you draw.** Name your `properties`. `history`, weather
  series and pictures cost Home Assistant real work and only come when
  asked for. Leave `iconPixelSize` out if you draw no pictures, and keep it
  to the size you draw.
- **Keep text short on the watch.** `shortText` is meant for labels, but
  names come as the wearer wrote them. Trim to what your layout fits.
- **What the wearer controls.** Which entities and values are shared, and
  in what order; whether apps may use the assistant; whether apps may
  unlock; and every permission in the Pebble app. Any of these can change
  between two reads, so handle `PERMISSION_DENIED` and an entity that
  disappears.
- **Privacy.** Your app never sees the Home Assistant address or token.
  It only reaches what the wearer shared. People come with their zone,
  never coordinates. The plugin never uses remembered lock or alarm codes,
  callers cannot send templates, and `call_service` stays on the one
  entity named. Please treat what you read the same way: keep it on the
  watch and the phone.

## Testing your app

[pebble-ha-plugin-tests](https://github.com/skylord123/pebble-ha-plugin-tests)
has two small apps built against this plugin, with ready pbws on its
latest release:

- **HA Plugin Tester**, a watch app that reaches every source and action,
  shows the raw replies, and tries the cases that should be refused. Its
  PebbleKit JS is a full example of reading sources and calling actions.
- **HA Plugin Face**, a watchface that shows the weather with its picture
  and the first shared entities, the way any face would.

Its `scripts/manifest_v2.py` marks a pbw built from `package.json` with
`"manifestVersion": 2`.

If you work on the plugin itself, `node --test tests/plugin` (Node 22,
nothing to install) runs it against a fake Home Assistant. How the plugin
is built and how it works inside is in [INTERNALS.md](INTERNALS.md).
