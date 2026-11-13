'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');
const fixtures = require('./fixtures');

//! As the watch app and the settings page save them: with the name where they know it
const SHARED = [
    { entity_id: 'todo.chores', name: 'Chores' },
    { entity_id: 'todo.shopping_list', name: 'Shopping List' },
    'todo.errands',
    'light.kitchen'
];
const DUE = '2026-06-16T09:00:00-06:00';

function setUp(extra) {
    const h = harness.create();
    h.states(fixtures.states(h.now()));
    h.settings(Object.assign({ plugin_exposed_entities: SHARED }, extra || {}));
    return h;
}

function onlyCall(h) {
    const calls = h.ha.serviceCalls();
    assert.equal(calls.length, 1, 'expected one service call, got ' + JSON.stringify(calls));
    return calls[0];
}

function configured(answer) {
    assert.ok(answer.data, JSON.stringify(answer.error));
    return answer.data.instances[0].properties.configured.boolean.value;
}

test('reminders/configured needs Home Assistant and a shared to-do list, and asks nothing', async () => {
    let h = harness.create();
    assert.equal(configured(await h.source('reminders', 'configured')), false);

    h.settings({ plugin_exposed_entities: ['light.kitchen'] });
    assert.equal(configured(await h.source('reminders', 'configured')), false);

    h.settings({ plugin_exposed_entities: SHARED });
    assert.equal(configured(await h.source('reminders', 'configured', { properties: ['configured'] })), true);
    assert.equal(h.ha.requests.length, 0);

    // Shared, but no Home Assistant to add to
    h = harness.create();
    h.localStorage.setItem('options:' + h.uuid, JSON.stringify({ plugin_exposed_entities: SHARED }));
    assert.equal(configured(await h.source('reminders', 'configured')), false);
});

test('reminders/list names the shared to-do lists in their order, without asking Home Assistant', async () => {
    const h = setUp();
    const answer = await h.source('reminders', 'list', { properties: ['name'] });
    assert.deepEqual(answer.data.instances, [
        { instanceId: 'todo.chores', properties: { name: { shortText: { text: 'Chores' } } } },
        { instanceId: 'todo.shopping_list', properties: { name: { shortText: { text: 'Shopping List' } } } },
        { instanceId: 'todo.errands', properties: { name: { shortText: { text: 'Errands' } } } }
    ]);
    assert.equal(h.ha.requests.length, 0);
});

test('reminders/list is AUTH_REQUIRED until Home Assistant is set up', async () => {
    const h = harness.create();
    assert.equal((await h.source('reminders', 'list')).error.code, 'AUTH_REQUIRED');
});

test('create_reminder adds the item to the list named, and says so', async () => {
    const h = setUp();
    const answer = await h.action('create_reminder', { title: ' Milk ', instanceId: 'todo.shopping_list' });
    assert.deepEqual(answer.ok, { text: 'Added Milk to Shopping List.', refreshed: ['reminders/list', 'home/entity'] });
    assert.deepEqual(onlyCall(h), {
        service: 'todo.add_item', data: { entity_id: 'todo.shopping_list', item: 'Milk' }, query: {}
    });
});

test('without a list, create_reminder uses the first one shared', async () => {
    const h = setUp();
    const answer = await h.action('create_reminder', { title: 'Take out the bins' });
    assert.equal(answer.ok.text, 'Added Take out the bins to Chores.');
    assert.equal(onlyCall(h).data.entity_id, 'todo.chores');
});

test('a due time is kept with its time, as a date, or left off, as each list allows', async () => {
    const args = { title: 'Call the plumber', due_iso: DUE, timezone: 'America/Denver', notify_before_ms: 3600000 };

    let h = setUp();
    let answer = await h.action('create_reminder', Object.assign({ instanceId: 'todo.chores' }, args));
    assert.equal(answer.ok.text, 'Added Call the plumber to Chores, due 2026-06-16 09:00.');
    assert.deepEqual(onlyCall(h).data, { entity_id: 'todo.chores', item: 'Call the plumber', due_datetime: DUE });

    h = setUp();
    answer = await h.action('create_reminder', Object.assign({ instanceId: 'todo.errands' }, args));
    assert.equal(answer.ok.text, 'Added Call the plumber to Errands, due 2026-06-16.');
    assert.deepEqual(onlyCall(h).data, { entity_id: 'todo.errands', item: 'Call the plumber', due_date: '2026-06-16' });

    h = setUp();
    answer = await h.action('create_reminder', Object.assign({ instanceId: 'todo.shopping_list' }, args));
    assert.equal(answer.ok.text, 'Added Call the plumber to Shopping List, without a due date: the list cannot keep one.');
    assert.deepEqual(onlyCall(h).data, { entity_id: 'todo.shopping_list', item: 'Call the plumber' });
});

