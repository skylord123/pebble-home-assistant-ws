/**
 * Weather condition pictures, for faces that draw the `icon` or `image`
 * shape instead of their own artwork.
 *
 * Both are 4 bits a pixel with a palette of Pebble colours, as the phone
 * expects them: two pixels a byte, the even column in the high nibble, each
 * row padded to a whole byte, pixels and palette base64. `icon` is a black
 * picture on a transparent ground, for a face to tint or lay over anything;
 * `image` is a white picture on a coloured disc.
 *
 * Each picture is a handful of shapes in a unit square, sampled four times a
 * pixel. A pixel is drawn when at least two of its samples land inside.
 */

//! A Pebble colour: 0b11rrggbb, two bits per channel
function color(r, g, b) { return 0xC0 | (r << 4) | (g << 2) | b; }

var TRANSPARENT = 0x00;
var BLACK = color(0, 0, 0);
var WHITE = color(3, 3, 3);

//! The disc behind each kind of picture in `image`
var DISC = {
    sun: color(3, 2, 0),
    moon: color(0, 0, 1),
    partly: color(0, 2, 3),
    partly_night: color(0, 0, 2),
    cloud: color(1, 1, 2),
    rain: color(0, 1, 2),
    pour: color(0, 0, 2),
    storm: color(1, 0, 2),
    snow: color(0, 2, 3),
    sleet: color(1, 2, 3),
    hail: color(1, 1, 2),
    fog: color(2, 2, 2),
    wind: color(0, 2, 2),
    unknown: color(1, 1, 1)
};

// ---- Shapes: each is a function (x, y) -> inside, in a 0..1 square ---------

function circle(cx, cy, r) {
    return function(x, y) { var dx = x - cx, dy = y - cy; return dx * dx + dy * dy <= r * r; };
}

function rect(x0, y0, x1, y1) {
    return function(x, y) { return x >= x0 && x <= x1 && y >= y0 && y <= y1; };
}

//! A line from (ax, ay) to (bx, by), `w` wide, with round ends
function line(ax, ay, bx, by, w) {
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, half = w / 2;
    return function(x, y) {
        var t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        var px = ax + t * dx - x, py = ay + t * dy - y;
        return px * px + py * py <= half * half;
    };
}

function polygon(points) {
    return function(x, y) {
        var inside = false;
        for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
            var xi = points[i][0], yi = points[i][1], xj = points[j][0], yj = points[j][1];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) { inside = !inside; }
        }
        return inside;
    };
}

function union(shapes) {
    return function(x, y) {
        for (var i = 0; i < shapes.length; i++) { if (shapes[i](x, y)) { return true; } }
        return false;
    };
}

function minus(shape, cut) {
    return function(x, y) { return shape(x, y) && !cut(x, y); };
}

//! Scale and move a shape: drawn at `s` of its size with its corner at (ox, oy)
function place(shape, ox, oy, s) {
    return function(x, y) { return shape((x - ox) / s, (y - oy) / s); };
}

// ---- Pictures ----------------------------------------------------------------

var STROKE = 0.075;

function sun() {
    var rays = [];
    for (var i = 0; i < 8; i++) {
        var a = i * Math.PI / 4, c = Math.cos(a), s = Math.sin(a);
        rays.push(line(0.5 + c * 0.3, 0.5 + s * 0.3, 0.5 + c * 0.42, 0.5 + s * 0.42, STROKE));
    }
    return union([circle(0.5, 0.5, 0.2)].concat(rays));
}

function moon() {
    return minus(circle(0.5, 0.5, 0.32), circle(0.64, 0.38, 0.27));
}

//! A cloud filling the square's lower middle, its base at `base`
function cloud(base) {
    base = base === undefined ? 0.72 : base;
    return union([
        circle(0.38, base - 0.16, 0.16),
        circle(0.6, base - 0.22, 0.2),
        circle(0.76, base - 0.1, 0.11),
        circle(0.24, base - 0.08, 0.1),
        rect(0.24, base - 0.16, 0.76, base + 0.01)
    ]);
}

//! `shape` grown by `d` all round
function grow(shape, d) {
    var offsets = [];
    for (var i = 0; i < 8; i++) {
        offsets.push([Math.cos(i * Math.PI / 4) * d, Math.sin(i * Math.PI / 4) * d]);
    }
    return function(x, y) {
        if (shape(x, y)) { return true; }
        for (var i = 0; i < offsets.length; i++) {
            if (shape(x + offsets[i][0], y + offsets[i][1])) { return true; }
        }
        return false;
    };
}

//! `back` partly hidden by `front`, with a gap between, as both are one colour
function behind(back, front) {
    return union([minus(back, grow(front, 0.06)), front]);
}

function drops(count, slant) {
    var shapes = [];
    for (var i = 0; i < count; i++) {
        var x = 0.3 + i * (0.4 / Math.max(1, count - 1));
        shapes.push(line(x + slant, 0.68, x, 0.86, STROKE));
    }
    return shapes;
}

function flakes(points) {
    return points.map(function(p) { return circle(p[0], p[1], 0.05); });
}

