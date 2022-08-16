/**
 * Initial Home Assistant interface for Pebble.
 *
 * By texnofobix (Dustin S.)
 * Updated by Skylord123 (https://skylar.tech)
 */

const appVersion = '0.6.3',
    confVersion = '0.3.0',
    debugMode = false,
    UI = require('ui'),
    ajax = require('ajax'),
    Settings = require('settings'),
    Voice = require('ui/voice'),
    HAWS = require('vendor/haws'),
    FavoriteEntityStore = require('vendor/FavoriteEntityStore');
const {_getDataKey} = require("./settings");

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
    ha_refresh_interval = Settings.option('refreshTime') ? Settings.option('refreshTime') : 15,
    ha_filter = Settings.option('filter'),
    ha_order_by = Settings.option('order_by'),
    ha_order_dir = Settings.option('order_dir');

let haws = null,
    area_registry_cache = null,
    device_registry_cache = null,
    entity_registry_cache = null,
    favoriteEntityStore = new FavoriteEntityStore();

let baseurl = ha_url + '/api';
let baseheaders = {
    'Authorization': 'Bearer ' + ha_password,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
};

let device_status,
    ha_state_cache = null,
    ha_state_cache_updated = null;
//let events;

log_message('ha_url: ' + baseurl);

// Initial screen
let loadingCard = new UI.Card({
    title: 'Wrist Home Assistant v' + appVersion,
    subtitle: 'Loading ...',
});

let mainMenu = null;
function showMainMenu() {
    if(!mainMenu) {
        mainMenu = new UI.Menu({
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Main Menu'
            }]
        });

        mainMenu.on('show', function(){
            mainMenu.items(0, []);

            // add items to menu
            let i = -1;
            i++; mainMenu.item(0, i, {
                title: "Voice Assistant",
                // subtitle: thisDevice.attributes[arr[i]],
                on_click: function(e) {
                    showDictationMenu();
                }
            });
            let favoriteEntities = favoriteEntityStore.all();
            if(favoriteEntities.length) {
                i++; mainMenu.item(0, i, {
                    title: "Favorites",
                    // subtitle: thisDevice.attributes[arr[i]],
                    on_click: function(e) {
                        // showEntityList();
                        showEntityList(favoriteEntities)
                    }
                });
            }
            i++; mainMenu.item(0, i, {
                title: "All Entities",
                // subtitle: thisDevice.attributes[arr[i]],
                on_click: function(e) {
                    showEntityList();
                }
            });
            i++; mainMenu.item(0, i, {
                title: "Areas",
                // subtitle: thisDevice.attributes[arr[i]],
                on_click: function(e) {
                    showAreaMenu();
                }
            });
        });

        // menu item pressed, if it has an event fn call it
        mainMenu.on('select', function(e) {
            if(typeof e.item.on_click == 'function') {
                e.item.on_click(e);
            } else {
                log_message("No click function for main menu item " + e.title);
            }
        });

        mainMenu.show();
        loadingCard.hide();
    }
}

let dictationMenu = null;
function showDictationMenu() {
    let convo_id = _getDataKey();
    if(!dictationMenu) {
        dictationMenu = new UI.Card({
            title: 'Voice Assistant:',
            // titleColor: '',
            // subtitle: 'How can I help you?',
            // subtitleColor: '',
            body: 'How can I help you?',
            // bodyColor: 'white',
            style: 'small', // small, large, or mono
            scrollable: true,
            // backgroundColor: '#5294e2'
        });

        function render_reply(data) {
            // {"id":4,"type":"result","success":true,"result":{"speehttps://developer.rebble.io/developer.pebble.com/assets/images/guides/app-resources/fonts/bitham_30_black_preview.pngch":{"plain":{"speech":"Hello! How can I help you?","extra_data":null}},"card":{}}}

            // "Turn kitchen lights on." =
            // {"id":4,"type":"result","success":true,"result":{"speech":{"plain":{"speech":"You have multiple kitchen light bulb devices. Which one do you want to use? Kitchen Light Three, Kitchen Light Four, Kitchen Light Two, Kitchen Light One, Kitchen","extra_data":null}},"card":{}}}
            log_message("conversation reply: " + JSON.stringify(data));

            dictationMenu.title('Home Assistant:');
            dictationMenu.body(data.result.speech.plain.speech);
        }

        function start_dictation() {
            // Start a diction session and skip confirmation
            Voice.dictate('start', true, function(e) {
                if (e.err) {
                    log_message('Transcription error: ' + e.err);
                    return;
                }

                // dictationMenu.title('Sending..');
                // dictationMenu.body(null);
                haws.send({
                    "type": "conversation/process",
                    "text": e.transcription,
                    "conversation_id": convo_id
                }, function(data) {
                    if(!data.success) {
                        log_message('Conversation error: ' + e.err);
                        return;
                    }

                    render_reply(data);
                });
            });
        }

        // start dictation when first opened
        dictationMenu.on('show', function(e) {
            start_dictation();
        });

        // start dictation if button pressed
        dictationMenu.on('click', function(e) {
            start_dictation();
        });
    }

    dictationMenu.show();
}

