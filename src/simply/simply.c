#include "simply.h"

#include "simply_accel.h"
#include "simply_res.h"
#include "simply_splash.h"
#include "simply_stage.h"
#include "simply_menu.h"
#include "simply_msg.h"
#include "simply_ui.h"
#include "simply_window_stack.h"
#include "simply_wakeup.h"
#include "simply_voice.h"
#include "simply_entities.h"
#include "simply_watchdata.h"

#include <pebble.h>

Simply *simply_init(void) {
  Simply *simply = malloc(sizeof(*simply));
  simply->accel = simply_accel_create(simply);
  simply->voice = simply_voice_create(simply);
  simply->entities = simply_entities_create(simply);
  simply->watchdata = simply_watchdata_create(simply);
  simply->res = simply_res_create(simply);
  simply->splash = simply_splash_create(simply);
  simply->stage = simply_stage_create(simply);
  simply->menu = simply_menu_create(simply);
  simply->msg = simply_msg_create(simply);
  simply->ui = simply_ui_create(simply);
  simply->window_stack = simply_window_stack_create(simply);

  simply_wakeup_init(simply);

  bool animated = false;
  window_stack_push(simply->splash->window, animated);

  return simply;
}

void simply_deinit(Simply *simply) {
  simply_window_stack_destroy(simply->window_stack);
  simply_ui_destroy(simply->ui);
  simply_msg_destroy(simply->msg);
  simply_menu_destroy(simply->menu);
  simply_stage_destroy(simply->stage);
  simply_res_destroy(simply->res);
  simply_accel_destroy(simply->accel);
  simply_watchdata_destroy(simply->watchdata);
  simply_entities_destroy(simply->entities);
  simply_voice_destroy(simply->voice);
  free(simply);
}
