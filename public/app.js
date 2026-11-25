/* global Chart */
'use strict';

// ============================================================ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3 };
const PALETTE = ['#1d8cf8', '#8b5cf6', '#e0a106', '#16a34a', '#e5484d', '#0ea5a4', '#db2777', '#64748b', '#f97316', '#4f46e5'];

function fmtSpeed(mbps, withUnit = true) {
  if (mbps == null || Number.isNaN(mbps)) return '—';
  if (mbps >= 1000) return withUnit ? `${(mbps / 1000).toFixed(2)} Gbps` : (mbps / 1000).toFixed(2);
  const v = mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1);
  return withUnit ? `${v} Mbps` : v;
}
function speedParts(mbps) {
  if (mbps == null) return ['—', ''];
  if (mbps >= 1000) return [(mbps / 1000).toFixed(2), 'Gbps'];
  return [mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1), 'Mbps'];
}
const fmtMs = (v) => (v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((ts - Date.now()) / 1000);
  const a = Math.abs(s);
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function fmtTick(ts, span) {
  const d = new Date(ts);
  if (span <= 2 * 86400e3) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Average points into at most n time buckets so dense or mixed series read as a trend.
function bucket(pts, n) {
  if (pts.length <= n * 1.5) return pts;
  const min = pts[0].x; const w = (pts[pts.length - 1].x - min) / n || 1;
  const out = []; let cur = null;
  const flush = () => { if (cur) out.push({ x: cur.sx / cur.n, y: cur.sy / cur.n, n: cur.n }); };
  for (const p of pts) {
    const i = Math.min(n - 1, Math.floor((p.x - min) / w));
    if (!cur || cur.i !== i) { flush(); cur = { i, sx: 0, sy: 0, n: 0 }; }
    cur.sx += p.x; cur.sy += p.y; cur.n++;
  }
  flush();
  return out;
}

// A profile's own thresholds, or the defaults from Settings.
function thresholdsFor(profileId) {
  return state.profiles.find((p) => p.id === profileId)?.thresholds || state.settings;
}

function grade(kind, v, profileId) {
  const s = thresholdsFor(profileId);
  if (v == null) return ['none', '—'];
  if (kind === 'ping') return v <= s.pingGood ? ['good', 'Good'] : v <= s.pingFair ? ['fair', 'Fair'] : ['poor', 'Poor'];
  const [g, f] = kind === 'dl' ? [s.downloadGood, s.downloadFair] : [s.uploadGood, s.uploadFair];
  return v >= g ? ['good', 'Good'] : v >= f ? ['fair', 'Fair'] : ['poor', 'Poor'];
}

function scheduleText(p) {
  if (!p.enabled) return 'Disabled';
  if (p.scheduleType === 'manual') return 'Manual only';
  if (p.scheduleType === 'cron') return `cron ${p.cron}`;
  const m = p.intervalMinutes;
  if (m % 1440 === 0) return `Every ${m / 1440}d`;
  if (m % 60 === 0) return `Every ${m / 60}h`;
  return `Every ${m} min`;
}
const MODE_LABEL = { auto: 'Auto (nearest)', fixed: 'Fixed server', rotate: 'Rotate list', all: 'All in list' };

function serverLabel(id) {
  const s = state.saved.find((x) => x.serverId === String(id));
  if (s) return s.label || `${s.sponsor}${s.location ? ` · ${s.location}` : ''}`;
  return `#${id}`;
}
function serversText(p) {
  if (p.serverMode === 'auto' || !p.servers.length) return MODE_LABEL.auto;
  if (p.serverMode === 'fixed') return serverLabel(p.servers[0]);
  return `${MODE_LABEL[p.serverMode]} (${p.servers.length})`;
}

// ============================================================ state
const state = {
  view: 'dashboard',
  profiles: [],
  saved: [],
  settings: {},
  runner: { running: null, queue: [] },
  progress: null,
  range: null,
  selected: new Set(store.get('selectedProfiles', [])),
  chartMode: store.get('chartMode', 'overview'),
  chartMetric: store.get('chartMetric', 'download_mbps'),
  table: { sort: 'ts', order: 'desc', offset: 0, limit: 25, search: '', server: '', status: '' },
  series: [],
};
const charts = {};

// ============================================================ navigation
function showView(v) {
  state.view = v;
  for (const b of $$('#nav button')) b.classList.toggle('active', b.dataset.view === v);
  for (const s of $$('main > section')) s.classList.toggle('hidden', s.id !== `view-${v}`);
  if (v === 'profiles') renderProfileGrid();
  if (v === 'servers') renderSaved();
  if (v === 'settings') renderSettings();
  if (v === 'dashboard') refreshDashboard();
  history.replaceState(null, '', v === 'dashboard' ? '/' : `#${v}`);
}
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showView(b.dataset.view); });
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) showView(g.dataset.goto); });

// theme
$('#themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
  rerenderCharts();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderCharts);

// ============================================================ run controls
$('#runAllBtn').addEventListener('click', async () => {
  try { const r = await api('/api/run', { method: 'POST', body: {} }); toast(`Queued ${r.jobs.length} test${r.jobs.length === 1 ? '' : 's'}`); } catch (e) { toast(e.message, 'error'); }
});
$('#runMenuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('#runMenu');
  m.innerHTML = `<button data-run="all"><b>All enabled profiles</b></button><hr>` +
    state.profiles.map((p) => `<button data-run="${p.id}"><span class="dotc" style="background:${p.color}"></span>${esc(p.name)} <span class="muted" style="margin-left:auto;font-size:12px">${esc(MODE_LABEL[p.serverMode])}</span></button>`).join('');
  m.classList.toggle('hidden');
});
$('#runMenu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-run]');
  if (!b) return;
  $('#runMenu').classList.add('hidden');
  try {
    const r = b.dataset.run === 'all' ? await api('/api/run', { method: 'POST', body: {} }) : await api(`/api/profiles/${b.dataset.run}/run`, { method: 'POST' });
    toast(`Queued ${r.jobs.length} test${r.jobs.length === 1 ? '' : 's'}`);
  } catch (err) { toast(err.message, 'error'); }
});
document.addEventListener('click', () => $('#runMenu').classList.add('hidden'));
async function runProfile(id) {
  try { const r = await api(`/api/profiles/${id}/run`, { method: 'POST' }); toast(`Queued ${r.jobs.length} test${r.jobs.length === 1 ? '' : 's'}`); } catch (e) { toast(e.message, 'error'); }
}
async function runServer(serverId) {
  const pid = state.selected.size === 1 ? [...state.selected][0] : undefined;
  try { await api('/api/run', { method: 'POST', body: { server: serverId, profileId: pid } }); toast(`Queued test against ${serverLabel(serverId)}`); } catch (e) { toast(e.message, 'error'); }
}
$('#liveCancel').addEventListener('click', () => { if (state.runner.running) api(`/api/jobs/${state.runner.running.id}`, { method: 'DELETE' }); });
$('#liveQueue').addEventListener('click', (e) => { const b = e.target.closest('[data-cancel]'); if (b) api(`/api/jobs/${b.dataset.cancel}`, { method: 'DELETE' }); });

