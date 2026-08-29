var util2 = require('util2');
var myutil = require('myutil');
var Propable = require('ui/propable');
var StageElement = require('ui/element');

var accessorProps = [
  'strokeColor',
  'strokeWidth',
  'points',
];

var defaults = {
  strokeColor: 'white',
  strokeWidth: 1,
  points: [],
};

/**
 * A connected line series for graphs, drawn natively on the watch. `points`
 * is an array of y pixel offsets (0-255) within the element's frame; the x
 * positions are spread evenly across the frame width. A single packet of
 * points replaces one Line element per segment, so updating a whole series
 * (e.g. when changing a graph's time period) is a single message.
 * Not supported on aplite.
 */
var Polyline = function(elementDef) {
  StageElement.call(this, myutil.shadow(defaults, elementDef || {}));
  this.state.type = StageElement.PolylineType;
};

util2.inherit(Polyline, StageElement);

Propable.makeAccessors(accessorProps, Polyline.prototype);

module.exports = Polyline;
