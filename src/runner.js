import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as store from './db.js';

const SPEEDTEST_BIN = process.env.SPEEDTEST_BIN || 'speedtest';
export const events = new EventEmitter();
events.setMaxListeners(1000);

let jobSeq = 0;
const queue = [];          // pending jobs
let current = null;        // { job, child, progress, startedAt }

const isNumericId = (s) => /^[0-9]+$/.test(String(s));

export function buildArgs({ server, iface, bindIp }) {
  const args = ['--accept-license', '--accept-gdpr', '-f', 'jsonl', '-p', 'yes', '--progress-update-interval=500'];
  if (server) args.push(isNumericId(server) ? `--server-id=${server}` : `--host=${server}`);
  if (iface) args.push(`--interface=${iface}`);
  if (bindIp) args.push(`--ip=${bindIp}`);
  return args;
}

/** Expand a profile into one or more jobs depending on its server mode. */
export function jobsForProfile(profile, trigger) {
  const base = { profileId: profile.id, profileName: profile.name, color: profile.color, trigger, iface: profile.interface, bindIp: profile.bindIp };
  const servers = profile.servers || [];
  switch (profile.serverMode) {
    case 'fixed':
      return [{ ...base, server: servers[0] || null }];
    case 'rotate': {
      if (!servers.length) return [{ ...base, server: null }];
      const s = servers[profile.rotateIndex % servers.length];
      store.bumpRotateIndex(profile.id);
      return [{ ...base, server: s }];
    }
    case 'all':
      return servers.length ? servers.map((s) => ({ ...base, server: s })) : [{ ...base, server: null }];
    default:
      return [{ ...base, server: null }];
  }
}

export function enqueueProfile(profile, trigger = 'manual') {
  // Avoid piling up scheduled runs for the same profile
  if (trigger === 'schedule') {
    const busy = queue.some((j) => j.profileId === profile.id) || current?.job.profileId === profile.id;
    if (busy) return [];
  }
  const jobs = jobsForProfile(profile, trigger).map((j) => ({ ...j, id: ++jobSeq, queuedAt: Date.now() }));
  queue.push(...jobs);
  emitState();
  setImmediate(pump);
  return jobs;
}

export function cancelJob(id) {
  const idx = queue.findIndex((j) => j.id === id);
  if (idx >= 0) { queue.splice(idx, 1); emitState(); return true; }
  if (current && current.job.id === id) { current.cancelled = true; current.child.kill('SIGTERM'); return true; }
  return false;
}

export function clearQueue() {
  queue.length = 0;
  emitState();
}

export function getState() {
  return {
    running: current ? { ...current.job, startedAt: current.startedAt, progress: current.progress } : null,
    queue: queue.map((j) => ({ ...j })),
  };
}

function emitState() {
  events.emit('state', getState());
}

const mbps = (bw) => (bw == null ? null : (bw * 8) / 1e6);

function pump() {
  if (current || !queue.length) return;
  const job = queue.shift();
  const settings = store.getSettings();
  const args = buildArgs(job);
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(SPEEDTEST_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    finish(job, startedAt, null, `Failed to start speedtest: ${err.message}`);
    return;
  }
  current = { job, child, startedAt, progress: { phase: 'starting', pct: 0 }, cancelled: false };
  emitState();

  let result = null;
  let fatalError = '';      // set by us: timeout, missing binary
  const cliErrors = [];     // errors the CLI reported; the first one is the cause, later ones are follow-ups
  const addCliError = (msg) => {
    msg = String(msg).replace(/^\[[^\]]*\]\s*\[error\]\s*/i, '').trim();
    if (msg && !cliErrors.includes(msg)) cliErrors.push(msg);
  };
  let stdoutBuf = '';
  let stderrBuf = '';

  const onLine = (line) => {
    line = line.trim();
    if (!line.startsWith('{')) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    const p = current?.progress;
    if (!p) return;
    switch (ev.type) {
      case 'testStart':
        p.phase = 'connecting';
        p.server = ev.server; p.isp = ev.isp;
        break;
      case 'ping':
        p.phase = 'ping'; p.pct = ev.ping.progress; p.ping = ev.ping.latency; p.jitter = ev.ping.jitter;
        break;
      case 'download':
        p.phase = 'download'; p.pct = ev.download.progress; p.download = mbps(ev.download.bandwidth);
        break;
      case 'upload':
        p.phase = 'upload'; p.pct = ev.upload.progress; p.upload = mbps(ev.upload.bandwidth);
        break;
      case 'result':
        result = ev;
        break;
      case 'log':
        if (ev.level === 'error') addCliError(ev.message);
        break;
      default:
        return;
    }
    events.emit('progress', { jobId: job.id, profileId: job.profileId, ...p });
  };

  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    let i;
    while ((i = stdoutBuf.indexOf('\n')) >= 0) { onLine(stdoutBuf.slice(0, i)); stdoutBuf = stdoutBuf.slice(i + 1); }
  });
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    let i;
    while ((i = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, i); stderrBuf = stderrBuf.slice(i + 1);
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'log' && ev.level === 'error') addCliError(ev.message);
      } catch {
        if (/error/i.test(line)) addCliError(line);
      }
    }
  });

  const timeout = setTimeout(() => {
    fatalError = `Timed out after ${settings.testTimeoutSeconds}s`;
    child.kill('SIGKILL');
  }, Math.max(30, settings.testTimeoutSeconds) * 1000);

  child.on('error', (err) => { fatalError = err.code === 'ENOENT' ? `speedtest binary not found (${SPEEDTEST_BIN})` : err.message; });
  child.on('close', (code) => {
    clearTimeout(timeout);
    if (stdoutBuf) onLine(stdoutBuf);
    const cancelled = current?.cancelled;
    let err = null;
    if (cancelled) err = 'Cancelled';
    else if (!result) err = explainError(job, fatalError || cliErrors[0] || `speedtest exited with code ${code}`);
    finish(job, startedAt, result, err);
  });
}

