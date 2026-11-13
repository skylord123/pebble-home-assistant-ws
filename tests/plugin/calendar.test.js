'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');
const fixtures = require('./fixtures');

function setUp(shared) {
    const h = harness.create();
    h.states(fixtures.states(h.now()));
    h.ha.calendars = fixtures.calendars(h.now());
    h.settings({
        plugin_exposed_entities: shared || ['calendar.family', 'calendar.work', 'light.kitchen'],
        plugin_weather_entities: []
    });
    return h;
}

function events(answer) {
    assert.ok(answer.data, 'expected data, got ' + JSON.stringify(answer.error));
    return answer.data.instances;
}

function names(answer) {
    return events(answer).map((i) => i.properties.name.shortText.text);
}

test('calendar/event serves the next ten events across the shared calendars, soonest first', async () => {
    const h = setUp();
    const answer = await h.source('calendar', 'event');
    // Breakfast is over; School run is under way; Dentist and Standup start
    // together and keep the wearer's order of calendars
    assert.deepEqual(names(answer), ['Bin day', 'School run', 'Dentist', 'Standup', 'Focus time',
        'Focus time', 'Dinner with Sam', 'Focus time', 'Focus time', 'Focus time']);
    assert.deepEqual(events(answer).map((i) => i.instanceId), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
});

test('an event has the phone calendar\'s properties and shapes', async () => {
    const h = setUp();
    const list = events(await h.source('calendar', 'event'));

    const run = list[1].properties;
    assert.deepEqual(run.name, { shortText: { text: 'School run' }, longText: { text: 'School run' } });
    assert.deepEqual(run.location, { shortText: { text: 'Elm Street' }, longText: { text: 'Elm Street' } });
    assert.deepEqual(run.starts_at, {
        shortText: { text: '08:30' }, longText: { text: '08:30' },
        timestamp: { value: Date.parse('2026-06-15T08:30:00-06:00') / 1000 }
    });
    assert.deepEqual(run.ends_at, {
        shortText: { text: '09:30' }, timestamp: { value: Date.parse('2026-06-15T09:30:00-06:00') / 1000 }
    });
    assert.deepEqual(run.all_day, { boolean: { value: false } });
    assert.deepEqual(run.calendar, { shortText: { text: 'Family' } });

    // A whole day runs from the phone's midnight to the next
    const bins = list[0].properties;
    assert.deepEqual(bins.starts_at.shortText, { text: 'All day' });
    assert.deepEqual(bins.ends_at.shortText, { text: 'All day' });
    assert.equal(bins.starts_at.timestamp.value, Date.parse('2026-06-15T00:00:00-06:00') / 1000);
    assert.equal(bins.ends_at.timestamp.value, Date.parse('2026-06-16T00:00:00-06:00') / 1000);
    assert.deepEqual(bins.all_day, { boolean: { value: true } });
    // An empty location is left out, as the phone's own source does
    assert.equal(bins.location, undefined);
    assert.deepEqual(list[3].properties.calendar, { shortText: { text: 'Work' } });
});

test('each calendar is asked for the next seven days once, then kept a few minutes', async () => {
    const h = setUp();
    await h.source('calendar', 'event');
    const calls = h.ha.calls(/^GET \/api\/calendars\//);
    assert.deepEqual(calls.map((c) => c.path), ['/api/calendars/calendar.family', '/api/calendars/calendar.work']);
    assert.equal(Date.parse(calls[0].query.start), h.now());
    assert.equal(Date.parse(calls[0].query.end), h.now() + 7 * 86400000);

    h.advance(4 * 60000);
    await h.source('calendar', 'event');
    assert.equal(h.ha.calls(/^GET \/api\/calendars\//).length, 2);
    h.advance(2 * 60000);
    await h.source('calendar', 'event');
    assert.equal(h.ha.calls(/^GET \/api\/calendars\//).length, 4);
});

test('an event that ends drops out of the list even from the cache', async () => {
    const h = setUp();
    h.advance(27 * 60000);
    assert.equal(names(await h.source('calendar', 'event'))[1], 'School run');
    // 09:31, and the events fetched at 09:27 are still kept
    h.advance(4 * 60000);
    assert.equal(names(await h.source('calendar', 'event'))[1], 'Dentist');
    assert.equal(h.ha.calls(/^GET \/api\/calendars\//).length, 2);
});

test('only shared calendars are read', async () => {
    const h = setUp(['calendar.work', 'light.kitchen']);
    const answer = await h.source('calendar', 'event');
    assert.ok(events(answer).every((i) => i.properties.calendar.shortText.text === 'Work'));
    assert.equal(h.ha.calls(/calendar\.family/).length, 0);

    const none = setUp(['light.kitchen']);
    assert.deepEqual(events(await none.source('calendar', 'event')), []);
    assert.equal(none.ha.requests.length, 0);
});

test('a calendar Home Assistant cannot read leaves the others', async () => {
    const h = setUp();
    h.ha.on('GET', '/api/calendars/calendar.family', () => ({ status: 400, body: { message: 'Error reading events' } }));
    const answer = await h.source('calendar', 'event');
    assert.ok(names(answer).length > 0);
    assert.ok(events(answer).every((i) => i.properties.calendar.shortText.text === 'Work'));
});

test('calendar entities are still served as plain entities too', async () => {
    const h = setUp();
    const answer = await h.source('home', 'entity');
    assert.deepEqual(answer.data.instances.map((i) => i.instanceId), ['calendar.family', 'calendar.work', 'light.kitchen']);
});