let areaMenu = null;
function showAreaMenu() {
    if(!areaMenu) {
        areaMenu = new UI.Menu({
            backgroundColor: 'black',
            textColor: 'white',
            highlightBackgroundColor: 'white',
            highlightTextColor: 'black',
            sections: [{
                title: 'Areas'
            }]
        });

        // add items to menu
        let i = -1;
        for(let area_id in area_registry_cache) {
            i++;
            let area_name = area_registry_cache[area_id];
            areaMenu.item(0, i, {
                title: area_name ? area_name : 'Unassigned',
                // subtitle: thisDevice.attributes[arr[i]],
                on_click: function(e) {
                    // log_message(JSON.stringify(getEntitiesForArea(area_id)));
                    showEntityList(Object.keys(getEntitiesForArea(area_id)));
                }
            });
        }

        // menu item pressed, if it has an event fn call it
        areaMenu.on('select', function(e) {
            if(typeof e.item.on_click == 'function') {
                e.item.on_click(e);
            } else {
                log_message("No click function for main menu item " + e.title);
            }
        });

        areaMenu.show();
    }
}

let entityListMenu = null;
function showEntityList(entity_id_list = false, ignoreEntityCache = true) {
    // setup entityListMenu if it hasn't been
    entityListMenu = new UI.Menu({
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'WHA'
        }]
    });

    entityListMenu.on('longSelect', function(e) {
        log_message('Item number ' + e.itemIndex + ' was long pressed!');
        log_message('Title: ' + JSON.stringify(entityListMenu.state.sections[0].items[e.itemIndex].title));
        let friendlyName = entityListMenu.state.sections[0].items[e.itemIndex].title;
        //log_message('Friendly: ' + friendlyName);
        //let thisDevice = device_status.find(x=> x.attributes.friendly_name == friendlyName);
        let thisDevice = device_status.filter(function(v) { return v.attributes.friendly_name == friendlyName; })[0];
        log_message('thisDevice: ', thisDevice);
    });

    // Add an action for SELECT
    entityListMenu.on('select', function(e) {
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
                },
                {
                    title: 'Extra'
                }
            ]
        });
        log_message('Item number ' + e.itemIndex + ' was short pressed!');
        log_message('Title: ' + JSON.stringify(entityListMenu.state.sections[0].items[e.itemIndex].title));
        var friendlyName = entityListMenu.state.sections[0].items[e.itemIndex].title;
        //log_message('Friendly: ' + friendlyName);
        //var thisDevice = device_status.find(x=> x.attributes.friendly_name == friendlyName);
        var thisDevice = device_status.filter(function(v) { return v.attributes.friendly_name == friendlyName; })[0];
        log_message('thisDevice: ', thisDevice);

        let msg_id = null;
        statusObjectMenu.on('show', function(){
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
            var domain = device[0];

            if (domain === "switch" || domain === "light" || domain === "input_boolean")
            {
                statusObjectMenu.item(1, 0, { //menuIndex
                    title: 'Toggle',
                    on_click: function(){
                        log_message("Request URL will be: " + baseurl + '/services/'+ domain +'/toggle');
                        var requestData = {"entity_id": thisDevice.entity_id};
                        log_message("Request Data: " + JSON.stringify(requestData));
                        haws.callService(
                            domain,
                            'toggle',
                            {},
                            {entity_id: thisDevice.entity_id},
                            function(data) {
                                // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                                // Success!
                                log_message(JSON.stringify(data));
                            },
                            function(error) {
                                // Failure!
                                log_message('no response');
                            });
                    }
                });
                statusObjectMenu.item(1, 1, { //menuIndex
                    title: 'Turn On',
                    on_click: function(){
                        log_message("Request URL will be: " + baseurl + '/services/'+ domain +'/turn_on');
                        var requestData = {"entity_id": thisDevice.entity_id};
                        log_message("Request Data: " + JSON.stringify(requestData));
                        haws.callService(
                            domain,
                            'turn_on',
                            {},
                            {entity_id: thisDevice.entity_id},
                            function(data) {
                                // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                                // Success!
                                log_message(JSON.stringify(data));
                            },
                            function(error) {
                                // Failure!
                                log_message('no response');
                            });
                    }
                });
                statusObjectMenu.item(1, 2, { //menuIndex
                    title: 'Turn Off',
                    on_click: function(){
                        log_message("Request URL will be: " + baseurl + '/services/'+ domain +'/turn_off');
                        var requestData = {"entity_id": thisDevice.entity_id};
                        log_message("Request Data: " + JSON.stringify(requestData));
                        haws.callService(
                            domain,
                            'turn_off',
                            {},
                            {entity_id: thisDevice.entity_id},
                            function(data) {
                                // {"id":4,"type":"result","success":true,"result":{"context":{"id":"01GAJKZ6HN5AHKZN06B5D706K6","parent_id":null,"user_id":"b2a77a8a08fc45f59f43a8218dc05121"}}}
                                // Success!
                                log_message(JSON.stringify(data));
                            },
                            function(error) {
                                // Failure!
                                log_message('no response');
                            });
                    }
                });
            }

            function _renderFavoriteBtn() {
                statusObjectMenu.item(2, 0, {
                    title: (favoriteEntityStore.has(thisDevice.entity_id) ? 'Remove' : 'Add') + ' Favorite',
                    on_click: function(e) {
                        if(!favoriteEntityStore.has(thisDevice.entity_id)) {
                            log_message(`Adding ${thisDevice.entity_id} to favorites`);
                            favoriteEntityStore.add(thisDevice.entity_id);
                        } else {
                            log_message(`Removing ${thisDevice.entity_id} from favorites`);
                            favoriteEntityStore.remove(thisDevice.entity_id);
                        }
                        _renderFavoriteBtn();
                    }
                });
            }
            _renderFavoriteBtn();

            msg_id = haws.subscribe({
                "type": "subscribe_trigger",
                "trigger": {
                    "platform": "state",
                    "entity_id": thisDevice.entity_id,
                },
            }, function(data) {
                log_message(`ENTITY UPDATE [${thisDevice.entity_id}]: ` + JSON.stringify(data));

                statusObjectMenu.item(0, stateIndex, {
                    title: 'State',
                    subtitle: data.event.variables.trigger.to_state.state
                });
            }, function(error) {
                log_message(`ENTITY UPDATE ERROR [${thisDevice.entity_id}]: ` + JSON.stringify(error));
            } );

            statusObjectMenu.on('select', function(e) {
                if(typeof e.item.on_click == 'function') {
                    e.item.on_click(e);
                    return;
                }

                // log_message(JSON.stringify(e.item));
                if(e.sectionIndex !== 1) return; // only care about clicks on service stuff

                // ajax(
                //     {
                //         url: baseurl + '/services/'+ domain +'/' + e.item.title,
                //         method: 'post',
                //         headers: baseheaders,
                //         type: 'json',
                //         data: requestData
                //     },
                //     function(data) {
                //         let entity = data;
                //         // Success!
                //         statusObjectMenu.item(0, stateIndex, {
                //             title: 'State',
                //             subtitle: entity.state
                //         });
                //         log_message(JSON.stringify(data));
                //     },
                //     function(error) {
                //         // Failure!
                //         log_message('no response');
                //     }
                // );
            });
        });
        statusObjectMenu.on('close', function(){
            if(msg_id) {
                haws.unsubscribe(msg_id);
            }
        });

        statusObjectMenu.show();

        /*statusObjectMenu.item(0, 0, { //menuIndex
                  title: 'test',
                  subtitle: 'test2'
                });*/
        // statusObjectMenu.show();
    });

    getStates(
        function(data) {
            entityListMenu.section(0).title = 'WHA';
            let now = new Date();
            // data = sortJSON(data, 'last_changed', 'desc');
            data = sortJSON(data, ha_order_by, ha_order_dir);
            device_status = data;
            let arrayLength = data.length;
            let menuIndex = 0;
            for (let i = 0; i < arrayLength; i++) {
                if(entity_id_list && entity_id_list.indexOf(data[i].entity_id) === -1) {
                    continue;
                }

                if(data[i].attributes.hidden){
                    continue;
                }

                entityListMenu.item(0, menuIndex, {
                    title: data[i].attributes.friendly_name,
                    subtitle: data[i].state + ' ' + humanDiff(now, new Date(data[i].last_changed))
                });
                menuIndex++;
            }

            entityListMenu.section(0).title = 'WHA - updating ...';
            entityListMenu.show();
            //Vibe.vibrate('short');
        },
        function() {
            entityListMenu.section(0).title = 'WHA - failed updating';
        },
        true
    );
}

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
function getStates(successCallback, errorCallback, ignoreCache = false) {
    if(!ignoreCache){
        // check if last fetch is old and needs update
        if(
            ha_state_cache
            && ha_state_cache_updated
        ) {
            let secondsAgo = (((new Date()).getTime() - ha_state_cache_updated.getTime()) / 1000);
            if(secondsAgo <= ha_refresh_interval) {
                log_message(`HA states loaded from cache (age ${secondsAgo} <= interval ${ha_refresh_interval})`);
                successCallback(ha_state_cache);
                return;
            }
        }
    }

    ajax({
            url: baseurl + '/states',
            type: 'json',
            headers: baseheaders
        },
        function(data) {
            ha_state_cache = data;
            ha_state_cache_updated = new Date();
            if(typeof successCallback == "function") {
                successCallback(data);
            }
        },
        function(error, status, request) {
            log_message('HA States failed: ' + error + ' status: ' + status);
            if(typeof successCallback == "function") {
                errorCallback(error, status, request);
            }
        }
    );
}