// ============================================================ live status
function renderRunner() {
  const { running, queue } = state.runner;
  const pill = $('#statusPill');
  pill.classList.toggle('running', !!running);
  pill.classList.toggle('paused', !running && state.settings.pauseAll);
  $('.ptxt', pill).textContent = running ? `Testing · ${running.profileName}${queue.length ? ` (+${queue.length})` : ''}` : state.settings.pauseAll ? 'Paused' : 'Idle';

  const card = $('#liveCard');
  card.classList.toggle('hidden', !running);
  if (!running) return;
  const p = state.progress && state.progress.jobId === running.id ? state.progress : running.progress || {};
  const phases = { starting: 'Starting', connecting: 'Connecting', ping: 'Measuring latency', download: 'Download', upload: 'Upload' };
  $('#livePhase').textContent = phases[p.phase] || 'Running';
  $('#liveTitle').innerHTML = `<span class="dotc" style="background:${esc(running.color)}"></span>${esc(running.profileName)}`;
  $('#liveSub').textContent = p.server ? `${p.server.name} · ${p.server.location}, ${p.server.country} (#${p.server.id})${p.isp ? ` — ${p.isp}` : ''}` : running.server ? `Server ${serverLabel(running.server)}` : 'Selecting best server…';
  const order = { starting: 0, connecting: 0, ping: 0, download: 1, upload: 2 };
  const overall = ((order[p.phase] ?? 0) + (p.phase === 'ping' ? (p.pct || 0) * 0.15 : p.phase === 'connecting' || p.phase === 'starting' ? 0 : (p.pct || 0))) / 3;
  $('#liveBar').style.width = `${Math.min(100, overall * 100).toFixed(1)}%`;
  $('#livePing').textContent = fmtMs(p.ping);
  $('#liveDl').textContent = fmtSpeed(p.download, false);
  $('#liveUl').textContent = fmtSpeed(p.upload, false);
  $('#liveQueue').innerHTML = queue.length
    ? `<span>Queued:</span>${queue.map((j) => `<span class="qitem"><span class="dotc" style="background:${esc(j.color)};margin:0"></span>${esc(j.profileName)}${j.server ? ` · ${esc(serverLabel(j.server))}` : ''}<button data-cancel="${j.id}" title="Remove">×</button></span>`).join('')}`
    : '';
}

// ============================================================ dashboard
function rangeBounds() { const to = Date.now(); return { from: to - RANGES[state.range], to }; }
function filterParams(extra = {}) {
  const { from, to } = rangeBounds();
  const params = new URLSearchParams({ from, to, ...extra });
  if (state.selected.size) params.set('profile', [...state.selected].join(','));
  for (const [k, v] of [...params]) if (v === '' || v == null) params.delete(k);
  return params;
}

$('#rangeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.range = b.dataset.range; store.set('range', state.range);
  state.table.offset = 0;
  refreshDashboard();
});

function renderChips() {
  const all = state.selected.size === 0;
  $('#profileChips').innerHTML = `<button class="chip ${all ? 'active' : ''}" data-chip="all">All profiles</button>` +
    state.profiles.map((p) => `<button class="chip ${state.selected.has(p.id) ? 'active' : ''}" data-chip="${p.id}"><span class="sw" style="background:${esc(p.color)}"></span>${esc(p.name)}${p.enabled ? '' : ' <span class="muted">(off)</span>'}</button>`).join('');
}
$('#profileChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-chip]'); if (!b) return;
  if (b.dataset.chip === 'all') state.selected.clear();
  else {
    const id = Number(b.dataset.chip);
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  }
  store.set('selectedProfiles', [...state.selected]);
  state.table.offset = 0;
  refreshDashboard();
});

let refreshing = null;
async function refreshDashboard() {
  if (state.view !== 'dashboard') return;
  if (refreshing) { refreshing.again = true; return; }
  refreshing = { again: false };
  try {
    for (const b of $$('#rangeSeg button')) b.classList.toggle('active', b.dataset.range === state.range);
    renderChips();
    const [series, sum] = await Promise.all([
      api(`/api/series?${filterParams()}`),
      api(`/api/summary?${filterParams()}`),
    ]);
    state.series = series;
    state.summary = sum;
    renderStats();
    renderProfileRows();
    renderHistory();
    await Promise.all([refreshTable(), refreshServerFilter()]);
  } catch (e) {
    console.error(e);
  } finally {
    const again = refreshing.again;
    refreshing = null;
    if (again) refreshDashboard();
  }
}

function sparkline(id, data, color, key) {
  const ctx = $(`#${id}`);
  charts[id]?.destroy();
  const pts = bucket(data.filter((d) => d[key] != null).map((d) => ({ x: d.ts, y: d[key] })), 36);
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        data: pts, borderColor: color, borderWidth: 1.6, pointRadius: 0, tension: 0.35, fill: true,
        backgroundColor: (c) => {
          const { chartArea, ctx: g } = c.chart; if (!chartArea) return 'transparent';
          const grad = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          grad.addColorStop(0, `${color}55`); grad.addColorStop(1, `${color}00`); return grad;
        },
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, events: [],
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { type: 'linear', display: false }, y: { display: false, grace: '10%' } },
      layout: { padding: 0 },
    },
  });
}

