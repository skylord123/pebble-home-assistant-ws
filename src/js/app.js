/**
 * Initial Home Assistant interface for Pebble.
 *
 * By texnofobix (Dustin S.)
 */
console.log('WHA started!');

var appVersion = '0.6.3';
var confVersion = '0.2.0';

var UI = require('ui');
//var Vector2 = require('vector2');
var ajax = require('ajax');
var Settings = require('settings');
//var Timeline = require('timeline');
//var Vibe = require('ui/vibe');

console.log('WHA version ' + appVersion);
console.log('WHA AccountToken:' + Pebble.getAccountToken());
//console.log('WHA TimelineToken:' + Pebble.getTimelineToken());

// Set a configurable with just the close callback
Settings.config({
    url: 'http://dustin.souers.org/pebble/WristHA-' + confVersion + '.htm'
  },
  function(e) {
    console.log('closed configurable');

    // Show the parsed response
    console.log('returned_settings: ' + JSON.stringify(e.options));
    Settings.option(e.options);

    // Show the raw response if parsing failed
    if (e.failed) {
      console.log(e.response);
    }
  }
);

// Set some variables for quicker access
var ha_url = Settings.option('haurl');
var ha_password = Settings.option('pwd');
var ha_refreshTime = Settings.option('refreshTime');

var baseurl = ha_url + '/api';
var baseheaders = {
  'Authorization': 'Bearer ' + ha_password,
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

var device_status;
//var events;

console.log('ha_url: ' + baseurl);

// Initial screen
var main = new UI.Card({
  title: 'Wrist Home Assistant v' + appVersion,
  subtitle: 'Loading ...',
});

// Set Menu colors
var statusMenu = new UI.Menu({
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
    var x = a[key];
    var y = b[key];
    if (way === '123') {
      return ((x < y) ? -1 : ((x > y) ? 1 : 0));
    }
    if (way === '321') {
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
      console.log('HA States: ' + data);
      console.log('WHA: upload title');
      statusMenu.section(0).title = 'WHA';
      var now = new Date();
      data = sortJSON(data, 'last_changed', '321'); // 123 or 321
      device_status = data;
      var arrayLength = data.length;
      var menuIndex = 0;
      for (var i = 0; i < arrayLength; i++) {
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
      console.log('HA States failed: ' + error + ' status: ' + status);
      statusMenu.section(0).title = 'WHA - failed updating';
    }
  );
}

function testApi() {
  // get API status
  ajax({
      url: baseurl + '/',
      type: 'json',
      headers: baseheaders
    },
    function(data) {
      console.log('HA Status: ' + data);
      main.subtitle(data.message);
      //on success call states?
      getstates();

    },
    function(error, status, request) {
      console.log('HA Status failed: ' + error + ' status: ' + status + 'at' + baseurl + '/');
      main.subtitle('Error!');
      main.body(error + ' status: ' + status);
    }
  );
}

/*
Expiremental reload
*/
if (ha_refreshTime < 1 || typeof ha_refreshTime == "undefined") {
  ha_refreshTime = 15;
}
var counter = 0;
var timerID = setInterval(clock, 60000 * ha_refreshTime);

function clock() {
  counter = counter + 1;
  console.log('WHA Reload' + counter);
  getstates();
}

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
  statusObjectMenu.hide();
  console.log('Item number ' + e.itemIndex + ' was short pressed!');
  console.log('Title: ' + JSON.stringify(statusMenu.state.sections[0].items[e.itemIndex].title));
  var friendlyName = statusMenu.state.sections[0].items[e.itemIndex].title;
  //console.log('Friendly: ' + friendlyName);
  //var thisDevice = device_status.find(x=> x.attributes.friendly_name == friendlyName);
  var thisDevice = device_status.filter(function(v) { return v.attributes.friendly_name == friendlyName; })[0];
  console.log('thisDevice: ' + JSON.stringify(thisDevice));
  
  //Object.getOwnPropertyNames(thisDevice);
  //Object.getOwnPropertyNames(thisDevice.attributes);
  var arr = Object.getOwnPropertyNames(thisDevice.attributes);
  //var arr = Object.getOwnPropertyNames(device_status.attributes);
  for (var i = 0, len = arr.length; i < len; i++) {
    //arr[i];
    //thisDevice.attributes[Object.getOwnPropertyNames(thisDevice.attributes)[i]];
    console.log(arr[i] + ' ' + thisDevice.attributes[arr[i]]);
    statusObjectMenu.item(0, i, {
            title: arr[i],
            subtitle: thisDevice.attributes[arr[i]]
    });
  }
  statusObjectMenu.item(0, i, {
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
  
  getServices();
  //POST /api/services/<domain>/<service>
  //get available servcies /api/services 
  
  //Object.getOwnPropertyNames(thisDevice);
  
  //thisDevice: {"attributes":{"friendly_name":"Family Room","icon":"mdi:lightbulb"},"entity_id":"switch.family_room","last_changed":"2016-10-12T02:03:26.849071+00:00","last_updated":"2016-10-12T02:03:26.849071+00:00","state":"off"}
  console.log("This Device entity_id: " + thisDevice.entity_id);
  var device = thisDevice.entity_id.split('.');
  var service = device[0];
  
  if (service == "switch" || service == "light")
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
  statusObjectMenu.show();
  
  
  statusObjectMenu.on('select', function(e) {
    console.log("Request URL will be: " + baseurl + '/services/'+ service +'/' + statusObjectMenu.state.sections[1].items[e.itemIndex].title);
    var requestData = {"entity_id": thisDevice.entity_id};
    console.log("Request Data: " + JSON.stringify(requestData));
    ajax(
      {
      url: baseurl + '/services/'+ service +'/' + statusObjectMenu.state.sections[1].items[e.itemIndex].title,
      method: 'post',
      headers: baseheaders,
      type: 'json',
      data: requestData
      },
      function(data) {
      // Success!
      console.log(JSON.stringify(data));
      },
      function(error) {
      // Failure!
      console.log('no response');
      }
      );
  });
});



// Add an action for LONGSELECT
statusMenu.on('longSelect', function(e) {
  console.log('Item number ' + e.itemIndex + ' was long pressed!');
});

function humanDiff(newestDate, oldestDate) {
  var prettyDate = {
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
      console.log('HA Services: ' + data);
      main.subtitle(data.message);
      //on success call states?
      //getstates();

    },
    function(error, status, request) {
      console.log('HA Services failed: ' + error + ' status: ' + status);
      main.subtitle('Error!');
      main.body(error + ' status: ' + status);
    }
  );
}



// show main screen
main.show();
//getEvents();
testApi();
