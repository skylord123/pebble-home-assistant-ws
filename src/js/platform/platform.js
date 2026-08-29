var Platform = module.exports;

Platform.version = function() {
  if (Pebble.getActiveWatchInfo) {
    return Pebble.getActiveWatchInfo().platform;
  } else {
    return 'aplite';
  }
};

// The watch's own 12 or 24 hour clock setting, reported by the firmware at
// launch. Assume 12 hour until the watch says otherwise, which matches the
// firmware default.
var clockIs24h = false;

Platform.setClockIs24h = function(is24h) {
  clockIs24h = !!is24h;
};

Platform.clockIs24h = function() {
  return clockIs24h;
};
