#pragma once

#define LOG(...) APP_LOG(APP_LOG_LEVEL_DEBUG, __VA_ARGS__)

typedef struct Simply Simply;

struct Simply {
  struct SimplyAccel *accel;
  struct SimplyTouch *touch;
  struct SimplyVoice *voice;
  struct SimplyRes *res;
  struct SimplyMsg *msg;
  struct SimplyWindowStack *window_stack;
  struct SimplySplash *splash;
  union {
    struct {
      struct SimplyStage *stage;
      struct SimplyMenu *menu;
      struct SimplyUi *ui;
    };
    struct SimplyWindow *windows[0];
  };
};

Simply *simply_init();
void simply_deinit(Simply *);