function deltaHtml(latest, avg, higherIsBetter = true) {
  if (latest == null || !avg) return '';
  const pct = ((latest - avg) / avg) * 100;
  const better = higherIsBetter ? pct >= 0 : pct <= 0;
  const cls = Math.abs(pct) < 1 ? 'flat' : better ? 'up' : 'down';
  const arrow = pct >= 0 ? '↗' : '↘';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(pct).toFixed(0)}% vs avg</span>`;
}

function renderStats() {
  const ok = state.series.filter((d) => d.status === 'ok');
  const last = ok[ok.length - 1];
  const avg = state.summary.current;
  const lastAny = state.series[state.series.length - 1];

  const [dlv, dlu] = speedParts(last?.download_mbps);
  $('#dlValue').innerHTML = `${dlv}<small>${dlu}</small>`;
  const [ulv, ulu] = speedParts(last?.upload_mbps);
  $('#ulValue').innerHTML = `${ulv}<small>${ulu}</small>`;
  $('#latValue').innerHTML = last ? `${last.ping_ms?.toFixed(0) ?? '—'}<small>ms</small> / ${last.dl_latency_ms?.toFixed(0) ?? '—'}<small>ms</small>` : '—';

  for (const [id, kind, v] of [['dlBadge', 'dl', last?.download_mbps], ['ulBadge', 'ul', last?.upload_mbps], ['latBadge', 'ping', last?.ping_ms]]) {
    const [cls, txt] = grade(kind, v, last?.profile_id);
    const lp = state.profiles.find((p) => p.id === last?.profile_id);
    $(`#${id}`).className = `badge ${cls}`; $(`#${id}`).textContent = txt;
    $(`#${id}`).title = lp?.thresholds ? `Using ${lp.name}'s own thresholds` : 'Using the default thresholds (Settings)';
  }
  const when = last ? `<span>• ${ago(last.ts)}</span>` : '<span>No successful tests in range</span>';
  const srv = last?.server_name ? `<span>• ${esc(last.server_name)}</span>` : '';
  $('#dlSub').innerHTML = `${deltaHtml(last?.download_mbps, avg.dl)} ${when}`;
  $('#ulSub').innerHTML = `${deltaHtml(last?.upload_mbps, avg.ul)} ${when}`;
  $('#latSub').innerHTML = `<span>unloaded / loaded</span> ${srv}`;

  sparkline('dlSpark', ok, css('--dl'), 'download_mbps');
  sparkline('ulSpark', ok, css('--ul'), 'upload_mbps');
  sparkline('latSpark', ok, css('--lat'), 'ping_ms');

  const total = avg.total || 0;
  const success = total ? (((total - avg.errors) / total) * 100).toFixed(total - avg.errors === total ? 0 : 1) : '—';
  $('#miniStats').innerHTML = [
    ['Avg download', fmtSpeed(avg.dl)],
    ['Avg upload', fmtSpeed(avg.ul)],
    ['Jitter (avg)', fmtMs(avg.jitter)],
    ['Packet loss', avg.loss == null ? '—' : `${avg.loss.toFixed(2)} %`],
    ['Tests / success', `${total} <small>· ${success}${total ? '%' : ''}</small>`],
  ].map(([k, v]) => `<div class="mini"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  void lastAny;
}

function renderProfileRows() {
  const per = new Map((state.summary.perProfile || []).map((r) => [r.profile_id, r]));
  const rows = state.profiles.filter((p) => !state.selected.size || state.selected.has(p.id));
  $('#profileRows').innerHTML = rows.length ? rows.map((p) => {
    const l = p.latest; const s = per.get(p.id);
    const isRunning = state.runner.running?.profileId === p.id;
    const queued = state.runner.queue.filter((j) => j.profileId === p.id).length;
    const last = !l ? '<span class="muted">never</span>' : l.status === 'error'
      ? `<span class="status error" title="${esc(l.error)}">Error</span><div class="cell-sub">${ago(l.ts)}</div>`
      : `<span class="mono" style="color:var(--dl)">${fmtSpeed(l.download_mbps)}</span> / <span class="mono" style="color:var(--ul)">${fmtSpeed(l.upload_mbps)}</span> / <span class="mono">${fmtMs(l.ping_ms)}</span><div class="cell-sub">${ago(l.ts)}</div>`;
    const avg = s && s.dl != null ? `<span class="mono">${fmtSpeed(s.dl)} / ${fmtSpeed(s.ul)}</span>` : '<span class="muted">—</span>';
    const succ = s ? `${Math.round(((s.total - (s.errors || 0)) / s.total) * 100)}% <span class="muted">(${s.total})</span>` : '<span class="muted">—</span>';
    const next = isRunning ? '<span style="color:var(--accent)">running…</span>' : queued ? `<span class="muted">queued (${queued})</span>` : p.nextRun ? ago(p.nextRun) : '<span class="muted">—</span>';
    return `<tr>
      <td><span class="dotc" style="background:${esc(p.color)}"></span><b>${esc(p.name)}</b></td>
      <td>${esc(scheduleText(p))}</td>
      <td class="wrap">${esc(serversText(p))}</td>
      <td>${last}</td><td>${avg}</td><td>${succ}</td><td>${next}</td>
      <td style="text-align:right"><button class="btn sm" data-runp="${p.id}">Run</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="empty">No profiles yet.</td></tr>';
}
$('#profileRows').addEventListener('click', (e) => { const b = e.target.closest('[data-runp]'); if (b) runProfile(Number(b.dataset.runp)); });

// ---------- history chart
$('#chartModeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.chartMode = b.dataset.mode; store.set('chartMode', state.chartMode); renderHistory();
});
$('#chartMetric').addEventListener('change', (e) => { state.chartMetric = e.target.value; store.set('chartMetric', state.chartMetric); renderHistory(); });

function areaFill(color) {
  return (c) => {
    const { chartArea, ctx: g } = c.chart; if (!chartArea) return 'transparent';
    const grad = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    grad.addColorStop(0, `${color}40`); grad.addColorStop(1, `${color}03`); return grad;
  };
}

function renderHistory() {
  for (const b of $$('#chartModeSeg button')) b.classList.toggle('active', b.dataset.mode === state.chartMode);
  $('#chartMetric').classList.toggle('hidden', state.chartMode === 'overview');
  $('#chartMetric').value = state.chartMetric;

  const data = state.series;
  const ok = data.filter((d) => d.status === 'ok');
  const errs = data.filter((d) => d.status === 'error');
  // fit the x-axis to the data actually present (like the reference UI), padded slightly
  let from; let to;
  if (data.length) {
    from = data[0].ts; to = data[data.length - 1].ts;
    const pad = Math.max((to - from) * 0.02, 60e3);
    if (to - from < 10 * 60e3) { from -= 15 * 60e3; to += 15 * 60e3; } else { from -= pad; to += pad; }
  } else ({ from, to } = rangeBounds());
  const span = to - from;
  const dense = data.length > 150;
  const text2 = css('--text-3'); const border = css('--border');
  let datasets; let legend; let scales;
  const isSpeed = (k) => k === 'download_mbps' || k === 'upload_mbps';
  const unitFor = (k) => (isSpeed(k) ? 'Mbps' : k === 'packet_loss' ? '%' : 'ms');

  const baseX = {
    type: 'linear', min: from, max: to,
    ticks: { color: text2, maxRotation: 0, autoSkipPadding: 24, callback: (v) => fmtTick(v, span), font: { family: css('--mono').split(',')[0].replace(/'/g, '') } },
    grid: { display: false }, border: { display: false },
  };

  if (state.chartMode === 'overview') {
    const dl = css('--dl'); const ul = css('--ul'); const lat = css('--lat');
    datasets = [
      { label: 'Download', data: bucket(ok.map((d) => ({ x: d.ts, y: d.download_mbps })), 160), borderColor: dl, backgroundColor: areaFill(dl), fill: 'origin', tension: 0.35, borderWidth: 2, pointRadius: dense ? 0 : 2, pointHoverRadius: 5, yAxisID: 'y' },
      { label: 'Upload', data: bucket(ok.map((d) => ({ x: d.ts, y: d.upload_mbps })), 160), borderColor: ul, backgroundColor: areaFill(ul), fill: 'origin', tension: 0.35, borderWidth: 2, pointRadius: dense ? 0 : 2, pointHoverRadius: 5, yAxisID: 'y' },
      { label: 'Latency', data: bucket(ok.filter((d) => d.ping_ms != null).map((d) => ({ x: d.ts, y: d.ping_ms })), 160), borderColor: css('--good'), borderDash: [4, 4], borderWidth: 1.5, tension: 0.35, pointRadius: dense ? 0 : 3, pointBackgroundColor: (c) => { const [g] = grade('ping', c.raw?.y, state.selected.size === 1 ? [...state.selected][0] : null); return g === 'good' ? css('--good') : g === 'fair' ? css('--fair') : css('--poor'); }, pointBorderWidth: 0, yAxisID: 'y1' },
      { label: 'Failed', type: 'scatter', data: errs.map((d) => ({ x: d.ts, y: 0, err: true })), pointStyle: 'crossRot', pointRadius: 6, borderColor: css('--poor'), borderWidth: 2, yAxisID: 'y' },
    ];
    legend = `<span><i style="background:${dl}"></i>Download</span><span><i style="background:${ul}"></i>Upload</span><span><i class="dash"></i>Latency</span>${errs.length ? `<span><i style="background:${css('--poor')}"></i>Failed (${errs.length})</span>` : ''}`;
    scales = {
      x: baseX,
      y: { beginAtZero: true, grace: '8%', ticks: { color: text2, callback: (v) => `${v} Mbps` }, grid: { color: border, drawTicks: false }, border: { display: false } },
      y1: { position: 'right', beginAtZero: true, grace: '10%', ticks: { color: text2, callback: (v) => `${v} ms` }, grid: { display: false }, border: { display: false } },
    };
  } else {
    const key = state.chartMetric;
    const groups = new Map();
    for (const d of ok) {
      const gk = state.chartMode === 'profile' ? `p${d.profile_id}` : `s${d.server_id}`;
      if (!groups.has(gk)) {
        let label; let color;
        if (state.chartMode === 'profile') {
          const p = state.profiles.find((x) => x.id === d.profile_id);
          label = p?.name || `Profile ${d.profile_id}`; color = p?.color;
        } else {
          label = `${d.server_name || 'Unknown'}${d.server_location ? ` · ${d.server_location}` : ''}`;
        }
        groups.set(gk, { label, color: color || PALETTE[groups.size % PALETTE.length], pts: [] });
      }
      if (d[key] != null) groups.get(gk).pts.push({ x: d.ts, y: d[key] });
    }
    for (const g of groups.values()) g.pts = bucket(g.pts, 200);
    datasets = [...groups.values()].map((g) => ({
      label: g.label, data: g.pts, borderColor: g.color, backgroundColor: g.color, tension: 0.3, borderWidth: 2,
      pointRadius: g.pts.length > 120 ? 0 : 2.5, pointHoverRadius: 5, spanGaps: true,
    }));
    legend = [...groups.values()].map((g) => `<span><i style="background:${g.color}"></i>${esc(g.label)}</span>`).join('') || '<span class="muted">No data</span>';
    scales = {
      x: baseX,
      y: { beginAtZero: true, grace: '8%', ticks: { color: text2, callback: (v) => `${v} ${unitFor(key)}` }, grid: { color: border, drawTicks: false }, border: { display: false } },
    };
  }

  $('#chartLegend').innerHTML = legend;
  charts.history?.destroy();
  charts.history = new Chart($('#historyChart'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: css('--text-2'), borderColor: border, borderWidth: 1, padding: 10, boxPadding: 4,
          callbacks: {
            title: (items) => (items[0] ? fmtDate(items[0].parsed.x) : ''),
            label: (it) => {
              if (it.raw?.err) return ' Failed test';
              const k = state.chartMode === 'overview' ? (it.dataset.yAxisID === 'y1' ? 'ping_ms' : 'download_mbps') : state.chartMetric;
              const v = it.parsed.y;
              const avgNote = it.raw?.n > 1 ? ` (avg of ${it.raw.n})` : '';
              return ` ${it.dataset.label}: ${isSpeed(k) ? fmtSpeed(v) : k === 'packet_loss' ? `${v.toFixed(2)} %` : fmtMs(v)}${avgNote}`;
            },
          },
        },
      },
      scales,
    },
  });
}

