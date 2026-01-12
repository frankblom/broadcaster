# Audio Broadcaster

A desktop application for real-time audio broadcasting that streams audio from any input device to web-based listeners using WebRTC.

## Features

- **Desktop app** - Native Electron application with auto-updates
- **Real-time streaming** - Low-latency WebRTC peer-to-peer audio
- **Unlimited listeners** - Each listener gets a direct WebRTC connection
- **Web-based clients** - No app installation needed for listeners
- **Live listener count** - See connected clients in real-time
- **Audio visualization** - Visual feedback while broadcasting
- **Device selection** - Choose from available audio inputs
- **Cross-platform** - Builds available for macOS, Windows, and Linux

## Installation

### From Release

Download the latest release for your platform from the [Releases](https://github.com/frankblom/audio-broadcaster/releases) page.

### From Source

1. **Clone the repository**:
   ```bash
   git clone https://github.com/frankblom/audio-broadcaster.git
   cd audio-broadcaster
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run the app**:
   ```bash
   npm start
   ```

## Usage

### For the Broadcaster

1. Launch the Audio Broadcaster app
2. Select your audio input device from the dropdown
3. Click "Start Broadcasting"
4. Share the listener URL with your audience (shown in the app)

### For Listeners

1. Open the shared URL (e.g., `http://192.168.1.x:3000`)
2. Enter your name and click "Start Listening"
3. Adjust volume as needed

## Building

Build for your current platform:
```bash
npm run build
```

Build for specific platforms:
```bash
npm run build:mac    # macOS (DMG and ZIP)
npm run build:win    # Windows (NSIS installer)
npm run build:linux  # Linux (AppImage and DEB)
```

## Network Setup

For listeners on the same network:
- Use the listener URL shown in the app
- Make sure port 3000 is not blocked by your firewall

For listeners over the internet:
- Set up port forwarding on your router for port 3000
- Or use a service like ngrok: `ngrok http 3000`

## Technical Details

- **Transport**: WebRTC (peer-to-peer audio streaming)
- **Signaling**: WebSocket (connection negotiation)
- **Audio**: Browser MediaStream API
- **Latency**: Very low (~50-150ms typical)

## API Endpoints

The embedded server exposes these endpoints:

- `GET /` - Listener web UI
- `GET /api/status` - Server status (listeners, streaming state, listener URLs)

## Troubleshooting

### No audio devices found
Make sure the app has microphone permission. On macOS, grant it in System Preferences > Security & Privacy > Privacy > Microphone.

### Listeners can't connect
- Ensure the broadcaster and listeners are on the same network, or port forwarding is configured
- Check that port 3000 is not blocked by a firewall
- Verify the listener URL is accessible from the listener's device

### Audio quality issues
- Use a wired network connection instead of WiFi when possible
- Reduce network congestion
- Check that your microphone input level is appropriate

## License

MIT
