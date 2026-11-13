/**
 * Home Assistant states as a real install reports them, at least one of each
 * kind the plugin serves and the variants that change what it builds (on and
 * off, unavailable, ranges, timestamps).
 */
'use strict';

const HOUR = 3600000;

function iso(ms) {
    return new Date(ms).toISOString();
}

function states(now) {
    const ago = iso(now - 10 * 60000);
    return [
        // Lights: dimmable with a white, on/off only, unavailable
        { entity_id: 'light.kitchen', state: 'on', attributes: {
            friendly_name: 'Kitchen', brightness: 128, color_temp_kelvin: 3000,
            min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500,
            supported_color_modes: ['color_temp', 'hs'], color_mode: 'color_temp', supported_features: 40 } },
        { entity_id: 'light.porch', state: 'off', attributes: {
            friendly_name: 'Porch', supported_color_modes: ['onoff'], supported_features: 0 } },
        { entity_id: 'light.garage', state: 'unavailable', attributes: { friendly_name: 'Garage light' } },

        // Switches and what is served as one
        { entity_id: 'switch.coffee', state: 'on', attributes: { friendly_name: 'Coffee maker' } },
        { entity_id: 'input_boolean.guest_mode', state: 'off', attributes: { friendly_name: 'Guest mode' } },
        { entity_id: 'fan.bedroom', state: 'on', attributes: {
            friendly_name: 'Bedroom fan', percentage: 66, percentage_step: 33.3, supported_features: 57 } },
        { entity_id: 'automation.night', state: 'on', attributes: {
            friendly_name: 'Night mode', last_triggered: ago, id: '1' } },
        { entity_id: 'siren.hall', state: 'unknown', attributes: { friendly_name: 'Hall siren' } },

        // Sensors: numeric, percentage, timestamp, text, a number with a range
        { entity_id: 'sensor.outside_temperature', state: '21.46', attributes: {
            friendly_name: 'Outside', unit_of_measurement: '°C', device_class: 'temperature', state_class: 'measurement' } },
        { entity_id: 'sensor.phone_battery', state: '87', attributes: {
            friendly_name: 'Phone battery', unit_of_measurement: '%', device_class: 'battery' } },
        { entity_id: 'sensor.last_boot', state: '2026-06-14T08:00:00+00:00', attributes: {
            friendly_name: 'Last boot', device_class: 'timestamp' } },
        // Few of these kinds carry supported_features, but some integrations add it
        { entity_id: 'sensor.washer_status', state: 'rinse_cycle', attributes: { friendly_name: 'Washer', supported_features: 0 } },
        { entity_id: 'number.volume_limit', state: '40', attributes: {
            friendly_name: 'Volume limit', min: 0, max: 80, step: 1, mode: 'slider' } },
        { entity_id: 'counter.coffees', state: '3', attributes: { friendly_name: 'Coffees', step: 1 } },

        // Binary sensors with and without a class
        { entity_id: 'binary_sensor.front_door', state: 'on', attributes: {
            friendly_name: 'Front door', device_class: 'door' } },
        { entity_id: 'binary_sensor.motion', state: 'off', attributes: {
            friendly_name: 'Hall motion', device_class: 'motion' } },
        { entity_id: 'binary_sensor.thing', state: 'on', attributes: { friendly_name: 'Thing', supported_features: 0 } },
        { entity_id: 'binary_sensor.gone', state: 'unavailable', attributes: { friendly_name: 'Gone' } },

        // Climate: one target, a heat_cool range, a water heater
        { entity_id: 'climate.living_room', state: 'heat', attributes: {
            friendly_name: 'Living room', current_temperature: 19.5, temperature: 21,
            min_temp: 7, max_temp: 35, target_temp_step: 0.5, temperature_unit: '°C',
            hvac_modes: ['off', 'heat', 'cool'], hvac_action: 'heating', supported_features: 385 } },
        { entity_id: 'climate.upstairs', state: 'heat_cool', attributes: {
            friendly_name: 'Upstairs', current_temperature: 22, target_temp_low: 19, target_temp_high: 24,
            min_temp: 7, max_temp: 35, hvac_modes: ['off', 'heat_cool'], supported_features: 386 } },
        { entity_id: 'water_heater.tank', state: 'eco', attributes: {
            friendly_name: 'Water heater', current_temperature: 50, temperature: 55, min_temp: 40, max_temp: 65,
            supported_features: 1 } },

        // Covers: a blind with a position, a garage door, a gate, a window, a valve
        { entity_id: 'cover.office_blind', state: 'open', attributes: {
            friendly_name: 'Office blind', current_position: 60, device_class: 'blind', supported_features: 15 } },
        { entity_id: 'cover.garage_door', state: 'closed', attributes: {
            friendly_name: 'Garage door', device_class: 'garage', supported_features: 11 } },
        { entity_id: 'cover.driveway_gate', state: 'closed', attributes: {
            friendly_name: 'Driveway gate', current_position: 0, device_class: 'gate', supported_features: 15 } },
        { entity_id: 'cover.window', state: 'closed', attributes: {
            friendly_name: 'Window', device_class: 'window', supported_features: 3 } },
        { entity_id: 'valve.garden', state: 'closed', attributes: {
            friendly_name: 'Garden valve', current_valve_position: 0, supported_features: 7 } },

        // Locks
        { entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front door lock', supported_features: 1 } },
        { entity_id: 'lock.shed', state: 'unlocked', attributes: { friendly_name: 'Shed', supported_features: 0 } },

        // Media players: playing with everything, off with nothing
        { entity_id: 'media_player.living_room', state: 'playing', attributes: {
            friendly_name: 'Living room speaker', media_title: 'So What', media_artist: 'Miles Davis',
            volume_level: 0.35, supported_features: 152461 } },
        { entity_id: 'media_player.tv', state: 'off', attributes: { friendly_name: 'TV', supported_features: 1 } },

        // People
        { entity_id: 'person.alex', state: 'home', attributes: {
            friendly_name: 'Alex', latitude: 40.01, longitude: -105.01, gps_accuracy: 10, source: 'device_tracker.alex' } },
        { entity_id: 'device_tracker.sam_phone', state: 'not_home', attributes: { friendly_name: 'Sam' } },
        { entity_id: 'person.jo', state: 'Work', attributes: { friendly_name: 'Jo', supported_features: 0 } },

        // Scenes, scripts, buttons
        { entity_id: 'scene.movie', state: ago, attributes: { friendly_name: 'Movie time' } },
        { entity_id: 'scene.never', state: 'unknown', attributes: { friendly_name: 'Never used' } },
        { entity_id: 'script.good_night', state: 'off', attributes: { friendly_name: 'Good night', last_triggered: ago } },
        { entity_id: 'button.restart_router', state: ago, attributes: { friendly_name: 'Restart router', supported_features: 0 } },
        { entity_id: 'input_button.doorbell', state: 'unknown', attributes: { friendly_name: 'Doorbell' } },

        // Alarm panels
        { entity_id: 'alarm_control_panel.house', state: 'armed_away', attributes: {
            friendly_name: 'House alarm', code_format: 'number', supported_features: 63 } },
        { entity_id: 'alarm_control_panel.shed', state: 'disarmed', attributes: { friendly_name: 'Shed alarm' } },

        // To-do lists, their state the number of open items: the Shopping List
        // keeps no due dates, Local To-do keeps a time, Google Tasks a date only
        { entity_id: 'todo.shopping_list', state: '3', attributes: { friendly_name: 'Shopping List', supported_features: 15 } },
        { entity_id: 'todo.chores', state: '2', attributes: { friendly_name: 'Chores', supported_features: 127 } },
        { entity_id: 'todo.errands', state: '0', attributes: { friendly_name: 'Errands', supported_features: 95 } },

        // Only served under home/entity
        { entity_id: 'select.washer_program', state: 'eco', attributes: {
            friendly_name: 'Washer program', options: ['eco', 'quick'] } },
        { entity_id: 'event.doorbell', state: ago, attributes: { friendly_name: 'Doorbell press', event_type: 'pressed' } },

        // Calendars: one in an event, one between events
        { entity_id: 'calendar.family', state: 'on', attributes: {
            friendly_name: 'Family', message: 'School run', all_day: false, location: 'Elm Street' } },
        { entity_id: 'calendar.work', state: 'off', attributes: { friendly_name: 'Work', message: 'Standup', all_day: false } },

        // Weather: the home's, with daily and hourly forecasts, and one with twice-daily only
        { entity_id: 'weather.home', state: 'partlycloudy', attributes: {
            friendly_name: 'Forecast Home', temperature: 18.4, apparent_temperature: 17.1, temperature_unit: '°C',
            humidity: 54, uv_index: 4.2, wind_speed: 12.6, wind_speed_unit: 'km/h', wind_bearing: 225,
            pressure: 1012, supported_features: 3 } },
        { entity_id: 'weather.nws', state: 'rainy', attributes: {
            friendly_name: 'NWS', temperature: 64, temperature_unit: '°F', humidity: 80,
            wind_speed: 9, wind_speed_unit: 'mph', supported_features: 6 } }
    ];
}

/** Areas of some of the entities above, as Home Assistant names them */
function areas() {
    return {
        'light.kitchen': 'Kitchen',
        'switch.coffee': 'Kitchen',
        'sensor.outside_temperature': 'Garden',
        'climate.living_room': 'Living room',
        'cover.office_blind': 'Office',
        'lock.front_door': 'Hall',
        'media_player.living_room': 'Living room',
        'person.alex': 'Hall',
        'scene.movie': 'Living room',
        'alarm_control_panel.house': 'Hall',
        'binary_sensor.front_door': 'Hall',
        'weather.home': 'Garden'
    };
}

/** A moment `day` days from today, at `hour` (fractions for minutes) in the phone's time zone */
function local(now, day, hour) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.getTime() + day * 86400000 + hour * HOUR;
}

