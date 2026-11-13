'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');

function setUp(extra) {
    const h = harness.create();
    h.states([{ entity_id: 'light.kitchen', state: 'off', attributes: { friendly_name: 'Kitchen' } }]);
    h.settings(Object.assign({
        plugin_exposed_entities: ['light.kitchen'],
        plugin_share_assistant: true
    }, extra || {}));
    return h;
}

function runs(h) {
    return h.ha.commands().filter((c) => c.type === 'assist_pipeline/run');
}

test('ask_assistant logs in over the WebSocket, runs the pipeline and returns its reply', async () => {
    const h = setUp({ selected_pipeline: 'p2', available_pipelines: [{ id: 'p1' }, { id: 'p2' }] });
    const answer = await h.action('ask_assistant', { text: '  turn on the kitchen light ' });
    assert.equal(answer.ok.text, 'Turned on the kitchen light.');
    assert.ok(answer.ok.refreshed.includes('home/light'));

    assert.equal(h.ha.sockets.length, 1);
    const socket = h.ha.sockets[0];
    assert.equal(socket.url, 'ws://ha.test:8123/api/websocket');
    assert.deepEqual(socket.received[0], { type: 'auth', access_token: harness.TOKEN });
    assert.deepEqual(runs(h), [{
        type: 'assist_pipeline/run', start_stage: 'intent', end_stage: 'intent',
        input: { text: 'turn on the kitchen light' }, pipeline: 'p2', id: 1
    }]);
    assert.equal(socket.readyState, 3, 'the socket was left open');
});

test('the conversation carries on for five minutes, unless a new one is asked for', async () => {
    const h = setUp();
    let n = 0;
    h.ha.assist = (command) => ({
        conversation_id: command.conversation_id || 'conv-' + (++n),
        response: { response_type: 'query_answer', speech: { plain: { speech: 'Answer' } } }
    });
    await h.action('ask_assistant', { text: 'one' });
    await h.action('send_to_agent', { message: 'two', chat_id: 'ignored' });
    await h.action('ask_assistant', { text: 'three', new_conversation: true });
    h.advance(6 * 60000);
    await h.action('ask_assistant', { text: 'four' });
    assert.deepEqual(runs(h).map((c) => [c.input.text, c.conversation_id]), [
        ['one', undefined], ['two', 'conv-1'], ['three', undefined], ['four', undefined]
    ]);
});

test('a deleted pipeline gives way to the preferred one', async () => {
    const h = setUp({ selected_pipeline: 'gone', available_pipelines: [{ id: 'p1' }] });
    await h.action('ask_assistant', { text: 'hi' });
    assert.equal(runs(h)[0].pipeline, undefined);
});

test('ask_assistant and send_to_agent are refused until Share with Apps is on', async () => {
    const h = setUp({ plugin_share_assistant: false });
    for (const [name, args] of [['ask_assistant', { text: 'unlock the door' }], ['send_to_agent', { message: 'hi' }]]) {
        const answer = await h.action(name, args);
        assert.equal(answer.error.code, 'PERMISSION_DENIED');
    }
    assert.equal(h.ha.sockets.length, 0);
});

test('an empty question is INVALID_ARGS', async () => {
    const h = setUp();
    assert.equal((await h.action('ask_assistant', { text: '   ' })).error.code, 'INVALID_ARGS');
    assert.equal((await h.action('send_to_agent', {})).error.code, 'INVALID_ARGS');
    assert.equal(h.ha.sockets.length, 0);
});

test('an agent error or a pipeline error comes back as UNKNOWN with its message', async () => {
    const h = setUp();
    h.ha.assist = () => ({ response: { response_type: 'error', speech: { plain: { speech: 'Sorry, I did not understand' } } } });
    assert.deepEqual((await h.action('ask_assistant', { text: 'blorp' })).error,
        { code: 'UNKNOWN', message: 'Sorry, I did not understand' });

    h.ha.assist = () => ({ event: { type: 'error', data: { code: 'intent-failed', message: 'Agent is not loaded' } } });
    assert.deepEqual((await h.action('ask_assistant', { text: 'hi' })).error,
        { code: 'UNKNOWN', message: 'Agent is not loaded' });

    h.ha.assist = () => ({ error: { code: 'pipeline-not-found', message: 'Pipeline p9 not found' } });
    assert.deepEqual((await h.action('ask_assistant', { text: 'hi' })).error,
        { code: 'INVALID_ARGS', message: 'Pipeline p9 not found' });
});

test('a reply with no speech still says something', async () => {
    const h = setUp();
    h.ha.assist = () => ({ response: { response_type: 'action_done', speech: {} } });
    assert.equal((await h.action('ask_assistant', { text: 'lights on' })).ok.text, 'Done.');
});

test('a token refused on the WebSocket is marked like one refused over REST', async () => {
    const h = setUp();
    h.ha.token = 'a-new-token';
    const answer = await h.action('ask_assistant', { text: 'hi' });
    assert.equal(answer.error.code, 'AUTH_REQUIRED');
    assert.ok(h.stored('auth_failed'));
    assert.equal((await h.action('ask_assistant', { text: 'hi' })).error.code, 'AUTH_REQUIRED');
    assert.equal(h.ha.sockets.length, 1, 'logged in again with a refused token');
});

test('a Home Assistant that cannot be reached is PLUGIN_UNAVAILABLE', async () => {
    const h = setUp();
    h.ha.reachable = false;
    const answer = await h.action('ask_assistant', { text: 'hi' });
    assert.equal(answer.error.code, 'PLUGIN_UNAVAILABLE');
    assert.ok(h.stored('unreachable'));
});

test('the assistant\'s work is read afresh, not from the cache', async () => {
    const h = setUp();
    await h.source('home', 'light');
    h.ha.statesById['light.kitchen'].state = 'on';
    await h.action('ask_assistant', { text: 'turn on the kitchen light' });
    const answer = await h.source('home', 'light');
    assert.deepEqual(answer.data.instances[0].properties.on.boolean, { value: true });
});
