const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const CONFIG = {
  port: process.env.PORT || 3000,
  // Separate port for the HTTPS listener (only used when SSL is enabled). Kept
  // distinct from the HTTP port so the in-app broadcaster can keep talking plain
  // HTTP on localhost while remote devices use HTTPS.
  httpsPort: process.env.HTTPS_PORT || 3443,
  // Optional TURN server for relaying audio when peers can't connect directly
  // (e.g. the translator is on cellular / a different network than the listeners).
  // Leave unset to use STUN only, which is enough on a shared local network.
  turn: {
    urls: process.env.TURN_URL || null,
    username: process.env.TURN_USERNAME || null,
    credential: process.env.TURN_CREDENTIAL || null,
  },
  // HTTPS is required for the microphone (getUserMedia) to work on remote
  // devices — browsers only expose it in a "secure context", which over a LAN
  // IP means HTTPS. Enable with HTTPS=true (uses an auto-generated self-signed
  // cert), or by providing your own cert via SSL_CERT + SSL_KEY.
  ssl: {
    enabled: /^(1|true|yes)$/i.test(process.env.HTTPS || '')
      || (!!process.env.SSL_CERT && !!process.env.SSL_KEY),
    certPath: process.env.SSL_CERT || null,
    keyPath: process.env.SSL_KEY || null,
  },
};

// Build the ICE server list shared by every WebRTC peer (broadcaster, listeners, translator).
function getIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  if (CONFIG.turn.urls) {
    // Support a comma-separated list of TURN URLs in a single env var.
    const turn = { urls: CONFIG.turn.urls.split(',').map(u => u.trim()) };
    if (CONFIG.turn.username) turn.username = CONFIG.turn.username;
    if (CONFIG.turn.credential) turn.credential = CONFIG.turn.credential;
    servers.push(turn);
  }

  return servers;
}

// Build the TLS options for the HTTPS server: use the user-provided cert/key if
// configured, otherwise generate a self-signed cert on the fly. The cert lists
// localhost plus every LAN IP as Subject Alternative Names so it matches the
// address phones actually connect to (it's still self-signed, so browsers show
// a one-time "Not Private" warning you tap through).
function getTlsOptions() {
  if (CONFIG.ssl.certPath && CONFIG.ssl.keyPath) {
    return {
      cert: fs.readFileSync(CONFIG.ssl.certPath),
      key: fs.readFileSync(CONFIG.ssl.keyPath),
    };
  }

  const selfsigned = require('selfsigned');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...getLocalIPs().map(ip => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    { days: 365, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }] }
  );
  return { cert: pems.cert, key: pems.private };
}

// Express app for serving the web UI
const app = express();

// Always run a plain HTTP listener. The in-app (Electron) broadcaster loads over
// file:// and talks to http/ws://localhost:3000 — localhost is a secure context,
// so that keeps working without any certificate handling inside Electron.
const httpServer = http.createServer(app);

// Optionally ALSO run an HTTPS listener on a separate port. This is what the
// translator uses, because its microphone (getUserMedia) only works in a secure
// context, which over a LAN IP means HTTPS. Listeners don't capture a mic, so
// they stay on plain HTTP and never see a certificate warning.
const USE_HTTPS = CONFIG.ssl.enabled;
const httpsServer = USE_HTTPS ? https.createServer(getTlsOptions(), app) : null;

// Protocol + port the translator should use (advertised via /api/status). HTTPS
// when enabled, otherwise plain HTTP. Listeners always use plain HTTP (CONFIG.port).
const TRANSLATOR_PROTOCOL = USE_HTTPS ? 'https' : 'http';
const TRANSLATOR_PORT = USE_HTTPS ? CONFIG.httpsPort : CONFIG.port;

// Attach a WebSocket signaling endpoint to each HTTP(S) server. Both share the
// same connection handler and the same broadcaster/source/client state, so a
// translator connected over wss:// and a broadcaster on localhost ws:// talk to
// each other through the one server.
const wss = new WebSocket.Server({ server: httpServer });
wss.on('connection', handleConnection);
if (httpsServer) {
  new WebSocket.Server({ server: httpsServer }).on('connection', handleConnection);
}

