import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './db.js';
import * as runner from './runner.js';
import * as scheduler from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CHART_JS = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const PORT = Number(process.env.PORT) || 3000;
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json' : 'text/plain', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new Error('body too large'); }
  return raw ? JSON.parse(raw) : {};
}

function safeEqual(a, b) {
  const ba = Buffer.from(a); const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function checkAuth(req, res) {
  if (!AUTH_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    if (safeEqual(u, AUTH_USER || 'admin') && safeEqual(rest.join(':'), AUTH_PASSWORD)) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Speed Monitor"' });
  res.end('Authentication required');
  return false;
}

function profilesWithMeta() {
  const latest = new Map(store.latestPerProfile().map((m) => [m.profile_id, m]));
  return store.listProfiles().map((p) => ({ ...p, nextRun: scheduler.getNextRun(p.id), latest: latest.get(p.id) || null }));
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
runner.events.on('state', (s) => broadcast('state', s));
runner.events.on('progress', (p) => broadcast('progress', p));
runner.events.on('measurement', (m) => { broadcast('measurement', m); broadcast('profiles', profilesWithMeta()); });
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(c === 'ts' ? new Date(r[c]).toISOString() : r[c])).join(','))].join('\n');
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const m = req.method;
  let match;

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: state\ndata: ${JSON.stringify(runner.getState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/state' && m === 'GET') return send(res, 200, runner.getState());

  // profiles
  if (p === '/api/profiles' && m === 'GET') return send(res, 200, profilesWithMeta());
  if (p === '/api/profiles' && m === 'POST') {
    const body = await readJson(req);
    validateProfile(body);
    const prof = store.createProfile(body);
    scheduler.resetProfile(prof);
    broadcast('profiles', profilesWithMeta());
    return send(res, 201, prof);
  }
  if ((match = p.match(/^\/api\/profiles\/(\d+)$/))) {
    const id = Number(match[1]);
    if (m === 'PUT') {
      const body = await readJson(req);
      validateProfile(body);
      const prof = store.updateProfile(id, body);
      if (!prof) return send(res, 404, { error: 'not found' });
      scheduler.resetProfile(prof);
      broadcast('profiles', profilesWithMeta());
      return send(res, 200, prof);
    }
    if (m === 'DELETE') {
      store.deleteProfile(id);
      scheduler.removeProfile(id);
      broadcast('profiles', profilesWithMeta());
      return send(res, 200, { ok: true });
    }
  }
  if ((match = p.match(/^\/api\/profiles\/(\d+)\/run$/)) && m === 'POST') {
    const prof = store.getProfile(Number(match[1]));
    if (!prof) return send(res, 404, { error: 'not found' });
    return send(res, 202, { jobs: runner.enqueueProfile(prof, 'manual') });
  }
  if (p === '/api/run' && m === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    let jobs = [];
    if (body.server) {
      // ad-hoc test against a specific server, attributed to a profile (or the first one)
      const prof = store.getProfile(Number(body.profileId)) || store.listProfiles()[0];
      if (!prof) return send(res, 400, { error: 'create a profile first' });
      jobs = runner.enqueueProfile({ ...prof, serverMode: 'fixed', servers: [String(body.server)] }, 'manual');
    } else {
      for (const prof of store.listProfiles().filter((x) => x.enabled)) jobs.push(...runner.enqueueProfile(prof, 'manual'));
    }
    return send(res, 202, { jobs });
  }
  if ((match = p.match(/^\/api\/jobs\/(\d+)$/)) && m === 'DELETE') {
    return send(res, 200, { ok: runner.cancelJob(Number(match[1])) });
  }
  if (p === '/api/queue' && m === 'DELETE') { runner.clearQueue(); return send(res, 200, { ok: true }); }

  // servers
  if (p === '/api/servers/nearby' && m === 'GET') return send(res, 200, await runner.listNearbyServers(q.refresh === '1'));
  if (p === '/api/servers/search' && m === 'GET') return send(res, 200, await runner.searchServers(q.q || '', Number(q.limit) || 50));
  if (p === '/api/servers/saved' && m === 'GET') return send(res, 200, store.listSavedServers());
  if (p === '/api/servers/saved' && m === 'POST') return send(res, 201, store.saveServer(await readJson(req)));
  if ((match = p.match(/^\/api\/servers\/saved\/(\d+)$/)) && m === 'DELETE') { store.deleteSavedServer(Number(match[1])); return send(res, 200, { ok: true }); }
  if (p === '/api/servers/seen' && m === 'GET') return send(res, 200, store.distinctServers());

  // measurements
  if (p === '/api/measurements' && m === 'GET') return send(res, 200, store.queryMeasurements(q));
  if (p === '/api/series' && m === 'GET') return send(res, 200, store.seriesMeasurements(q));
  if (p === '/api/summary' && m === 'GET') {
    const from = Number(q.from) || 0;
    const span = (Number(q.to) || Date.now()) - from;
    // previous window of the same length, to compute "vs previous" deltas
    const prev = from ? store.summary({ ...q, from: from - span, to: from }) : null;
    return send(res, 200, { current: store.summary(q), previous: prev, perProfile: store.perProfileStats(from) });
  }
  if ((match = p.match(/^\/api\/measurements\/(\d+)$/)) && m === 'DELETE') { store.deleteMeasurement(Number(match[1])); return send(res, 200, { ok: true }); }
  if (p === '/api/export.csv' && m === 'GET') {
    return send(res, 200, toCsv(store.allMeasurementsForExport(q)), {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="speedtest-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }

  // settings
  if (p === '/api/settings' && m === 'GET') return send(res, 200, store.getSettings());
  if (p === '/api/settings' && m === 'PUT') {
    const s = store.saveSettings(await readJson(req));
    broadcast('settings', s);
    return send(res, 200, s);
  }
  if (p === '/api/cron/preview' && m === 'GET') {
    try {
      const chain = []; let from = Date.now();
      for (let i = 0; i < 5; i++) { const n = scheduler.nextCronTime(q.expr || '', from); if (!n) break; chain.push(n); from = n; }
      return send(res, 200, { ok: true, next: chain });
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }

  return send(res, 404, { error: 'not found' });
}

function validateProfile(body) {
  if (body.scheduleType === 'cron') scheduler.parseCron(body.cron || '');
  if (['fixed', 'rotate', 'all'].includes(body.serverMode) && !(body.servers || []).length) {
    throw Object.assign(new Error('Pick at least one server for this server mode'), { status: 400 });
  }
}

function serveStatic(req, res, url) {
  let file;
  if (url.pathname === '/vendor/chart.js') file = CHART_JS;
  else {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      if (!path.extname(url.pathname)) return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => (e2 ? send(res, 404, 'not found') : send(res, 200, html, { 'Content-Type': MIME['.html'] })));
      return send(res, 404, 'not found');
    }
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/health') return send(res, 200, { ok: true });
  if (!checkAuth(req, res)) return;
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || (e instanceof SyntaxError || /cron|bad |needs 5/.test(e.message) ? 400 : 500);
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message });
  }
});

scheduler.start();
server.listen(PORT, () => console.log(`Speed monitor listening on :${PORT}${AUTH_PASSWORD ? ' (basic auth enabled)' : ''}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