function connect() {
    log_message("WS Test clicked");



    // let ws_url = 'ws://localhost:8123/api/websocket';
    let haws = null;
    loadingCard.on('show', function(){
        // wsCard.subtitle('Setup required');
        // wsCard.body("Configure from the Pebble app");
    });

    wsCard.on('hide', function(){
        if(haws) {
            log_message("ws disconnected");
            haws.close();
        }
    });

    wsCard.show();
}

function getEntitiesForArea(area_id) {
    if(!area_registry_cache || !device_registry_cache || !entity_registry_cache) {
        return false;
    }

    const areaDevices = new Set();
    // Find all devices linked to this area
    for (const device_id in device_registry_cache) {
        if (device_registry_cache[device_id].area_id === area_id) {
            areaDevices.add(device_id);
        }
    }

    const results = {};
    // Find all entities directly linked to this area
    // or linked to a device linked to this area.
    for (const entity_id in entity_registry_cache) {
        let entity = entity_registry_cache[entity_id];
        if (
            entity.area_id
                ? entity.area_id === area_id
                : areaDevices.has(entity.device_id)
        ) {
            results[entity_id] = entity;
        }
    }

    return results;
}

function on_connected(evt) {
    let onOnLoaded = function(){
        if(area_registry_cache && device_registry_cache && entity_registry_cache) {
            getEntitiesForArea();
            showMainMenu();
        }
    };

    haws.getConfigAreas(function(data) {
        log_message('config/area_registry/list response: ' + JSON.stringify(data));

        area_registry_cache = {};
        for(let result of data.result) {
            area_registry_cache[result.area_id] = result.name;                            // {
            //     "id":1,
            //     "type":"result",
            //     "success":true,
            //     "result":[
            //     {
            //         "area_id":"9f55b85d123043cb8dfc01088302d2c7",
            //         "name":"",
            //         "picture":null
            //     },
        }
        onOnLoaded();
    });

    haws.getConfigDevices(function(data) {
        log_message('config/device_registry/list response: ' + JSON.stringify(data));
        device_registry_cache = {};
        for(let result of data.result) {
            // {
            //     "area_id":"afb218164821434386244a956d47f2eb",
            //     "configuration_url":null,
            //     "config_entries":[
            //     "d1d5c0dd075844ca9146790b8647adeb"
            // ],
            //     "connections":[
            //     [
            //         "mac",
            //         "00:17:88:01:00:de:6a:52"
            //     ]
            // ],
            //     "disabled_by":null,
            //     "entry_type":null,
            //     "id":"d05562381cd94559a3f99f6983746bb7",
            //     "identifiers":[
            //     [
            //         "hue",
            //         "ce4a484b-76d9-4e82-989a-08874ecb7d00"
            //     ]
            // ],
            //     "manufacturer":"Signify Netherlands B.V.",
            //     "model":"Hue white lamp (LWB004)",
            //     "name_by_user":null,
            //     "name":"Garage Back Door Light",
            //     "sw_version":"130.1.30000",
            //     "hw_version":null,
            //     "via_device_id":"a02e79078d1c4b2e87252bf3c7d560f9"
            // }
            device_registry_cache[result.id] = result;
        }
        onOnLoaded();
    });

    haws.getConfigEntities( function(data) {
        log_message('config/entity_registry/list response: ' + JSON.stringify(data));
        entity_registry_cache = {};
        for(let result of data.result) {
            // {
            //     "area_id":null,
            //     "config_entry_id":"d1d5c0dd075844ca9146790b8647adeb",
            //     "device_id":"858419a35f354fbba83cb2350cad7835",
            //     "disabled_by":null,
            //     "entity_category":null,
            //     "entity_id":"light.garage_door_light_right",
            //     "hidden_by":null,
            //     "icon":null,
            //     "name":null,
            //     "platform":"hue"
            // }
            entity_registry_cache[result.entity_id] = result;
        }

        onOnLoaded();
    });
}

