# Plugin

This is a proof of concept. It lets other watchfaces and apps read Home
Assistant through this app, and control it, using the Core Devices plugin
system. That system is experimental: the Pebble app only runs plugins from
sideloaded pbws, and only with **Use experimental plugins** turned on.

The plugin serves two things:

- the entities the wearer chooses to share, through **Expose to Plugins** on an
  entity's page on the watch or **Shared with Other Apps** in the settings page;
- every `weather.*` entity, which is always shared.

Anything that has not been shared is refused with `PERMISSION_DENIED`, for
reads and for actions alike.

## How it is built

- `plugin/js/` is a separate bundle. It is built with the same module loader as
  the app (`wscript`, `concat_javascript`) and written to
  `build/plugin/plugin.js`.
- `plugin/manifest.json` becomes the `plugin` block of the pbw's
  `appinfo.json`.
- `waftools/bundle_config_page.py` adds the script and the manifest to the pbw
  after `pebble build` has zipped it. The build log says
  `Bundled the plugin into build/…pbw as plugin.js`.
- Phone apps that do not know about plugins ignore both.

The phone starts a fresh JS engine for every request, so the plugin has no
WebSocket and no timers. It reads the same `localStorage` as the watch app
(same UUID):

| What it reads | Where it comes from |
| --- | --- |
| URL, token, shared list, assistant switch | the `options:<uuid>` object the settings page saves |
| Weather entity list | `plugin_weather_entities`, which the watch app writes once it has the states |

Before the watch app has written the weather list, the plugin finds the
weather entities itself and caches them for an hour.

Everything the plugin caches is stored under a `plugin:` prefix:

- entity states, for 10 s;
- forecasts, for 15 min;
- a marker for a token Home Assistant refused. While a token is marked, the
  plugin returns `AUTH_REQUIRED` straight away instead of asking again with a
  token it knows is bad.

The plugin never logs the URL or the token. It never uses the lock and alarm
codes the watch app remembers; a code has to come from the caller.

## Sources

Every entity is an instance whose `instanceId` is its `entity_id`. Every
instance includes these properties:

- `name`;
- `last_changed` and `last_updated`, as timestamps.

| Source | Domains | Other properties |
| --- | --- | --- |
| `home/entity` | everything shared, plus weather | `state`, `on`, `domain` |
| `home/light` | light | `on`, `brightness`, `color_temp` |
| `home/switch` | switch, input_boolean, fan, automation, siren, humidifier, remote | `on`, `speed` |
| `home/sensor` | sensor, number, input_number, counter | `value`, `device_class` |
| `home/binary_sensor` | binary_sensor | `on`, `state` (e.g. Open/Closed by device class), `device_class` |
| `home/climate` | climate, water_heater | `current_temperature`, `target_temperature`, `on`, `hvac_mode`, `hvac_action`, `summary` |
| `home/cover` | cover, valve | `open`, `position`, `state` |
| `home/lock` | lock | `locked`, `state` |
| `home/media_player` | media_player | `on`, `playing`, `state`, `title`, `artist`, `volume` |
| `home/person` | person, device_tracker | `home`, `zone`, `since` (never coordinates) |
| `home/scene` | scene, script, button, input_button | `running`, `last_run` |
| `home/alarm` | alarm_control_panel | `armed`, `state` |
| `weather/location` | weather | `temperature`, `feels_like`, `high`, `low`, `condition`, `condition_code`, `uv_index`, `precipitation` |
| `weather/hour` | weather | `temperature`, `condition`, `condition_code`, `time` |

Notes on the weather sources:

- `weather/location` has one instance per weather entity.
- `weather/hour` has the next six hours of `weather.home`, or of the first
  weather entity if there is no `weather.home`.
- `condition_code` uses the same words as the phone's own weather: `sun`,
  `partly_cloudy`, `light_rain` and so on.

The phone's built-in weather plugin also answers `weather/location` and
`weather/hour`, and it is asked first. To get Home Assistant's weather, name
this app's UUID in the request:

```js
{ category: 'weather', item: 'location', plugin: '61ae3254-ce00-49db-aad8-23143f649b90' }
```

## Actions

Every entity action takes `instanceId`. Each action returns a line saying what
happened, and asks the sources that show that entity to refresh.

| Action | Does |
| --- | --- |
| `set_on` `{ on }` | On or off. For covers and valves, opens or closes them. Takes the same arguments as the Hue plugin's action. |
| `toggle` | Toggles. A locked lock is refused: use `unlock`. |
| `activate` | Runs a scene or script, presses a button, or triggers an automation. |
| `set_brightness` `{ percent }` | Sets a light's brightness. |
| `set_temperature` `{ temperature }` | Sets the target temperature. |
| `set_hvac_mode` `{ hvac_mode }` | Sets the heating or cooling mode. |
| `set_position` `{ position }` | Sets a cover's position. |
| `open` `{ code? }`, `close`, `stop` | Covers and valves. `open` also unlatches a lock. |
| `lock` `{ code? }`, `unlock` `{ code? }` | Locks and unlocks. |
| `alarm_arm` `{ mode?, code? }`, `alarm_disarm` `{ code? }` | Alarm panels. `mode` is `home`, `away` (the default), `night`, `vacation` or `custom_bypass`. |
| `set_playing` `{ playing }`, `next_track`, `previous_track`, `set_volume` `{ percent }` | Media players. |
| `call_service` `{ service, data? }` | Any other service of the entity's own domain, called on that entity only. See below. |
| `ask_assistant` `{ text, new_conversation? }` | Asks Home Assistant's assistant and returns what it said. See below. |

Three actions ask the wearer before running: `unlock`, `alarm_disarm` and
`open`. That confirmation cannot be skipped another way:

- `toggle` never unlocks a lock.
- `call_service` refuses `lock.unlock`, `lock.open` and
  `alarm_control_panel.alarm_disarm`.
- `call_service` drops any target (`entity_id`, `device_id`, `area_id`,
  `floor_id`, `label_id`) from `data`.

`ask_assistant` is off until the wearer turns on **Share with Apps** under
Voice. It uses the pipeline chosen in the app, and it continues the same
conversation if asked again within five minutes.

## Trying it

1. Build and sideload the pbw.
2. Turn on **Use experimental plugins** in the Pebble app.
3. Open the settings page from the Pebble app and share a few entities. When
   the settings page can reach the plugin, the status line under
   **Shared with Other Apps** says so.
4. Any consumer can then read and control them, for example the Core Devices
   Dashboard demo.

The phone keeps the manifest from when the app was installed. After changing
`manifest.json`, bump `versionLabel` in `appinfo.json` so the phone reads it
again.

## Settings page messages

The settings page (v1.7 and later) sends messages to the plugin with
`Pebble.sendMessage('plugin', …)`:

| Request | Reply |
| --- | --- |
| `{ type: 'status' }` | `{ ok, shared, weather, assistant }`, or `{ ok: false, error: { code, message } }`. Checks that the plugin can reach Home Assistant. |
| `{ type: 'refresh' }` | `{ ok }`. Asks every source to refresh. The page sends it after a save. |
