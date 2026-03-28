/**
 * WeatherPage - Weather entity detail page (Native Bridge)
 */
var simply = require('ui/simply');
var ajax = require('lib/ajax');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

var nextScreenId = 400;

function conditionText(state) {
    var conditions = {
        'clear-night': 'Clear', 'cloudy': 'Cloudy', 'exceptional': 'Exceptional',
        'fog': 'Foggy', 'hail': 'Hail', 'lightning': 'Lightning',
        'lightning-rainy': 'Thunderstorm', 'partlycloudy': 'Partly Cloudy',
        'pouring': 'Pouring', 'rainy': 'Rainy', 'snowy': 'Snowy',
        'snowy-rainy': 'Sleet', 'sunny': 'Sunny', 'windy': 'Windy',
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
    if (!weather) throw new Error("Weather entity " + entity_id + " not found");

    var attrs = weather.attributes;
    var unit = attrs.temperature_unit || '\u00B0';
    var friendlyName = attrs.friendly_name || entity_id;
    var screenId = nextScreenId++;
    var subscriptionId = null;

    simply.impl.nativeMenuPush(screenId, friendlyName, 2, {
        onSelect: function() {},
        onLongSelect: function() {},
        onBack: function() {
            if (subscriptionId && appState.haws) {
                appState.haws.unsubscribe(subscriptionId);
            }
        }
    });

    simply.impl.nativeMenuSectionTitle(screenId, 1, 'Forecast');

    // Current conditions
    var i = 0;
    var locationIndex = i;
    simply.impl.nativeMenuUpdate(screenId, 0, i++, 'Location', friendlyName, 0);

    // Reverse geocode (cached)
    var Settings = require('settings');
    var cachedLocation = Settings.option('weather_location_name');
    if (cachedLocation) {
        simply.impl.nativeMenuUpdate(screenId, 0, locationIndex, 'Location', cachedLocation, 0);
    } else {
        appState.haws.getConfig(function(data) {
            if (data && data.result && data.result.latitude && data.result.longitude) {
                ajax({
                    url: 'https://nominatim.openstreetmap.org/reverse?lat=' + data.result.latitude + '&lon=' + data.result.longitude + '&format=json',
                    type: 'json',
                    headers: { 'User-Agent': 'PebbleHomeAssistant/2.0' }
                }, function(response) {
                    if (response && response.address) {
                        var city = response.address.city || response.address.town || response.address.village || '';
                        var state = response.address.state || '';
                        var loc = city && state ? city + ', ' + state : (city || state || friendlyName);
                        Settings.option('weather_location_name', loc);
                        simply.impl.nativeMenuUpdate(screenId, 0, locationIndex, 'Location', loc, 0);
                    }
                }, function() {});
            }
        }, function() {});
    }

    var condIndex = i;
    simply.impl.nativeMenuUpdate(screenId, 0, i++, 'Condition', conditionText(weather.state), 0);
    var tempIndex = i;
    simply.impl.nativeMenuUpdate(screenId, 0, i++, 'Temperature', formatTemp(attrs.temperature, unit), 0);

    if (attrs.humidity !== undefined)
        simply.impl.nativeMenuUpdate(screenId, 0, i++, 'Humidity', attrs.humidity + '%', 0);
    if (attrs.wind_speed !== undefined) {
        var windText = attrs.wind_speed + (attrs.wind_speed_unit || '');
        if (attrs.wind_bearing !== undefined) windText += ' ' + attrs.wind_bearing + '\u00B0';
        simply.impl.nativeMenuUpdate(screenId, 0, i++, 'Wind', windText, 0);
    }
    if (attrs.pressure !== undefined)
        simply.impl.nativeMenuUpdate(screenId, 0, i++, 'Pressure', attrs.pressure + (attrs.pressure_unit || ''), 0);
    if (attrs.visibility !== undefined)
        simply.impl.nativeMenuUpdate(screenId, 0, i++, 'Visibility', attrs.visibility + (attrs.visibility_unit || ''), 0);

    // Forecast
    var forecast = attrs.forecast || [];
    for (var f = 0; f < Math.min(forecast.length, 7); f++) {
        var day = forecast[f];
        var date = new Date(day.datetime);
        var dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
        var tempRange = formatTemp(day.templow) + ' / ' + formatTemp(day.temperature, unit);
        var sub = tempRange + (day.precipitation_probability !== undefined ? '  ' + day.precipitation_probability + '%' : '');
        simply.impl.nativeMenuUpdate(screenId, 1, f, dayName + ' - ' + conditionText(day.condition), sub, 0);
    }
    if (forecast.length === 0) {
        simply.impl.nativeMenuUpdate(screenId, 1, 0, 'No forecast data', 'Check HA weather integration', 0);
    }

    // Real-time updates
    subscriptionId = appState.haws.subscribeTrigger({
        type: 'subscribe_trigger',
        trigger: { platform: 'state', entity_id: entity_id }
    }, function(data) {
        if (data.event && data.event.variables && data.event.variables.trigger && data.event.variables.trigger.to_state) {
            var updated = data.event.variables.trigger.to_state;
            appState.ha_state_dict[entity_id] = updated;
            simply.impl.nativeMenuUpdate(screenId, 0, condIndex, 'Condition', conditionText(updated.state), 0);
            simply.impl.nativeMenuUpdate(screenId, 0, tempIndex, 'Temperature', formatTemp(updated.attributes.temperature, unit), 0);
        }
    }, function(error) {
        helpers.log_message("WEATHER UPDATE ERROR: " + JSON.stringify(error));
    });
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
