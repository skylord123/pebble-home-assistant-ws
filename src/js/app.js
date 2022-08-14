/**
 * Initial Home Assistant interface for Pebble.
 *
 * By texnofobix (Dustin S.)
 */

let appVersion = '0.6.3',
    confVersion = '0.3.0',
    debugMode = false,
    UI = require('ui'),
    ajax = require('ajax'),
    Settings = require('settings'),
    Voice = require('ui/voice');
//let Vector2 = require('vector2');
//let Timeline = require('timeline');
//let Vibe = require('ui/vibe');

// Voice.dictate('start', true, function(e) {
//     if (e.err) {
//         console.log('Error: ' + e.err);
//         return;
//     }
//
//     ajax({
//             url: 'http://echo.jsontest.com/message/'+encode(e.transcription),
//             method: 'GET',
//             type: undefined,
//             headers: {
//             }
//         },
//         function(data, status, request) {
//             console.log('Awesome! Your message has been posted.');
//         },
//         function(error, status, request) {
//             console.log('There was an error posting your message.');
//         }
//     );
//
// });

// only call console.log if debug is enabled
function log_message(msg, extra) {
    if(!debugMode) return;

    if(extra){
        console.log(msg, extra);
        return;
    }

    console.log(msg);
}

log_message('WHA started!');
log_message('WHA version ' + appVersion);
log_message('WHA AccountToken:' + Pebble.getAccountToken());
//log_message('WHA TimelineToken:' + Pebble.getTimelineToken());

// Set a configurable with just the close callback
Settings.config({
        url: 'https://skylar.tech/uploads/wrist-ha-' + confVersion + '.htm'
    },
    function(e) {
        log_message('closed configurable');

        // Show the parsed response
        log_message('returned_settings: ' + JSON.stringify(e.options));
        Settings.option(e.options);

        // Show the raw response if parsing failed
        if (e.failed) {
            log_message(e.response);
        }
    }
);

// Set some variables for quicker access
let ha_url = Settings.option('ha_url'),
    ha_password = Settings.option('token'),
    ha_refreshTime = Settings.option('refreshTime'),
    ha_filter = Settings.option('filter'),
    ha_order_by = Settings.option('order_by'),
    ha_order_dir = Settings.option('order_dir');

let baseurl = ha_url + '/api';
let baseheaders = {
    'Authorization': 'Bearer ' + ha_password,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
};

let device_status;
//let events;

log_message('ha_url: ' + baseurl);

// Initial screen
let main = new UI.Card({
    title: 'Wrist Home Assistant v' + appVersion,
    subtitle: 'Loading ...',
});

// Set Menu colors
let statusMenu = new UI.Menu({
    backgroundColor: 'black',
    textColor: 'white',
    highlightBackgroundColor: 'white',
    highlightTextColor: 'black',
    sections: [{
        title: 'WHA'
    }]
});

//from http://stackoverflow.com/questions/881510/sorting-json-by-values
function sortJSON(data, key, way) {
    return data.sort(function(a, b) {
        if(typeof key == "string" && key.indexOf('.') >= 0) {
            let split = key.split('.');
            let x = a[split[0]][split[1]];
            let y = b[split[0]][split[1]];
        } else {
            let x = a[key];
            let y = b[key];
        }
        if (way === 'asc') {
            return ((x < y) ? -1 : ((x > y) ? 1 : 0));
        }
        if (way === 'desc') {
            return ((x > y) ? -1 : ((x < y) ? 1 : 0));
        }
    });
}