function ymd(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * The calendars' events as /api/calendars/<id> lists them, with `now` at
 * 09:00: one already over, one under way, a whole day, two starting at
 * once, and more than the ten the source serves.
 */
function calendars(now) {
    const timed = (summary, day, from, to, extra) => Object.assign({
        summary: summary,
        start: { dateTime: iso(local(now, day, from)) },
        end: { dateTime: iso(local(now, day, to)) },
        description: '', location: null, uid: summary.toLowerCase().replace(/\W+/g, '-') + '-' + day,
        recurrence_id: null, rrule: null
    }, extra || {});
    const focus = [];
    for (let day = 0; day < 9; day++) {
        focus.push(timed('Focus time', day, 13, 15, { rrule: 'FREQ=DAILY' }));
    }
    return {
        'calendar.family': [
            timed('Breakfast', 0, 7, 8),
            timed('School run', 0, 8.5, 9.5, { location: 'Elm Street' }),
            { summary: 'Bin day', start: { date: ymd(local(now, 0, 0)) }, end: { date: ymd(local(now, 1, 0)) },
                description: '', location: '', uid: 'bins', recurrence_id: null, rrule: null },
            timed('Dentist', 0, 10, 10.5),
            timed('Dinner with Sam', 1, 18, 19.75, { location: 'Luigi\'s' })
        ],
        'calendar.work': [timed('Standup', 0, 10, 10.25)].concat(focus)
    };
}

/**
 * State changes over the last day and a bit, as the recorder keeps them: a
 * temperature that changes every half hour with an outage, a battery that
 * only changed twice, and a text sensor.
 */
function history(now) {
    const out = { 'sensor.outside_temperature': [], 'sensor.phone_battery': [], 'sensor.washer_status': [] };
    const start = now - 26 * HOUR;
    for (let t = start, i = 0; t <= now - 10 * 60000; t += HOUR / 2, i++) {
        // Down for two hours around six hours ago
        const down = t > now - 7 * HOUR && t < now - 5 * HOUR;
        out['sensor.outside_temperature'].push({ state: down ? 'unavailable' : String(10 + (i % 12)), last_changed: iso(t) });
    }
    out['sensor.phone_battery'].push({ state: '100', last_changed: iso(now - 30 * HOUR) });
    out['sensor.phone_battery'].push({ state: '87', last_changed: iso(now - 3 * HOUR) });
    out['sensor.washer_status'].push({ state: 'wash', last_changed: iso(now - 2 * HOUR) });
    out['sensor.washer_status'].push({ state: 'rinse_cycle', last_changed: iso(now - HOUR) });
    return out;
}

/** Forecasts for the weather entities above, from `now` on */
function forecasts(now) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const hourly = [];
    const firstHour = Math.ceil(now / HOUR) * HOUR;
    for (let i = 0; i < 30; i++) {
        hourly.push({
            datetime: iso(firstHour + i * HOUR),
            condition: i % 7 === 0 ? 'rainy' : 'partlycloudy',
            temperature: 15 + (i % 10),
            precipitation_probability: i % 7 === 0 ? 60 : 10,
            is_daytime: (i % 24) < 12
        });
    }
    const daily = [];
    for (let d = 1; d < 7; d++) {
        // Open-Meteo style: each day stamped at midnight UTC
        const date = new Date(midnight.getTime() + d * 86400000 + 12 * HOUR);
        daily.push({
            datetime: date.toISOString().slice(0, 10) + 'T00:00:00+00:00',
            condition: ['sunny', 'cloudy', 'pouring', 'snowy', 'lightning-rainy', 'fog'][d - 1],
            temperature: 20 + d,
            templow: 8 + d,
            precipitation_probability: d * 10,
            uv_index: d
        });
    }
    const halves = [];
    for (let d = 0; d < 4; d++) {
        const day = new Date(midnight.getTime() + d * 86400000);
        halves.push({ datetime: iso(day.getTime() + 6 * HOUR), condition: 'sunny', temperature: 70 + d, is_daytime: true,
            precipitation_probability: 5 });
        halves.push({ datetime: iso(day.getTime() + 18 * HOUR), condition: 'clear-night', temperature: 50 + d, is_daytime: false });
    }
    return {
        'weather.home': { daily: daily, hourly: hourly },
        'weather.nws': { twice_daily: halves, hourly: hourly }
    };
}

/** Items on the to-do lists above, done ones among them */
function todoItems() {
    const item = (uid, summary, status, extra) => Object.assign({ uid: uid, summary: summary, status: status }, extra || {});
    return {
        'todo.shopping_list': [item('1', 'Milk', 'needs_action'), item('2', 'Eggs', 'completed'),
            item('3', 'Bread', 'needs_action'), item('4', 'Coffee', 'needs_action')],
        'todo.chores': [item('5', 'Vacuum', 'needs_action', { due: '2026-06-16T18:00:00-06:00' }),
            item('6', 'Laundry', 'needs_action', { description: 'Darks first' })],
        'todo.errands': [item('7', 'Post office', 'completed')]
    };
}

module.exports = {
    states: states,
    forecasts: forecasts,
    todoItems: todoItems,
    areas: areas,
    calendars: calendars,
    history: history
};
