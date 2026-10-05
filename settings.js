// Small persistent settings store for user-adjustable options (currently the
// mDNS / friendly-name config). Everything else in the app is configured via
// environment variables at startup, but mDNS needs to be toggled from the UI at
// runtime, so it lives in a JSON file instead.
//
// The file location comes from SETTINGS_PATH (the Electron main process points
// this at app.getPath('userData'), which is writable even when the rest of the
// app is packaged read-only inside an asar). When unset — e.g. running
// `node server.js` directly — it falls back to a file next to this module.
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = process.env.SETTINGS_PATH
  || path.join(__dirname, 'app-settings.json');

// Defaults. mDNS is on by default so the friendly name works out of the box;
// the IP URLs always remain available as a fallback, and the whole feature can
// be turned off from the UI. An empty hostname means "derive one from the
// machine name", and an empty interface means "advertise on all interfaces".
const DEFAULTS = {
  mdns: {
    enabled: true,
    hostname: '',
    interface: '',
  },
  // Ports the server listens on. Overridable from the UI so a user can move off
  // a port that's already taken by something else. An explicit PORT /
  // HTTPS_PORT env var still wins over these at startup (see server.js).
  server: {
    httpPort: 3000,
    httpsPort: 3443,
  },
};

// Coerce a value to a valid TCP port (1-65535), or return the fallback when it
// isn't a usable number. Keeps a bad hand-edited settings file or UI input from
// crashing the listener.
function toPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

// Merge persisted values over the defaults so new fields added in future
// versions still get a sensible value for existing installs.
function load() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const server = { ...DEFAULTS.server, ...(parsed.server || {}) };
    return {
      mdns: { ...DEFAULTS.mdns, ...(parsed.mdns || {}) },
      server: {
        httpPort: toPort(server.httpPort, DEFAULTS.server.httpPort),
        httpsPort: toPort(server.httpsPort, DEFAULTS.server.httpsPort),
      },
    };
  } catch (err) {
    // Missing or unreadable file -> use defaults (don't write one yet).
    return { mdns: { ...DEFAULTS.mdns }, server: { ...DEFAULTS.server } };
  }
}

function save(settings) {
  const server = { ...DEFAULTS.server, ...(settings.server || {}) };
  const toSave = {
    mdns: { ...DEFAULTS.mdns, ...(settings.mdns || {}) },
    server: {
      httpPort: toPort(server.httpPort, DEFAULTS.server.httpPort),
      httpsPort: toPort(server.httpsPort, DEFAULTS.server.httpsPort),
    },
  };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(toSave, null, 2));
  } catch (err) {
    console.error('Failed to save settings:', err.message);
  }
  return toSave;
}

module.exports = { load, save, SETTINGS_PATH, DEFAULTS };