// gets HA device states
function getstates() {
    statusMenu.section(0).title = 'WHA - updating ...';
    statusMenu.show();
    main.hide();

    ajax({
            url: baseurl + '/states',
            type: 'json',
            headers: baseheaders
        },
        function(data) {
            log_message('HA States: ', data);
            log_message('WHA: upload title');
            statusMenu.section(0).title = 'WHA';
            let now = new Date();
            // data = sortJSON(data, 'last_changed', 'desc');
            data = sortJSON(data, ha_order_by, ha_order_dir);
            device_status = data;
            let arrayLength = data.length > 50 ? 50 : data.length;
            let menuIndex = 0;
            for (let i = 0; i < arrayLength; i++) {
                if (data[i].attributes.hidden) {
                    //
                } else {
                    statusMenu.item(0, menuIndex, {
                        title: data[i].attributes.friendly_name,
                        subtitle: data[i].state + ' ' + humanDiff(now, new Date(data[i].last_changed))
                    });
                    menuIndex++;
                }
            }
            //Vibe.vibrate('short');
        },
        function(error, status, request) {
            log_message('HA States failed: ' + error + ' status: ' + status);
            statusMenu.section(0).title = 'WHA - failed updating';
        }
    );
}

function testApi() {
    if(!ha_url || !ha_password) {
        main.subtitle('Setup required');
        main.body("Configure from the Pebble app");
        return;
    }

    // get API status
    ajax({
            url: baseurl + '/',
            type: 'json',
            headers: baseheaders
        },
        function(data) {
            log_message('HA Status: ' + data);
            main.subtitle(data.message);
            //on success call states?
            getstates();
        },
        function(error, status, request) {
            log_message('HA Status failed: ' + error + ' status: ' + status + ' at ' + baseurl + '/');
            main.subtitle('Error!');
            main.body(error + ' status: ' + status);
        });
}

/*
Expiremental reload
*/
if (ha_refreshTime < 1 || typeof ha_refreshTime == "undefined") {
    ha_refreshTime = 15;
}
let counter = 0;
let timerID = setInterval(clock, 60000 * ha_refreshTime);

function clock() {
    counter = counter + 1;
    log_message('WHA Reload' + counter);
    getstates();
}


statusMenu.on('longSelect', function(e) {
    log_message('Item number ' + e.itemIndex + ' was long pressed!');
    log_message('Title: ' + JSON.stringify(statusMenu.state.sections[0].items[e.itemIndex].title));
    let friendlyName = statusMenu.state.sections[0].items[e.itemIndex].title;
    //log_message('Friendly: ' + friendlyName);
    //let thisDevice = device_status.find(x=> x.attributes.friendly_name == friendlyName);
    let thisDevice = device_status.filter(function(v) { return v.attributes.friendly_name == friendlyName; })[0];
    log_message('thisDevice: ', thisDevice);
});