function rerenderCharts() {
  if (state.view !== 'dashboard' || !state.summary) return;
  setTimeout(() => { renderStats(); renderHistory(); }, 30);
}

// ---------- measurements table
const COLS = [
  ['ts', 'Time'], ['profile_name', 'Profile'], ['download_mbps', 'Download'], ['upload_mbps', 'Upload'],
  ['ping_ms', 'Latency (u/l)'], ['jitter_ms', 'Jitter'], ['packet_loss', 'Loss'], ['server_name', 'Server'], ['status', 'Status'], [null, ''],
];
function renderHead() {
  $('#measHead').innerHTML = COLS.map(([k, label]) => {
    if (!k) return '<th></th>';
    const active = state.table.sort === k;
    return `<th class="sortable" data-sort="${k}">${label}<span class="arrow">${active ? (state.table.order === 'asc' ? '↑' : '↓') : '⇅'}</span></th>`;
  }).join('');
}
$('#measHead').addEventListener('click', (e) => {
  const th = e.target.closest('[data-sort]'); if (!th) return;
  const k = th.dataset.sort;
  if (state.table.sort === k) state.table.order = state.table.order === 'asc' ? 'desc' : 'asc';
  else { state.table.sort = k; state.table.order = 'desc'; }
  state.table.offset = 0; refreshTable();
});

async function refreshTable() {
  renderHead();
  const t = state.table;
  const params = filterParams({ sort: t.sort, order: t.order, limit: t.limit, offset: t.offset, search: t.search, server: t.server, status: t.status });
  const { rows, total } = await api(`/api/measurements?${params}`);
  const exportParams = filterParams({ search: t.search, server: t.server, status: t.status });
  $('#exportBtn').href = `/api/export.csv?${exportParams}`;
  $('#measRows').innerHTML = rows.length ? rows.map((r) => {
    const p = state.profiles.find((x) => x.id === r.profile_id);
    const [lg] = grade('ping', r.ping_ms, r.profile_id);
    const ok = r.status === 'ok';
    return `<tr>
      <td><div class="mono">${ago(r.ts)}</div><div class="muted mono" style="font-size:11.5px">${fmtDate(r.ts)}</div></td>
      <td class="wrap" style="min-width:140px"><span class="dotc" style="background:${esc(p?.color || '#888')}"></span>${esc(p?.name || r.profile_name)}${r.trigger === 'manual' ? '<div class="cell-sub">manual run</div>' : ''}</td>
      <td class="num dl">${ok ? fmtSpeed(r.download_mbps) : '—'}</td>
      <td class="num ul">${ok ? fmtSpeed(r.upload_mbps) : '—'}</td>
      <td class="num">${ok ? `<span class="dotc" style="background:var(--${lg})"></span>${r.ping_ms?.toFixed(0)} ms / ${r.dl_latency_ms?.toFixed(0) ?? '—'} ms` : '—'}</td>
      <td class="num">${ok ? fmtMs(r.jitter_ms) : '—'}</td>
      <td class="num">${r.packet_loss == null ? '—' : `${r.packet_loss.toFixed(1)}%`}</td>
      <td title="${esc(`${r.server_host || ''} · ${r.isp || ''} · ${r.external_ip || ''}`)}">${esc(r.server_name || (r.requested_server ? serverLabel(r.requested_server) : 'auto'))}${r.server_location ? `<div class="cell-sub">${esc(r.server_location)}</div>` : ''}</td>
      <td>${ok ? '<span class="status ok">OK</span>' : `<span class="status error">Error</span><div class="err-text" title="${esc(r.error)}">${esc(r.error)}</div>`}</td>
      <td style="text-align:right">${r.result_url ? `<a class="btn sm ghost" href="${esc(r.result_url)}" target="_blank" rel="noopener" title="Open result on speedtest.net">↗</a>` : ''}<button class="btn sm ghost" data-del="${r.id}" title="Delete">✕</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="${COLS.length}" class="empty">No measurements in this range yet. Hit “Run now” to start.</td></tr>`;
  const end = Math.min(total, t.offset + rows.length);
  $('#pagerInfo').textContent = total ? `${t.offset + 1}–${end} of ${total}` : '0 results';
  $('#prevPage').disabled = t.offset === 0;
  $('#nextPage').disabled = end >= total;
}
$('#measRows').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  if (!confirm('Delete this measurement?')) return;
  await api(`/api/measurements/${b.dataset.del}`, { method: 'DELETE' });
  refreshDashboard();
});
$('#prevPage').addEventListener('click', () => { state.table.offset = Math.max(0, state.table.offset - state.table.limit); refreshTable(); });
$('#nextPage').addEventListener('click', () => { state.table.offset += state.table.limit; refreshTable(); });
let searchTimer;
$('#fSearch').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.table.search = e.target.value; state.table.offset = 0; refreshTable(); }, 300); });
$('#fServer').addEventListener('change', (e) => { state.table.server = e.target.value; state.table.offset = 0; refreshTable(); });
$('#fStatus').addEventListener('change', (e) => { state.table.status = e.target.value; state.table.offset = 0; refreshTable(); });
$('#fLimit').addEventListener('change', (e) => { state.table.limit = Number(e.target.value); state.table.offset = 0; refreshTable(); });

