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

// Track broadcaster and listeners
let broadcaster = null;
const listeners = new Map(); // listenerId -> { ws, name }
let listenerIdCounter = 0;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint for server status
app.get('/api/status', (req, res) => {
  res.json({
    listeners: listeners.size,
    broadcasting: broadcaster !== null,
    uptime: process.uptime(),
  });
});

// Get list of listener names
function getListenerList() {
  const list = [];
  for (const [id, listener] of listeners) {
    list.push({ id, name: listener.name });
  }
  return list;
}

// Broadcast listener count and list to broadcaster and all listeners
function broadcastListenerCount() {
  const listenerList = getListenerList();

  // Send full list to broadcaster
  if (broadcaster && broadcaster.readyState === WebSocket.OPEN) {
    broadcaster.send(JSON.stringify({
      type: 'listeners',
      count: listeners.size,
      list: listenerList,
    }));
  }

  // Send just count to listeners
  const countMessage = JSON.stringify({
    type: 'listeners',
    count: listeners.size,
  });

  for (const [, listener] of listeners) {
    if (listener.ws.readyState === WebSocket.OPEN) {
      try {
        listener.ws.send(countMessage);
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

  let clientType = null; // 'broadcaster' or 'listener'
  let listenerId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.type) {
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
            broadcastListenerCount();
          }
          break;

        // Listener wants to connect
        case 'request-offer':
          if (!broadcaster || broadcaster.readyState !== WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'no-broadcaster' }));
            return;
          }

          clientType = 'listener';
          listenerId = ++listenerIdCounter;
          const listenerName = data.name || `Listener ${listenerId}`;
          listeners.set(listenerId, { ws, name: listenerName });
          ws.listenerId = listenerId;

          console.log(`Listener ${listenerId} (${listenerName}) registered. Total: ${listeners.size}`);
          broadcastListenerCount();

          // Tell broadcaster about new listener
          broadcaster.send(JSON.stringify({
            type: 'listener-joined',
            listenerId: listenerId,
            name: listenerName
          }));
          break;

        // Broadcaster sends offer to a specific listener
        case 'offer':
          if (clientType === 'broadcaster' && data.listenerId) {
            const listener = listeners.get(data.listenerId);
            if (listener && listener.ws.readyState === WebSocket.OPEN) {
              listener.ws.send(JSON.stringify({
                type: 'offer',
                sdp: data.sdp
              }));
            }
          }
          break;

        // Listener sends answer back to broadcaster
        case 'answer':
          if (clientType === 'listener' && broadcaster && broadcaster.readyState === WebSocket.OPEN) {
            broadcaster.send(JSON.stringify({
              type: 'answer',
              listenerId: listenerId,
              sdp: data.sdp
            }));
          }
          break;

        // ICE candidate exchange
        case 'ice-candidate':
          if (clientType === 'broadcaster' && data.listenerId) {
            // Broadcaster -> Listener
            const listener = listeners.get(data.listenerId);
            if (listener && listener.ws.readyState === WebSocket.OPEN) {
              listener.ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: data.candidate
              }));
            }
          } else if (clientType === 'listener' && broadcaster && broadcaster.readyState === WebSocket.OPEN) {
            // Listener -> Broadcaster
            broadcaster.send(JSON.stringify({
              type: 'ice-candidate',
              listenerId: listenerId,
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
    if (clientType === 'broadcaster') {
      console.log('Broadcaster disconnected');
      broadcaster = null;

      // Notify all listeners that broadcast ended
      for (const [, listener] of listeners) {
        if (listener.ws.readyState === WebSocket.OPEN) {
          listener.ws.send(JSON.stringify({ type: 'broadcast-ended' }));
        }
      }
    } else if (clientType === 'listener' && listenerId) {
      const listener = listeners.get(listenerId);
      const name = listener ? listener.name : `Listener ${listenerId}`;
      listeners.delete(listenerId);
      console.log(`Listener ${listenerId} (${name}) disconnected. Total: ${listeners.size}`);

      // Tell broadcaster about listener leaving
      if (broadcaster && broadcaster.readyState === WebSocket.OPEN) {
        broadcaster.send(JSON.stringify({
          type: 'listener-left',
          listenerId: listenerId,
          name: name
        }));
      }

      broadcastListenerCount();
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});

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

  for (const [, listener] of listeners) {
    listener.ws.close();
  }
  listeners.clear();

  if (broadcaster) {
    broadcaster.close();
  }

  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
