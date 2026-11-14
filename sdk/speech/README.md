# Speech kit

Let your watch app talk. The speech kit plays Home Assistant's speech on the
watch's own speaker: any text you like, or the assistant's answer to a
question, in the voice of the wearer's Home Assistant assistant.

It works through [Home Assistant WS](../../README.md), so your app never needs
a Home Assistant address or token. You copy three files into your app and add
a few lines.

```js
speech.say('The garage door is closed.');
```

Only the Pebble Time 2 and Core 2 Duo have a speaker. On every other watch the
kit builds to nothing and tells you there is no speaker, so the same app runs
everywhere.

- [What you need](#what-you-need)
- [Set it up](#set-it-up)
- [Using it](#using-it)
- [Errors](#errors)
- [Examples](#examples)
- [How it works](#how-it-works)
- [Good to know](#good-to-know)

## What you need

- **The wearer has Home Assistant WS** installed and connected to Home
  Assistant, on the Core Devices Pebble app with plugins.
- **For `ask`**, the wearer has turned on **Share with Apps** in Home
  Assistant WS (Settings, Assistant on the watch). `say` works without it.
- **A Home Assistant voice pipeline with text-to-speech.** The kit speaks
  with the engine, voice and language of the pipeline the wearer picked in
  Home Assistant WS.

## Set it up

### 1. Copy the files

| Copy | Into your app at |
| --- | --- |
| [`ha_speech.c`](ha_speech.c) | `src/c/ha_speech.c` |
| [`ha_speech.h`](ha_speech.h) | `src/c/ha_speech.h` |
| [`ha_speech.js`](ha_speech.js) | `src/pkjs/ha_speech.js` |

Copy them unchanged, and keep all three from the same version of Home
Assistant WS: the watch and phone halves talk to each other in a format that
can change between versions.

### 2. Add to your package.json

In the `pebble` block, add a message key, the plugin permissions, and
`manifestVersion` 2, which the Pebble app needs before it lets an app use a
plugin:

```json
"manifestVersion": 2,
"enableMultiJS": true,
"messageKeys": ["HA_SPEECH"],
"usesPermissions": [
  { "name": "Location", "reason": "Home Assistant WS asks this of every app that uses it" },
  { "name": "InvokeAction", "plugin": "61ae3254-ce00-49db-aad8-23143f649b90" },
  { "name": "Assistant", "plugin": "61ae3254-ce00-49db-aad8-23143f649b90" }
]
```

Keep any message keys and permissions you already have. `Assistant` is only
needed if you use `ask`. `Location` is there because Home Assistant WS only
answers apps that have it (see the [plugin guide](../../plugin/README.md)).

### 3. The watch

```c
#include <pebble.h>
#include "ha_speech.h"

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  if (ha_speech_handle_message(iter)) {
    return;
  }
  // Your own messages
}

static void prv_init(void) {
  ha_speech_init(MESSAGE_KEY_HA_SPEECH);
  app_message_register_inbox_received(prv_inbox_received);
  app_message_open(HA_SPEECH_INBOX_SIZE, HA_SPEECH_OUTBOX_SIZE);
  // Your windows
}

static void prv_deinit(void) {
  ha_speech_deinit();
}
```

If your own messages are bigger than the kit's, open the inbox and outbox
with whichever size is larger. `HA_SPEECH_INBOX_SIZE` is about 1.8 KB.

### 4. The phone

```js
var HaSpeech = require('./ha_speech');
var speech = HaSpeech.create({ key: 'HA_SPEECH' });

Pebble.addEventListener('appmessage', function(e) {
    if (speech.handleMessage(e.payload)) { return; }
    // Your own messages
});
```

That is the whole setup. Now anything your app says is heard.

## Using it

### Say something

```js
speech.say('The garage door is closed.').then(function(how) {
    console.log('Finished: ' + how);
}, function(error) {
    console.log('Could not say it: ' + error.code + ' ' + error.message);
});
```

`say` resolves once the watch has finished, with how it finished:

| `how` | |
| --- | --- |
| `'done'` | It was all played. |
| `'muted'` | The watch's speaker is muted, in its Sounds settings or for Quiet Time. |
| `'stopped'` | It was stopped: by `stop()`, by the wearer (see below), or by something new being said. |
| `'preempted'` | Something more important took the speaker, such as an alarm. |

Text can be up to 20000 characters, and Markdown is read as the words it
shows. About the first 1200 characters are spoken, ending at a sentence.

### Ask the assistant

```js
speech.ask('Is the garage door open?').then(function(answer) {
    showOnWatch(answer.text);           // the reply, as soon as it is in
    return answer.spoken;               // then it is read aloud
}).then(function(how) {
    console.log('Read aloud: ' + how);
}, function(error) {
    console.log(error.code + ': ' + error.message);
});
```

`ask` resolves as soon as the assistant has answered, so you can show the
reply while it is being read. `answer.text` is the reply, and `answer.spoken`
is a promise like the one `say` gives. On a watch without a speaker you still
get the reply, and `spoken` rejects with `NO_SPEAKER`.

Anything else you pass in a second argument goes to Home Assistant WS's
`ask_assistant` action, such as a `conversation_id` to carry on a
conversation, or a `pipeline`:

```js
speech.ask('And the back door?', { conversation_id: lastId });
```

### Ask it yourself

If your app already calls `ask_assistant` (for its own conversation handling,
say), pass `speak: true` and the kit's `rate()`, then hand the result to
`playReply`:

```js
Pebble.invokeAction({ plugin: HaSpeech.PLUGIN_UUID, action: 'ask_assistant',
    args: { text: question, json: true, speak: true, rate: speech.rate() } })
    .then(function(result) {
        if (!result.ok) { return; }
        var answer = JSON.parse(result.text);
        showOnWatch(answer.reply);
        speech.playReply(answer);
    });
```

`playReply` takes the result, its `text`, or the parsed answer, and resolves
like `say`. This is how [Home Assistant Voice](https://github.com/skylord123/pebble-home-assistant-voice)
uses the kit.

### Stop

```js
speech.stop();
```

Stops whatever is playing. On the watch, `ha_speech_stop()` does the same,
and `ha_speech_is_playing()` tells you whether anything is. A good place for
them is your Back button: the first press stops the speech, the next leaves.

```c
static void prv_back_click(ClickRecognizerRef recognizer, void *context) {
  if (ha_speech_is_playing()) {
    ha_speech_stop();
    return;
  }
  window_stack_pop(true);
}
```

Only one thing is said at a time. Saying something new stops what was
playing, and its promise resolves `'stopped'`.

### Options

`HaSpeech.create(options)`:

| Option | |
| --- | --- |
| `key` | The message key you gave the watch side, by name or number. Required, unless you give `transport`. |
| `volume` | 0 to 100, on top of the watch's own speaker volume. 100 unless given. Can be a function, asked each time speech starts, so a setting in your app is heard at once. |
| `storage` | Where the kit remembers how fast your link to the watch has been. `localStorage` unless given. |
| `log` | A function for the kit's log lines. `console.log` unless given; `null` for none. |

Also on the object: `hasSpeaker()` is true on the Pebble Time 2 and Core 2
Duo, and `rate()` is the sample rate the kit wants right now, for
`ask_assistant`.

## Errors

When something goes wrong the promise rejects with an `Error` whose `code`
says what:

| `code` | Means | What to do |
| --- | --- | --- |
| `NO_SPEAKER` | This watch has no speaker. Nothing was sent. | Check `hasSpeaker()` first, or ignore it. |
| `AUTH_REQUIRED` | Home Assistant WS is not set up, or Home Assistant refused it. | Ask the wearer to open Home Assistant WS's settings. |
| `PERMISSION_DENIED` | The wearer said no to your app using Home Assistant WS, or (for `ask`) Share with Apps is off. | Show the message: it says which. |
| `PLUGIN_UNAVAILABLE` | Home Assistant WS is not installed, or Home Assistant could not be reached. | Show the message. |
| `TIMEOUT` | Home Assistant took too long. | Try again. |
| `INVALID_ARGS` | Home Assistant WS did not accept what was sent, such as an argument `ask` passes on. | Check the arguments. |
| `UNKNOWN` | Home Assistant could not make the speech, often because the pipeline has no text-to-speech. | Show the message. |
| `NO_MEMORY` | The watch did not have the memory to play. | Free some memory on the watch (see below). |
| `FAILED` | The speaker failed, or the watch stopped answering. | Try again. |

When it fails part way through, whatever had already arrived is still played
before the promise rejects, and the error's `partial` is `true`. That lets
you tell "it was cut short" apart from "nothing was heard".

## Examples

- **[The example app](example/)** is the smallest complete app: press Select
  to ask Home Assistant the time, and hear the answer. Back stops it. Build it
  with `make docker-build-example` from the top of this repository. Its copies
  of the kit's files are checked to be identical to the ones here.
- **[Home Assistant Voice](https://github.com/skylord123/pebble-home-assistant-voice)**
  is a real app built on the kit. It asks the assistant itself and hands each
  reply to the kit; all of its speech code is in
  [`src/js/app/ReadAloud.js`](https://github.com/skylord123/pebble-home-assistant-voice/blob/main/src/js/app/ReadAloud.js),
  under 100 lines with its comments.
- **Home Assistant WS** reads its own answers out with the same files.

## How it works

1. The phone asks Home Assistant WS's plugin for speech. Home Assistant makes
   it with the wearer's text-to-speech engine, and the plugin hands it back
   compressed to a quarter of its size (4-bit IMA ADPCM), a few seconds at a
   time. It asks Home Assistant for the next sentence while the current one
   is on its way, so there is no wait between sentences.
2. The phone sends the audio to the watch in small pieces.
3. The watch keeps the audio in a ring buffer and plays it as it goes. It
   tells the phone how much it has played, and the phone never sends more
   than there is room for, however slow or fast Bluetooth is that day.
4. The kit remembers how fast your link has been. On a fast link it uses
   16 kHz audio, which sounds clearer, and on a slow one 8 kHz. It also
   decides how much the watch holds before it starts, so that once it starts
   it does not run dry.

If you want to use the plugin's speech yourself, without the kit, the
plugin guide's [Speech](../../plugin/README.md#speech) section describes
`speak` and `speak_next`, and the top of [`ha_speech.js`](ha_speech.js)
describes the messages between the two halves.

## Good to know

- **Memory.** The watch takes what it can spare for the ring: up to 32 KB on
  a Pebble Time 2, leaving 12 KB free, and up to 8 KB on a Core 2 Duo,
  leaving 6 KB. It needs at least 2 KB. To change these, define
  `HA_SPEECH_RING_MAX` or `HA_SPEECH_HEAP_RESERVE` in your build (`-D`).
- **The voice and its cost.** The speech comes from the wearer's own
  pipeline, so speech from a paid cloud engine is paid for by the wearer.
- **One at a time.** The Pebble app runs plugin requests one after another,
  so speech for your app waits while another app is using Home Assistant WS.
- **Your own messages.** The kit sends one message at a time and tries again
  when the watch is busy. Your own messages share the same link, so a long
  one may be held up while speech is going down.
- **Updating.** Copy all three files again whenever you update, and test on a
  watch.

## Licence

MIT, the same as Home Assistant WS. See [LICENSE](../LICENSE).