async function refreshServerFilter() {
  const seen = await api('/api/servers/seen');
  const sel = $('#fServer'); const cur = sel.value;
  sel.innerHTML = '<option value="">All servers</option>' + seen.map((s) => `<option value="${esc(s.server_id)}">${esc(s.server_name)} · ${esc(s.server_location)} (${s.n})</option>`).join('');
  sel.value = cur;
}

// ============================================================ profiles page
function renderProfileGrid() {
  $('#profileGrid').innerHTML = state.profiles.map((p) => {
    const l = p.latest;
    const servers = p.serverMode === 'auto' ? '<span class="muted">Nearest server, picked by Ookla</span>'
      : p.servers.map((s) => `<span class="tag">${esc(serverLabel(s))}</span>`).join('');
    return `<div class="card pcard" style="--pc:${esc(p.color)}">
      <div class="pcard-head">
        <div><h3>${esc(p.name)}</h3><div class="muted" style="font-size:12.5px;margin-top:3px">${esc(scheduleText(p))}${p.nextRun ? ` · next ${ago(p.nextRun)}` : ''}</div></div>
        <label class="toggle" title="Enabled"><input type="checkbox" data-toggle="${p.id}" ${p.enabled ? 'checked' : ''}/><span></span></label>
      </div>
      <dl class="meta">
        <dt>Servers</dt><dd>${esc(MODE_LABEL[p.serverMode])}</dd>
        <dt></dt><dd>${servers}</dd>
        ${p.interface ? `<dt>Interface</dt><dd class="mono">${esc(p.interface)}</dd>` : ''}
        ${p.bindIp ? `<dt>Source IP</dt><dd class="mono">${esc(p.bindIp)}</dd>` : ''}
        <dt>Thresholds</dt><dd>${p.thresholds
          ? `<span title="Good / Fair: download ≥ ${p.thresholds.downloadGood} / ${p.thresholds.downloadFair} Mbps, upload ≥ ${p.thresholds.uploadGood} / ${p.thresholds.uploadFair} Mbps, ping ≤ ${p.thresholds.pingGood} / ${p.thresholds.pingFair} ms">Custom</span><div class="cell-sub mono">good at ↓${p.thresholds.downloadGood} ↑${p.thresholds.uploadGood} Mbps, ${p.thresholds.pingGood} ms</div>`
          : '<span class="muted">Default</span>'}</dd>
      </dl>
      <div class="nums">${l ? (l.status === 'ok'
        ? `<span style="color:var(--dl)">↓ ${fmtSpeed(l.download_mbps)}</span><span style="color:var(--ul)">↑ ${fmtSpeed(l.upload_mbps)}</span><span>${fmtMs(l.ping_ms)}</span>`
        : `<span class="status error">Last run failed</span>`) : '<span class="muted">No results yet</span>'}</div>
      <div class="actions">
        <button class="btn sm primary" data-runp="${p.id}">Run now</button>
        <button class="btn sm" data-edit="${p.id}">Edit</button>
        <button class="btn sm" data-dup="${p.id}">Duplicate</button>
        <button class="btn sm ghost danger" data-delp="${p.id}" style="margin-left:auto">Delete</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">No profiles yet — create one.</div>';
}
$('#profileGrid').addEventListener('click', async (e) => {
  const t = e.target;
  const id = Number(t.dataset.runp || t.dataset.edit || t.dataset.dup || t.dataset.delp);
  if (t.dataset.runp) runProfile(id);
  if (t.dataset.edit) openProfileEditor(state.profiles.find((p) => p.id === id));
  if (t.dataset.dup) {
    const p = state.profiles.find((x) => x.id === id);
    openProfileEditor({ ...p, id: undefined, name: `${p.name} (copy)` });
  }
  if (t.dataset.delp) {
    const p = state.profiles.find((x) => x.id === id);
    if (!confirm(`Delete profile "${p.name}"? Its measurements are kept.`)) return;
    await api(`/api/profiles/${id}`, { method: 'DELETE' });
    state.selected.delete(id);
    await loadProfiles(); renderProfileGrid();
  }
});
$('#profileGrid').addEventListener('change', async (e) => {
  const id = Number(e.target.dataset.toggle); if (!id) return;
  try { await api(`/api/profiles/${id}`, { method: 'PUT', body: { enabled: e.target.checked } }); await loadProfiles(); renderProfileGrid(); } catch (err) { toast(err.message, 'error'); }
});
$('#newProfileBtn').addEventListener('click', () => openProfileEditor(null));

// ---------- profile editor modal
function serverRow(s, actionHtml) {
  return `<div class="srv-row">
    <div class="info"><div class="name">${esc(s.sponsor || s.label || s.host || s.serverId)}</div>
    <div class="sub">${esc([s.location, s.country].filter(Boolean).join(', '))}${s.distance != null ? ` · ${s.distance} km` : ''}${s.host ? ` · ${esc(s.host)}` : ''}</div></div>
    <span class="id">#${esc(s.serverId)}</span>${actionHtml}</div>`;
}

function openProfileEditor(profile) {
  const p = profile ? structuredClone(profile) : {
    name: '', color: PALETTE[state.profiles.length % PALETTE.length], enabled: true, scheduleType: 'interval', intervalMinutes: 30,
    cron: '0 * * * *', serverMode: 'auto', servers: [], interface: '', bindIp: '',
  };
  let pickerTab = state.saved.length ? 'saved' : 'search';
  let searchResults = [];
  let nearby = null;

  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${p.id ? 'Edit profile' : 'New profile'}</h2><button class="btn ghost icon" data-close>✕</button></div>
    <div class="modal-body">
      <div class="row2">
        <div class="field"><label for="pName">Name</label><input class="input" id="pName" placeholder="e.g. ISP backbone check" value="${esc(p.name)}" /></div>
        <div class="field"><label>Color &amp; status</label>
          <div class="inline"><input type="color" id="pColor" value="${esc(p.color)}" /><label class="toggle"><input type="checkbox" id="pEnabled" ${p.enabled ? 'checked' : ''}/><span></span></label><span class="hint">Enabled</span></div>
        </div>
      </div>

      <div class="field"><span class="label">Schedule</span>
        <div class="seg text" id="pSchedSeg"><button data-v="interval">Interval</button><button data-v="cron">Cron</button><button data-v="manual">Manual only</button></div>
        <div id="pSchedInterval" class="inline">
          <span>Every</span><input class="input" type="number" id="pInterval" min="1" style="width:90px" value="${p.intervalMinutes}" /><span>minutes</span>
          ${[5, 15, 30, 60, 180, 360, 1440].map((m) => `<button class="btn sm" data-preset="${m}">${m < 60 ? `${m}m` : `${m / 60}h`}</button>`).join('')}
        </div>
        <div id="pSchedCron" class="field">
          <input class="input mono" id="pCron" value="${esc(p.cron)}" placeholder="*/15 8-22 * * 1-5" />
          <div class="hint">min hour day month weekday — e.g. <code>*/20 * * * *</code>, <code>0 7-23 * * *</code>, <code>@hourly</code>. Uses the container's TZ.</div>
          <div class="cron-preview" id="pCronPreview"></div>
        </div>
      </div>

      <div class="field"><span class="label">Server strategy</span>
        <div class="seg text" id="pModeSeg"><button data-v="auto">Auto</button><button data-v="fixed">Fixed</button><button data-v="rotate">Rotate</button><button data-v="all">All in list</button></div>
        <div class="hint" id="pModeHint"></div>
      </div>

      <div id="pServerBlock" class="field">
        <span class="label">Servers <span class="muted" id="pSrvCount"></span></span>
        <div class="selected-servers" id="pSelected"></div>
        <div class="picker">
          <div class="picker-tabs"><button data-tab="saved">Saved</button><button data-tab="search">Search</button><button data-tab="nearby">Nearest</button><button data-tab="manual">Manual</button></div>
          <div class="picker-body" id="pPicker"></div>
        </div>
      </div>

      <div class="field"><span class="label">Quality thresholds</span>
        <div class="inline" style="justify-content:space-between">
          <span class="hint">Decide what counts as Good, Fair or Poor for this profile. A nearby server can be much faster than one in another country.</span>
          <label class="inline" style="gap:8px;flex:none"><span class="hint">Use defaults</span><label class="toggle"><input type="checkbox" id="pThDefault" ${p.thresholds ? '' : 'checked'}/><span></span></label></label>
        </div>
        <div id="pTh" class="${p.thresholds ? '' : 'hidden'}" style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
          <div class="threshold-row"><span></span><span class="label">Good</span><span class="label">Fair</span></div>
          <div class="threshold-row"><span class="label">Download ≥ Mbps</span><input class="input" type="number" min="0" id="pThDlGood" /><input class="input" type="number" min="0" id="pThDlFair" /></div>
          <div class="threshold-row"><span class="label">Upload ≥ Mbps</span><input class="input" type="number" min="0" id="pThUlGood" /><input class="input" type="number" min="0" id="pThUlFair" /></div>
          <div class="threshold-row"><span class="label">Ping ≤ ms</span><input class="input" type="number" min="0" id="pThPingGood" /><input class="input" type="number" min="0" id="pThPingFair" /></div>
        </div>
      </div>

      <details>
        <summary class="label" style="cursor:pointer">Advanced network options</summary>
        <div class="row2" style="margin-top:12px">
          <div class="field"><label for="pIface">Bind to interface</label><input class="input mono" id="pIface" list="pIfaceList" placeholder="eth0, wg0…" value="${esc(p.interface)}" /><datalist id="pIfaceList"></datalist><span class="hint">Passed as <code>--interface</code>. Needs host networking in Docker.</span></div>
          <div class="field"><label for="pIp">Bind to source IP</label><input class="input mono" id="pIp" placeholder="192.168.1.10" value="${esc(p.bindIp)}" /><span class="hint">Passed as <code>--ip</code>.</span></div>
        </div>
      </details>
    </div>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pSave">${p.id ? 'Save changes' : 'Create profile'}</button></div>
  </div></div>`;

  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('.modal-bg', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  for (const b of $$('[data-close]', root)) b.addEventListener('click', close);

  const MODE_HINT = {
    auto: 'Ookla picks the best nearby server each run. No list needed.',
    fixed: 'Always test against the first server below.',
    rotate: 'Each scheduled run uses the next server in the list (round-robin).',
    all: 'Every run tests each server in the list back-to-back — great for comparing routes.',
  };

  function renderSched() {
    for (const b of $$('#pSchedSeg button')) b.classList.toggle('active', b.dataset.v === p.scheduleType);
    $('#pSchedInterval').classList.toggle('hidden', p.scheduleType !== 'interval');
    $('#pSchedCron').classList.toggle('hidden', p.scheduleType !== 'cron');
    if (p.scheduleType === 'cron') previewCron();
  }
  let cronTimer;
  function previewCron() {
    clearTimeout(cronTimer);
    cronTimer = setTimeout(async () => {
      const r = await api(`/api/cron/preview?expr=${encodeURIComponent(p.cron)}`);
      const el = $('#pCronPreview'); if (!el) return;
      el.classList.toggle('bad', !r.ok);
      el.textContent = r.ok ? `Next: ${r.next.map((t) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })).join('  ·  ')}` : r.error;
    }, 250);
  }
  function renderMode() {
    for (const b of $$('#pModeSeg button')) b.classList.toggle('active', b.dataset.v === p.serverMode);
    $('#pModeHint').textContent = MODE_HINT[p.serverMode];
    $('#pServerBlock').classList.toggle('hidden', p.serverMode === 'auto');
    renderSelected();
  }
  function renderSelected() {
    const max = p.serverMode === 'fixed' ? 1 : 50;
    if (p.servers.length > max) p.servers = p.servers.slice(0, max);
    $('#pSrvCount').textContent = p.serverMode === 'fixed' ? '(pick one)' : `(${p.servers.length})`;
    $('#pSelected').innerHTML = p.servers.length
      ? p.servers.map((s, i) => `<span class="sv-chip"><b>${esc(s)}</b>${esc(serverLabel(s) !== `#${s}` ? serverLabel(s) : '')}<button data-rm="${i}" title="Remove">×</button></span>`).join('')
      : '<span class="hint">No servers selected — add some from the picker below.</span>';
    renderPicker();
  }
  function addServer(s) {
    const id = String(s.serverId);
    if (p.serverMode === 'fixed') p.servers = [id];
    else if (!p.servers.includes(id)) p.servers.push(id);
    // remember it in the library so it has a nice name
    if (s.sponsor && !state.saved.some((x) => x.serverId === id)) {
      api('/api/servers/saved', { method: 'POST', body: s }).then(loadSaved).then(renderSelected).catch(() => {});
    }
    renderSelected();
  }
  const addBtn = (s) => (p.servers.includes(String(s.serverId)) ? '<span class="hint">added</span>' : `<button class="btn sm" data-add='${esc(JSON.stringify(s))}'>Add</button>`);

  function renderPicker() {
    for (const b of $$('.picker-tabs button', root)) b.classList.toggle('active', b.dataset.tab === pickerTab);
    const body = $('#pPicker');
    if (pickerTab === 'saved') {
      body.innerHTML = state.saved.length ? state.saved.map((s) => serverRow(s, addBtn(s))).join('') : '<div class="hint">No saved servers yet. Use Search or Nearest, or the Servers page.</div>';
    } else if (pickerTab === 'search') {
      body.innerHTML = `<form class="inline" id="pSearchForm" style="margin-bottom:8px"><input class="input" id="pSearchQ" placeholder="City, provider or ID" style="flex:1" /><button class="btn sm">Search</button></form>
        <div id="pSearchRes">${searchResults.map((s) => serverRow(s, addBtn(s))).join('') || '<div class="hint">Searches speedtest.net\'s server directory.</div>'}</div>`;
      $('#pSearchForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        $('#pSearchRes').innerHTML = '<div class="hint">Searching…</div>';
        try { searchResults = await api(`/api/servers/search?q=${encodeURIComponent($('#pSearchQ').value)}`); } catch (err) { toast(err.message, 'error'); searchResults = []; }
        const q = $('#pSearchQ').value; renderPicker(); $('#pSearchQ').value = q;
      });
    } else if (pickerTab === 'nearby') {
      if (!nearby) {
        body.innerHTML = '<div class="hint">Asking the speedtest CLI for nearby servers…</div>';
        api('/api/servers/nearby').then((r) => { nearby = r; if (pickerTab === 'nearby') renderPicker(); }).catch((err) => { body.innerHTML = `<div class="hint">${esc(err.message)}</div>`; });
        return;
      }
      body.innerHTML = nearby.map((s) => serverRow(s, addBtn(s))).join('');
    } else {
      body.innerHTML = `<form class="inline" id="pManualForm"><input class="input mono" id="pManualQ" placeholder="Server ID (e.g. 4166) or hostname" style="flex:1" /><button class="btn sm">Add</button></form>
        <div class="hint" style="margin-top:8px">Numeric values are passed as <code>--server-id</code>, hostnames as <code>--host</code>.</div>`;
      $('#pManualForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#pManualQ').value.trim(); if (v) addServer({ serverId: v }); });
    }
  }

  $('#pSchedSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { p.scheduleType = b.dataset.v; renderSched(); } });
  $('#pModeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { p.serverMode = b.dataset.v; renderMode(); } });
  $('#pSchedInterval').addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) { p.intervalMinutes = Number(b.dataset.preset); $('#pInterval').value = p.intervalMinutes; } });
  $('#pCron').addEventListener('input', (e) => { p.cron = e.target.value; previewCron(); });
  $('.picker-tabs', root).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { pickerTab = b.dataset.tab; renderPicker(); } });
  $('#pPicker').addEventListener('click', (e) => { const b = e.target.closest('[data-add]'); if (b) addServer(JSON.parse(b.dataset.add)); });
  $('#pSelected').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { p.servers.splice(Number(b.dataset.rm), 1); renderSelected(); } });

  $('#pSave').addEventListener('click', async () => {
    const body = {
      name: $('#pName').value.trim() || 'Untitled', color: $('#pColor').value, enabled: $('#pEnabled').checked,
      scheduleType: p.scheduleType, intervalMinutes: Number($('#pInterval').value), cron: p.cron,
      serverMode: p.serverMode, servers: p.serverMode === 'auto' ? [] : p.servers,
      interface: $('#pIface').value.trim(), bindIp: $('#pIp').value.trim(),
      thresholds: $('#pThDefault').checked ? null : Object.fromEntries(TH_FIELDS.map(([el, k]) => [k, Number($(`#${el}`).value)])),
    };
    try {
      if (p.id) await api(`/api/profiles/${p.id}`, { method: 'PUT', body });
      else await api('/api/profiles', { method: 'POST', body });
      close();
      toast(p.id ? 'Profile saved' : 'Profile created');
      await loadProfiles();
      if (state.view === 'profiles') renderProfileGrid(); else refreshDashboard();
    } catch (err) { toast(err.message, 'error'); }
  });

  // thresholds: start from the profile's own values, or the defaults when it has none
  const th = p.thresholds || state.settings;
  for (const [el, k] of TH_FIELDS) $(`#${el}`).value = th[k];
  $('#pThDefault').addEventListener('change', (e) => $('#pTh').classList.toggle('hidden', e.target.checked));
  // suggest the interfaces the container can see
  api('/api/network').then((n) => {
    const list = $('#pIfaceList');
    if (list) list.innerHTML = n.interfaces.filter((i) => !i.internal).map((i) => `<option value="${esc(i.name)}">`).join('');
  }).catch(() => {});

  renderSched(); renderMode();
  $('#pName').focus();
}