// Track broadcaster, dashboard, source (remote translator), and clients
let broadcaster = null;
let dashboard = null; // Dashboard connection (receives client list updates)
let source = null; // Remote audio source (translator) connection
const clients = new Map(); // clientId -> { ws, name, status: 'connecting' | 'listening' | 'paused' }
let clientIdCounter = 0;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Get local IP addresses for display
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }

  return addresses;
}

// API endpoint for server status
app.get('/api/status', (req, res) => {
  const ips = getLocalIPs();
  // Listeners stay on plain HTTP (no mic needed). The translator uses HTTPS when
  // enabled, since its microphone requires a secure context.
  res.json({
    clients: clients.size,
    broadcasting: broadcaster !== null,
    sourceConnected: source !== null,
    uptime: process.uptime(),
    secure: USE_HTTPS,
    listenerUrls: ips.map(ip => `http://${ip}:${CONFIG.port}`),
    translatorUrls: ips.map(ip => `${TRANSLATOR_PROTOCOL}://${ip}:${TRANSLATOR_PORT}/translate`),
  });
});

// ICE server configuration for WebRTC peers (STUN + optional TURN)
app.get('/api/ice', (req, res) => {
  res.json({ iceServers: getIceServers() });
});

// Clean URL for the translator page
app.get('/translate', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'translate.html'));
});

// Get list of clients with their status
function getClientList() {
  const list = [];
  for (const [id, client] of clients) {
    list.push({ id, name: client.name, status: client.status });
  }
  return list;
}

// Broadcast client list to broadcaster, dashboard, and count to clients
function broadcastClientList() {
  const clientList = getClientList();
  const fullMessage = JSON.stringify({
    type: 'clients',
    count: clients.size,
    list: clientList,
  });

  // Send full list to broadcaster
  if (broadcaster && broadcaster.readyState === WebSocket.OPEN) {
    broadcaster.send(fullMessage);
  }

  // Send full list to dashboard (even when not broadcasting)
  if (dashboard && dashboard.readyState === WebSocket.OPEN) {
    dashboard.send(fullMessage);
  }

  // Send just count to clients
  const countMessage = JSON.stringify({
    type: 'clients',
    count: clients.size,
  });

  for (const [, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(countMessage);
      } catch (error) {
        // Ignore errors
      }
    }
  }
}

