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

### Using a Remote Translator (audio from another device)

Instead of using the audio interface on the machine running the app, you can take
the audio from a translator who joins from a phone or laptop browser:

1. In the app, set **Audio Source** to **🌐 Remote translator**.
2. Copy the **Translator URL** shown (e.g. `http://192.168.1.x:3000/translate`)
   and send it to the translator.
3. Click **Start Broadcasting**. The app will show "waiting for translator".
4. The translator opens the URL, picks a microphone, and taps **Go Live**. They
   can **Mute/Unmute** at any time.
5. The translator's audio is now broadcast to all listeners — the app relays it,
   so listeners connect exactly as before.

The app shows the translator's live/muted/disconnected status, and audio resumes
automatically if the translator drops and reconnects.

> **⚠️ The translator's microphone needs HTTPS.** Browsers only allow microphone
> access in a "secure context". That means `https://`, or `http://localhost` on
> the server machine itself. Opening the translator page over a plain-HTTP LAN
> address (e.g. `http://192.168.1.x:3000/translate`) fails with
> *"undefined is not an object (evaluating 'navigator.mediaDevices.getUserMedia')"*.
> See [Enabling HTTPS](#enabling-https-for-remote-microphones) below.

### Enabling HTTPS (for remote microphones)

**In the packaged desktop app this is automatic** — the app starts both an HTTP
and an HTTPS listener, and the **Translator URL it shows you is already
`https://…`** (on port `3443`). Just send that URL to the translator. Everything
else — the broadcaster on this machine and the listeners — stays on plain HTTP,
so listeners never see a certificate warning.

Only the translator needs HTTPS (it's the only role that captures a microphone).
The server runs **two listeners side by side**:

| Listener | Port | Used by |
|----------|------|---------|
| HTTP  | `3000` | the broadcaster on this machine (`localhost`) **and all listeners** |
| HTTPS | `3443` | the **translator** only (needs a secure context for the mic) |

When running the server standalone (not via the app), enable HTTPS with an env var:

```bash
HTTPS=true npm run start:server
```

HTTPS uses a **self-signed certificate**, generated automatically (valid for
`localhost` and your current LAN IPs). The first time each device opens the
`https://` URL, the browser shows a one-time *"Your connection is not private" /
"Not Secure"* warning — tap **Advanced → Proceed / Visit anyway** to continue.
After that, the microphone works.

To use your own certificate instead of the generated one, point the server at a
cert/key pair (this also enables HTTPS automatically):

```bash
export SSL_CERT=/path/to/cert.pem
export SSL_KEY=/path/to/key.pem
npm run start:server
```

The HTTPS port is configurable with `HTTPS_PORT` (default `3443`). Without
`HTTPS=true` (and no `SSL_CERT`/`SSL_KEY`), the standalone server runs over plain
HTTP only — fine for listeners and for a broadcaster/translator on `localhost`,
but **not** for microphones on remote devices.

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

### Remote translator over the internet (TURN)

On a shared local network, the remote translator works out of the box using STUN.
If the translator connects from **a different network (e.g. cellular)**, direct
peer-to-peer usually fails behind NAT and you'll need a **TURN** relay server.
Provide its details via environment variables before launching the app/server:

```bash
export TURN_URL="turn:your-turn-host:3478"      # comma-separate multiple URLs
export TURN_USERNAME="your-username"
export TURN_CREDENTIAL="your-credential"
```

These are served to all WebRTC peers automatically via `GET /api/ice`. With no
TURN variables set, STUN-only is used (fine for same-network use).

## Technical Details

- **Transport**: WebRTC (peer-to-peer audio streaming)
- **Signaling**: WebSocket (connection negotiation)
- **Audio**: Browser MediaStream API
- **Latency**: Very low (~50-150ms typical)

## API Endpoints

The embedded server exposes these endpoints:

- `GET /` - Listener web UI
- `GET /translate` - Remote translator web UI (microphone + mute/unmute)
- `GET /api/status` - Server status (listeners, streaming state, listener & translator URLs)
- `GET /api/ice` - WebRTC ICE server config (STUN + optional TURN)

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
