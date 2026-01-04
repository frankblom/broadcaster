const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');

// Configuration
const CONFIG = {
  port: process.env.PORT || 3000,
  audioDevice: process.env.AUDIO_DEVICE || null, // Will auto-detect or use specified
  sampleRate: 48000,
  channels: 2,
  bitrate: '128k',
};

// Express app for serving the web UI
const app = express();
const server = http.createServer(app);

// WebSocket server for audio streaming
const wss = new WebSocket.Server({ server });

// Track connected clients
const clients = new Set();
let audioProcess = null;
let isStreaming = false;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint for server status
app.get('/api/status', (req, res) => {
  res.json({
    listeners: clients.size,
    streaming: isStreaming,
    audioDevice: CONFIG.audioDevice,
    uptime: process.uptime(),
  });
});

// API endpoint to list available audio devices
app.get('/api/devices', (req, res) => {
  const devices = listAudioDevices();
  res.json(devices);
});

// API endpoint to change audio device
app.post('/api/device/:index', express.json(), (req, res) => {
  const index = req.params.index;
  CONFIG.audioDevice = index;
  console.log(`Switching to audio device: ${index}`);
  
  // Restart audio capture with new device
  if (isStreaming) {
    stopAudioCapture();
    startAudioCapture();
  }
  
  res.json({ success: true, device: index });
});

// List available audio input devices on macOS
function listAudioDevices() {
  try {
    // Use ffmpeg to list AVFoundation devices
    const result = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true', {
      encoding: 'utf-8',
    });
    
    const lines = result.split('\n');
    const audioDevices = [];
    let inAudioSection = false;
    
    for (const line of lines) {
      if (line.includes('AVFoundation audio devices:')) {
        inAudioSection = true;
        continue;
      }
      if (inAudioSection) {
        const match = line.match(/\[(\d+)\]\s+(.+)/);
        if (match) {
          audioDevices.push({
            index: match[1],
            name: match[2].trim(),
          });
        }
      }
    }
    
    return audioDevices;
  } catch (error) {
    console.error('Error listing devices:', error.message);
    return [];
  }
}

// Start capturing audio from the input device
function startAudioCapture() {
  if (audioProcess) {
    return;
  }

  const deviceIndex = CONFIG.audioDevice || '0';
  
  console.log(`Starting audio capture from device index: ${deviceIndex}`);
  
  // Use ffmpeg to capture audio and encode to Opus in WebM container
  // WebM/Opus is natively supported by browsers
  const ffmpegArgs = [
    '-f', 'avfoundation',           // macOS audio capture
    '-i', `:${deviceIndex}`,        // Audio device (: prefix means audio-only)
    '-ac', CONFIG.channels.toString(),
    '-ar', CONFIG.sampleRate.toString(),
    '-c:a', 'libopus',              // Opus codec
    '-b:a', CONFIG.bitrate,         // Bitrate
    '-application', 'lowdelay',     // Optimize for low latency
    '-frame_duration', '20',        // 20ms frames for low latency
    '-vbr', 'off',                  // Constant bitrate for streaming
    '-f', 'webm',                   // WebM container
    '-cluster_size_limit', '2M',
    '-cluster_time_limit', '100',   // Smaller clusters for lower latency
    'pipe:1'                        // Output to stdout
  ];

  console.log('FFmpeg command:', 'ffmpeg', ffmpegArgs.join(' '));
  
  audioProcess = spawn('ffmpeg', ffmpegArgs);
  isStreaming = true;

  audioProcess.stdout.on('data', (chunk) => {
    // Broadcast to all connected clients
    broadcastAudio(chunk);
  });

  audioProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    // Only log important messages, not the continuous status updates
    if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid')) {
      console.error('FFmpeg error:', msg);
    }
  });

  audioProcess.on('close', (code) => {
    console.log(`FFmpeg process exited with code ${code}`);
    audioProcess = null;
    isStreaming = false;
    
    // Restart if there are still clients connected
    if (clients.size > 0) {
      console.log('Restarting audio capture...');
      setTimeout(startAudioCapture, 1000);
    }
  });

  audioProcess.on('error', (error) => {
    console.error('Failed to start FFmpeg:', error.message);
    console.log('\nMake sure FFmpeg is installed: brew install ffmpeg');
    audioProcess = null;
    isStreaming = false;
  });
}

// Stop audio capture
function stopAudioCapture() {
  if (audioProcess) {
    console.log('Stopping audio capture...');
    audioProcess.kill('SIGTERM');
    audioProcess = null;
    isStreaming = false;
  }
}

// Broadcast audio chunk to all connected clients
function broadcastAudio(chunk) {
  const deadClients = [];
  
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(chunk);
      } catch (error) {
        console.error('Error sending to client:', error.message);
        deadClients.push(client);
      }
    } else {
      deadClients.push(client);
    }
  }
  
  // Clean up dead clients
  for (const client of deadClients) {
    clients.delete(client);
  }
}

// Broadcast listener count to all clients
function broadcastListenerCount() {
  const message = JSON.stringify({
    type: 'listeners',
    count: clients.size,
  });
  
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        // Ignore errors here
      }
    }
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`Client connected from ${clientIp}. Total listeners: ${clients.size + 1}`);
  
  clients.add(ws);
  broadcastListenerCount();
  
  // Start audio capture when first client connects
  if (clients.size === 1 && !audioProcess) {
    startAudioCapture();
  }
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected. Total listeners: ${clients.size}`);
    broadcastListenerCount();
    
    // Stop audio capture when no clients are connected
    if (clients.size === 0) {
      console.log('No listeners, stopping audio capture...');
      stopAudioCapture();
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    clients.delete(ws);
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
  
  console.log(`\n🔊 Audio Devices:`);
  const devices = listAudioDevices();
  if (devices.length === 0) {
    console.log('   No devices found. Make sure FFmpeg is installed.');
  } else {
    for (const device of devices) {
      const marker = device.index === (CONFIG.audioDevice || '0') ? '→' : ' ';
      console.log(`   ${marker} [${device.index}] ${device.name}`);
    }
  }
  
  console.log(`\n💡 To use a different device, set AUDIO_DEVICE environment variable:`);
  console.log(`   AUDIO_DEVICE=1 npm start`);
  console.log('\n━'.repeat(50));
  console.log('Waiting for listeners...\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  stopAudioCapture();
  
  for (const client of clients) {
    client.close();
  }
  
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
