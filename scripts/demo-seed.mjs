// Fills a fresh database with demo data: fictional servers and a week of plausible results.
// Used for README / Community Applications screenshots, so no real IPs, ISPs or locations appear.
//
//   DATA_DIR=/tmp/wims-demo node scripts/demo-seed.mjs
//
// DATA_DIR must be an empty or non-existent folder. The latest demo result of each
// profile is recent, so no schedule is due for a while. scripts/screenshots.mjs also
// points the server at a dummy speedtest binary, so it can never run a real test.
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATA_DIR) { console.error('Set DATA_DIR to an empty folder'); process.exit(1); }
if (fs.existsSync(path.join(process.env.DATA_DIR, 'speedtest.db'))) { console.error(`${process.env.DATA_DIR} already has a database`); process.exit(1); }

const store = await import('../src/db.js');

let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;

const SERVERS = {
  90001: { name: 'Northwind Fiber', location: 'Amsterdam', country: 'Netherlands', host: 'speedtest.northwind.example' },
  90002: { name: 'Bluepeak Networks', location: 'Frankfurt', country: 'Germany', host: 'st.bluepeak.example' },
  90003: { name: 'Harbor Telecom', location: 'London', country: 'United Kingdom', host: 'speed.harbor.example' },
  90004: { name: 'Metro Link', location: 'Paris', country: 'France', host: 'ookla.metrolink.example' },
  90005: { name: 'Citynet', location: 'Your City', country: 'Local', host: 'speedtest.citynet.example' },
  90006: { name: 'Fjord Net', location: 'Oslo', country: 'Norway', host: 'speedtest.fjordnet.example' },
};
for (const [id, s] of Object.entries(SERVERS)) {
  store.saveServer({ serverId: id, host: s.host, sponsor: s.name, location: s.location, country: s.country });
}

const auto = store.updateProfile(store.listProfiles()[0].id, {
  name: 'Home fiber (auto)', color: '#1d8cf8', scheduleType: 'interval', intervalMinutes: 30,
  thresholds: { downloadGood: 800, downloadFair: 400, uploadGood: 400, uploadFair: 200, pingGood: 10, pingFair: 25 },
});
const eu = store.createProfile({ name: 'EU backbone', color: '#8b5cf6', scheduleType: 'cron', cron: '0 */2 * * *', serverMode: 'all', servers: ['90001', '90002', '90003'] });
const vpn = store.createProfile({
  name: 'VPN tunnel', color: '#e0a106', scheduleType: 'interval', intervalMinutes: 60, serverMode: 'rotate', servers: ['90004', '90006'], interface: 'wg0',
  thresholds: { downloadGood: 250, downloadFair: 100, uploadGood: 150, uploadFair: 50, pingGood: 40, pingFair: 80 },
});
store.createProfile({ name: 'Nightly ISP check', color: '#16a34a', scheduleType: 'cron', cron: '30 3 * * *', serverMode: 'fixed', servers: ['90005'], enabled: false });

const now = Date.now();
const start = now - 8 * 86400e3;
// evening congestion: a dip between 19:00 and 23:00
const congestion = (ts) => {
  const d = new Date(ts); const h = d.getHours() + d.getMinutes() / 60;
  return h >= 19 && h <= 23 ? 0.72 + 0.1 * Math.cos(((h - 21) / 2) * Math.PI) : 1;
};

function row(profile, ts, sid, base) {
  const s = SERVERS[sid];
  const r = {
    ts, profile_id: profile.id, profile_name: profile.name, trigger: 'schedule', server_id: sid, server_name: s.name,
    server_location: s.location, server_country: s.country, server_host: s.host, requested_server: profile.serverMode === 'auto' ? null : sid,
  };
  if (rnd() < base.failRate) {
    return { ...r, status: 'error', error: rnd() < 0.5 ? 'Cannot read from socket: Connection reset by peer' : 'Timed out after 180s', duration_s: 180 };
  }
  const c = congestion(ts);
  const dl = Math.max(5, base.dl * c * (1 + 0.06 * gauss()));
  const ul = Math.max(2, base.ul * (0.9 + 0.1 * c) * (1 + 0.05 * gauss()));
  const ping = Math.max(1, base.ping * (1 + 0.15 * gauss()) + (c < 1 ? 3 : 0));
  return {
    ...r, status: 'ok', download_mbps: dl, upload_mbps: ul, ping_ms: ping, jitter_ms: Math.abs(0.8 + 1.2 * gauss()),
    ping_low: ping * 0.9, ping_high: ping * 1.3, dl_latency_ms: ping + 12 + 20 * rnd() + (c < 1 ? 25 : 0), ul_latency_ms: ping + 18 + 25 * rnd(),
    packet_loss: rnd() < 0.85 ? 0 : +(rnd() * 1.2).toFixed(2), download_bytes: Math.round(((dl * 1e6) / 8) * 12), upload_bytes: Math.round(((ul * 1e6) / 8) * 8),
    // documentation-only addresses (RFC 5737 / private range)
    isp: 'Example Fiber Co.', external_ip: '203.0.113.42', internal_ip: '192.168.1.20', interface_name: 'eth0', is_vpn: 0,
    result_url: null, duration_s: 22 + 6 * rnd(),
  };
}

let n = 0;
// newest first, so the latest run of each profile is recent and no schedule is due yet
for (let t = now - 6 * 60e3; t > start; t -= 30 * 60e3) { store.insertMeasurement(row(auto, t + rnd() * 30e3, '90005', { dl: 920, ul: 480, ping: 6, failRate: 0.01 })); n++; }
const EU = { 90001: { dl: 860, ul: 450, ping: 14 }, 90002: { dl: 780, ul: 430, ping: 19 }, 90003: { dl: 640, ul: 390, ping: 27 } };
for (let t = Math.ceil(start / 7200e3) * 7200e3; t < now; t += 7200e3) {
  ['90001', '90002', '90003'].forEach((sid, k) => { store.insertMeasurement(row(eu, t + k * 30e3 + 5e3, sid, { ...EU[sid], failRate: 0.02 })); n++; });
}
let i = 0;
for (let t = now - 25 * 60e3; t > start; t -= 3600e3) {
  const sid = i++ % 2 ? '90006' : '90004';
  const r = row(vpn, t, sid, { dl: 310, ul: 180, ping: 32, failRate: 0.04 });
  if (r.status === 'ok') { r.is_vpn = 1; r.interface_name = 'wg0'; }
  store.insertMeasurement(r); n++;
}
store.saveSettings({ ooklaNoticeAcknowledged: true, defaultRange: '7d' });
console.log(`Seeded ${n} demo measurements into ${process.env.DATA_DIR}.`);