// ============================================================ servers page
let srvSource = 'search';
$('#srvSourceSeg').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  srvSource = b.dataset.src;
  for (const x of $$('#srvSourceSeg button')) x.classList.toggle('active', x === b);
  $('#srvSearchForm').classList.toggle('hidden', srvSource !== 'search');
  if (srvSource === 'nearby') {
    $('#srvResults').innerHTML = '<div class="empty">Asking the speedtest CLI for nearby servers…</div>';
    try { renderSrvResults(await api('/api/servers/nearby')); } catch (err) { $('#srvResults').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  } else $('#srvResults').innerHTML = '<div class="empty">Search Ookla\'s server directory by city, sponsor or ID.</div>';
});
$('#srvSearchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#srvResults').innerHTML = '<div class="empty">Searching…</div>';
  try { renderSrvResults(await api(`/api/servers/search?q=${encodeURIComponent($('#srvQuery').value)}&limit=60`)); } catch (err) { $('#srvResults').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
});
function renderSrvResults(list) {
  $('#srvResults').innerHTML = list.length ? list.map((s) => {
    const saved = state.saved.some((x) => x.serverId === s.serverId);
    return serverRow(s, `<button class="btn sm ghost" data-test="${esc(s.serverId)}" title="Run a one-off test now">Test</button>${saved ? '<span class="hint" style="width:44px;text-align:center">saved</span>' : `<button class="btn sm" data-save='${esc(JSON.stringify(s))}'>Save</button>`}`);
  }).join('') : '<div class="empty">No servers found.</div>';
  $('#srvResults')._list = list;
}
$('#srvResults').addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.test) runServer(t.dataset.test);
  if (t.dataset.save) {
    await api('/api/servers/saved', { method: 'POST', body: JSON.parse(t.dataset.save) });
    await loadSaved(); renderSaved(); renderSrvResults($('#srvResults')._list || []);
  }
});
$('#manualSrvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#manualSrv').value.trim(); if (!v) return;
  let info = { serverId: v };
  if (/^\d+$/.test(v)) {
    try { const r = await api(`/api/servers/search?q=${v}&limit=20`); info = r.find((x) => x.serverId === v) || info; } catch { /* keep bare */ }
  } else info.host = v;
  await api('/api/servers/saved', { method: 'POST', body: info });
  $('#manualSrv').value = '';
  await loadSaved(); renderSaved();
});
function renderSaved() {
  $('#savedList').innerHTML = state.saved.length ? state.saved.map((s) => {
    const usedBy = state.profiles.filter((p) => p.servers.includes(s.serverId)).map((p) => p.name);
    return `<div class="srv-row"><div class="info">
        <div class="name">${esc(s.label || s.sponsor || s.host || s.serverId)}</div>
        <div class="sub">${esc([s.label ? s.sponsor : '', s.location, s.country].filter(Boolean).join(', '))}${usedBy.length ? ` · used by ${esc(usedBy.join(', '))}` : ''}</div></div>
        <span class="id">#${esc(s.serverId)}</span>
        <button class="btn sm ghost" data-test="${esc(s.serverId)}">Test</button>
        <button class="btn sm ghost" data-label="${s.id}" title="Rename">✎</button>
        <button class="btn sm ghost danger" data-unsave="${s.id}" title="Remove">✕</button></div>`;
  }).join('') : '<div class="empty">No saved servers. Search and save the ones you want to track.</div>';
}
$('#savedList').addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.test) runServer(t.dataset.test);
  if (t.dataset.unsave) { await api(`/api/servers/saved/${t.dataset.unsave}`, { method: 'DELETE' }); await loadSaved(); renderSaved(); }
  if (t.dataset.label) {
    const s = state.saved.find((x) => x.id === Number(t.dataset.label));
    const label = prompt('Custom label for this server', s.label || s.sponsor);
    if (label == null) return;
    await api('/api/servers/saved', { method: 'POST', body: { ...s, label } });
    await loadSaved(); renderSaved();
  }
});

