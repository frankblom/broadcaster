const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// Keep a global reference of the window object
let mainWindow = null;
let serverStarted = false;

// Start the Express server
function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  require('./server.js');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Wait a moment for the server to be ready, then load broadcast.html
  setTimeout(() => {
    mainWindow.loadFile('broadcast.html');
  }, 500);

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
