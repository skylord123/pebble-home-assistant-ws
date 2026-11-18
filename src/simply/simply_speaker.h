#pragma once

#include "simply.h"

#include "simply_msg.h"

#include <pebble.h>

// Speech from the phone, played through the watch's own speaker. The phone
// asks Home Assistant to say an answer, compresses the audio to 4-bit IMA
// ADPCM and sends it down a piece at a time; this decodes it into the
// speaker's PCM stream as it plays, and tells the phone how much it has
// played so the phone never sends more than there is room for. The speaker
// itself is sdk/speech/ha_speech.c; this carries its messages.
//
// Only the Pebble Time 2 and Core 2 Duo have a speaker. PBL_SPEAKER is the
// SDK's own name for that, and everywhere else this compiles away.

#if defined(PBL_SPEAKER)

#define SIMPLY_HAS_SPEAKER 1

bool simply_speaker_handle_packet(Simply *simply, Packet *packet);

//! Whether something is being said, or is about to be
bool simply_speaker_is_active(void);

//! Stop at once and tell the phone the wearer stopped it. Safe when silent.
void simply_speaker_stop(void);

#else

#define simply_speaker_handle_packet(simply, packet) ((void)(simply), (void)(packet), false)
#define simply_speaker_is_active() (false)
#define simply_speaker_stop()

#endif