// WebSocket connection handler (shared by the HTTP and HTTPS WebSocket servers)
function handleConnection(ws, req) {
  const clientIp = req.socket.remoteAddress;
  console.log(`Client connected from ${clientIp}`);

  let clientType = null; // 'broadcaster' or 'client'
  let clientId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.type) {
        // Dashboard registration (to receive client list without broadcasting)
        case 'register-dashboard':
          dashboard = ws;
          clientType = 'dashboard';
          console.log('Dashboard registered');
          ws.send(JSON.stringify({ type: 'dashboard-registered' }));
          broadcastClientList();
          break;

        // Broadcaster registration
        case 'register-broadcaster':
          if (broadcaster && broadcaster.readyState === WebSocket.OPEN) {
            // Already have a broadcaster
            ws.send(JSON.stringify({ type: 'broadcaster-rejected' }));
          } else {
            broadcaster = ws;
            clientType = 'broadcaster';
            console.log('Broadcaster registered');
            ws.send(JSON.stringify({ type: 'broadcaster-registered' }));

            // If a remote translator is already waiting, let both sides know
            // so the translator can start negotiating its audio stream.
            if (source && source.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'source-available' }));
              source.send(JSON.stringify({ type: 'broadcaster-present' }));
            }

            broadcastClientList();
          }
          break;

        // Remote translator (audio source) registration
        case 'register-source':
          source = ws;
          clientType = 'source';
          console.log('Remote source (translator) registered');
          ws.send(JSON.stringify({ type: 'source-registered' }));
          // Tell the source whether a broadcaster is ready to receive its audio
          ws.send(JSON.stringify({
            type: broadcaster && broadcaster.readyState === WebSocket.OPEN
              ? 'broadcaster-present'
              : 'broadcaster-absent',
          }));
          // Notify the broadcaster that a source is available
          if (broadcaster && broadcaster.readyState === WebSocket.OPEN) {
            broadcaster.send(JSON.stringify({ type: 'source-available' }));
          }
          break;

        // Translator -> broadcaster: SDP offer for the source audio stream
        case 'source-offer':
          if (clientType === 'source' && broadcaster && broadcaster.readyState === WebSocket.OPEN) {
            broadcaster.send(JSON.stringify({ type: 'source-offer', sdp: data.sdp }));
          }
          break;

        // Broadcaster -> translator: SDP answer for the source audio stream
        case 'source-answer':
          if (clientType === 'broadcaster' && source && source.readyState === WebSocket.OPEN) {
            source.send(JSON.stringify({ type: 'source-answer', sdp: data.sdp }));
          }
          break;

        // ICE candidate exchange on the translator <-> broadcaster leg
        case 'source-ice':
          if (clientType === 'source' && broadcaster && broadcaster.readyState === WebSocket.OPEN) {
            broadcaster.send(JSON.stringify({ type: 'source-ice', candidate: data.candidate }));
          } else if (clientType === 'broadcaster' && source && source.readyState === WebSocket.OPEN) {
            source.send(JSON.stringify({ type: 'source-ice', candidate: data.candidate }));
          }
          break;

        // Translator -> broadcaster: mute/unmute status
        case 'source-status':
          if (clientType === 'source' && broadcaster && broadcaster.readyState === WebSocket.OPEN) {
            broadcaster.send(JSON.stringify({ type: 'source-status', muted: !!data.muted }));
          }
          break;

        // Client registers with name (before starting to listen)
        case 'register-client':
          clientType = 'client';
          clientId = ++clientIdCounter;
          const clientName = data.name || `Client ${clientId}`;
          clients.set(clientId, { ws, name: clientName, status: 'connecting' });
          ws.clientId = clientId;

          console.log(`Client ${clientId} (${clientName}) registered. Total: ${clients.size}`);
          broadcastClientList();

          // Send client their ID
          ws.send(JSON.stringify({ type: 'registered', clientId }));
          break;

        // Client wants to start listening
        case 'request-offer':
          if (!broadcaster || broadcaster.readyState !== WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'no-broadcaster' }));
            return;
          }

          // Update client status to listening
          if (clientId && clients.has(clientId)) {
            const client = clients.get(clientId);
            client.status = 'listening';
            clients.set(clientId, client);
            broadcastClientList();
          }

          // Tell broadcaster about listener wanting to connect
          broadcaster.send(JSON.stringify({
            type: 'listener-joined',
            listenerId: clientId,
            name: clients.get(clientId)?.name || 'Unknown'
          }));
          break;

        // Client updates their status (paused/listening)
        case 'status-update':
          if (clientId && clients.has(clientId)) {
            const client = clients.get(clientId);
            client.status = data.status; // 'connecting', 'listening', 'paused'
            clients.set(clientId, client);
            console.log(`Client ${clientId} status: ${data.status}`);
            broadcastClientList();
          }
          break;

        // Broadcaster sends offer to a specific client
        case 'offer':
          if (clientType === 'broadcaster' && data.listenerId) {
            const client = clients.get(data.listenerId);
            if (client && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({
                type: 'offer',
                sdp: data.sdp
              }));
            }
          }
          break;

        // Client sends answer back to broadcaster
        case 'answer':
          if (clientType === 'client' && broadcaster && broadcaster.readyState === WebSocket.OPEN) {
            broadcaster.send(JSON.stringify({
              type: 'answer',
              listenerId: clientId,
              sdp: data.sdp
            }));
          }
          break;

        // ICE candidate exchange
        case 'ice-candidate':
          if (clientType === 'broadcaster' && data.listenerId) {
            // Broadcaster -> Client
            const client = clients.get(data.listenerId);
            if (client && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: data.candidate
              }));
            }
          } else if (clientType === 'client' && broadcaster && broadcaster.readyState === WebSocket.OPEN) {
            // Client -> Broadcaster
            broadcaster.send(JSON.stringify({
              type: 'ice-candidate',
              listenerId: clientId,
              candidate: data.candidate
            }));
          }
          break;
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  ws.on('close', () => {
    if (clientType === 'dashboard') {
      console.log('Dashboard disconnected');
      dashboard = null;
    } else if (clientType === 'broadcaster') {
      console.log('Broadcaster disconnected');
      broadcaster = null;

      // Notify all clients that broadcast ended
      for (const [, client] of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ type: 'broadcast-ended' }));
        }
      }

      // Tell the translator the broadcaster is gone so it can pause/retry
      if (source && source.readyState === WebSocket.OPEN) {
        source.send(JSON.stringify({ type: 'broadcaster-absent' }));
      }
    } else if (clientType === 'source') {
      console.log('Remote source (translator) disconnected');
      source = null;

      // Tell the broadcaster the remote audio source went away
      if (broadcaster && broadcaster.readyState === WebSocket.OPEN) {
        broadcaster.send(JSON.stringify({ type: 'source-gone' }));
      }
    } else if (clientType === 'client' && clientId) {
      const client = clients.get(clientId);
      const name = client ? client.name : `Client ${clientId}`;
      clients.delete(clientId);
      console.log(`Client ${clientId} (${name}) disconnected. Total: ${clients.size}`);

      // Tell broadcaster about client leaving
      if (broadcaster && broadcaster.readyState === WebSocket.OPEN) {
        broadcaster.send(JSON.stringify({
          type: 'listener-left',
          listenerId: clientId,
          name: name
        }));
      }

      broadcastClientList();
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
}

