/**
 * WeatherPage - Weather entity detail page
 *
 * Features:
 * - Current conditions (temp, humidity, wind, pressure)
 * - Forecast display (daily)
 * - Real-time state subscription
 */
var UI = require('ui');
var Vibe = require('ui/vibe');

var ajax = require('lib/ajax');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

// Menu selection tracking
var menuSelections = {
    weatherMenu: 0
};

function conditionText(state) {
    var conditions = {
        'clear-night': 'Clear',
        'cloudy': 'Cloudy',
        'exceptional': 'Exceptional',
        'fog': 'Foggy',
        'hail': 'Hail',
        'lightning': 'Lightning',
        'lightning-rainy': 'Thunderstorm',
        'partlycloudy': 'Partly Cloudy',
        'pouring': 'Pouring',
        'rainy': 'Rainy',
        'snowy': 'Snowy',
        'snowy-rainy': 'Sleet',
        'sunny': 'Sunny',
        'windy': 'Windy',
        'windy-variant': 'Windy'
    };
    return conditions[state] || state;
}

function formatTemp(temp, unit) {
    if (temp === undefined || temp === null) return 'N/A';
    return Math.round(temp) + (unit || '');
}

function showWeatherEntity(entity_id) {
    var appState = AppState.getInstance();
    var weather = appState.ha_state_dict[entity_id];
    if (!weather) {
        throw new Error("Weather entity " + entity_id + " not found");
    }

    var attrs = weather.attributes;
    var unit = attrs.temperature_unit || '\u00B0';
    var friendlyName = attrs.friendly_name || entity_id;

    var weatherMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: friendlyName
        }, {
            title: 'Forecast'
        }]
    });

    // Current conditions
    var i = 0;
    var locationIndex = i;
    weatherMenu.item(0, i++, {
        title: 'Location',
        subtitle: friendlyName
    });

    // Reverse geocode from HA config lat/lng (cached)
    var Settings = require('settings');
    var cachedLocation = Settings.option('weather_location_name');
    if (cachedLocation) {
        weatherMenu.item(0, locationIndex, {
            title: 'Location',
            subtitle: cachedLocation
        });
    } else {
        appState.haws.getConfig(function(data) {
            if (data && data.result && data.result.latitude && data.result.longitude) {
                var lat = data.result.latitude;
                var lon = data.result.longitude;
                ajax({
                    url: 'https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lon + '&format=json',
                    type: 'json',
                    headers: { 'User-Agent': 'PebbleHomeAssistant/2.0' }
                }, function(response) {
                    if (response && response.address) {
                        var city = response.address.city || response.address.town || response.address.village || '';
                        var state = response.address.state || '';
                        var loc = city && state ? city + ', ' + state : (city || state || friendlyName);
                        Settings.option('weather_location_name', loc);
                        weatherMenu.item(0, locationIndex, {
                            title: 'Location',
                            subtitle: loc
                        });
                    }
                }, function() {});
            }
        }, function() {});
    }

    weatherMenu.item(0, i++, {
        title: 'Condition',
        subtitle: conditionText(weather.state)
    });

    weatherMenu.item(0, i++, {
        title: 'Temperature',
        subtitle: formatTemp(attrs.temperature, unit)
    });

    if (attrs.humidity !== undefined) {
        weatherMenu.item(0, i++, {
            title: 'Humidity',
            subtitle: attrs.humidity + '%'
        });
    }

    if (attrs.wind_speed !== undefined) {
        var windText = attrs.wind_speed + (attrs.wind_speed_unit || '') ;
        if (attrs.wind_bearing !== undefined) {
            windText += ' ' + attrs.wind_bearing + '\u00B0';
        }
        weatherMenu.item(0, i++, {
            title: 'Wind',
            subtitle: windText
        });
    }

    if (attrs.pressure !== undefined) {
        weatherMenu.item(0, i++, {
            title: 'Pressure',
            subtitle: attrs.pressure + (attrs.pressure_unit || '')
        });
    }

    if (attrs.visibility !== undefined) {
        weatherMenu.item(0, i++, {
            title: 'Visibility',
            subtitle: attrs.visibility + (attrs.visibility_unit || '')
        });
    }

    // Forecast
    var forecast = attrs.forecast || [];
    for (var f = 0; f < Math.min(forecast.length, 7); f++) {
        var day = forecast[f];
        var date = new Date(day.datetime);
        var dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
        var tempRange = formatTemp(day.templow) + ' / ' + formatTemp(day.temperature, unit);
        weatherMenu.item(1, f, {
            title: dayName + ' - ' + conditionText(day.condition),
            subtitle: tempRange + (day.precipitation_probability !== undefined ? '  ' + day.precipitation_probability + '%' : '')
        });
    }

    if (forecast.length === 0) {
        weatherMenu.item(1, 0, {
            title: 'No forecast data',
            subtitle: 'Check HA weather integration'
        });
    }

    // Select handler
    weatherMenu.on('select', function(e) {
        menuSelections.weatherMenu = e.itemIndex;
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    // Real-time updates
    var subscription_msg_id = null;

    weatherMenu.on('show', function() {
        subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "subscribe_trigger",
            "trigger": {
                "platform": "state",
                "entity_id": entity_id,
            },
        }, function(data) {
            if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
                var updated = data.event.variables.trigger.to_state;
                appState.ha_state_dict[entity_id] = updated;

                // Update current conditions
                weatherMenu.item(0, 0, { title: 'Condition', subtitle: conditionText(updated.state) });
                weatherMenu.item(0, 1, { title: 'Temperature', subtitle: formatTemp(updated.attributes.temperature, unit) });
            }
        }, function(error) {
            helpers.log_message("WEATHER UPDATE ERROR [" + entity_id + "]: " + JSON.stringify(error));
        });
    });

    weatherMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
    });

    weatherMenu.show();
}

function getWeatherSubtitle(entity_id) {
    var appState = AppState.getInstance();
    var weather = appState.ha_state_dict[entity_id];
    if (!weather) return '';
    var attrs = weather.attributes;
    var temp = attrs.temperature !== undefined ? Math.round(attrs.temperature) + (attrs.temperature_unit || '\u00B0') : '';
    var cond = conditionText(weather.state);
    var humid = attrs.humidity !== undefined ? attrs.humidity + '%' : '';
    var parts = [temp, cond];
    if (humid) parts.push(humid);
    return parts.join('  ');
}

module.exports.showWeatherEntity = showWeatherEntity;
module.exports.getWeatherSubtitle = getWeatherSubtitle;
