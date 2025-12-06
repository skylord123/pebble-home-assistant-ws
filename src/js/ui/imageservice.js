var imagelib = require('lib/image');
var myutil = require('myutil');
var Feature = require('platform/feature');
var Resource = require('ui/resource');
var simply = require('ui/simply');

var ImageService = module.exports;

var state;

ImageService.init = function() {
  state = ImageService.state = {
    cache: {},
    nextId: Resource.items.length + 1,
    rootUrl: undefined,
  };
};

var makeImageHash = function(image) {
  var url = image.url;
  var hashPart = '';
  if (image.width) {
    hashPart += ',width:' + image.width;
  }
  if (image.height) {
    hashPart += ',height:' + image.height;
  }
  if (image.dither) {
    hashPart += ',dither:' + image.dither;
  }
  if (hashPart) {
    url += '#' + hashPart.substr(1);
  }
  return url;
};

var parseImageHash = function(hash) {
  var image = {};
  hash = hash.split('#');
  image.url = hash[0];
  hash = hash[1];
  if (!hash) { return image; }
  var args = hash.split(',');
  for (var i = 0, ii = args.length; i < ii; ++i) {
    var arg = args[i];
    if (arg.match(':')) {
      arg = arg.split(':');
      var v = arg[1];
      image[arg[0]] = !isNaN(Number(v)) ? Number(v) : v;
    } else {
      image[arg] = true;
    }
  }
  return image;
};

ImageService.load = function(opt, reset, callback) {
  if (typeof opt === 'string') {
    opt = parseImageHash(opt);
  }
  if (typeof reset === 'function') {
    callback = reset;
    reset = null;
  }
  var url = myutil.abspath(state.rootUrl, opt.url);
  var hash = makeImageHash(opt);
  var image = state.cache[hash];
  var fetch = false;
  if (image) {
    if ((opt.width && image.width !== opt.width) ||
        (opt.height && image.height !== opt.height) ||
        (opt.dither && image.dither !== opt.dither)) {
      reset = true;
    }
    if (reset !== true && image.loaded) {
      return image.id;
    }
  }
  if (!image || reset === true) {
    fetch = true;
    image = {
      id: state.nextId++,
      url: url,
    };
  }
  image.width = opt.width;
  image.height = opt.height;
  image.dither =  opt.dither;
  image.loaded = true;
  state.cache[hash] = image;
  var onLoad = function() {
    // Only send image if image data is available
    if (image.image) {
      simply.impl.image(image.id, image.image);
    } else {
      console.log('[ImageService] ERROR: Image data unavailable for: ' + image.url);
    }
    if (callback) {
      var e = {
        type: 'image',
        image: image.id,
        url: image.url,
      };
      callback(e);
    }
  };
  if (fetch) {
    var bitdepth = Feature.color(8, 1);
    imagelib.load(image, bitdepth, onLoad);
  } else {
    onLoad();
  }
  return image.id;
};

ImageService.setRootUrl = function(url) {
  state.rootUrl = url;
};

/**
 * Resolve an image path to an id. If the image is defined in appinfo, the index of the resource is used,
 * otherwise a new id is generated for dynamic loading.
 */
ImageService.resolve = function(opt) {
  var id = Resource.getId(opt);
  return typeof id !== 'undefined' ? id : ImageService.load(opt);
};

ImageService.markAllUnloaded = function() {
  for (var k in state.cache) {
    delete state.cache[k].loaded;
  }
};

ImageService.init();
