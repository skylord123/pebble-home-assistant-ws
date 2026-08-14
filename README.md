# Pebble Home Assistant on your Wrist

Control your Home Assistant smart home directly from your Pebble smartwatch! This app uses WebSockets for real-time updates and control of your Home Assistant devices and entities.


![config/logo_large.png](config/logo_large.png)

## Features

- **Voice Assistant** — Control your smart home using natural voice commands with support for multiple conversation agents (Assist, ChatGPT, and more)
- **Browse by Floor & Area** — Easily find entities organized by their assigned floors and areas
- **Browse by Label** — Filter and view entities by their Home Assistant labels
- **Favorites** — Mark frequently used entities for quick access
- **Pin to Main Menu** — Pin your most important entities directly to the main menu
- **Live Updates** — Entity states update instantly in real-time via WebSocket connection

### Improvements against [Home Assistant WS](https://github.com/skylord123/pebble-home-assistant-ws)
- Edit the favorites directly on the smart phone
- **Color** your favorites for easier handling
- Security - **HA Token** is only stored on the watch (not sent to the internet during the configuration)
- UI enhancements

Support
-------

If Home Assistant on your Wrist has been useful to you, consider supporting its development.
All of my projects are fully open-source and free — donations help cover time, tools, and ongoing maintenance.

The donations go to [skylord123](https://github.com/skylord123) who did the main work.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/B0B51BM7C)
[![Donate with PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate/?hosted_button_id=4VS2UQWDUALXA)


## Installation

#### Rebble App Store
You can find our app in the app store under [Home Assistant on your Wrist](https://apps.rebble.io/en_US/application/68dea5734be9cb0009429595)

#### Sideload

This is useful if you want to install a version not yet available on the app store for example.

1. **Download the app**:
   - Click the [Releases](https://github.com/caco3/pebble-home-assistant-on-your-wrist/releases) tab on the GitHub repository page
   - Press the `pebble.pbw` link under the release you want to start the download
   - The downloaded .pbw file is ready to be installed on your Pebble watch

2. **Install on your Pebble**:
   - **Android:** Use [rebble-sideloader](https://github.com/pebble-dev/rebble-sideloader) to side load the pbw file to your watch

If you need any assistance, feel free to join our [Discord Discussion](#join-the-discussion)

## Configuration

After installation, you'll need to configure the app to connect to your Home Assistant instance:

1. **Open the settings** for the app in the Pebble smartphone app
2. **Enter your Home Assistant details**:
   - **URL**: Your Home Assistant URL (e.g., `https://yourhomeassistant.duckdns.org`)
   - **Access Token**: A [Long-Lived Access Token](https://www.home-assistant.io/docs/authentication/) from Home Assistant
   - **Voice Confirmation**: Enable/disable voice command confirmation
   - **Enable Voice**: Turn on/off voice assistant functionality

### Home Assistant Setup Requirements

- Enable the [Conversation integration](https://www.home-assistant.io/integrations/conversation/) for voice control
- Optional: Configure additional conversation agents (like ChatGPT) for enhanced voice control

## Using the App

### Main Menu

- **Voice Assistant**: Access voice controls (if enabled)
- **Favorites**: View and control favorite entities
- **Areas**: Browse entities organized by room/area
- **All Entities**: Browse all available entities by type

### Voice Control

1. Select "Voice Assistant" from the main menu
2. Press the middle button to start dictation
3. Speak your command (e.g., "Turn on the kitchen lights" or "What's the temperature outside?")
4. View the response and scroll if needed using up/down buttons
5. Long-press the middle button to change conversation agents

### Entity Control

- **Short press** on an entity to view its details and controls
- **Long press** on compatible entities (lights, switches, etc.) to toggle them directly
- For media players, use the dedicated control screen with volume and playback controls
- Add frequently used entities to favorites for quicker access

## Troubleshooting

- **Connection Issues**: Verify your Home Assistant URL and token are correct
- **Entity Not Responding**: Check that the entity is available in Home Assistant
- **Voice Commands Not Working**: Ensure the conversation integration is enabled in Home Assistant
- **App Crashes**: Try restarting your Pebble watch
- **Entity Changes Not Updating**: Adjust the refresh interval in settings

## Join the Discussion

To participate in our Discord community:
1. First join the [Rebble Discord server](http://rebble.io/discord)
2. Then access the [pebble-home-assistant-ws](https://discord.com/channels/221364737269694464/1356054710439903232) channel on that server

## Development

This app is built using Pebble.js and is open source. Contributions are welcome!

- **GitHub Repository**: [github.com/caco3/pebble-home-assistant-on-your-wrist](https://github.com/caco3/pebble-home-assistant-on-your-wrist)
- **Bug Reports**: Please use the GitHub issues page to report bugs
- **Feature Requests**: Feel free to suggest new features through GitHub issues

### Building From Source

This requires the pebble sdk. Go into the Pebble app on your phone and enable the Developer Connection. Use the "Server IP" in the sample below to install the app over the network to your watch.

```bash
# Clone the repository
git clone https://github.com/caco3/pebble-home-assistant-on-your-wrist.git
cd pebble-ha-ws

# Install dependencies
npm install

# Build the app
pebble build

# Install on your Pebble (when connected)
pebble install --logs --phone 192.168.1.100
```

## Motivation

I recently dusted off my Pebble watch and wanted to start using it again. Controlling Home Assistant was at the top of my list of wants for a smartwatch.

While other Home Assistant applications existed, none of them offered complete device control at the time this project started. The existing voice assistant (Snowy) didn't work with Home Assistant, and the Home Assistant conversation API was only accessible via WebSockets.

Converting the entire application to use WebSockets not only enabled voice control but also provided the benefits of live event updates and access to additional endpoints not available through the REST API.

## Acknowledgements

- Thanks to the Home Assistant team for their excellent API documentation
- Special thanks to the Pebble developer community for keeping the platform alive
- Thanks to all contributors who have helped improve this application
- Thanks to [skylord123](https://github.com/skylord123) for the original work

## License

This project is licensed under the MIT License - see the LICENSE file for details.
