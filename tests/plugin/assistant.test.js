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

test('with json, the caller keeps its own conversation and the shared one is left alone', async () => {
    const h = setUp();
    let n = 0;
    h.ha.assist = (command) => ({
        conversation_id: command.conversation_id || 'conv-' + (++n),
        continue_conversation: command.input.text === 'ask me',
        response: { response_type: 'query_answer', speech: { plain: { speech: '**Answer** ' + n } } }
    });
    // The shared conversation, as Index or another app has it
    await h.action('ask_assistant', { text: 'shared one' });
    assert.equal(h.stored('conversation').value, 'conv-1');

    const first = await h.action('ask_assistant', { text: 'mine', json: true, new_conversation: false });
    assert.ok(first.ok.refreshed.includes('home/light'));
    assert.deepEqual(JSON.parse(first.ok.text), {
        reply: '**Answer** 2', conversation_id: 'conv-2', response_type: 'query_answer', continue_conversation: false
    });
    const second = JSON.parse((await h.action('ask_assistant', { text: 'ask me', json: true, conversation_id: 'conv-2' })).ok.text);
    assert.equal(second.conversation_id, 'conv-2');
    assert.equal(second.continue_conversation, true);

    // Neither read nor written: the shared one carries on where it was
    assert.equal(h.stored('conversation').value, 'conv-1');
    await h.action('ask_assistant', { text: 'shared two' });
    assert.deepEqual(runs(h).map((c) => [c.input.text, c.conversation_id]), [
        ['shared one', undefined], ['mine', undefined], ['ask me', 'conv-2'], ['shared two', 'conv-1']
    ]);
});

test('with json, an answer without an id keeps the one sent, and continue_conversation only comes when Home Assistant says', async () => {
    const h = setUp();
    h.ha.assist = () => ({ response: { response_type: 'action_done', speech: {} } });
    assert.deepEqual(JSON.parse((await h.action('ask_assistant', { text: 'lights on', json: true, conversation_id: 'abc' })).ok.text),
        { reply: 'Done.', conversation_id: 'abc', response_type: 'action_done' });
    assert.deepEqual(JSON.parse((await h.action('ask_assistant', { text: 'lights on', json: true })).ok.text),
        { reply: 'Done.', conversation_id: null, response_type: 'action_done' });
});

test('with json, a bad conversation_id is INVALID_ARGS, and the errors stay errors', async () => {
    const h = setUp();
    for (const id of [42, 'x'.repeat(201), {}]) {
        assert.equal((await h.action('ask_assistant', { text: 'hi', json: true, conversation_id: id })).error.code, 'INVALID_ARGS');
    }
    assert.equal(h.ha.sockets.length, 0);
    h.ha.assist = () => ({ response: { response_type: 'error', speech: { plain: { speech: 'Sorry, I did not understand' } } } });
    assert.deepEqual((await h.action('ask_assistant', { text: 'blorp', json: true })).error,
        { code: 'UNKNOWN', message: 'Sorry, I did not understand' });

    const off = setUp({ plugin_share_assistant: false });
    assert.equal((await off.action('ask_assistant', { text: 'hi', json: true })).error.code, 'PERMISSION_DENIED');
});

test('without json, conversation_id is ignored and the answer is plain text', async () => {
    const h = setUp();
    const answer = await h.action('ask_assistant', { text: 'hi', conversation_id: 'mine' });
    assert.equal(answer.ok.text, 'Turned on the kitchen light.');
    assert.equal(runs(h)[0].conversation_id, undefined);
});

test('the manifest offers json and conversation_id on ask_assistant, for watch apps only', () => {
    const action = harness.manifest().actions.find((a) => a.name === 'ask_assistant');
    assert.equal(action.parameters.properties.json.type, 'boolean');
    assert.match(action.parameters.properties.json.description, /^For watch apps keeping their own conversation only/);
    assert.equal(action.parameters.properties.conversation_id.type, 'string');
    assert.deepEqual(action.parameters.required, ['text']);
});