var PICTURES = {
    sun: sun,
    moon: moon,
    partly: function() {
        return behind(place(sun(), -0.02, -0.06, 0.62), place(cloud(), 0.1, 0.1, 0.9));
    },
    partly_night: function() {
        return behind(place(moon(), -0.02, -0.06, 0.62), place(cloud(), 0.1, 0.1, 0.9));
    },
    cloud: function() { return place(cloud(0.66), -0.09, -0.02, 1.18); },
    rain: function() { return union([cloud(0.58)].concat(drops(3, 0.05))); },
    pour: function() { return union([cloud(0.58)].concat(drops(4, 0.07))); },
    storm: function() {
        return union([cloud(0.56), polygon([[0.52, 0.56], [0.36, 0.78], [0.48, 0.78], [0.42, 0.94], [0.62, 0.7], [0.5, 0.7], [0.56, 0.56]])]);
    },
    snow: function() {
        return union([cloud(0.58)].concat(flakes([[0.32, 0.74], [0.5, 0.82], [0.68, 0.74], [0.41, 0.9], [0.59, 0.9]])));
    },
    sleet: function() {
        return union([cloud(0.58), line(0.36, 0.68, 0.32, 0.84, STROKE), line(0.64, 0.68, 0.6, 0.84, STROKE)]
            .concat(flakes([[0.48, 0.78], [0.48, 0.92]])));
    },
    hail: function() {
        return union([cloud(0.58)].concat([[0.32, 0.76], [0.5, 0.84], [0.68, 0.76]].map(function(p) {
            return minus(circle(p[0], p[1], 0.07), circle(p[0], p[1], 0.03));
        })));
    },
    fog: function() {
        return union([cloud(0.5), line(0.22, 0.64, 0.78, 0.64, STROKE), line(0.3, 0.78, 0.7, 0.78, STROKE)]);
    },
    wind: function() {
        return union([
            line(0.16, 0.38, 0.66, 0.38, STROKE), minus(circle(0.66, 0.29, 0.12), circle(0.64, 0.29, 0.06)),
            line(0.16, 0.56, 0.8, 0.56, STROKE),
            line(0.24, 0.74, 0.58, 0.74, STROKE), minus(circle(0.58, 0.83, 0.12), circle(0.56, 0.83, 0.06))
        ]);
    },
    unknown: function() {
        var hook = minus(minus(circle(0.5, 0.34, 0.2), circle(0.5, 0.34, 0.11)), rect(0, 0.34, 0.5, 1));
        return union([hook, line(0.5, 0.5, 0.5, 0.64, 0.09), circle(0.5, 0.8, 0.06)]);
    }
};

//! Which picture each of Home Assistant's conditions gets
var PICTURE_BY_CONDITION = {
    'sunny': 'sun',
    'clear-night': 'moon',
    'partlycloudy': 'partly',
    'cloudy': 'cloud',
    'fog': 'fog',
    'rainy': 'rain',
    'pouring': 'pour',
    'lightning': 'storm',
    'lightning-rainy': 'storm',
    'snowy': 'snow',
    'snowy-rainy': 'sleet',
    'hail': 'hail',
    'windy': 'wind',
    'windy-variant': 'wind',
    'exceptional': 'unknown'
};

function pictureFor(condition, night) {
    var name = PICTURE_BY_CONDITION[condition] || 'unknown';
    if (night && name === 'sun') { name = 'moon'; }
    if (night && name === 'partly') { name = 'partly_night'; }
    return name;
}

// ---- Drawing -----------------------------------------------------------------

var SAMPLES = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];

/**
 * Draw a picture at `size` pixels square.
 * @param {Function} shape
 * @param {boolean} onDisc - true for `image`: palette index 1 fills a disc
 * @returns {Array<Array<number>>} palette index per pixel, row by row
 */
function rasterize(shape, size, onDisc) {
    var rows = [];
    // On a disc the picture is shrunk to keep clear of its edge
    var inset = onDisc ? 0.17 : 0;
    var scale = 1 - 2 * inset;
    var disc = circle(0.5, 0.5, 0.5);
    for (var py = 0; py < size; py++) {
        var row = [];
        for (var px = 0; px < size; px++) {
            var inPicture = 0, inDisc = 0;
            for (var s = 0; s < SAMPLES.length; s++) {
                var x = (px + SAMPLES[s][0]) / size, y = (py + SAMPLES[s][1]) / size;
                if (shape((x - inset) / scale, (y - inset) / scale)) { inPicture++; }
                if (onDisc && disc(x, y)) { inDisc++; }
            }
            row.push(inPicture >= 2 ? (onDisc ? 2 : 1) : (inDisc >= 2 ? 1 : 0));
        }
        rows.push(row);
    }
    return rows;
}

function encode(rows, palette) {
    var height = rows.length, width = height ? rows[0].length : 0;
    var packed = '';
    for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x += 2) {
            var hi = rows[y][x], lo = x + 1 < width ? rows[y][x + 1] : 0;
            packed += String.fromCharCode((hi << 4) | lo);
        }
    }
    return {
        pixels: btoa(packed),
        palette: btoa(String.fromCharCode.apply(null, palette)),
        width: width,
        height: height
    };
}

//! Drawn pictures, by kind, picture and size: a series repeats the same few
var drawn = {};

/**
 * The `icon` or `image` shape for a condition, square and as large as fits
 * the size asked for.
 * @param {string} kind - 'icon' or 'image'
 * @param {string} condition - Home Assistant's condition, such as 'rainy'
 * @param {Object} pixelSize - the request's iconPixelSize, { w, h }
 * @param {boolean} night - draw the moon rather than the sun
 */
function shape(kind, condition, pixelSize, night) {
    var size = Math.max(1, Math.min(pixelSize.w, pixelSize.h) | 0);
    var name = pictureFor(condition, night);
    var key = kind + ':' + name + ':' + size;
    if (!drawn[key]) {
        var onDisc = kind === 'image';
        var rows = rasterize(PICTURES[name](), size, onDisc);
        drawn[key] = encode(rows, onDisc ? [TRANSPARENT, DISC[name], WHITE] : [TRANSPARENT, BLACK]);
    }
    return drawn[key];
}

module.exports = {
    shape: shape,
    pictureFor: pictureFor
};
