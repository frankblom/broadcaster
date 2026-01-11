const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');

// Configuration
const CONFIG = {
  port: process.env.PORT || 3000,
};

// Express app for serving the web UI
const app = express();
const server = http.createServer(app);

// WebSocket server for signaling
const wss = new WebSocket.Server({ server });

// Track broadcaster, dashboard, and clients
let broadcaster = null;
let dashboard = null; // Dashboard connection (receives client list updates)
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
  const port = CONFIG.port;
  res.json({
    clients: clients.size,
    broadcasting: broadcaster !== null,
    uptime: process.uptime(),
    listenerUrls: ips.map(ip => `http://${ip}:${port}`),
  });
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

// WebSocket connection handler
wss.on('connection', (ws, req) => {
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
            broadcastClientList();
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
});

// Start the server
server.listen(CONFIG.port, () => {
  console.log('\n🎙️  Audio Broadcaster Server');
  console.log('━'.repeat(50));
  console.log(`\n📡 Server running on port ${CONFIG.port}`);
  console.log(`\n🌐 Access URLs:`);
  console.log(`   Local:    http://localhost:${CONFIG.port}`);

  const localIPs = getLocalIPs();
  for (const ip of localIPs) {
    console.log(`   Network:  http://${ip}:${CONFIG.port}`);
  }

  console.log(`\n📻 Broadcaster: http://localhost:${CONFIG.port}/broadcast.html`);
  console.log(`🎧 Listeners:   http://localhost:${CONFIG.port}/`);
  console.log('\n━'.repeat(50));
  console.log('Waiting for broadcaster...\n');
});

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

  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
