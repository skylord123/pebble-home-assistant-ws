/**
 * `node --test tests/sdk` runs this file: Node 22 takes a folder as a
 * module rather than looking in it for tests, so this loads them all.
 */
'use strict';

const fs = require('fs');
const path = require('path');

fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js')).sort().forEach((name) => {
    require(path.join(__dirname, name));
});
