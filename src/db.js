import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'speedtest.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0a84ff',
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_type TEXT NOT NULL DEFAULT 'interval',   -- interval | cron | manual
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  cron TEXT NOT NULL DEFAULT '',
  server_mode TEXT NOT NULL DEFAULT 'auto',         -- auto | fixed | rotate | all
  servers TEXT NOT NULL DEFAULT '[]',               -- JSON array of server ids / hostnames
  rotate_index INTEGER NOT NULL DEFAULT 0,
  interface TEXT NOT NULL DEFAULT '',
  bind_ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL UNIQUE,      -- Ookla numeric id, or hostname
  host TEXT NOT NULL DEFAULT '',
  sponsor TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  profile_id INTEGER,
  profile_name TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL DEFAULT 'schedule',
  status TEXT NOT NULL,                -- ok | error
  error TEXT,
  download_mbps REAL,
  upload_mbps REAL,
  ping_ms REAL,
  jitter_ms REAL,
  ping_low REAL,
  ping_high REAL,
  dl_latency_ms REAL,
  ul_latency_ms REAL,
  packet_loss REAL,
  download_bytes INTEGER,
  upload_bytes INTEGER,
  isp TEXT,
  external_ip TEXT,
  internal_ip TEXT,
  interface_name TEXT,
  is_vpn INTEGER,
  server_id TEXT,
  server_name TEXT,
  server_location TEXT,
  server_country TEXT,
  server_host TEXT,
  requested_server TEXT,
  result_url TEXT,
  duration_s REAL
);
CREATE INDEX IF NOT EXISTS idx_meas_ts ON measurements(ts);
CREATE INDEX IF NOT EXISTS idx_meas_profile_ts ON measurements(profile_id, ts);
`);

// ---------- migrations for databases created by older versions ----------
const profileCols = db.prepare('PRAGMA table_info(profiles)').all().map((c) => c.name);
if (!profileCols.includes('thresholds')) db.exec('ALTER TABLE profiles ADD COLUMN thresholds TEXT');

export const THRESHOLD_KEYS = ['downloadGood', 'downloadFair', 'uploadGood', 'uploadFair', 'pingGood', 'pingFair'];

export const DEFAULT_SETTINGS = {
  retentionDays: 365,
  testTimeoutSeconds: 180,
  defaultRange: '24h',
  downloadGood: 100,
  downloadFair: 25,
  uploadGood: 50,
  uploadFair: 10,
  pingGood: 30,
  pingFair: 80,
  pauseAll: false,
  ooklaNoticeAcknowledged: false,
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) {
      try { s[r.key] = JSON.parse(r.value); } catch { /* ignore */ }
    }
  }
  return s;
}

export function saveSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    let val = v;
    if (typeof def === 'number') { val = Number(v); if (!Number.isFinite(val)) continue; }
    if (typeof def === 'boolean') val = Boolean(v);
    if (typeof def === 'string') val = String(v);
    stmt.run(k, JSON.stringify(val));
  }
  return getSettings();
}

// ---------- profiles ----------
function rowToProfile(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    enabled: !!r.enabled,
    scheduleType: r.schedule_type,
    intervalMinutes: r.interval_minutes,
    cron: r.cron,
    serverMode: r.server_mode,
    servers: JSON.parse(r.servers || '[]'),
    rotateIndex: r.rotate_index,
    interface: r.interface,
    bindIp: r.bind_ip,
    thresholds: r.thresholds ? JSON.parse(r.thresholds) : null, // null = use the default thresholds
    createdAt: r.created_at,
  };
}

export function listProfiles() {
  return db.prepare('SELECT * FROM profiles ORDER BY id').all().map(rowToProfile);
}
export function getProfile(id) {
  return rowToProfile(db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
}

export function sanitizeProfile(p, existing = {}) {
  const out = { ...existing, ...p };
  out.name = String(out.name || 'Untitled').slice(0, 80);
  out.color = /^#[0-9a-fA-F]{6}$/.test(out.color || '') ? out.color : '#0a84ff';
  out.enabled = out.enabled !== false;
  out.scheduleType = ['interval', 'cron', 'manual'].includes(out.scheduleType) ? out.scheduleType : 'interval';
  out.intervalMinutes = Math.min(10080, Math.max(1, Math.round(Number(out.intervalMinutes) || 30)));
  out.cron = String(out.cron || '').trim();
  out.serverMode = ['auto', 'fixed', 'rotate', 'all'].includes(out.serverMode) ? out.serverMode : 'auto';
  out.servers = (Array.isArray(out.servers) ? out.servers : [])
    .map((s) => String(s).trim())
    .filter((s) => /^[0-9]+$/.test(s) || /^[a-zA-Z0-9.-]+$/.test(s))
    .slice(0, 50);
  out.interface = String(out.interface || '').trim().replace(/[^a-zA-Z0-9_.:@-]/g, '');
  out.bindIp = String(out.bindIp || '').trim().replace(/[^0-9a-fA-F.:]/g, '');
  out.thresholds = sanitizeThresholds(out.thresholds);
  return out;
}

// Either null (use defaults) or all six thresholds as non-negative numbers.
function sanitizeThresholds(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const k of THRESHOLD_KEYS) {
    const v = Number(t[k]);
    if (!Number.isFinite(v) || v < 0) {
      throw Object.assign(new Error(`Threshold "${k}" must be a number of 0 or more`), { status: 400 });
    }
    out[k] = v;
  }
  return out;
}

export function createProfile(p) {
  const s = sanitizeProfile(p);
  const r = db.prepare(`INSERT INTO profiles(name, color, enabled, schedule_type, interval_minutes, cron, server_mode, servers, interface, bind_ip, thresholds, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    s.name, s.color, s.enabled ? 1 : 0, s.scheduleType, s.intervalMinutes, s.cron, s.serverMode,
    JSON.stringify(s.servers), s.interface, s.bindIp, s.thresholds ? JSON.stringify(s.thresholds) : null, Date.now());
  return getProfile(r.lastInsertRowid);
}