test('create_reminder refuses lists that are not shared, and anything that is not a list', async () => {
    const h = setUp();
    h.ha.statesById['todo.secret'] = { entity_id: 'todo.secret', state: '1', attributes: { supported_features: 1 } };
    assert.equal((await h.action('create_reminder', { title: 'x', instanceId: 'todo.secret' })).error.code, 'PERMISSION_DENIED');
    assert.equal((await h.action('create_reminder', { title: 'x', instanceId: 'light.kitchen' })).error.code, 'INVALID_ARGS');
    assert.equal((await h.action('create_reminder', { title: 'x', instanceId: 'todo.a,todo.b' })).error.code, 'INVALID_ARGS');
    assert.equal(h.ha.serviceCalls().length, 0);

    h.settings({ plugin_exposed_entities: ['light.kitchen'] });
    assert.equal((await h.action('create_reminder', { title: 'x' })).error.code, 'PERMISSION_DENIED');
    assert.equal(h.ha.serviceCalls().length, 0);
});

test('create_reminder needs a title and a due time it can read', async () => {
    const h = setUp();
    assert.equal((await h.action('create_reminder', { title: '  ' })).error.code, 'INVALID_ARGS');
    assert.equal((await h.action('create_reminder', { title: 'x', due_iso: 'tomorrow' })).error.code, 'INVALID_ARGS');
    assert.equal((await h.action('create_reminder', { title: 'x', due_iso: 1781600000 })).error.code, 'INVALID_ARGS');
    assert.equal(h.ha.serviceCalls().length, 0);
});

test('a list that cannot take new items, or is gone, is refused before anything is added', async () => {
    const h = setUp({ plugin_exposed_entities: ['todo.read_only', 'todo.deleted'] });
    h.ha.statesById['todo.read_only'] = { entity_id: 'todo.read_only', state: '4',
        attributes: { friendly_name: 'Calendar tasks', supported_features: 0 } };
    const refused = await h.action('create_reminder', { title: 'x' });
    assert.deepEqual(refused.error, { code: 'INVALID_ARGS', message: 'Calendar tasks cannot take new items' });
    assert.equal((await h.action('create_reminder', { title: 'x', instanceId: 'todo.deleted' })).error.code,
        'PLUGIN_UNAVAILABLE');
    assert.equal(h.ha.serviceCalls().length, 0);
});

test('create_reminder goes through without the assistant being shared', async () => {
    const h = setUp({ plugin_share_assistant: false });
    assert.ok((await h.action('create_reminder', { title: 'Eggs' })).ok);
});

function listProps(answer) {
    assert.ok(answer.data, JSON.stringify(answer.error));
    const out = {};
    answer.data.instances.forEach((i) => { out[i.instanceId] = i.properties; });
    return out;
}

test('reminders/list counts the open items, and lists the first few when asked', async () => {
    const h = setUp();
    const items = fixtures.todoItems();
    Object.keys(items).forEach((id) => h.todoItems(id, items[id]));

    const all = listProps(await h.source('reminders', 'list'));
    assert.deepEqual(Object.keys(all), ['todo.chores', 'todo.shopping_list', 'todo.errands']);
    assert.deepEqual(all['todo.shopping_list'], {
        name: { shortText: { text: 'Shopping List' } },
        count: { numericValue: { value: 3 }, shortText: { text: '3' } },
        items: { longText: { text: 'Milk\nBread\nCoffee' } }
    });
    assert.deepEqual(all['todo.errands'].items, { longText: { text: '' } });
    assert.deepEqual(h.ha.serviceCalls(), [{
        service: 'todo.get_items', query: { return_response: '' },
        data: { entity_id: ['todo.chores', 'todo.shopping_list', 'todo.errands'], status: 'needs_action' }
    }]);

    // The count is the list's state; the items are only fetched for a caller that wants them
    const counted = listProps(await h.source('reminders', 'list', { properties: ['name', 'count'] }));
    assert.deepEqual(counted['todo.chores'].count.numericValue, { value: 2 });
    assert.equal(counted['todo.chores'].items, undefined);
    assert.equal(h.ha.serviceCalls().length, 1);
});

test('only five items are listed', async () => {
    const h = setUp();
    h.todoItems('todo.chores', [1, 2, 3, 4, 5, 6, 7].map((n) => ({ uid: String(n), summary: 'Job ' + n, status: 'needs_action' })));
    const props = listProps(await h.source('reminders', 'list', { properties: ['items'] }));
    assert.equal(props['todo.chores'].items.longText.text, 'Job 1\nJob 2\nJob 3\nJob 4\nJob 5');
});

test('a Home Assistant that cannot answer services over REST still gets its counts served', async () => {
    const h = setUp();
    h.ha.on('POST', '/api/services/todo/get_items', () => ({ status: 400,
        body: { message: 'Service call requires responses but caller did not ask for responses' } }));
    const props = listProps(await h.source('reminders', 'list'));
    assert.deepEqual(props['todo.shopping_list'].count.shortText, { text: '3' });
    assert.equal(props['todo.shopping_list'].items, undefined);
});

test('reading the counts leaves out a list Home Assistant no longer has, and an unavailable count', async () => {
    const h = setUp({ plugin_exposed_entities: ['todo.deleted', 'todo.chores'] });
    h.ha.statesById['todo.chores'].state = 'unavailable';
    const answer = await h.source('reminders', 'list', { properties: ['count'] });
    assert.deepEqual(answer.data.instances, [
        { instanceId: 'todo.chores', properties: { name: { shortText: { text: 'Chores' } } } }
    ]);
});
