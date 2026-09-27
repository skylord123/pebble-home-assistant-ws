#pragma once

#include "simply.h"

#include "simply_msg.h"
#include "simply_touch.h"

#include <pebble.h>

// The voice assistant conversation, drawn and animated entirely on the watch.
// Everything the wearer sees and touches lives here: the transcript appears
// the instant dictation returns, the thinking animation runs while the phone
// talks to Home Assistant, and scrolling and paging never leave the watch.
// PKJS keeps only what it is actually good for, which is the websocket: it
// asks for the screen, receives the transcript, runs the pipeline, and sends
// the reply back down as text.
//
// Aplite has no microphone, so it can never reach this screen. The whole
// implementation compiles away there rather than spending flash and RAM on a
// feature that platform cannot run. PBL_MICROPHONE is the SDK's own name for
// the condition, and it is defined for every platform that ships a mic.

#if defined(PBL_MICROPHONE)

typedef struct SimplyAssist SimplyAssist;

//! Who said it. The values travel in the message packet, so JS agrees on them.
typedef enum AssistRole {
  AssistRoleUser = 0,
  AssistRoleAssistant = 1,
  AssistRoleError = 2,
} AssistRole;

bool simply_assist_handle_packet(Simply *simply, Packet *packet);

//! Deliver a dictation result to the conversation. Called by simply_voice
//! when the session it started belongs to this screen rather than to a JS
//! Voice.dictate() caller. Returns false when there is no assist screen up,
//! in which case the result is nobody's.
bool simply_assist_handle_dictation(Simply *simply, int status, const char *transcription);

//! True while the conversation window is on the native stack. Windows covered
//! by it must not report hide events to JS: the JS window stack keeps the page
//! beneath so it is restored when the conversation closes.
bool simply_assist_is_covering(Simply *simply);

#ifdef SIMPLY_HAS_TOUCH

//! Handle a touch event while the conversation is the window on screen:
//! dragging scrolls it (snapping to a page on round), a tap starts a new turn,
//! and a swipe right leaves. Returns true when the conversation consumed the
//! event, which also keeps the generic swipe back from acting on the JS window
//! hidden underneath.
bool simply_assist_handle_touch(Simply *simply, const TouchEvent *event);

#endif

#else

#define simply_assist_handle_packet(simply, packet) (false)
#define simply_assist_handle_dictation(simply, status, transcription) (false)
#define simply_assist_is_covering(simply) (false)
#define simply_assist_handle_touch(simply, event) (false)

#endif