export function updateProfile(id, p) {
  const existing = getProfile(id);
  if (!existing) return null;
  const s = sanitizeProfile(p, existing);
  db.prepare(`UPDATE profiles SET name=?, color=?, enabled=?, schedule_type=?, interval_minutes=?, cron=?, server_mode=?, servers=?, interface=?, bind_ip=?, thresholds=? WHERE id=?`).run(
    s.name, s.color, s.enabled ? 1 : 0, s.scheduleType, s.intervalMinutes, s.cron, s.serverMode,
    JSON.stringify(s.servers), s.interface, s.bindIp, s.thresholds ? JSON.stringify(s.thresholds) : null, id);
  return getProfile(id);
}

export function deleteProfile(id) {
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

export function bumpRotateIndex(id) {
  db.prepare('UPDATE profiles SET rotate_index = rotate_index + 1 WHERE id = ?').run(id);
}

// ---------- saved servers ----------
export function listSavedServers() {
  return db.prepare('SELECT * FROM saved_servers ORDER BY sponsor, location').all().map((r) => ({
    id: r.id, serverId: r.server_id, host: r.host, sponsor: r.sponsor, location: r.location,
    country: r.country, label: r.label,
  }));
}
export function saveServer(s) {
  const serverId = String(s.serverId || '').trim();
  if (!serverId) throw new Error('serverId required');
  db.prepare(`INSERT INTO saved_servers(server_id, host, sponsor, location, country, label, created_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(server_id) DO UPDATE SET host=excluded.host, sponsor=excluded.sponsor, location=excluded.location, country=excluded.country, label=excluded.label`)
    .run(serverId, String(s.host || ''), String(s.sponsor || ''), String(s.location || ''), String(s.country || ''), String(s.label || ''), Date.now());
  return listSavedServers().find((x) => x.serverId === serverId);
}
export function deleteSavedServer(id) {
  db.prepare('DELETE FROM saved_servers WHERE id = ?').run(id);
}

// ---------- measurements ----------
const MEAS_COLS = ['ts', 'profile_id', 'profile_name', 'trigger', 'status', 'error', 'download_mbps', 'upload_mbps', 'ping_ms', 'jitter_ms',
  'ping_low', 'ping_high', 'dl_latency_ms', 'ul_latency_ms', 'packet_loss', 'download_bytes', 'upload_bytes', 'isp', 'external_ip',
  'internal_ip', 'interface_name', 'is_vpn', 'server_id', 'server_name', 'server_location', 'server_country', 'server_host',
  'requested_server', 'result_url', 'duration_s'];

export function insertMeasurement(m) {
  const stmt = db.prepare(`INSERT INTO measurements(${MEAS_COLS.join(',')}) VALUES(${MEAS_COLS.map(() => '?').join(',')})`);
  const r = stmt.run(...MEAS_COLS.map((c) => (m[c] === undefined ? null : m[c])));
  return db.prepare('SELECT * FROM measurements WHERE id = ?').get(r.lastInsertRowid);
}

const SORTABLE = new Set(['ts', 'download_mbps', 'upload_mbps', 'ping_ms', 'jitter_ms', 'dl_latency_ms', 'packet_loss', 'status', 'profile_name', 'server_name']);

function buildWhere(q) {
  const where = [];
  const args = [];
  if (q.from) { where.push('ts >= ?'); args.push(Number(q.from)); }
  if (q.to) { where.push('ts <= ?'); args.push(Number(q.to)); }
  if (q.profile) {
    const ids = String(q.profile).split(',').map(Number).filter(Number.isFinite);
    if (ids.length) { where.push(`profile_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  }
  if (q.server) { where.push('server_id = ?'); args.push(String(q.server)); }
  if (q.status) { where.push('status = ?'); args.push(String(q.status)); }
  if (q.search) {
    where.push('(server_name LIKE ? OR server_location LIKE ? OR isp LIKE ? OR profile_name LIKE ?)');
    const s = `%${q.search}%`; args.push(s, s, s, s);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export function queryMeasurements(q = {}) {
  const { sql, args } = buildWhere(q);
  const sort = SORTABLE.has(q.sort) ? q.sort : 'ts';
  const order = q.order === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(5000, Math.max(1, Number(q.limit) || 25));
  const offset = Math.max(0, Number(q.offset) || 0);
  const total = db.prepare(`SELECT COUNT(*) c FROM measurements ${sql}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM measurements ${sql} ORDER BY ${sort} ${order}, id ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { total, rows };
}

export function seriesMeasurements(q = {}) {
  const { sql, args } = buildWhere(q);
  return db.prepare(`SELECT id, ts, profile_id, status, download_mbps, upload_mbps, ping_ms, jitter_ms, dl_latency_ms, ul_latency_ms, packet_loss, server_id, server_name, server_location
    FROM measurements ${sql} ORDER BY ts ASC LIMIT 20000`).all(...args);
}

export function allMeasurementsForExport(q = {}) {
  const { sql, args } = buildWhere(q);
  return db.prepare(`SELECT * FROM measurements ${sql} ORDER BY ts ASC`).all(...args);
}

export function summary(q = {}) {
  const { sql, args } = buildWhere(q);
  const okSql = sql ? `${sql} AND status = 'ok'` : "WHERE status = 'ok'";
  const agg = db.prepare(`SELECT COUNT(*) n, AVG(download_mbps) dl, AVG(upload_mbps) ul, AVG(ping_ms) ping, AVG(dl_latency_ms) loaded,
      MIN(download_mbps) dlMin, MAX(download_mbps) dlMax, MIN(upload_mbps) ulMin, MAX(upload_mbps) ulMax, AVG(jitter_ms) jitter, AVG(packet_loss) loss
      FROM measurements ${okSql}`).get(...args);
  const counts = db.prepare(`SELECT COUNT(*) total, SUM(status = 'error') errors FROM measurements ${sql}`).get(...args);
  return { ...agg, total: counts.total, errors: counts.errors || 0 };
}

export function perProfileStats(from) {
  return db.prepare(`SELECT profile_id, COUNT(*) total, SUM(status='error') errors,
      AVG(CASE WHEN status='ok' THEN download_mbps END) dl, AVG(CASE WHEN status='ok' THEN upload_mbps END) ul,
      AVG(CASE WHEN status='ok' THEN ping_ms END) ping, MAX(ts) lastTs
    FROM measurements WHERE ts >= ? GROUP BY profile_id`).all(from);
}

export function latestSuccessful() {
  return db.prepare(`SELECT ts, isp, external_ip, internal_ip, interface_name, is_vpn FROM measurements
    WHERE status = 'ok' ORDER BY ts DESC LIMIT 1`).get() || null;
}

export function latestPerProfile() {
  return db.prepare(`SELECT m.* FROM measurements m
    JOIN (SELECT profile_id, MAX(ts) ts FROM measurements GROUP BY profile_id) x ON x.profile_id = m.profile_id AND x.ts = m.ts`).all();
}

export function lastRunTs(profileId) {
  const r = db.prepare('SELECT MAX(ts) ts FROM measurements WHERE profile_id = ?').get(profileId);
  return r?.ts || null;
}

export function distinctServers() {
  return db.prepare(`SELECT server_id, server_name, server_location, COUNT(*) n FROM measurements WHERE server_id IS NOT NULL
    GROUP BY server_id ORDER BY n DESC`).all();
}

export function deleteMeasurement(id) {
  db.prepare('DELETE FROM measurements WHERE id = ?').run(id);
}

export function pruneOld(days) {
  if (!days || days <= 0) return 0;
  return db.prepare('DELETE FROM measurements WHERE ts < ?').run(Date.now() - days * 86400000).changes;
}

// Seed a default profile on first boot
if (db.prepare('SELECT COUNT(*) c FROM profiles').get().c === 0) {
  createProfile({
    name: process.env.DEFAULT_PROFILE_NAME || 'Auto (nearest)',
    color: '#0a84ff',
    scheduleType: 'interval',
    intervalMinutes: Number(process.env.DEFAULT_INTERVAL_MINUTES) || 30,
    serverMode: 'auto',
  });
}
