import * as store from './db.js';
import { enqueueProfile } from './runner.js';

// ---------- minimal 5-field cron parser (min hour dom month dow) ----------
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };

function parseField(field, [lo, hi]) {
  const set = new Set();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step "${part}"`);
    let a; let b;
    if (rangePart === '*') { a = lo; b = hi; } else if (rangePart.includes('-')) {
      [a, b] = rangePart.split('-').map(Number);
    } else { a = Number(rangePart); b = stepPart ? hi : a; }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) throw new Error(`bad value "${part}"`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

export function parseCron(expr) {
  const e = ALIASES[expr.trim()] || expr.trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) throw new Error('cron needs 5 fields: min hour day month weekday');
  const [min, hour, dom, mon, dow] = parts.map((f, i) => parseField(f, RANGES[i]));
  if (dow.has(7)) dow.add(0);
  return { min, hour, dom, mon, dow, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

function cronMatches(c, d) {
  if (!c.min.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domStar || c.dowStar) return domOk && dowOk;
  return domOk || dowOk; // standard cron semantics
}

export function nextCronTime(expr, from = Date.now()) {
  const c = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (cronMatches(c, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ---------- scheduler ----------
const nextRun = new Map(); // profileId -> timestamp

export function computeNext(profile, from = Date.now()) {
  if (!profile.enabled || profile.scheduleType === 'manual') return null;
  if (profile.scheduleType === 'cron') {
    try { return nextCronTime(profile.cron, from); } catch { return null; }
  }
  return from + profile.intervalMinutes * 60000;
}

export function resetProfile(profile) {
  if (!profile) return;
  if (!profile.enabled || profile.scheduleType === 'manual') { nextRun.delete(profile.id); return; }
  if (profile.scheduleType === 'interval') {
    const last = store.lastRunTs(profile.id);
    const n = last ? last + profile.intervalMinutes * 60000 : Date.now() + 15000;
    nextRun.set(profile.id, Math.max(n, Date.now() + 5000));
  } else {
    nextRun.set(profile.id, computeNext(profile));
  }
}

export function removeProfile(id) { nextRun.delete(id); }
export function getNextRun(id) { return nextRun.get(id) ?? null; }

function tick() {
  const settings = store.getSettings();
  const now = Date.now();
  for (const p of store.listProfiles()) {
    if (!nextRun.has(p.id)) resetProfile(p);
    const due = nextRun.get(p.id);
    if (due == null || due > now) continue;
    if (!settings.pauseAll) enqueueProfile(p, 'schedule');
    nextRun.set(p.id, computeNext(p, p.scheduleType === 'interval' ? now : due));
  }
}

let lastPrune = 0;
export function start() {
  for (const p of store.listProfiles()) resetProfile(p);
  setInterval(() => {
    try { tick(); } catch (e) { console.error('scheduler tick failed', e); }
    if (Date.now() - lastPrune > 3600000) {
      lastPrune = Date.now();
      const n = store.pruneOld(store.getSettings().retentionDays);
      if (n) console.log(`[retention] pruned ${n} old measurements`);
    }
  }, 5000);
}