// Start the server(s): always HTTP, plus HTTPS on its own port when enabled.
function logStartup() {
  const localIPs = getLocalIPs();

  console.log('\n🎙️  Audio Broadcaster Server');
  console.log('━'.repeat(50));
  console.log(`\n📡 HTTP  listening on port ${CONFIG.port}`);
  if (USE_HTTPS) console.log(`🔒 HTTPS listening on port ${CONFIG.httpsPort}`);

  console.log(`\n🖥️  On this machine:`);
  console.log(`   Broadcaster: http://localhost:${CONFIG.port}/broadcast.html`);
  console.log(`   Listeners:   http://localhost:${CONFIG.port}/`);
  console.log(`   Translator:  http://localhost:${CONFIG.port}/translate`);

  console.log(`\n📱 From other devices on the network (use these):`);
  if (localIPs.length === 0) {
    console.log('   (no LAN IP detected)');
  }
  for (const ip of localIPs) {
    console.log(`   Listeners:   http://${ip}:${CONFIG.port}/`);
    console.log(`   Translator:  ${TRANSLATOR_PROTOCOL}://${ip}:${TRANSLATOR_PORT}/translate`);
  }

  if (USE_HTTPS) {
    console.log('\n🔒 HTTPS enabled for the translator — its microphone will work.');
    console.log('   Listeners stay on plain HTTP (no certificate warning for them).');
    if (!CONFIG.ssl.certPath) {
      console.log('   The translator opens the https:// URL and accepts the one-time');
      console.log('   "Not Private" / security warning (self-signed certificate).');
    }
  } else {
    console.log('\n⚠️  HTTP only. The translator microphone will NOT work from a remote');
    console.log('   device — getUserMedia needs HTTPS. Enable it with HTTPS=true, then');
    console.log('   reshare the translator URL.');
  }

  console.log('\n━'.repeat(50));
  console.log('Waiting for broadcaster...\n');
}

httpServer.listen(CONFIG.port, logStartup);
if (httpsServer) httpsServer.listen(CONFIG.httpsPort);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');

  for (const [, client] of clients) {
    client.ws.close();
  }
  clients.clear();

  if (broadcaster) {
    broadcaster.close();
  }

  if (source) {
    source.close();
  }

  if (httpsServer) {
    try { httpsServer.close(); } catch (e) {}
  }

  httpServer.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
