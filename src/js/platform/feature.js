var Vector2 = require('vector2');
var Platform = require('platform');

var Feature = module.exports;

Feature.platform = function(map, yes, no) {
  var v = map[Platform.version()] || map.unknown;
  var rv;
  if (v && yes !== undefined) {
    rv = typeof yes === 'function' ? yes(v) : yes;
  } else if (!v && no !== undefined) {
    rv = typeof no === 'function' ? no(v) : no;
  }
  return rv !== undefined ? rv : v;
};

Feature.makePlatformTest = function(map) {
  return function(yes, no) {
    return Feature.platform(map, yes, no);
  };
};

Feature.blackAndWhite = Feature.makePlatformTest({
  aplite: true,
  basalt: false,
  chalk: false,
  diorite: true,
  emery: false,
  flint: true,  // Core 2 Duo (Pebble 2 Duo)
  unknown: false,  // Assume color by default for unknown platforms
});

Feature.color = Feature.makePlatformTest({
  aplite: false,
  basalt: true,
  chalk: true,
  diorite: false,
  emery: true,
  flint: false,  // Core 2 Duo (Pebble 2 Duo)
  unknown: true,  // Assume color by default for unknown platforms
});

Feature.rectangle = Feature.makePlatformTest({
  aplite: true,
  basalt: true,
  chalk: false,
  diorite: true,
  emery: true,
  flint: true,  // Core 2 Duo (Pebble 2 Duo)
  unknown: true,  // Assume rectangle by default for unknown platforms
});

Feature.round = Feature.makePlatformTest({
  aplite: false,
  basalt: false,
  chalk: true,
  diorite: false,
  emery: false,
  flint: false,  // Core 2 Duo (Pebble 2 Duo)
  unknown: false,  // Assume rectangle by default for unknown platforms
});

Feature.microphone = Feature.makePlatformTest({
  aplite: false,
  basalt: true,
  chalk: true,
  diorite: true,
  emery: true,
  flint: true,  // Core 2 Duo (Pebble 2 Duo) - has dual mics with ENC
  unknown: true,  // Assume microphone support for unknown platforms
});

Feature.resolution = Feature.makePlatformTest({
  aplite: new Vector2(144, 168),
  basalt: new Vector2(144, 168),
  chalk: new Vector2(180, 180),
  diorite: new Vector2(144, 168),
  emery: new Vector2(200, 228),
  flint: new Vector2(144, 168),  // Core 2 Duo (Pebble 2 Duo)
  unknown: new Vector2(144, 168),  // Safe default for unknown platforms
});

Feature.actionBarWidth = function() {
  return Feature.rectangle(30, 40);
};

Feature.statusBarHeight = function() {
  return 16;
};