// ============================================================ settings page
const SETTING_FIELDS = [['sDlGood', 'downloadGood'], ['sDlFair', 'downloadFair'], ['sUlGood', 'uploadGood'], ['sUlFair', 'uploadFair'],
  ['sPingGood', 'pingGood'], ['sPingFair', 'pingFair'], ['sTimeout', 'testTimeoutSeconds'], ['sRetention', 'retentionDays'], ['sRange', 'defaultRange']];
const TH_FIELDS = [['pThDlGood', 'downloadGood'], ['pThDlFair', 'downloadFair'], ['pThUlGood', 'uploadGood'], ['pThUlFair', 'uploadFair'], ['pThPingGood', 'pingGood'], ['pThPingFair', 'pingFair']];

async function renderNetwork() {
  const el = $('#netInfo');
  try {
    const n = await api('/api/network');
    const rows = n.interfaces.map((i) => `<tr>
      <td><b class="mono">${esc(i.name)}</b>${i.defaultRoute ? ' <span class="tag">default route</span>' : ''}${i.internal ? ' <span class="tag">loopback</span>' : ''}</td>
      <td class="mono wrap">${i.addresses.map((a) => `<div>${esc(a.cidr || a.address)} <span class="muted">${esc(a.family)}</span></div>`).join('')}</td>
      <td class="mono muted">${esc(i.mac || '—')}</td>
    </tr>`).join('');
    const t = n.lastTest;
    el.innerHTML = `
      <div class="net-summary">
        <div><div class="k">Public IP (last test)</div><div class="v mono">${t ? esc(t.externalIp || '—') : '—'}</div></div>
        <div><div class="k">ISP</div><div class="v">${t ? esc(t.isp || '—') : '—'}</div></div>
        <div><div class="k">Tested via</div><div class="v mono">${t ? `${esc(t.interface || '—')}${t.internalIp ? ` · ${esc(t.internalIp)}` : ''}` : '—'}</div></div>
        <div><div class="k">Hostname</div><div class="v mono">${esc(n.hostname)}</div></div>
      </div>
      ${t ? `<div class="hint">From the latest successful test, ${ago(t.ts)}${t.isVpn ? ' (Ookla flagged it as a VPN)' : ''}.</div>` : '<div class="hint">Run a test to see your public IP and ISP.</div>'}
      <div class="table-wrap"><table><thead><tr><th>Interface</th><th>Addresses</th><th>MAC</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="hint">${n.inContainer
        ? 'These are the interfaces inside the container. With Docker\'s default bridge network you\'ll usually see only <code>eth0</code> and <code>lo</code>. To test through a host interface such as a VPN (<code>wg0</code>), run the container with host networking.'
        : 'These are this machine\'s network interfaces.'} Use an interface name or address in a profile's advanced network options.</div>`;
  } catch (e) {
    el.innerHTML = `<div class="hint">Couldn't load network info: ${esc(e.message)}</div>`;
  }
}

