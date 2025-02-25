function sortJSON(data, key, way) {
    return data.sort(function(a, b) {
        let x = null,
            y = null;
        if(typeof key == "string" && key.indexOf('.') > -1) {
            let split = key.split('.');
            x = a[split[0]][split[1]];
            y = b[split[0]][split[1]];
        } else {
            x = a[key];
            y = b[key];
        }
        if (way === 'asc') {
            return ((x < y) ? -1 : ((x > y) ? 1 : 0));
        } else {
            return ((x > y) ? -1 : ((x < y) ? 1 : 0));
        }
    });
}

module.exports = sortJSON;