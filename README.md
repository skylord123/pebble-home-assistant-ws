# Pebble Home Assistant WS

Control Home Assistant from your pebble watch!

## Features

 - Control Home Assistant using your voice
   - Requires [conversation to be enabled](https://www.home-assistant.io/integrations/conversation/) in Home Assistant
 - Websocket connection to the Home Assistant API for live updates
 - Favorite entities for quick access
 - Entities sorted by area and type to make finding them easier
 - Pagination for areas that have lots of entities
 - View entity details
### Motivation for making thi

I recently dusted my Pebble watch off and wanted to start using it again. Controlling HA was at the top of my list of wants for a smart watch.

There are other Home Assistant applications but none of them let you actually control devices. There was also Snowy as an existing voice assistant but didn't work with HA. The Home Assistant conversation API only returns when you do a request over the websocket API, so I decided to convert the entire application to use websockets which gave the added bonus of receiving events live (and also some endpoints that aren't available in REST for HA).