function renderSettings() {
  renderNetwork();
  for (const [el, k] of SETTING_FIELDS) $(`#${el}`).value = state.settings[k];
  $('#sPause').checked = !!state.settings.pauseAll;
}
$('#netRefresh').addEventListener('click', renderNetwork);
$('#saveSettingsBtn').addEventListener('click', async () => {
  const body = { pauseAll: $('#sPause').checked };
  for (const [el, k] of SETTING_FIELDS) body[k] = $(`#${el}`).value;
  try { state.settings = await api('/api/settings', { method: 'PUT', body }); toast('Settings saved'); renderRunner(); } catch (e) { toast(e.message, 'error'); }
});

// ============================================================ data loading & live events
async function loadProfiles() { state.profiles = await api('/api/profiles'); }
async function loadSaved() { state.saved = await api('/api/servers/saved'); }

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    state.runner = JSON.parse(e.data);
    if (!state.runner.running) state.progress = null;
    renderRunner();
    if (state.view === 'dashboard' && state.summary) renderProfileRows();
  });
  es.addEventListener('progress', (e) => { state.progress = JSON.parse(e.data); renderRunner(); });
  es.addEventListener('measurement', (e) => {
    const m = JSON.parse(e.data);
    if (m.status === 'error') toast(`${m.profile_name}: test failed — ${m.error}`, 'error');
    else toast(`${m.profile_name}: ↓ ${fmtSpeed(m.download_mbps)} ↑ ${fmtSpeed(m.upload_mbps)} · ${fmtMs(m.ping_ms)}`);
    refreshDashboard();
  });
  es.addEventListener('profiles', (e) => {
    state.profiles = JSON.parse(e.data);
    if (state.view === 'profiles') renderProfileGrid();
  });
  es.addEventListener('settings', (e) => { state.settings = JSON.parse(e.data); renderRunner(); });
}

// ============================================================ Ookla notice & version
function showOoklaNotice() {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-bg"><div class="modal notice-modal" role="alertdialog" aria-modal="true" aria-labelledby="noticeTitle">
    <div class="modal-head"><h2 id="noticeTitle">Before you start</h2></div>
    <div class="modal-body">
      <p>This container runs the official <b>Ookla Speedtest CLI</b>. By using it, you accept Ookla's
      End User License Agreement and Privacy Policy.</p>
      <p>Each test sends data such as your IP address to Ookla, and Ookla may store the results.</p>
      <div class="notice-links">
        <a class="btn sm" href="https://www.speedtest.net/about/eula" target="_blank" rel="noopener">Ookla EULA ↗</a>
        <a class="btn sm" href="https://www.speedtest.net/about/privacy" target="_blank" rel="noopener">Ookla Privacy Policy ↗</a>
      </div>
    </div>
    <div class="modal-foot"><button class="btn primary" id="noticeAck">I understand</button></div>
  </div></div>`;
  $('#noticeAck').addEventListener('click', async () => {
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: { ooklaNoticeAcknowledged: true } });
      root.innerHTML = '';
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#noticeAck').focus();
}

async function loadVersion() {
  try {
    const quick = await api('/api/version?quick=1');
    $('#versionText').textContent = quick.current;
    const v = quick.status === 'checking' ? await api('/api/version') : quick;
    const dot = $('#versionDot');
    dot.className = `vdot ${v.status === 'current' || v.status === 'outdated' ? v.status : ''}`;
    $('#versionText').textContent = v.current;
    const link = $('#versionLink');
    link.href = v.url;
    link.title = {
      current: `Version ${v.current} is the latest version`,
      outdated: `Version ${v.current}: ${v.latest} is available. Click to see what's new`,
      disabled: 'Update check is disabled',
    }[v.status] || `Couldn't check for updates${v.error ? ` (${v.error})` : ''}`;
    link.setAttribute('aria-label', link.title);
  } catch { /* indicator stays neutral */ }
}

async function init() {
  const [settings] = await Promise.all([api('/api/settings'), loadProfiles(), loadSaved()]);
  state.settings = settings;
  state.range = store.get('range', settings.defaultRange || '24h');
  if (!RANGES[state.range]) state.range = '24h';
  // drop stale profile selections
  for (const id of [...state.selected]) if (!state.profiles.some((p) => p.id === id)) state.selected.delete(id);
  connectEvents();
  loadVersion();
  if (!settings.ooklaNoticeAcknowledged) showOoklaNotice();
  const v = location.hash.slice(1);
  showView(['profiles', 'servers', 'settings'].includes(v) ? v : 'dashboard');
  // keep relative times & next-run countdowns fresh
  setInterval(() => {
    if (state.view === 'dashboard' && state.summary) { renderProfileRows(); }
  }, 30000);
}
init().catch((e) => { console.error(e); toast(`Failed to load: ${e.message}`, 'error'); });