// Turn the CLI's terse messages into something actionable where we can.
function explainError(job, msg) {
  if (/Failed binding local connection end/i.test(msg)) {
    if (job.iface) return `Can't bind to interface "${job.iface}": it doesn't exist inside the container or has no IP address. See Settings → Network. (${msg})`;
    if (job.bindIp) return `Can't bind to IP ${job.bindIp}: no interface inside the container has this address. See Settings → Network. (${msg})`;
  }
  return msg;
}

function finish(job, startedAt, r, error) {
  const row = {
    ts: Date.now(),
    profile_id: job.profileId,
    profile_name: job.profileName,
    trigger: job.trigger,
    status: error ? 'error' : 'ok',
    error,
    requested_server: job.server || null,
    duration_s: (Date.now() - startedAt) / 1000,
  };
  if (r) {
    Object.assign(row, {
      ts: r.timestamp ? Date.parse(r.timestamp) || row.ts : row.ts,
      download_mbps: mbps(r.download?.bandwidth),
      upload_mbps: mbps(r.upload?.bandwidth),
      ping_ms: r.ping?.latency,
      jitter_ms: r.ping?.jitter,
      ping_low: r.ping?.low,
      ping_high: r.ping?.high,
      dl_latency_ms: r.download?.latency?.iqm,
      ul_latency_ms: r.upload?.latency?.iqm,
      packet_loss: typeof r.packetLoss === 'number' ? r.packetLoss : null,
      download_bytes: r.download?.bytes,
      upload_bytes: r.upload?.bytes,
      isp: r.isp,
      external_ip: r.interface?.externalIp,
      internal_ip: r.interface?.internalIp,
      interface_name: r.interface?.name,
      is_vpn: r.interface?.isVpn ? 1 : 0,
      server_id: r.server?.id != null ? String(r.server.id) : null,
      server_name: r.server?.name,
      server_location: r.server?.location,
      server_country: r.server?.country,
      server_host: r.server?.host,
      result_url: r.result?.url,
    });
  } else if (current?.progress?.server) {
    const s = current.progress.server;
    Object.assign(row, { server_id: String(s.id), server_name: s.name, server_location: s.location, server_country: s.country, server_host: s.host });
  }
  let saved = null;
  try { saved = store.insertMeasurement(row); } catch (e) { console.error('Failed to save measurement', e); }
  console.log(`[speedtest] ${job.profileName} @ ${row.server_name || job.server || 'auto'}: ` +
    (error ? `ERROR ${error}` : `${row.download_mbps?.toFixed(1)} / ${row.upload_mbps?.toFixed(1)} Mbps, ${row.ping_ms?.toFixed(1)} ms`));
  current = null;
  if (saved) events.emit('measurement', saved);
  emitState();
  setImmediate(pump);
}

// ---------- server discovery ----------
let nearbyCache = { at: 0, data: null };

export function listNearbyServers(force = false) {
  if (!force && nearbyCache.data && Date.now() - nearbyCache.at < 10 * 60 * 1000) return Promise.resolve(nearbyCache.data);
  return new Promise((resolve, reject) => {
    const child = spawn(SPEEDTEST_BIN, ['--accept-license', '--accept-gdpr', '-L', '-f', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    const t = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', () => {
      clearTimeout(t);
      try {
        const line = out.split('\n').find((l) => l.includes('"serverList"'));
        const servers = JSON.parse(line).servers.map((s) => ({
          serverId: String(s.id), host: `${s.host}`, sponsor: s.name, location: s.location, country: s.country,
        }));
        nearbyCache = { at: Date.now(), data: servers };
        resolve(servers);
      } catch {
        reject(new Error('Could not parse server list from speedtest CLI'));
      }
    });
  });
}

/** Search Ookla's public server directory (same endpoint speedtest.net uses). */
export async function searchServers(query, limit = 50) {
  const url = new URL('https://www.speedtest.net/api/js/servers');
  url.searchParams.set('engine', 'js');
  url.searchParams.set('limit', String(Math.min(100, limit)));
  url.searchParams.set('https_functional', 'true');
  if (query) url.searchParams.set('search', query);
  const res = await fetch(url, { headers: { 'User-Agent': 'what-is-my-speed/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`speedtest.net returned ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((s) => ({
    serverId: String(s.id),
    host: String(s.host || '').replace(/:\d+$/, ''),
    sponsor: s.sponsor,
    location: s.name,
    country: s.country,
    cc: s.cc,
    distance: s.distance,
  }));
}