// Add an action for SELECT
statusMenu.on('select', function(e) {
    // Set Menu colors
    var statusObjectMenu = new UI.Menu({
        backgroundColor: 'white',
        textColor: 'black',
        highlightBackgroundColor: 'black',
        highlightTextColor: 'white',
        sections: [
            {
                title: 'Attributes'
            },
            {
                title: 'Services'
            }
        ]
    });
    statusObjectMenu.show();
    log_message('Item number ' + e.itemIndex + ' was short pressed!');
    log_message('Title: ' + JSON.stringify(statusMenu.state.sections[0].items[e.itemIndex].title));
    var friendlyName = statusMenu.state.sections[0].items[e.itemIndex].title;
    //log_message('Friendly: ' + friendlyName);
    //var thisDevice = device_status.find(x=> x.attributes.friendly_name == friendlyName);
    var thisDevice = device_status.filter(function(v) { return v.attributes.friendly_name == friendlyName; })[0];
    log_message('thisDevice: ', thisDevice);

    //Object.getOwnPropertyNames(thisDevice);
    //Object.getOwnPropertyNames(thisDevice.attributes);
    var arr = Object.getOwnPropertyNames(thisDevice.attributes);
    //var arr = Object.getOwnPropertyNames(device_status.attributes);
    var i = 0;
    for (i = 0; i < arr.length; i++) {
        //arr[i];
        //thisDevice.attributes[Object.getOwnPropertyNames(thisDevice.attributes)[i]];
        log_message(arr[i] + ' ' + thisDevice.attributes[arr[i]]);
        statusObjectMenu.item(0, i, {
            title: arr[i],
            subtitle: thisDevice.attributes[arr[i]]
        });
    }
    statusObjectMenu.item(0, i, {
        title: 'Entity ID',
        subtitle: thisDevice.entity_id
    });
    i++; statusObjectMenu.item(0, i, {
        title: 'Last Changed',
        subtitle: thisDevice.last_changed
    });
    i++; statusObjectMenu.item(0, i, {
        title: 'Last Updated',
        subtitle: thisDevice.last_updated
    });
    i++; statusObjectMenu.item(0, i, {
        title: 'State',
        subtitle: thisDevice.state
    });
    var stateIndex = i;

    getServices();
    //POST /api/services/<domain>/<service>
    //get available servcies /api/services

    //Object.getOwnPropertyNames(thisDevice);

    //thisDevice: {"attributes":{"friendly_name":"Family Room","icon":"mdi:lightbulb"},"entity_id":"switch.family_room","last_changed":"2016-10-12T02:03:26.849071+00:00","last_updated":"2016-10-12T02:03:26.849071+00:00","state":"off"}
    log_message("This Device entity_id: " + thisDevice.entity_id);
    var device = thisDevice.entity_id.split('.');
    var service = device[0];

    if (service == "switch" || service == "light" || service == "input_boolean")
    {
        statusObjectMenu.item(1, 0, { //menuIndex
            title: 'turn_on'
        });
        statusObjectMenu.item(1, 1, { //menuIndex
            title: 'turn_off'
        });
    }


    /*statusObjectMenu.item(0, 0, { //menuIndex
              title: 'test',
              subtitle: 'test2'
            });*/
    // statusObjectMenu.show();


    statusObjectMenu.on('select', function(e) {
        log_message(JSON.stringify(e.item));
        if(e.sectionIndex !== 1) return; // only care about clicks on service stuff
        log_message("Request URL will be: " + baseurl + '/services/'+ service +'/' + e.item.title);
        var requestData = {"entity_id": thisDevice.entity_id};
        log_message("Request Data: " + JSON.stringify(requestData));
        ajax(
            {
                url: baseurl + '/services/'+ service +'/' + e.item.title,
                method: 'post',
                headers: baseheaders,
                type: 'json',
                data: requestData
            },
            function(data) {
                let entity = data[0];
                // Success!
                statusObjectMenu.item(0, stateIndex, {
                    title: 'State',
                    subtitle: entity.state
                });
                log_message(JSON.stringify(data));
            },
            function(error) {
                // Failure!
                log_message('no response');
            }
        );
    });
});



// Add an action for LONGSELECT
statusMenu.on('longSelect', function(e) {
    log_message('Item number ' + e.itemIndex + ' was long pressed!');
});

function humanDiff(newestDate, oldestDate) {
    let prettyDate = {
        diffDate: newestDate - oldestDate,
        diffUnit: "ms"
    };

    function reduceNumbers(inPrettyDate, interval, unit) {
        if (inPrettyDate.diffDate > interval) {
            inPrettyDate.diffDate = inPrettyDate.diffDate / interval;
            inPrettyDate.diffUnit = unit;
        }
        return inPrettyDate;
    }

    prettyDate = reduceNumbers(prettyDate, 1000, 's');
    prettyDate = reduceNumbers(prettyDate, 60, 'm');
    prettyDate = reduceNumbers(prettyDate, 60, 'h');
    prettyDate = reduceNumbers(prettyDate, 24, 'd');
    return '> ' + Math.round(prettyDate.diffDate, 0) + ' ' + prettyDate.diffUnit;
}

function getServices(){
    // get API events
    ajax({
            url: baseurl + '/services',
            type: 'json',
            headers: baseheaders
        },
        function(data) {
            log_message('HA Services: ' + data);
            main.subtitle(data.message);
            //on success call states?
            //getstates();

        },
        function(error, status, request) {
            log_message('HA Services failed: ' + error + ' status: ' + status);
            main.subtitle('Error!');
            main.body(error + ' status: ' + status);
        }
    );
}



// show main screen
main.show();
//getEvents();
testApi();
