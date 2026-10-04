const { app, BrowserWindow, shell, dialog, ipcMain, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// The HTTP port the local server listens on, using the same precedence as
// server.js (PORT env var > saved setting > default). The broadcaster window is
// loaded over file:// and talks to http://localhost:<port>, so it needs to know
// which port was chosen. Resolved after SETTINGS_PATH is set in startServer().
function localHttpPort() {
  if (Number(process.env.PORT)) return Number(process.env.PORT);
  try {
    return require('./settings').load().server.httpPort;
  } catch (e) {
    return 3000;
  }
}

// Keep a global reference of the window object
let mainWindow = null;
let settingsWindow = null;
let serverStarted = false;

// Open (or focus) the standalone Settings window. It loads over file:// like the
// main window and talks to the local server's /api/settings, so it needs the
// same httpPort. When it closes we tell the main window to refresh anything a
// setting may have changed (e.g. the shared listener URL after an mDNS change).
function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 560,
    minWidth: 420,
    minHeight: 420,
    parent: mainWindow || undefined,
    title: 'Settings',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Use the standard window menu role instead of the app menu bar on this window.
  settingsWindow.setMenuBarVisibility(false);

  settingsWindow.loadFile('settings.html', {
    query: { httpPort: String(localHttpPort()) },
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings-changed');
    }
  });
}

// Start the Express server
function startServer() {
  if (serverStarted) return;
  serverStarted = true;

  // Enable HTTPS (alongside HTTP) so remote devices — a translator joining from a
  // phone — can use their microphone. getUserMedia only works in a secure context,
  // which over a LAN IP means HTTPS. The HTTP listener stays up on localhost for
  // this window's own broadcaster, so nothing here needs to trust the self-signed
  // cert. Respect an explicit override if the user set their own env vars.
  if (!process.env.HTTPS && !process.env.SSL_CERT) {
    process.env.HTTPS = 'true';
  }

  // Persist user settings (mDNS config) in the per-user data directory, which
  // stays writable even though the packaged app itself is read-only (asar).
  if (!process.env.SETTINGS_PATH) {
    process.env.SETTINGS_PATH = path.join(app.getPath('userData'), 'app-settings.json');
  }

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
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Wait a moment for the server to be ready, then load broadcast.html. Pass the
  // chosen HTTP port along so the page (which runs over file://) connects to the
  // right localhost port instead of assuming the default.
  setTimeout(() => {
    mainWindow.loadFile('broadcast.html', {
      query: { httpPort: String(localHttpPort()) },
    });
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

// Build an application menu that keeps the standard roles (so copy/paste in the
// settings inputs, window controls, etc. still work) and adds a Settings item
// with the platform-standard accelerator (Cmd+, on macOS, Ctrl+, elsewhere).
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const settingsItem = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: openSettingsWindow,
  };

  const template = [
    ...(isMac ? [{
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        ...(isMac ? [] : [settingsItem, { type: 'separator' }]),
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Renderer (via preload) asks to open the Settings window.
ipcMain.on('open-settings', openSettingsWindow);

app.whenReady().then(() => {
  startServer();
  buildMenu();
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

// Auto-updater configuration
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Available',
    message: `Version ${info.version} is available. It will be downloaded in the background.`,
  });
});

autoUpdater.on('update-downloaded', (info) => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: `Version ${info.version} has been downloaded. Restart the app to apply the update.`,
    buttons: ['Restart Now', 'Later'],
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

autoUpdater.on('error', (err) => {
  console.error('Auto-updater error:', err);
});

// Check for updates after app is ready (only in production)
app.whenReady().then(() => {
  if (app.isPackaged) {
    autoUpdater.checkForUpdates();
  }
});
