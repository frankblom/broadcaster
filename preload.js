// Preload for the broadcaster window. contextIsolation is on, so the renderer
// can't reach Electron APIs directly — this exposes a tiny, explicit bridge:
//   openSettings()        -> ask the main process to open the Settings window
//   onSettingsChanged(cb) -> fired after the Settings window closes, so the
//                            main window can refresh anything a setting affects
//                            (e.g. the shared listener URL after an mDNS change).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openSettings: () => ipcRenderer.send('open-settings'),
  onSettingsChanged: (callback) => ipcRenderer.on('settings-changed', () => callback()),
});
