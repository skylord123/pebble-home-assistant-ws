/**
 * The speech kit's example app (sdk/speech/example) carries its own copies
 * of the kit, as any app would. CI builds it; these check it uses the kit as
 * it is now and declares what an app using the plugin must.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const harness = require('../plugin/harness');
const HaSpeech = require('../../sdk/speech/ha_speech');

const ROOT = path.join(__dirname, '..', '..');
const KIT = path.join(ROOT, 'sdk', 'speech');
const EXAMPLE = path.join(KIT, 'example');

test('the example\'s copies of the kit are byte for byte the kit', () => {
    for (const [copy, original] of [
        ['src/c/ha_speech.c', 'ha_speech.c'],
        ['src/c/ha_speech.h', 'ha_speech.h'],
        ['src/pkjs/ha_speech.js', 'ha_speech.js']
    ]) {
        assert.ok(fs.readFileSync(path.join(EXAMPLE, copy)).equals(fs.readFileSync(path.join(KIT, original))),
            copy + ' differs from sdk/speech/' + original + '; copy it again');
    }
});

test('the example declares the message key, the plugin\'s permissions and manifestVersion 2', () => {
    const pebble = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'package.json'), 'utf8')).pebble;
    assert.equal(pebble.manifestVersion, 2);
    assert.ok(pebble.messageKeys.includes('HA_SPEECH'));
    const plugin = pebble.usesPermissions.filter((p) => p.plugin === HaSpeech.PLUGIN_UUID).map((p) => p.name);
    assert.deepEqual(plugin.sort(), ['Assistant', 'InvokeAction']);
    assert.ok(pebble.usesPermissions.some((p) => p === 'Location' || p.name === 'Location'));
    // With a speaker and without
    assert.ok(pebble.targetPlatforms.includes('emery'));
    assert.ok(pebble.targetPlatforms.includes('flint'));
    assert.ok(pebble.targetPlatforms.some((p) => p !== 'emery' && p !== 'flint'));
});

test('the example uses the kit in the few lines it takes', () => {
    const c = fs.readFileSync(path.join(EXAMPLE, 'src', 'c', 'main.c'), 'utf8');
    assert.match(c, /ha_speech_init\(MESSAGE_KEY_HA_SPEECH\)/);
    assert.match(c, /if \(ha_speech_handle_message\(iter\)\)/);
    assert.match(c, /app_message_open\(HA_SPEECH_INBOX_SIZE/);
    assert.match(c, /ha_speech_stop\(\)/);
    const js = fs.readFileSync(path.join(EXAMPLE, 'src', 'pkjs', 'index.js'), 'utf8');
    assert.match(js, /require\('\.\/ha_speech'\)/);
    assert.match(js, /HaSpeech\.create\(\{ key: 'HA_SPEECH' \}\)/);
    assert.match(js, /speech\.handleMessage\(e\.payload\)/);
    assert.match(js, /speech\.ask\('What time is it\?'\)/);
});

test('Select on the watch asks the time and the answer comes back to show', async () => {
    const h = harness.create();
    h.settings({ plugin_share_assistant: true });
    const listeners = {};
    const sent = [];
    const invoked = [];
    const pebble = {
        // No speaker, so only the answer goes to the watch
        getActiveWatchInfo: () => ({ platform: 'basalt' }),
        addEventListener: (name, fn) => { listeners[name] = fn; },
        sendAppMessage: (dict, ok) => { sent.push(dict); if (ok) { ok(); } },
        invokeAction: (req) => {
            invoked.push(req);
            return h.action(req.action, req.args).then((answer) => (answer.ok ?
                { ok: true, text: answer.ok.text } : { ok: false, code: answer.error.code, message: answer.error.message }));
        }
    };
    const context = vm.createContext({ Pebble: pebble, console: { log() {} } });
    const source = fs.readFileSync(path.join(EXAMPLE, 'src', 'pkjs', 'index.js'), 'utf8');
    vm.runInContext('(function(require) {' + source + '\n})', context)((name) => {
        assert.equal(name, './ha_speech');
        return HaSpeech;
    });
    const realPebble = global.Pebble;
    global.Pebble = pebble;
    try {
        listeners.appmessage({ payload: { HA_SPEECH: [4, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0] } });
        assert.equal(invoked.length, 0, 'the kit\'s own message is left to it');
        listeners.appmessage({ payload: { ASK: 1 } });
        for (let i = 0; i < 50 && !sent.length; i++) { await new Promise((r) => setImmediate(r)); }
    } finally {
        global.Pebble = realPebble;
    }
    assert.equal(invoked[0].plugin, HaSpeech.PLUGIN_UUID);
    assert.equal(invoked[0].action, 'ask_assistant');
    assert.equal(invoked[0].args.text, 'What time is it?');
    // Made in the script's own context, so compared as JSON
    assert.equal(JSON.stringify(sent), JSON.stringify([{ REPLY: 'Turned on the kitchen light.' }]));
});
