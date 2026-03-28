#pragma once

typedef enum Command Command;

enum Command {
  CommandSegment = 1,
  CommandReady,
  CommandLaunchReason,
  CommandWakeupSet,
  CommandWakeupSetResult,
  CommandWakeupCancel,
  CommandWakeupEvent,
  CommandWindowShow,
  CommandWindowHide,
  CommandWindowShowEvent,
  CommandWindowHideEvent,
  CommandWindowProps,
  CommandWindowButtonConfig,
  CommandWindowStatusBar,
  CommandWindowActionBar,
  CommandClick,
  CommandLongClick,
  CommandImagePacket,
  CommandCardClear,
  CommandCardText,
  CommandCardImage,
  CommandCardStyle,
  CommandVibe,
  CommandLight,
  CommandAccelPeek,
  CommandAccelConfig,
  CommandAccelData,
  CommandAccelTap,
  CommandMenuClear,
  CommandMenuClearSection,
  CommandMenuProps,
  CommandMenuSection,
  CommandMenuGetSection,
  CommandMenuItem,
  CommandMenuGetItem,
  CommandMenuSelection,
  CommandMenuGetSelection,
  CommandMenuSelectionEvent,
  CommandMenuSelect,
  CommandMenuLongSelect,
  CommandStageClear,
  CommandElementInsert,
  CommandElementRemove,
  CommandElementCommon,
  CommandElementRadius,
  CommandElementAngle,
  CommandElementAngle2,
  CommandElementText,
  CommandElementTextStyle,
  CommandElementImage,
  CommandElementAnimate,
  CommandElementAnimateDone,
  CommandVoiceStart,
  CommandVoiceStop,
  CommandVoiceData,
  CommandVoiceResponse,
  CommandCalculateTextSize,
  CommandCalculateTextSizeResponse,
  CommandEntitySync,
  CommandEntityClear,
  CommandEntityCount,
  CommandEntityAction,
  CommandWatchData,
  CommandWatchDataEnable,

  // Native bridge commands
  CommandNativeMenuPush,      // JS → C: push a new native menu screen
  CommandNativeMenuUpdate,    // JS → C: update item in current native menu
  CommandNativeMenuPop,       // JS → C: pop current native screen
  CommandNativeMenuSelect,    // C → JS: user selected an item
  CommandNativeMenuLongSelect,// C → JS: user long-selected an item
  CommandNativeMenuBack,      // C → JS: user pressed back
  CommandNativeCardPush,      // JS → C: push a card (title/subtitle/body)
  CommandNativeToast,         // JS → C: show brief overlay (Sending.../Done/Error)

  NumCommands,
};
