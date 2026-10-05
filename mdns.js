// mDNS (multicast-DNS / "Bonjour"-style) responder.
//
// This lets people reach the app with a friendly name like
//   http://audiocaster.local:3000
// instead of a bare LAN IP. It is purely additive: the IP URLs always keep
// working as a fallback, and the whole thing can be turned off from the UI.
//
// We advertise a single A record for "<name>.local" pointing at the IP(s) of
// the selected network interface (or every non-internal IPv4 interface when
// none is selected). Resolving ".local" names requires an mDNS resolver on the
// client — macOS/iOS and Windows 10+ have one built in; some Android devices do
// not, which is exactly why the IP fallback stays in place.
const os = require('os');

let mdns = null; // active multicast-dns instance (null when stopped)
let current = { enabled: false, hostname: null, fqdn: null, ips: [], interface: '' };

// Turn an arbitrary string into a valid DNS label: lowercase, only a-z/0-9/-,
// collapse runs of separators, and trim leading/trailing hyphens.
function sanitizeHostname(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.local\.?$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

// A reasonable default name derived from the machine's hostname, e.g.
// "Franks-MacBook-Pro.local" -> "franks-macbook-pro". Falls back to a constant.
function defaultHostname() {
  return sanitizeHostname(os.hostname()) || 'audiocaster';
}

// List selectable interfaces (non-internal IPv4), one entry per address.
function listInterfaces() {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        result.push({ name, address: iface.address });
      }
    }
  }
  return result;
}

// Resolve the IP(s) we should advertise. When a specific interface is selected
// we only advertise its address(es); otherwise we advertise all of them.
function resolveIPs(interfaceName) {
  const all = listInterfaces();
  if (interfaceName) {
    const match = all.filter((i) => i.name === interfaceName).map((i) => i.address);
    if (match.length) return match;
    // Selected interface is gone (e.g. VPN disconnected) — fall back to all.
  }
  return all.map((i) => i.address);
}

// Send an unsolicited announcement so resolvers/caches learn the record without
// having to query first. Safe to call repeatedly.
function announce() {
  if (!mdns || !current.fqdn || current.ips.length === 0) return;
  mdns.respond({
    answers: current.ips.map((ip) => ({
      name: current.fqdn,
      type: 'A',
      ttl: 120,
      flush: true,
      data: ip,
    })),
  });
}

// (Re)configure the responder. Tears down any existing instance first so this
// doubles as "restart with new settings".
function apply(config = {}) {
  stop();

  const enabled = !!config.enabled;
  const interfaceName = config.interface || '';
  const hostname = sanitizeHostname(config.hostname) || defaultHostname();

  if (!enabled) {
    current = { enabled: false, hostname, fqdn: null, ips: [], interface: interfaceName };
    return current;
  }

  const fqdn = `${hostname}.local`;
  const ips = resolveIPs(interfaceName);

  try {
    const multicastDns = require('multicast-dns');
    mdns = multicastDns();

    // Answer A / ANY queries for our name with the advertised IP(s).
    mdns.on('query', (query) => {
      const answers = [];
      for (const q of query.questions || []) {
        if ((q.type === 'A' || q.type === 'ANY')
          && typeof q.name === 'string'
          && q.name.toLowerCase() === fqdn.toLowerCase()) {
          for (const ip of ips) {
            answers.push({ name: fqdn, type: 'A', ttl: 120, data: ip });
          }
        }
      }
      if (answers.length) {
        try { mdns.respond({ answers }); } catch (err) { /* ignore transient send errors */ }
      }
    });

    mdns.on('error', (err) => {
      console.error('mDNS error:', err.message);
    });

    current = { enabled: true, hostname, fqdn, ips, interface: interfaceName };
    announce();
    console.log(`📛 mDNS advertising ${fqdn} -> ${ips.join(', ') || '(no IPs)'}`);
  } catch (err) {
    console.error('Failed to start mDNS:', err.message);
    mdns = null;
    current = { enabled: false, hostname, fqdn: null, ips: [], interface: interfaceName };
  }

  return current;
}

function stop() {
  if (mdns) {
    try { mdns.destroy(); } catch (err) { /* ignore */ }
    mdns = null;
  }
}

// Snapshot of what's currently being advertised (used by /api/status).
function getState() {
  return { ...current };
}

module.exports = {
  apply,
  stop,
  getState,
  announce,
  listInterfaces,
  sanitizeHostname,
  defaultHostname,
};
