/*
 * This is the main PebbleJS file. You do not need to modify this file unless
 * you want to change the way PebbleJS starts, the script it runs or the libraries
 * it loads.
 *
 * By default, this will run app.js
 */

// Everything written to the console from here on is kept for the settings
// page's log viewer, so this goes before anything else can log
require('app/LogBuffer').install();

var safe = require('safe');
var util2 = require('util2');
require('vendor/event-target-polyfill');

Pebble.addEventListener('ready', function(e) {
  // Initialize the Pebble protocol
  require('ui/simply-pebble.js').init();

  // Backwards compatibility: place moment.js in global scope
  // This will be removed in a future update
  var moment = require('vendor/moment');

  var momentPasser = function(methodName) {
    return function() {
      if (safe.warnGlobalMoment !== false) {
        safe.warn("You've accessed moment globally. Pleae use `var moment = require('moment')` instead.\n\t" +
                  'moment will not be automatically loaded as a global in future versions.', 1);
        safe.warnGlobalMoment = false;
      }
      return (methodName ? moment[methodName] : moment).apply(this, arguments);
    };
  };

  var globalMoment = momentPasser();
  util2.copy(moment.prototype, globalMoment.prototype);
  for (var k in moment) {
    var v = moment[k];
    globalMoment[k] = typeof v === 'function' ? momentPasser(k) : v;
  }

  window.moment = globalMoment;

  // Load local file
  require('./app');
});
