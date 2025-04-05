var util2 = require('util2');
var myutil = require('myutil');
var Propable = require('ui/propable');
var StageElement = require('ui/element');

var textProps = [
  'text',
  'font',
  'color',
  'textOverflow',
  'textAlign',
  'updateTimeUnits',
];

var defaults = {
  backgroundColor: 'clear',
  borderColor: 'clear',
  borderWidth: 1,
  color: 'white',
  font: 'gothic-24',
};

var Text = function(elementDef) {
  StageElement.call(this, myutil.shadow(defaults, elementDef || {}));
  this.state.type = StageElement.TextType;
};

util2.inherit(Text, StageElement);

Propable.makeAccessors(textProps, Text.prototype);

// Font metrics for more accurate text measurement
var fontMetrics = {
  'gothic-14': { charWidth: 8, lineHeight: 16 },
  'gothic-14-bold': { charWidth: 8.5, lineHeight: 16 },
  'gothic-18': { charWidth: 10, lineHeight: 22 },
  'gothic-18-bold': { charWidth: 10.5, lineHeight: 22 },
  'gothic-24': { charWidth: 13, lineHeight: 28 },
  'gothic-24-bold': { charWidth: 14, lineHeight: 28 },
  'gothic-28': { charWidth: 15, lineHeight: 32 },
  'gothic-28-bold': { charWidth: 16, lineHeight: 32 },
  'bitham-30-black': { charWidth: 16, lineHeight: 34 },
  'bitham-42-bold': { charWidth: 24, lineHeight: 46 },
  'bitham-42-light': { charWidth: 22, lineHeight: 46 },
  'bitham-42-medium-numbers': { charWidth: 24, lineHeight: 46 },
  'roboto-condensed-21': { charWidth: 11, lineHeight: 24 },
  'roboto-bold-subset-49': { charWidth: 26, lineHeight: 52 },
  'droid-serif-28-bold': { charWidth: 15, lineHeight: 32 }
};

/**
 * Gets the height of the text element
 * @param {function} callback - Function to call with the height value
 */
Text.prototype.getHeight = function(callback) {
  console.log('getHeight called for element with ID:', this.state.id);

  var simply = require('ui/simply');
  var text = this.state.text || '';
  var font = this.state.font || defaults.font;
  var width = this.state.frame ? this.state.frame.size.w : 144; // Default to screen width
  var overflow = this.state.textOverflow || 'ellipsis';
  var alignment = this.state.textAlign || 'left';

  // Use the direct text height calculation
  simply.impl.calculateTextHeight(text, font, width, overflow, alignment, callback);
};

module.exports = Text;
