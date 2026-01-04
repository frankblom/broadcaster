# Audio Broadcaster

A real-time audio broadcasting server for macOS that streams audio from any input device to unlimited web clients.

## Features

- **Real-time streaming** - Low-latency Opus audio codec
- **Unlimited listeners** - WebSocket-based distribution scales well
- **Web-based clients** - No app installation needed for listeners
- **Live listener count** - See how many people are connected
- **Audio visualization** - Visual feedback for listeners
- **Device selection** - Choose from available audio inputs
- **Auto-start/stop** - Audio capture starts when first client connects

## Requirements

- macOS (uses AVFoundation for audio capture)
- Node.js 18+
- FFmpeg with libopus support

## Installation

1. **Install FFmpeg** (if not already installed):
   ```bash
   brew install ffmpeg
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the server**:
   ```bash
   npm start
   ```

## Usage

### For the Broadcaster

1. Start the server with `npm start`
2. Open the dashboard at `http://localhost:3000/dashboard.html`
3. Select your audio input device
4. Share the main URL with listeners

### For Listeners

1. Open the shared URL (e.g., `http://192.168.1.x:3000`)
2. Click "Start Listening"
3. Adjust volume as needed

## Configuration

### Audio Device Selection

List available devices:
```bash
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -A 20 "audio devices"
```

Select a specific device:
```bash
AUDIO_DEVICE=1 npm start
```

### Port

Change the port:
```bash
PORT=8080 npm start
```

### Example with both options:
```bash
AUDIO_DEVICE=2 PORT=8080 npm start
```

## Network Setup

For listeners on the same network:
- Use the local IP address shown when the server starts
- Make sure port 3000 (or your custom port) is not blocked

For listeners over the internet:
- Set up port forwarding on your router
- Or use a service like ngrok: `ngrok http 3000`

## Technical Details

- **Codec**: Opus (optimized for real-time audio)
- **Container**: WebM (native browser support)
- **Transport**: WebSocket (reliable delivery)
- **Sample rate**: 48kHz stereo
- **Bitrate**: 128kbps (configurable)
- **Latency**: ~100-300ms typical

## API Endpoints

- `GET /` - Listener web UI
- `GET /dashboard.html` - Broadcaster dashboard
- `GET /api/status` - Server status (listeners, streaming state)
- `GET /api/devices` - List audio input devices
- `POST /api/device/:index` - Switch audio device

## Troubleshooting

### No audio devices found
Make sure FFmpeg is installed with AVFoundation support:
```bash
ffmpeg -f avfoundation -list_devices true -i ""
```

### Permission denied
macOS may ask for microphone permission. Grant it in System Preferences > Security & Privacy > Microphone.

### High latency
- Reduce network distance between server and clients
- Use a wired connection instead of WiFi
- Try reducing the bitrate

### Audio cuts out
- Check your network stability
- Reduce the number of simultaneous listeners
- Consider using a more powerful machine for many listeners

## License

MIT