function main() {
    // if config not complete display message
    if(!ha_url || !ha_password) {
        loadingCard.subtitle('Setup required');
        loadingCard.body("Configure from the Pebble app");
        return;
    }

    loadingCard.subtitle('Connecting');
    log_message('Connecting');
    haws = new HAWS(ha_url, ha_password);

    haws.on('open', function(evt){
        log_message("ws connected!");
        loadingCard.subtitle('Connected');
    });

    // haws.on('result', function(evt){
    //     let result = evt.detail;
    //     log_message("ws result! " + JSON.stringify(result));
    //     wsCard.subtitle('Result');
    // });

    haws.on('error', function(evt){
        log_message("ws error: " + JSON.stringify(evt));
        loadingCard.subtitle('Error');
    });

    haws.on('auth_ok', function(evt){
        log_message("ws auth_ok: " + JSON.stringify(evt));
        on_connected(evt);
    });

    haws.connect();

    // removed below lines as we can just try to fetch services and avoid doing
    // multiple unnecessary requests
    // // test hitting the API
    // ajax({
    //         url: baseurl + '/',
    //         type: 'json',
    //         headers: baseheaders
    //     },
    //     function(data) {
    //         log_message('HA Status: ' + data);
    //         loadingCard.subtitle(data.message);
    //         // Successfully called API
    //         getstates();
    //     },
    //     function(error, status, request) {
    //         log_message('HA Status failed: ' + error + ' status: ' + status + ' at ' + baseurl + '/');
    //         loadingCard.subtitle('Error!');
    //         loadingCard.body(error + ' status: ' + status);
    //     });
}

/*
Expiremental reload
*/
if (ha_refresh_interval < 1 || typeof ha_refresh_interval == "undefined") {
    ha_refresh_interval = 15;
}
let counter = 0;
let timerID = setInterval(clock, 60000 * ha_refresh_interval);

function clock() {
    counter = counter + 1;
    log_message('WHA Reload' + counter);
    getstates();
}

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
            loadingCard.subtitle(data.message);
            //on success call states?
            //getstates();

        },
        function(error, status, request) {
            log_message('HA Services failed: ' + error + ' status: ' + status);
            loadingCard.subtitle('Error!');
            loadingCard.body(error + ' status: ' + status);
        }
    );
}

// show main screen
loadingCard.show();
//getEvents();
main();