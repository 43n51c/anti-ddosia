// anti-DDoSia — ops console frontend
'use strict';
const REFRESH_MS = 60_000;
const DAY = 24 * 3600 * 1000;
const TYPE_COLORS = { http: '#4d9dff', http2: '#5b8def', http3: '#7f7fe0', tcp: '#f5b301', udp: '#f5b301', nginx_loris: '#ff5566' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// country centroids [lng, lat] for the map
const CENTROID = {
  CA: [-106, 56], US: [-97, 38], MX: [-102, 23], BR: [-51, -10], AR: [-64, -34],
  GB: [-2, 54], IE: [-8, 53], FR: [2, 46], DE: [10, 51], NL: [5.3, 52], BE: [4.5, 50.6],
  LU: [6, 49.8], ES: [-4, 40], PT: [-8, 39.5], IT: [12, 42], CH: [8, 47], AT: [14, 47.5],
  PL: [19, 52], CZ: [15, 49.8], SK: [19, 48.7], HU: [19, 47], RO: [25, 46], BG: [25, 43],
  GR: [22, 39], HR: [15.5, 45], SI: [15, 46], RS: [21, 44], UA: [32, 49], MD: [28, 47],
  LT: [24, 55], LV: [25, 57], EE: [26, 59], FI: [26, 64], SE: [15, 62], NO: [9, 62],
  DK: [10, 56], IS: [-19, 65], TR: [35, 39], IL: [35, 31], JP: [138, 36], KR: [128, 36],
  AU: [134, -25], NZ: [172, -41], ZA: [24, -29], IN: [79, 22], SG: [104, 1.3], AE: [54, 24],
  TW: [121, 24], MT: [14.4, 35.9], CY: [33, 35], AL: [20, 41], MK: [21.7, 41.6], ME: [19.3, 42.7], XK: [21, 42.6],
  BY: [28, 53.5], GE: [43.4, 42], AM: [45, 40], AZ: [48, 40], KZ: [67, 48], SA: [45, 24], EG: [30, 27],
  NG: [8, 9.5], KE: [38, 0.5], MA: [-6, 32], TH: [101, 15], VN: [107, 16], PH: [122, 12], ID: [118, -2],
  MY: [110, 3.5], PK: [70, 30], BD: [90, 24], LK: [81, 7.5], CL: [-71, -35], CO: [-73, 4], PE: [-76, -10],
  UY: [-56, -33], VE: [-66, 7], RU: [90, 62],
};
// world map (real Natural Earth 110m geometry), projected equirectangular
const MAP_W = 1000, MAP_H = 500;
const world = { all: '', byCode: new Map(), loaded: false };
function ringToPath(ring) {
  let d = '';
  for (let i = 0; i < ring.length; i++) { const x = ((ring[i][0] + 180) / 360 * MAP_W).toFixed(1); const y = ((90 - ring[i][1]) / 180 * MAP_H).toFixed(1); d += (i ? 'L' : 'M') + x + ',' + y; }
  return d + 'Z';
}
function geomToPath(g) {
  if (g.type === 'Polygon') return g.coordinates.map(ringToPath).join('');
  if (g.type === 'MultiPolygon') return g.coordinates.map((p) => p.map(ringToPath).join('')).join('');
  return '';
}
async function loadWorld() {
  try {
    const gj = await fetch('/world.geojson').then((r) => r.json());
    let all = ''; const bnds = {};
    for (const f of gj.features) {
      const d = geomToPath(f.g); all += d;
      if (!f.c) continue;
      world.byCode.set(f.c, (world.byCode.get(f.c) || '') + d);
      const b = bnds[f.c] || { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
      const walk = (a) => { if (typeof a[0] === 'number') { const x = (a[0] + 180) / 360 * MAP_W, y = (90 - a[1]) / 180 * MAP_H; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; } else a.forEach(walk); };
      walk(f.g.coordinates); bnds[f.c] = b;
    }
    world.bounds = bnds;
    world.all = all; world.loaded = true;
    if (state.view === 'ops' && state.stats) renderMap(state.stats.byCountry);
  } catch (e) { console.error('world map load failed', e.message); }
}

let trendGeom = null;
const state = { targets: [], stats: null, view: 'ops', geoMode: 'live', hostsMode: 'live', search: '', filterType: '', filterCountry: '', filterPort: '', filterMethod: '', filterNew: false, tSortKey: 'host', tSortDir: 'asc', fSortKey: 'targetCount', fSortDir: 'desc', hSort: 'targetCount' };

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function flag(cc) { if (!cc || cc.length !== 2 || cc === 'XX') return '<span class="flag flag-x"></span>'; return `<img class="flag" src="/flags/${cc.toLowerCase()}.svg" alt="${esc(cc)}" loading="lazy">`; }
// CSP-friendly flag fallback: replace a broken flag image with its code (no inline onerror)
document.addEventListener('error', (e) => { const t = e.target; if (t && t.tagName === 'IMG' && t.classList.contains('flag')) t.replaceWith(document.createTextNode(t.getAttribute('alt') || '')); }, true);
const codeOf = (c) => c.code || codeFor(c.key);
const LOCK = '<svg class="lock" viewBox="0 0 24 24" aria-label="ssl"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>';
function timeAgo(iso) { if (!iso) return '—'; const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`; }
function fmtDur(iso) {
  if (!iso) return '—';
  let s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 0) s = 0;
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const p = (n) => String(n).padStart(2, '0');
  return (d > 0 ? d + 'd ' : '') + `${p(h)}:${p(m)}:${p(s)}`;
}
function tickDurations() { for (const el of document.querySelectorAll('.dur[data-since]')) el.textContent = fmtDur(el.dataset.since); }
const dayIso = (d) => (d ? `${d}T00:00:00.000Z` : null);
const isNew = (t) => t.hostFirstSeen && (Date.now() - new Date(t.hostFirstSeen).getTime()) < DAY;
const typeCls = (ty) => (['http', 'http2', 'http3', 'tcp', 'udp', 'nginx_loris'].includes(ty) ? 't-' + ty : 't-default');
function toast(m) { const el = $('#toast'); el.textContent = m; el.hidden = false; clearTimeout(el._t); el._t = setTimeout(() => (el.hidden = true), 1800); }
async function copy(t, l) { try { await navigator.clipboard.writeText(t); toast(`${l} copied`); } catch { toast('copy blocked'); } }
function download(n, t, m) { const b = new Blob([t], { type: m }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = n; a.click(); URL.revokeObjectURL(u); }

// ---------- data ----------
async function api(path, opts) { const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts }); let d = {}; try { d = await res.json(); } catch {} if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`); return d; }
async function load() {
  try {
    const [t, s] = await Promise.all([api('/api/targets'), api('/api/stats')]);
    state.targets = t.targets || []; state.stats = s; setStatus(t.ok, t); render();
  } catch (e) { setStatus(false, { error: e.message }); }
}
function setStatus(ok, meta) { $('#statusDot').className = 'dot ' + (ok ? 'ok' : 'err'); $('#statusText').textContent = ok ? `live · ${timeAgo(meta.fetchedAt)} ago` : 'feed error'; }
function tick() { const d = new Date(); $('#clock').textContent = d.toISOString().slice(0, 16).replace('T', ' ') + 'Z'; tickDurations(); }

// ---------- filtering ----------
function filtered() {
  const q = state.search.toLowerCase();
  return state.targets.filter((t) => {
    if (state.filterType && t.type !== state.filterType) return false;
    if (state.filterCountry && t.country !== state.filterCountry) return false;
    if (state.filterPort && String(t.port) !== state.filterPort) return false;
    if (state.filterMethod && t.method !== state.filterMethod) return false;
    if (state.filterNew && !isNew(t)) return false;
    if (q) { const h = `${t.host} ${t.ip} ${t.path} ${t.org} ${t.country} ${t.method} ${t.type}`.toLowerCase(); if (!h.includes(q)) return false; }
    return true;
  });
}
function groupHosts(rows) {
  const m = new Map();
  for (const t of rows) {
    let h = m.get(t.host);
    if (!h) { h = { host: t.host, country: t.country, countryCode: t.countryCode, city: t.city, org: t.org, ips: new Set(), types: {}, methods: new Set(), ports: new Set(), paths: new Set(), ssl: false, targetCount: 0, firstSeen: t.hostFirstSeen, sessionStart: t.sessionStart || t.hostFirstSeen, vectors: [] }; m.set(t.host, h); }
    if (t.ip) h.ips.add(t.ip);
    h.types[t.type] = (h.types[t.type] || 0) + 1;
    if (t.method) h.methods.add(t.method);
    if (t.port != null) h.ports.add(t.port);
    if (t.path) h.paths.add(t.path);
    if (t.use_ssl) h.ssl = true;
    h.targetCount++; h.vectors.push(t);
    if (t.hostFirstSeen && new Date(t.hostFirstSeen) < new Date(h.firstSeen)) h.firstSeen = t.hostFirstSeen;
  }
  return [...m.values()].map((h) => ({ ...h, ips: [...h.ips], methods: [...h.methods], ports: [...h.ports].sort((a, b) => a - b), paths: [...h.paths] }));
}
function codeFor(country) { const t = state.targets.find((x) => x.country === country); return t ? t.countryCode : 'XX'; }

// ---------- render ----------
function render() {
  syncFilters();
  const rows = filtered();
  $('#resultCount').textContent = `${rows.length}/${state.targets.length} vectors`;
  $('#badgeHosts').textContent = state.stats?.totals?.hosts ?? '';
  $('#badgeTargets').textContent = state.targets.length || '';
  $('#searchClear').hidden = !state.search;
  // type/country/port/new filter the target/host LIST — only shown where a
  // filtered list is the main content (FEED + live HOSTS), like the grep box.
  // OPS is a holistic overview, so it ignores these and shows the full snapshot.
  const liveFilterView = (state.view === 'targets' || (state.view === 'hosts' && state.hostsMode === 'live'));
  $('#toolbar').style.display = liveFilterView ? '' : 'none';
  $('.search-wrap').style.display = (state.view === 'hosts' || state.view === 'targets') ? '' : 'none';
  if (state.view === 'ops') renderOps(state.targets);
  if (state.view === 'hosts') renderHosts(rows);
  if (state.view === 'targets') renderTargets(rows);
  if (state.view === 'assets') renderAssets();
  if (state.view === 'alerts') renderAlerts();
  tickDurations();
}

function renderOps(rows) {
  const s = state.stats; if (!s || !s.totals) return;
  const T = s.totals;
  renderPulse(T, s);
  loadPeriod(); // period-windowed metric tiles (async)

  renderMap(s.byCountry); // map always shows current attacks (live)
  $('#mapMeta').textContent = `${T.countries} ${T.countries === 1 ? 'country' : 'countries'} · ${T.hosts} distinct hosts now`;
  // BY COUNTRY / ATTACK METHODS bars are period-scoped — rendered by renderPeriodTiles

  renderOpsFeed(rows);
  // TREND stays all-time (a window of 1 day would be a single point); rankings are period-scoped
  $('#trendWin').textContent = 'all-time';
  $('#trendMeta').textContent = s.trendPeak?.day ? `peak ${s.trendPeak.count} · avg ${s.trendAvg}` : '';
  renderTrend($('#trendChart'), s.trend || []);
  $('#iocHosts').textContent = new Set(rows.map((r) => r.host).filter(Boolean)).size;
  $('#iocIps').textContent = new Set(rows.map((r) => r.ip).filter(Boolean)).size;
  $('#iocPaths').textContent = new Set(rows.map((r) => r.path).filter(Boolean)).size;
}

const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US').replace(/,/g, ' '));

function miniSpark(vals, w = 60, h = 18, color = '#7f8ea3') {
  if (vals.length < 2) return '';
  const max = Math.max(...vals), min = Math.min(...vals);
  const x = (i) => (i / (vals.length - 1)) * w;
  const y = (v) => h - 2 - ((v - min) / ((max - min) || 1)) * (h - 4);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.3"/><circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(vals[vals.length - 1]).toFixed(1)}" r="1.6" fill="${color}"/></svg>`;
}

function renderPulse(T, s) {
  const el = $('#pulse');
  const hosts = groupHosts(state.targets).sort((a, b) => b.targetCount - a.targetCount);
  const hot = hosts[0];
  const newHosts = [...new Set(state.targets.filter(isNew).map((t) => t.host))];
  const newNames = newHosts.length ? esc(newHosts.slice(0, 2).join(', ')) + (newHosts.length > 2 ? ` +${newHosts.length - 2}` : '') : 'no new hosts';
  const delta = s.yesterdayCount != null ? T.targets - s.yesterdayCount : null;
  const trajV = delta == null ? '—' : (delta === 0 ? '±0' : (delta > 0 ? `▲ ${delta}` : `▼ ${-delta}`));
  const trajCls = delta > 0 ? 'up' : (delta < 0 ? 'down' : '');
  const last7 = (s.trend || []).slice(-8).map((d) => d.count);
  const cc = s.byCountry.slice(0, 3).map((c) => `${flag(codeFor(c.key))} ${esc(c.key)}`).join('&nbsp; ');
  const sigs = [
    { l: 'LIVE NOW', v: `${T.targets}&nbsp;<span class="sig-sub">targets</span>`, d: `${T.hosts} hosts · ${T.ips} IPs · ${T.countries} ${T.countries === 1 ? 'country' : 'countries'}`, vc: '' },
    { l: 'TRAJECTORY', v: `${trajV}&nbsp;<span class="sig-sub">vs yday</span>&nbsp;${miniSpark(last7, 56, 16, delta > 0 ? '#ff5566' : '#3ddc84')}`, d: `${T.targets} now &larr; ${s.yesterdayCount ?? '—'} yesterday`, vc: trajCls },
    { l: 'CURRENT WAVE', v: s.waveSince ? `<span class="dur" data-since="${dayIso(s.waveSince)}"></span>` : '—', d: `since ${s.waveSince || '—'}${cc ? ' · ' + cc : ''}` },
    { l: 'HOT TARGET', v: hot ? esc(hot.host) : '—', d: hot ? `${hot.targetCount} vectors · ${Object.keys(hot.types).join('/')}` : '' },
  ];
  el.hidden = false;
  el.innerHTML = `
    <div class="pulse-h"><span class="pulse-dot"></span> PULSE <span class="pulse-tag">last 24h</span><span class="pulse-upd mono">updated ${timeAgo(s.fetchedAt)} ago</span></div>
    <div class="pulse-grid">${sigs.map((x) => `<div class="sig"><div class="sig-l">${x.l}</div><div class="sig-v ${x.vc || ''}">${x.v}</div><div class="sig-d">${x.d}</div></div>`).join('')}</div>`;
}

// ---------- period-windowed metrics ----------
const PERIOD = { range: '7', from: null, to: null };
const PRESET_LABEL = { today: 'today', '7': '7d', '30': '30d', '365': '365d', all: 'all-time', custom: 'custom' };
function periodDates() {
  const s = state.stats || {};
  const today = (s.fetchedAt || new Date().toISOString()).slice(0, 10);
  const start = s.historyStart || '2023-06-01';
  if (PERIOD.range === 'today') return { from: today, to: today };
  if (PERIOD.range === 'all') return { from: start, to: today };
  if (PERIOD.range === 'custom') return { from: PERIOD.from || start, to: PERIOD.to || today };
  const n = Number(PERIOD.range) || 7;
  const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - (n - 1));
  const from = d.toISOString().slice(0, 10);
  return { from: from < start ? start : from, to: today };
}
// remember the chosen window across reloads and shareable links
function persistPeriod() {
  try { localStorage.setItem('ddosia.period', JSON.stringify(PERIOD)); } catch { /* private mode */ }
  const q = new URLSearchParams(location.search);
  if (PERIOD.range === 'custom' && PERIOD.from && PERIOD.to) { q.set('period', 'custom'); q.set('from', PERIOD.from); q.set('to', PERIOD.to); }
  else { q.set('period', PERIOD.range); q.delete('from'); q.delete('to'); }
  history.replaceState(null, '', location.pathname + '?' + q.toString());
}
function restorePeriod() {
  const q = new URLSearchParams(location.search);
  let range = q.get('period'), from = q.get('from'), to = q.get('to');
  if (!range) { try { const sv = JSON.parse(localStorage.getItem('ddosia.period') || 'null'); if (sv) { range = sv.range; from = sv.from; to = sv.to; } } catch { /* ignore */ } }
  const valid = ['today', '7', '30', '365', 'all', 'custom'];
  if (!valid.includes(range)) return; // keep the 7d default
  if (range === 'custom' && !(from && to)) range = '7';
  PERIOD.range = range; PERIOD.from = from || null; PERIOD.to = to || null;
  $$('#periodSeg .seg').forEach((sg) => sg.classList.toggle('on', sg.dataset.range === range));
  if (range === 'custom') { $('#periodCustom').hidden = false; if (from) setDateField('from', from); if (to) setDateField('to', to); }
}
let periodToken = 0;
async function loadPeriod() {
  if (!state.stats) return;
  const { from, to } = periodDates();
  const mine = ++periodToken;
  let p;
  try { p = await api(`/api/period?from=${from}&to=${to}`); } catch { return; }
  if (mine !== periodToken) return; // a newer request superseded this one
  renderPeriodTiles(p);
}
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function countUp(el, to, dur = 560) {
  if (prefersReducedMotion() || !to) { el.textContent = fmt(to); return; }
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  (function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = fmt(Math.round(to * ease(t)));
    if (t < 1) requestAnimationFrame(frame); else el.textContent = fmt(to);
  })(start);
}
let periodLastKey = null;
function renderPeriodTiles(p) {
  const span = p.from === p.to ? p.from : `${p.from} → ${p.to}`;
  const winLabel = PRESET_LABEL[PERIOD.range] || 'custom';
  $('#periodRange').innerHTML = `<span class="pr-win">${winLabel}</span> ${span} · ${p.days} day${p.days === 1 ? '' : 's'}`;
  $('#countryWin').textContent = winLabel;
  $('#methodWin').textContent = winLabel;
  const tiles = [
    { l: 'HOSTS', v: p.hosts, d: 'distinct in window' },
    { l: 'UNIQUE IPS', v: p.ips, d: 'geo-resolved' },
    { l: 'COUNTRIES', v: p.countries, d: 'targeted' },
    { l: 'NEW HOSTS', v: p.newHosts, d: 'first appeared' },
    { l: 'PEAK / DAY', v: p.peak.count, d: p.peak.day ? `on ${p.peak.day}` : '' },
    { l: 'AVG / DAY', v: p.avg, d: 'targets/day' },
  ];
  const key = p.from + '|' + p.to;
  const animate = key !== periodLastKey && !prefersReducedMotion(); // only when the window actually changes
  periodLastKey = key;
  $('#tiles').innerHTML = tiles.map((c) => `<div class="tile"><div class="l">${c.l}</div><div class="v" data-val="${c.v}">${animate ? '0' : fmt(c.v)}</div>${c.d ? `<div class="d">${c.d}</div>` : ''}<span class="tile-bar"></span></div>`).join('');
  // period-scoped breakdown bars (share the same one-shot animation)
  bars($('#countryBars'), (p.byCountry || []).slice(0, 8), (r) => `${flag(r.code)} ${esc(r.key)}`, '#34e0d0', animate);
  bars($('#methodBars'), (p.byMethod || []).slice(0, 6), (r) => esc(r.key || '—'), '#f5b301', animate);
  // period-scoped rankings
  $('#mostWin').textContent = winLabel;
  $('#longestWin').textContent = winLabel;
  renderRanks(p.mostTargeted, p.longestAttacks);
  if (!animate) return;
  $$('#tiles .tile').forEach((tile) => {
    countUp(tile.querySelector('.v'), Number(tile.querySelector('.v').dataset.val));
    const bar = tile.querySelector('.tile-bar');
    requestAnimationFrame(() => { bar.classList.add('grow'); });
    setTimeout(() => bar.classList.add('fade'), 620);
  });
}

function bars(el, rows, labelFn, color, animate) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) { el.innerHTML = '<div class="empty">no data</div>'; return; }
  el.innerHTML = rows.map((r) => {
    const w = (r.count / max * 100).toFixed(1);
    return `<div class="bar" data-key="${esc(r.key)}"><span class="n" title="${esc(r.key)}">${labelFn(r)}</span><span class="tk"><span class="fl" style="width:${animate ? 0 : w}%;background:${color}" data-w="${w}"></span></span><span class="p" data-val="${r.count}">${animate ? 0 : fmt(r.count)}</span></div>`;
  }).join('');
  if (!animate) return;
  requestAnimationFrame(() => el.querySelectorAll('.fl').forEach((f) => { f.style.width = f.dataset.w + '%'; }));
  el.querySelectorAll('.p').forEach((p) => countUp(p, Number(p.dataset.val)));
}

function renderMap(data) {
  const W = MAP_W, H = MAP_H;
  const proj = (lng, lat) => [(lng + 180) / 360 * W, (90 - lat) / 180 * H];
  // markers are sized/labelled by HOST count per country (target-requests go in the tooltip)
  // per-country host counts (truthful geography): a host hosted in several
  // countries is counted in each, so markers can exceed the distinct total
  const hostsBy = {};
  for (const t of state.targets) { (hostsBy[t.countryCode] ||= new Set()).add(t.host); }
  const codes = data.map((c) => [codeOf(c), c]).filter(([cc]) => cc && cc !== 'XX');
  const hostsOf = (cc) => (hostsBy[cc] ? hostsBy[cc].size : (data.find((c) => codeOf(c) === cc)?.hosts || 0));
  const max = Math.max(1, ...codes.map(([cc]) => hostsOf(cc)));
  const hi = codes.map(([cc]) => world.byCode.get(cc)).filter(Boolean)
    .map((d) => `<path d="${d}" fill="rgba(255,85,102,0.16)" stroke="#8a3a45" stroke-width="0.5"/>`).join('');
  const labelN = 14; // label the top-N; long tail shown as plain dots to avoid clutter
  const markers = codes.map(([cc, c], i) => {
    const ce = CENTROID[cc]; if (!ce) return '';
    const [x, y] = proj(ce[0], ce[1]);
    const n = hostsOf(cc);
    const r = 4 + Math.sqrt(n / max) * 20;
    const dataAttr = `class="mk" data-code="${cc}" data-country="${esc(c.key)}" data-hosts="${n}" data-targets="${c.count}"`;
    const base = `${i === 0 ? `<circle cx="${x}" cy="${y}" r="${r}" fill="#ff5566" opacity="0.12"><animate attributeName="r" values="${r};${r + 16};${r}" dur="2.6s" repeatCount="indefinite"/></circle>` : ''}
      <circle cx="${x}" cy="${y}" r="${Math.max(r, 9)}" fill="transparent" ${dataAttr} style="cursor:pointer"/>
      <circle cx="${x}" cy="${y}" r="${r}" fill="rgba(255,85,102,0.18)" stroke="#ff5566" stroke-width="1" pointer-events="none"/>
      <circle cx="${x}" cy="${y}" r="2.5" fill="#ff5566" pointer-events="none"/>`;
    const fw = 22, fh = 15;
    const label = i < labelN ? `
      <image href="/flags/${cc.toLowerCase()}.svg" x="${x - fw / 2}" y="${y - r - fh - 5}" width="${fw}" height="${fh}" preserveAspectRatio="xMidYMid slice"/>
      <text x="${x + fw / 2 + 4}" y="${y - r - fh / 2 - 3}" fill="#dbe6f2" font-size="15" font-family="JetBrains Mono, monospace">${n}</text>` : '';
    // wrap in a group so markers can be counter-scaled to stay constant screen size on zoom
    return `<g class="mk-g" data-x="${x.toFixed(1)}" data-y="${y.toFixed(1)}">${base}${label}</g>`;
  }).join('');
  const land = world.loaded ? `<path d="${world.all}" fill="#0e1a2a" stroke="#22384f" stroke-width="0.35"/>${hi}` : '';
  // solidarity overlay: fill Ukraine with its flag; label Russia
  let overlay = '';
  if (world.loaded && world.bounds) {
    const uaPath = world.byCode.get('UA'), ub = world.bounds.UA;
    if (uaPath && ub) {
      const mid = (ub.y0 + ub.y1) / 2, w = ub.x1 - ub.x0;
      overlay += `<defs><clipPath id="uaClip"><path d="${uaPath}"/></clipPath></defs>
        <g clip-path="url(#uaClip)" opacity="0.85">
          <rect x="${ub.x0}" y="${ub.y0}" width="${w}" height="${mid - ub.y0}" fill="#0057B7"/>
          <rect x="${ub.x0}" y="${mid}" width="${w}" height="${ub.y1 - mid}" fill="#FFD700"/>
        </g>`;
    }
    // Russia bbox wraps the antimeridian, so anchor the label at a fixed spot over central Russia
    overlay += `<text x="760" y="96" text-anchor="middle" fill="#ff6b76" font-weight="700" font-size="12" font-family="JetBrains Mono, monospace" opacity="0.92">#russiaisaterroriststate</text>`;
  }
  const y0 = (90 - 84) / 180 * H, y1 = (90 - -58) / 180 * H;
  mapBase = { x: 0, y: y0, w: W, h: y1 - y0 };
  if (!mapVB) mapVB = { ...mapBase };
  $('#map').innerHTML = `<svg viewBox="0 ${y0.toFixed(0)} ${W} ${(y1 - y0).toFixed(0)}" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#070d16"/>
    ${land}${overlay}${markers}
  </svg>`;
  applyMapView(); // re-apply zoom/pan (as an SVG viewBox, so it stays vector-crisp)
}

// ---------- map zoom / pan via SVG viewBox (crisp — no raster scaling) ----------
let mapBase = null, mapVB = null;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function applyMapView() { const svg = $('#map')?.querySelector('svg'); if (svg && mapVB) svg.setAttribute('viewBox', `${mapVB.x} ${mapVB.y} ${mapVB.w} ${mapVB.h}`); updateMarkerScale(); }
// counter-scale markers (flags/circles/numbers) by 1/zoom so they keep a constant screen size
function updateMarkerScale() {
  const k = (mapBase && mapVB) ? (mapVB.w / mapBase.w) : 1;
  const svg = $('#map')?.querySelector('svg'); if (!svg) return;
  svg.querySelectorAll('.mk-g').forEach((g) => {
    const x = +g.dataset.x, y = +g.dataset.y;
    g.setAttribute('transform', `translate(${x} ${y}) scale(${k.toFixed(4)}) translate(${-x} ${-y})`);
  });
}
// zoom keeping the point under (px,py) — screen px within the svg — fixed
function zoomMapAt(px, py, factor) {
  if (!mapBase || !mapVB) return;
  const svg = $('#map')?.querySelector('svg'); if (!svg) return;
  const r = svg.getBoundingClientRect();
  const ux = mapVB.x + px / r.width * mapVB.w, uy = mapVB.y + py / r.height * mapVB.h; // cursor in user units
  const minW = mapBase.w / 8;
  const newW = clamp(mapVB.w / factor, minW, mapBase.w); // zoom in → smaller viewBox
  const s = newW / mapVB.w, newH = mapVB.h * s;
  let nx = ux - (ux - mapVB.x) * s, ny = uy - (uy - mapVB.y) * s;
  nx = clamp(nx, mapBase.x, mapBase.x + mapBase.w - newW);
  ny = clamp(ny, mapBase.y, mapBase.y + mapBase.h - newH);
  mapVB = { x: nx, y: ny, w: newW, h: newH };
  applyMapView();
}
(() => {
  const box = $('#mapBox'); if (!box) return;
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    const svg = $('#map')?.querySelector('svg'); if (!svg) return;
    const r = svg.getBoundingClientRect();
    zoomMapAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });
  box.addEventListener('click', (e) => {
    const z = e.target.closest('[data-mapzoom]'); if (!z || !mapBase) return;
    const svg = $('#map')?.querySelector('svg'); const r = svg.getBoundingClientRect();
    if (z.dataset.mapzoom === 'reset') { mapVB = { ...mapBase }; applyMapView(); }
    else zoomMapAt(r.width / 2, r.height / 2, z.dataset.mapzoom === 'in' ? 1.4 : 1 / 1.4);
  });
  // drag to pan (convert screen delta to user units)
  let drag = false, lx = 0, ly = 0;
  box.addEventListener('mousedown', (e) => { if (e.target.closest('[data-mapzoom]') || !mapVB) return; drag = true; lx = e.clientX; ly = e.clientY; box.classList.add('grabbing'); });
  window.addEventListener('mousemove', (e) => {
    if (!drag || !mapBase) return;
    const svg = $('#map')?.querySelector('svg'); if (!svg) return;
    const r = svg.getBoundingClientRect();
    mapVB.x = clamp(mapVB.x - (e.clientX - lx) / r.width * mapVB.w, mapBase.x, mapBase.x + mapBase.w - mapVB.w);
    mapVB.y = clamp(mapVB.y - (e.clientY - ly) / r.height * mapVB.h, mapBase.y, mapBase.y + mapBase.h - mapVB.h);
    lx = e.clientX; ly = e.clientY; applyMapView();
  });
  window.addEventListener('mouseup', () => { drag = false; box.classList.remove('grabbing'); });
  box.addEventListener('mouseleave', () => { $('#mapTip').hidden = true; });
})();

function rankBar(frac, color) { return `<span class="rk-track"><span class="rk-fill" style="width:${(Math.max(0.03, frac) * 100).toFixed(1)}%;background:${color}"></span></span>`; }
function renderRanks(most, longest) {
  most = most || [];
  const live = new Set(state.targets.map((t) => t.host));
  const maxS = Math.max(1, ...most.map((r) => r.days));
  $('#mostTargeted').innerHTML = most.length ? most.map((r, i) => `
    <div class="rk" data-host="${esc(r.host)}" title="on the list ${r.days} day${r.days === 1 ? '' : 's'} in this window">
      <span class="rk-i">${i + 1}</span>
      <span class="rk-h">${live.has(r.host) ? '<span class="rk-live">●</span> ' : ''}${esc(r.host)}</span>
      ${rankBar(r.days / maxS, '#8b5cf6')}
      <span class="rk-v">${r.days}d</span>
    </div>`).join('') : '<div class="empty">no data in this window</div>';

  longest = longest || [];
  const maxD = Math.max(0.01, ...longest.map((r) => r.days));
  $('#longestAttacks').innerHTML = longest.length ? longest.map((r, i) => {
    const ongoing = !r.ended;
    return `<div class="rk" data-host="${esc(r.host)}" title="${ongoing ? 'ongoing' : 'ended ' + r.ended.slice(0, 10)}">
      <span class="rk-i">${i + 1}</span>
      <span class="rk-h">${ongoing ? '<span class="rk-live">●</span> ' : ''}${esc(r.host)}</span>
      ${rankBar(r.days / maxD, ongoing ? '#3ddc84' : '#f5b301')}
      <span class="rk-v">${fmtSpan(r.days)}</span>
    </div>`;
  }).join('') : '<div class="empty">no session data — run backfill</div>';
  tickDurations();
}

function renderOpsFeed(rows) {
  let hosts = groupHosts(rows);
  const { fSortKey: k, fSortDir: dir } = state;
  hosts.sort((a, b) => {
    let va = a[k], vb = b[k];
    if (k === 'firstSeen') { va = new Date(a.firstSeen); vb = new Date(b.firstSeen); }
    if (typeof va === 'number' || va instanceof Date) return dir === 'asc' ? va - vb : vb - va;
    va = String(va ?? '').toLowerCase(); vb = String(vb ?? '').toLowerCase();
    return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  });
  const body = $('#opsFeedBody');
  if (!hosts.length) { body.innerHTML = '<tr><td colspan="6" class="empty">no targets match</td></tr>'; return; }
  body.innerHTML = hosts.map((h) => {
    const fresh = h.firstSeen && (Date.now() - new Date(h.firstSeen).getTime()) < DAY;
    return `<tr class="${fresh ? 'new' : ''}" data-host="${esc(h.host)}">
      <td><span class="tdot"></span>${esc(h.host)}${fresh ? ' <span class="nbadge">NEW</span>' : ''}</td>
      <td class="cc">${flag(h.countryCode)} ${esc(h.city || h.country)}</td>
      <td>${h.targetCount}</td>
      <td class="tt">${Object.keys(h.types).join(' ')}</td>
      <td class="cc">${h.ports.length > 10 ? h.ports.slice(0, 10).join(' ') + ` +${h.ports.length - 10}` : h.ports.join(' ')}</td>
      <td class="cc"><span class="dur" data-since="${esc(h.sessionStart)}"></span></td>
    </tr>`;
  }).join('');
  markSort('#opsFeed', state.fSortKey, state.fSortDir);
}

let lastTrend = [];
function renderTrend(el, trend, animate) {
  lastTrend = trend;
  if (!trend.length) { el.innerHTML = '<div class="empty">no history in this window…</div>'; return; }
  const W = Math.round(el.clientWidth) || 900, H = 180, pad = 30, bot = 22;
  const max = Math.max(...trend.map((d) => d.count)) * 1.12 || 1;
  const many = trend.length > 40;
  const x = (i) => pad + (i / Math.max(1, trend.length - 1)) * (W - pad * 2);
  const y = (v) => H - bot - (v / max) * (H - pad - bot);
  const pts = trend.map((d, i) => `${x(i)},${y(d.count)}`).join(' ');
  const area = `${pad},${H - bot} ${pts} ${x(trend.length - 1)},${H - bot}`;
  const yt = [0, max / 2, max].map((v) => `<line x1="${pad}" y1="${y(v)}" x2="${W - pad}" y2="${y(v)}" stroke="#141c28" stroke-dasharray="2 4"/><text x="4" y="${y(v) + 3}" fill="#566274" font-size="9">${Math.round(v)}</text>`).join('');
  let xl = '';
  if (many) {
    const multi = new Set(trend.map((d) => d.day.slice(0, 4))).size > 1;
    const every = trend.length > 500 ? 3 : 1; let lm = -1;
    xl = trend.map((d, i) => { const m = +d.day.slice(5, 7) - 1; if (m === lm) return ''; lm = m; const lbl = multi ? `${MONTHS[m]} '${d.day.slice(2, 4)}` : MONTHS[m]; return `<line x1="${x(i)}" y1="${pad - 6}" x2="${x(i)}" y2="${H - bot}" stroke="${m === 0 ? '#1f2b3b' : '#131c27'}"/>${m % every === 0 ? `<text x="${x(i) + 2}" y="${H - 7}" fill="#566274" font-size="9">${lbl}</text>` : ''}`; }).join('');
  }
  const last = trend[trend.length - 1];
  const peak = trend.reduce((m, d) => (d.count > m.count ? d : m), trend[0]);
  const px = x(trend.indexOf(peak));
  trendGeom = { W, H, pad, bot, n: trend.length, trend, xAt: x, yAt: y };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none">
    <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3ddc84" stop-opacity="0.28"/><stop offset="100%" stop-color="#3ddc84" stop-opacity="0"/></linearGradient></defs>
    ${yt}${xl}
    <polygon points="${area}" fill="url(#tg)"/>
    <polyline points="${pts}" fill="none" stroke="#3ddc84" stroke-width="${many ? 1.4 : 2}"/>
    <circle cx="${px}" cy="${y(peak.count)}" r="3" fill="#ff5566"><title>peak ${peak.day}: ${peak.count}</title></circle>
    <line id="tCross" x1="0" y1="${pad - 6}" x2="0" y2="${H - bot}" stroke="#3ddc84" stroke-width="0.8" stroke-dasharray="2 3" opacity="0" pointer-events="none"/>
    <circle id="tDot" r="3.2" fill="#3ddc84" stroke="#0a0f16" stroke-width="1" opacity="0" pointer-events="none"/>
    <text x="${W - pad}" y="11" text-anchor="end" fill="#c4d0de" font-size="10">last ${last.count}</text>
  </svg>`;
  if (animate && !prefersReducedMotion()) { el.classList.remove('draw'); void el.offsetWidth; el.classList.add('draw'); }
}

// ---------- check hero ----------
$('#checkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#checkInput').value.trim();
  const el = $('#checkVerdict');
  if (!q) { el.hidden = true; return; }
  try {
    const r = await api('/api/check?q=' + encodeURIComponent(q));
    if (!r.ok) { el.hidden = false; el.className = 'verdict'; el.innerHTML = `<div class="vrow">${esc(r.error)}</div>`; return; }
    el.hidden = false;
    if (r.targeted) {
      el.className = 'verdict hit';
      el.innerHTML = `<div class="vhead">■ ON THE TARGET LIST</div>` + r.matches.map((m) =>
        `<div class="vrow"><b>${esc(r.query)}</b> → <span class="host" data-host="${esc(m.host)}">${esc(m.host)}</span> · ${m.vectors} vectors · ${esc(m.types.join('/'))} · ${m.ips.length} IP${m.ips.length > 1 ? 's' : ''} · ${flag(m.country && codeFor(m.country) || 'XX')} ${esc(m.city || m.country)}</div>`).join('')
        + `<div class="vrow" style="margin-top:6px">→ sign in to monitor this asset and get alerted on new hits.</div>`;
    } else {
      el.className = 'verdict ok';
      el.innerHTML = `<div class="vhead">○ NOT on the current list</div><div class="vrow"><b>${esc(r.query)}</b> (${r.type}) is not among today's ${state.targets.length} targets. Add it to monitoring to catch future waves.</div>`;
    }
  } catch (err) { el.hidden = false; el.className = 'verdict'; el.innerHTML = `<div class="vrow">check failed: ${esc(err.message)}</div>`; }
});

// ---------- hosts view ----------
const HSORT_TO_ALL = { targetCount: 'sessions', host: 'name', firstSeen: 'recent', ports: 'longest' };
let hostsAllKey = null;
function renderHosts(rows) {
  $$('.hosts-toggle .seg').forEach((b) => b.classList.toggle('on', b.dataset.hostmode === state.hostsMode));
  const all = state.hostsMode === 'all';
  $('#hostGrid').hidden = all;
  $('#hostAllWrap').hidden = !all;
  $('#hostAllCountry').hidden = !all;
  if (all) { syncHostCountry(); return renderHostsAll(); }
  renderHostsLive(rows);
}
function syncHostCountry() {
  const sel = $('#hostAllCountry'); const cur = sel.value;
  const items = state.stats?.byCountryAllTime || [];
  if (sel.options.length <= 1 && items.length) {
    sel.innerHTML = '<option value="">country: all</option>' + items.map((c) => `<option value="${esc(c.code)}">${esc(c.key)} (${c.count})</option>`).join('');
    sel.value = cur;
  }
}
async function renderHostsAll() {
  const sort = HSORT_TO_ALL[state.hSort] || 'sessions';
  const country = $('#hostAllCountry').value || '';
  const key = `${state.search}|${sort}|${country}`;
  if (key === hostsAllKey && $('#hostAllBody').children.length) return; // avoid refetch on poll re-render
  hostsAllKey = key;
  try {
    const d = await api(`/api/hosts-all?q=${encodeURIComponent(state.search)}&sort=${sort}&country=${encodeURIComponent(country)}`);
    const hosts = d.hosts || [];
    const body = $('#hostAllBody');
    body.innerHTML = hosts.length ? hosts.map((h) => `<tr data-host="${esc(h.host)}">
      <td>${h.active ? '<span class="tdot"></span>' : ''}${esc(h.host)}</td>
      <td class="cc">${flag(h.code)} ${esc(h.country || '')}</td>
      <td>${h.sessions}×</td>
      <td class="cc">${fmtSpan(h.longest)}</td>
      <td class="cc">${fmtSpan(h.total)}</td>
      <td class="cc">${h.active ? '<span class="ssl1">targeted now</span>' : timeAgo(h.last) + ' ago'}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">no hosts match</td></tr>';
  } catch { $('#hostAllBody').innerHTML = '<tr><td colspan="6" class="empty">could not load</td></tr>'; }
}
$('#hostAllCountry').addEventListener('change', () => { hostsAllKey = null; renderHostsAll(); });
function renderHostsLive(rows) {
  let hosts = groupHosts(rows);
  hosts.sort((a, b) => { if (state.hSort === 'host') return a.host.localeCompare(b.host); if (state.hSort === 'firstSeen') return new Date(b.firstSeen) - new Date(a.firstSeen); if (state.hSort === 'ports') return (b.ports.length + b.paths.length) - (a.ports.length + a.paths.length); return b.targetCount - a.targetCount; });
  const g = $('#hostGrid');
  if (!hosts.length) { g.innerHTML = '<div class="empty">no hosts match</div>'; return; }
  g.innerHTML = hosts.map((h) => {
    const chips = Object.entries(h.types).sort((a, b) => b[1] - a[1]).map(([ty, c]) => `<span class="tag ${typeCls(ty)}">${esc(ty)} ${c}</span>`).join('');
    const fresh = h.firstSeen && (Date.now() - new Date(h.firstSeen).getTime()) < DAY;
    return `<div class="hcard ${fresh ? 'new' : ''}" data-host="${esc(h.host)}">
      <div class="hc-top"><div><div class="hc-name">${esc(h.host)} ${fresh ? '<span class="nbadge">NEW</span>' : ''}</div>
        <div class="hc-geo">${flag(h.countryCode)} ${esc(h.country)}${h.city ? ` · ${esc(h.city)}` : ''}</div>
        ${h.org ? `<div class="hc-org">${esc(h.org)}</div>` : ''}</div>
        <div class="hc-v"><div class="n">${h.targetCount}</div><div class="l">VEC</div></div></div>
      <div class="hc-chips">${chips}</div>
      <div class="hc-surf"><span><b>${h.ips.length}</b> IP</span><span><b>${h.ports.length}</b> ports</span><span><b>${h.paths.length}</b> paths</span><span>${h.ssl ? LOCK + ' ssl' : 'no ssl'}</span></div>
    </div>`;
  }).join('');
}

// ---------- targets (raw) ----------
function renderTargets(rows) {
  const { tSortKey: k, tSortDir: dir } = state;
  rows = [...rows].sort((a, b) => { let va = a[k], vb = b[k]; if (typeof va === 'boolean') { va = +va; vb = +vb; } if (typeof va === 'number' && typeof vb === 'number') return dir === 'asc' ? va - vb : vb - va; va = String(va ?? '').toLowerCase(); vb = String(vb ?? '').toLowerCase(); return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va); });
  const body = $('#targetsBody');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="empty">no targets match</td></tr>'; return; }
  body.innerHTML = rows.map((t) => `<tr class="${isNew(t) ? 'new' : ''}" data-host="${esc(t.host)}">
    <td>${esc(t.host)}${isNew(t) ? ' <span class="nbadge">NEW</span>' : ''}</td><td class="cc">${esc(t.ip)}</td><td class="cc">${flag(t.countryCode)} ${esc(t.country)}</td>
    <td><span class="tag ${typeCls(t.type)}">${esc(t.type)}</span></td><td class="cc">${esc(t.method || '—')}</td><td class="cc">${esc(t.port)}</td>
    <td class="${t.use_ssl ? 'ssl1' : 'ssl0'}">${t.use_ssl ? LOCK : '—'}</td><td class="path">${esc(t.path || '—')}</td></tr>`).join('');
  markSort('#targetsTable', state.tSortKey, state.tSortDir);
}
function markSort(sel, key, dir) { $$(`${sel} thead th`).forEach((h) => h.classList.remove('sa', 'sd')); const th = $(`${sel} thead th[data-sort="${key}"]`); if (th) th.classList.add(dir === 'asc' ? 'sa' : 'sd'); }

// ---------- drawer ----------
function dsecC(title, body, open, hint) { return `<details class="dsec-c" ${open ? 'open' : ''}><summary><span class="dsc-t">${esc(title)}</span>${hint ? `<span class="dsc-hint">${esc(hint)}</span>` : ''}</summary><div class="dsc-body">${body}</div></details>`; }
function fmtSpan(days) {
  let mins = Math.max(0, Math.round(days * 1440));
  const d = Math.floor(mins / 1440); mins -= d * 1440;
  const h = Math.floor(mins / 60); mins -= h * 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return mins > 0 ? `${h}h ${mins}m` : `${h}h`;
  return `${mins}m`;
}
// one collapsible per IP with that IP's live target entries (type/method/port/path)
function renderIpTargets(ip, vecs, openIt) {
  const ports = [...new Set(vecs.map((v) => v.port))].sort((a, b) => a - b);
  const paths = [...new Set(vecs.map((v) => v.path).filter(Boolean))];
  const copyBtns = `<div class="dsc-copyall"><button class="mini-copy" data-copy="${esc(ip)}">copy IP</button>${paths.length ? ` <button class="mini-copy" data-copy="${esc(paths.join('\n'))}">copy paths</button>` : ''}</div>`;
  const table = `<table class="vec-tbl"><thead><tr><th>type</th><th>method</th><th>port</th><th>path</th></tr></thead><tbody>${vecs.map((v) => `<tr><td><span class="tag ${typeCls(v.type)}">${esc(v.type)}</span></td><td class="cc">${esc(v.method || '—')}</td><td class="cc">${esc(v.port)}</td><td class="p">${esc(v.path || '—')}</td></tr>`).join('')}</tbody></table>`;
  return dsecC(`${ip} · ${vecs.length} target${vecs.length === 1 ? '' : 's'}`, copyBtns + table, openIt, `ports ${ports.join(', ') || '—'}`);
}
// one collapsible per IP with that IP's all-time paths (from the stored surface)
function renderIpPathsHist(ip, e, openIt) {
  const paths = e.paths || [], ports = e.ports || [], types = e.types || {}, methods = e.methods || [];
  const copyBtns = `<div class="dsc-copyall"><button class="mini-copy" data-copy="${esc(ip)}">copy IP</button>${paths.length ? ` <button class="mini-copy" data-copy="${esc(paths.map((p) => p[0]).join('\n'))}">copy paths</button>` : ''}</div>`;
  const rows = paths.length ? paths.map(([p, c]) => `<div class="res-row"><span class="res-p mono" title="${esc(p)}">${esc(p)}</span><span class="res-m">${c}×</span><button class="mini-copy" data-copy="${esc(p)}">copy</button></div>`).join('') : '<div class="empty">no path-based targets on this IP</div>';
  const chips = (Object.keys(types).length || methods.length) ? `<div class="surf-chips">${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, c]) => `<span class="tag ${typeCls(t)}">${esc(t)} ${c}</span>`).join('')}${methods.map((m) => `<span class="tag t-default">${esc(m)}</span>`).join('')}</div>` : '';
  return dsecC(`${ip} · ${paths.length} path${paths.length === 1 ? '' : 's'}`, copyBtns + rows + chips, openIt, `ports ${ports.join(', ') || '—'}`);
}
async function openDrawer(host) {
  const rows = state.targets.filter((t) => t.host === host);
  const isCurrent = rows.length > 0;
  const h = isCurrent ? groupHosts(rows)[0] : null;
  const proto = (h && h.ssl) ? 'https' : 'http';
  $('#drawerHost').innerHTML = `${esc(host)} <a href="${proto}://${esc(host)}" target="_blank" rel="noopener">↗</a>`;
  $('#drawerSub').innerHTML = isCurrent
    ? `${flag(h.countryCode)} ${esc(h.country)}${h.city ? ' · ' + esc(h.city) : ''}${h.org ? ' · ' + esc(h.org) : ''}`
    : '<span class="off">not currently on the target list — showing attack history</span>';
  $('#drawerBody').innerHTML = '<div class="empty">loading…</div>';
  $('#drawer').hidden = false; $('#drawerOverlay').hidden = false;

  let d = {};
  try { d = await api('/api/host-sessions?host=' + encodeURIComponent(host)); } catch {}
  const surf = d.surface, sm = d.summary || { count: 0, totalDays: 0, longest: 0, firstSeen: null }, ss = d.sessions || [];

  const facts = isCurrent
    ? [{ k: 'vectors', v: h.targetCount }, { k: 'unique IPs', v: h.ips.length }, { k: 'ports', v: h.ports.join(', ') || '—' }, { k: 'targeted for', v: `<span class="dur" data-since="${esc(h.sessionStart)}"></span>`, raw: true }]
    : [{ k: 'attack sessions', v: String(sm.count) }, { k: 'longest stint', v: sm.longest ? fmtSpan(sm.longest) : '—' }, { k: 'total under attack', v: sm.totalDays ? fmtSpan(sm.totalDays) : '—' }, { k: 'first seen', v: (sm.firstSeen || '').slice(0, 10) || '—' }];
  const factsHtml = `<div class="facts">${facts.map((f) => `<div class="fact"><div class="k">${f.k}</div><div class="v">${f.raw ? f.v : esc(f.v)}</div></div>`).join('')}</div>`;

  // paths grouped per IP: one collapsible section per IP with that IP's targets
  let targetsHtml;
  if (isCurrent) {
    const byIp = {};
    for (const v of h.vectors) (byIp[v.ip] ||= []).push(v);
    const ips = Object.keys(byIp).sort((a, b) => byIp[b].length - byIp[a].length);
    const secs = ips.map((ip) => renderIpTargets(ip, byIp[ip], false)).join('');
    targetsHtml = `<div class="dsec-label">TARGETS BY IP <span class="dsc-hint">${ips.length} IP${ips.length === 1 ? '' : 's'} · ${h.vectors.length} entries · live</span></div>${secs}`;
  } else {
    const byIp = surf && surf.byIp ? surf.byIp : {};
    const ips = Object.keys(byIp).sort((a, b) => (byIp[b].paths ? byIp[b].paths.length : 0) - (byIp[a].paths ? byIp[a].paths.length : 0));
    const secs = ips.length ? ips.map((ip) => renderIpPathsHist(ip, byIp[ip], false)).join('') : '<div class="empty">no per-IP path data recorded</div>';
    targetsHtml = `<div class="dsec-label">TARGETS BY IP <span class="dsc-hint">${ips.length} IP${ips.length === 1 ? '' : 's'} · all-time</span></div>${secs}`;
  }

  const sessRows = ss.length ? ss.map((s) => {
    const ongoing = !s.ended;
    const from = s.started.slice(0, 10);
    const lastDay = ongoing ? new Date().toISOString().slice(0, 10) : s.ended.slice(0, 10);
    const title = from === lastDay ? from : `${from} → ${lastDay}`;
    const dur = ongoing ? `<span class="dur" data-since="${esc(s.started)}"></span>` : (s.days * 86400 < 60 ? '<1m' : fmtSpan(s.days));
    const hint = `${ongoing ? '<span class="on">ongoing</span> · ' : ''}${dur}`;
    return `<details class="dsec-c sess" data-shost="${esc(host)}" data-from="${from}" data-to="${lastDay}"><summary><span class="dsc-t">${title}</span><span class="dsc-hint">${hint}</span></summary><div class="dsc-body sess-body"><div class="empty">…</div></div></details>`;
  }).join('') : '<div class="empty">no recorded sessions</div>';
  const histHtml = `<div class="dsec-label">ATTACK HISTORY <span class="dsc-hint">${sm.count} session${sm.count === 1 ? '' : 's'} · click to expand</span></div>${sessRows}`;

  $('#drawerBody').innerHTML = factsHtml + targetsHtml + histHtml;
  tickDurations();
  $$('#drawerBody details.sess').forEach((el) => el.addEventListener('toggle', () => loadSessionDetail(el)));
}
function renderSessDetail(d) {
  const paths = d.paths || [], types = d.types || {}, methods = d.methods || [], ips = d.ips || [], ports = d.ports || [];
  const meta = `<div class="sess-meta">${ips.length ? 'IPs: ' + ips.map(esc).join(', ') + ' · ' : ''}ports ${ports.join(', ') || '—'}</div>`;
  const pathRows = paths.length ? paths.map(([p, c]) => `<div class="res-row"><span class="res-p mono" title="${esc(p)}">${esc(p)}</span><span class="res-m">${c}×</span><button class="mini-copy" data-copy="${esc(p)}">copy</button></div>`).join('') : '<div class="empty">no path-based vectors in this session</div>';
  const chips = (Object.keys(types).length || methods.length) ? `<div class="surf-chips">${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, c]) => `<span class="tag ${typeCls(t)}">${esc(t)} ${c}</span>`).join('')}${methods.map((m) => `<span class="tag t-default">${esc(m)}</span>`).join('')}</div>` : '';
  return meta + pathRows + chips;
}
async function loadSessionDetail(el) {
  if (!el.open || el.dataset.loaded) return;
  el.dataset.loaded = '1';
  const body = el.querySelector('.sess-body');
  try {
    const d = await api(`/api/session-detail?host=${encodeURIComponent(el.dataset.shost)}&from=${el.dataset.from}&to=${el.dataset.to}`);
    body.innerHTML = renderSessDetail(d);
  } catch { el.dataset.loaded = ''; body.innerHTML = '<div class="empty">could not load</div>'; }
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawerOverlay').hidden = true; }

// ---------- export ----------
function exportData(kind) {
  // OPS shows the full current list; the FEED view exports the filtered slice
  const rows = state.view === 'targets' ? filtered() : state.targets;
  if (kind === 'json') download('ddosia-targets.json', JSON.stringify(rows, null, 2), 'application/json');
  else if (kind === 'csv') { const cols = ['host', 'ip', 'country', 'city', 'org', 'type', 'method', 'port', 'use_ssl', 'path']; const e = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`; download('ddosia-targets.csv', [cols.join(','), ...rows.map((r) => cols.map((c) => e(r[c])).join(','))].join('\n'), 'text/csv'); }
  else if (kind === 'hosts') copy([...new Set(rows.map((r) => r.host).filter(Boolean))].join('\n'), 'Hosts');
  else if (kind === 'ips') copy([...new Set(rows.map((r) => r.ip).filter(Boolean))].join('\n'), 'IPs');
  else if (kind === 'paths') copy([...new Set(rows.map((r) => r.path).filter(Boolean))].join('\n'), 'Paths');
  $('#exportMenu').hidden = true;
}

// ---------- filters ----------
function syncFilters() {
  const s = state.stats; if (!s) return;
  // reflect state.filterX; if a drilled value isn't in the current snapshot, keep it as an extra option
  const fill = (sel, items, all, fmt, val) => {
    const opts = [`<option value="">${all}</option>`].concat(items.map((r) => `<option value="${esc(r.key)}">${fmt(r)}</option>`));
    if (val && !items.some((r) => String(r.key) === String(val))) opts.push(`<option value="${esc(val)}">${esc(val)}</option>`);
    sel.innerHTML = opts.join(''); sel.value = val || '';
  };
  fill($('#filterType'), s.byType, 'type: all', (r) => `${r.key} (${r.count})`, state.filterType);
  fill($('#filterCountry'), s.byCountry, 'country: all', (r) => `${r.key} (${r.count})`, state.filterCountry);
  fill($('#filterPort'), s.byPort, 'port: all', (r) => `${r.key} (${r.count})`, state.filterPort);
  fill($('#filterMethod'), s.byMethod, 'method: all', (r) => `${r.key} (${r.count})`, state.filterMethod);
}

// ==================== account / auth / assets / alerts ====================
const account = { user: null, unseen: 0, emailConfigured: false, assets: [], alerts: [], providers: [] };
let pendingView = null;

const PROVIDER_ICON = {
  google: '<svg viewBox="0 0 48 48" width="18" height="18"><path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z"/><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.8 28.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 17.1 2.1 20.4 2.1 24s.9 6.9 2.4 9.9l7.3-5.7z"/><path fill="#EA4335" d="M24 10.7c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 8.1 6.9 4.5 14.1l7.3 5.7c1.7-5.1 6.5-9.1 12.2-9.1z"/></svg>',
  github: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0C17.3 4.7 18.3 5 18.3 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.6.8.5 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/></svg>',
};
async function loadMe() {
  try {
    const d = await api('/api/me');
    account.user = d.user; account.unseen = d.unseen || 0; account.emailConfigured = !!d.emailConfigured;
    renderAccount();
    if (account.user) await Promise.all([loadAssets(), loadAlerts()]);
    if (state.view === 'assets' || state.view === 'alerts') render();
  } catch {}
}
function renderAccount() {
  const on = !!account.user;
  $('#signinBtn').hidden = on; $('#acctWrap').hidden = !on; $('#bellWrap').hidden = !on;
  if (on) { $('#acctAvatar').textContent = account.user.email[0] || '?'; $('#acctEmail').textContent = account.user.email; const b = $('#bellBadge'); b.hidden = !account.unseen; b.textContent = account.unseen; }
  const nb = $('#badgeAlerts'); nb.hidden = !(on && account.unseen); nb.textContent = account.unseen;
}
let authMode = 'login';
function setAuthMode(m) { authMode = m; $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === m)); $('#authSubmit').textContent = m === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT'; $('#authLead').textContent = m === 'login' ? 'sign in to monitor your assets and get alerts.' : 'create an account to monitor your assets and get alerts.'; $('#authErr').hidden = true; }
function renderAuthProviders() {
  const el = $('#oauthBtns');
  const provs = account.providers || [];
  el.innerHTML = provs.map((p) => `<a class="oauth-btn" href="/auth/${p.key}">${PROVIDER_ICON[p.key] || ''}<span>Continue with ${esc(p.label)}</span></a>`).join('');
  $('#authOr').hidden = provs.length === 0;
}
async function loadProviders() { try { account.providers = (await api('/api/providers')).providers || []; renderAuthProviders(); } catch {} }
function openAuth(m = 'login') { setAuthMode(m); renderAuthProviders(); $('#authModal').hidden = false; $('#authOverlay').hidden = false; setTimeout(() => $('#authEmail').focus(), 50); }
function closeAuth() { $('#authModal').hidden = true; $('#authOverlay').hidden = true; pendingView = null; }
async function loadAssets() { try { account.assets = (await api('/api/assets')).assets || []; } catch { account.assets = []; } }
function assetTargeted(a) { for (const t of state.targets) { if (a.type === 'ip') { if (t.ip === a.value) return t.host; } else if (t.host === a.value || t.host.endsWith('.' + a.value)) return t.host; } return null; }
function renderDashboard() {
  const dash = $('#dash'); if (!account.user) { dash.hidden = true; return; }
  dash.hidden = false;
  const alerts = account.alerts || [];
  const activeAlerts = alerts.filter((a) => a.active !== 0);
  const resolved = alerts.length - activeAlerts.length;
  const targetedAssets = new Set(activeAlerts.map((a) => a.asset_value));
  const totalVectors = activeAlerts.reduce((s, a) => s + (a.vectors || 0), 0);
  const underAttack = targetedAssets.size > 0;

  // posture cells
  $('#poAssets').textContent = account.assets.length;
  $('#poTargeted').textContent = targetedAssets.size;
  $('#poActive').textContent = activeAlerts.length;
  $('#poResolved').textContent = resolved;
  $('#posture').classList.toggle('alarm', underAttack);

  // status hero
  const hero = $('#dashHero');
  hero.className = 'dash-hero ' + (underAttack ? 'alarm' : (account.assets.length ? 'clear' : 'idle'));
  $('#dhIco').textContent = underAttack ? '⚠' : (account.assets.length ? '✓' : '＋');
  if (underAttack) {
    const hosts = activeAlerts.length;
    $('#dhHead').innerHTML = `${targetedAssets.size} asset${targetedAssets.size === 1 ? '' : 's'} under active attack`;
    $('#dhSub').textContent = `${totalVectors} attack vector${totalVectors === 1 ? '' : 's'} across ${hosts} target host${hosts === 1 ? '' : 's'} on the current list`;
  } else if (account.assets.length) {
    $('#dhHead').textContent = 'All clear';
    $('#dhSub').textContent = `None of your ${account.assets.length} monitored asset${account.assets.length === 1 ? '' : 's'} is on the current target list.`;
  } else {
    $('#dhHead').textContent = 'No assets monitored yet';
    $('#dhSub').textContent = 'Add a domain or IPv4 below to start watching the target list.';
  }

  // under-attack cards
  const atkPnl = $('#attackPnl');
  atkPnl.hidden = !underAttack;
  if (underAttack) {
    $('#atkCount').textContent = `(${activeAlerts.length})`;
    $('#attackList').innerHTML = activeAlerts.map((a) => {
      const chips = (a.types || '').split(',').map((t) => t.trim()).filter(Boolean)
        .map((t) => `<span class="tag ${typeCls(t)}">${esc(t)}</span>`).join('');
      return `<div class="atk-row" data-host="${esc(a.target_host)}">
        <div class="atk-main">
          <div class="atk-host">${esc(a.target_host)}</div>
          <div class="atk-meta">matches <b>${esc(a.asset_value)}</b> · IPs ${esc(a.target_ips || '—')}</div>
          <div class="atk-chips">${chips}</div>
        </div>
        <div class="atk-vec"><b>${a.vectors || 0}</b><span>vectors</span></div>
      </div>`;
    }).join('');
  }

  // attack methods across the user's active alerts
  const mPnl = $('#methodsPnl');
  const mm = new Map();
  for (const a of activeAlerts) for (const t of (a.types || '').split(',').map((x) => x.trim()).filter(Boolean)) mm.set(t, (mm.get(t) || 0) + 1);
  const rows = [...mm.entries()].map(([key, count]) => ({ key, count })).sort((x, y) => y.count - x.count).slice(0, 6);
  mPnl.hidden = rows.length === 0;
  if (rows.length) bars($('#dashMethods'), rows, (r) => `<span class="tag ${typeCls(r.key)}">${esc(r.key)}</span>`, '#ff5566');
}
function renderAssets() {
  renderDashboard();
  $('#assetCount').textContent = account.assets.length ? `(${account.assets.length})` : '';
  const el = $('#assetList');
  if (!account.assets.length) { el.innerHTML = '<div class="empty">no assets yet — add a domain or IP above</div>'; return; }
  el.innerHTML = account.assets.map((a) => { const hit = assetTargeted(a); return `<div class="asset-row"><span class="a-type">${a.type}</span><div><div class="a-val">${esc(a.value)}</div>${a.label ? `<div class="a-label">${esc(a.label)}</div>` : ''}</div><span class="a-status ${hit ? 'a-hit' : 'a-clear'}" ${hit ? `data-host="${esc(hit)}"` : ''}>${hit ? '● targeted now' : '○ clear'}</span><button class="a-del" data-del="${a.id}">×</button></div>`; }).join('');
}
async function loadAlerts() { try { const d = await api('/api/alerts'); account.alerts = d.alerts || []; account.unseen = d.unseen || 0; account.activeAlerts = d.active || 0; renderAccount(); renderBell(); } catch {} }
function renderBell() { const el = $('#bellList'); const it = account.alerts.slice(0, 6); el.innerHTML = it.length ? it.map((a) => { const active = a.active !== 0; return `<div class="bell-item ${a.seen ? '' : 'unseen'}" data-host="${esc(a.target_host)}"><div class="h">${active ? '<span class="dot live"></span>' : '<span class="dot done"></span>'}${esc(a.target_host)}</div><div class="m">${esc(a.asset_value)} · ${active ? a.vectors + ' vec · active' : 'resolved ' + timeAgo(a.resolved_at || a.last_seen) + ' ago'}</div></div>`; }).join('') : '<div class="bell-empty">no alerts yet</div>'; }
function alertRow(a) {
  const active = a.active !== 0;
  const state = active
    ? `<span class="al-badge live">● ACTIVE</span><span class="alert-time">started ${timeAgo(a.first_matched)} ago</span>`
    : `<span class="al-badge done">✓ RESOLVED</span><span class="alert-time">left list ${timeAgo(a.resolved_at || a.last_seen)} ago</span>`;
  return `<div class="alert-row ${a.seen ? '' : 'unseen'} ${active ? '' : 'resolved'}" data-host="${esc(a.target_host)}">
    <div class="alert-ico">${active ? '◉' : '○'}</div>
    <div class="alert-b">
      <div class="alert-t">asset <b>${esc(a.asset_value)}</b><span class="arw">→</span><span class="host">${esc(a.target_host)}</span></div>
      <div class="alert-m">${a.vectors} vectors · ${esc(a.types || '')} · IPs ${esc(a.target_ips || '')}</div>
    </div>
    <div class="alert-r">${state}</div>
  </div>`;
}
function renderAlerts() {
  const active = account.alerts.filter((a) => a.active !== 0).length;
  $('#alertsCount').textContent = account.alerts.length ? `(${active} active · ${account.alerts.length} total)` : '';
  const el = $('#alertsList');
  el.innerHTML = account.alerts.length ? account.alerts.map(alertRow).join('') : '<div class="empty">no alerts yet — when a monitored asset hits the list it shows here</div>';
}
function loadSettingsForm() { const u = account.user; if (!u) return; $('#setWebhook').value = u.webhook_url || ''; $('#setEmail').checked = !!u.email_alerts; $('#setInapp').checked = !!u.inapp_alerts; const em = $('#setEmail'), h = $('#emailHint'); if (!account.emailConfigured) { em.disabled = true; h.textContent = '(server SMTP off — webhook/in-app still work)'; } else { em.disabled = false; h.textContent = ''; } }
function openSettings() { if (!account.user) return; $('#setAcctEmail').textContent = account.user.email; loadSettingsForm(); $('#saveOk').hidden = true; $('#settingsModal').hidden = false; $('#settingsOverlay').hidden = false; $('#acctMenu').hidden = true; }
function closeSettings() { $('#settingsModal').hidden = true; $('#settingsOverlay').hidden = true; }

// promise-based confirm dialog (in-app styled)
let confirmResolve = null;
function askConfirm({ title = 'Are you sure?', msg = '', yes = 'DELETE' }) {
  $('#confirmTitle').textContent = title; $('#confirmMsg').innerHTML = msg; $('#confirmYes').textContent = yes;
  $('#confirmModal').hidden = false; $('#confirmOverlay').hidden = false;
  setTimeout(() => $('#confirmYes').focus(), 50);
  return new Promise((res) => { confirmResolve = res; });
}
function closeConfirm(val) { $('#confirmModal').hidden = true; $('#confirmOverlay').hidden = true; if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(val); } }
async function markSeen() { try { await api('/api/alerts/seen', { method: 'POST' }); account.unseen = 0; account.alerts = account.alerts.map((a) => ({ ...a, seen: 1 })); renderAccount(); renderBell(); if (state.view === 'alerts') renderAlerts(); } catch {} }

// ---------- events ----------
function switchView(v) {
  if ((v === 'assets' || v === 'alerts') && !account.user) { pendingView = v; openAuth('login'); return; }
  // grep only applies to list views — clear a stale term when leaving them so it can't filter invisibly
  if (v !== 'hosts' && v !== 'targets' && state.search) { state.search = ''; $('#search').value = ''; $('#searchClear').hidden = true; }
  state.view = v;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === v));
  $$('.view').forEach((s) => { s.hidden = s.id !== `view-${v}`; });
  render();
}
$$('.nav-item').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));
$('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
// re-run a one-shot fade on the visible list so a filter change is felt, not just applied
function flashActiveList() {
  const sel = state.view === 'targets' ? '#targetsTable tbody' : (state.view === 'hosts' ? '#hostAllTbl tbody' : null);
  if (!sel) return; const el = $(sel); if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
const applyFilter = () => { render(); flashActiveList(); };
$('#searchClear').addEventListener('click', () => { state.search = ''; $('#search').value = ''; applyFilter(); });
$('#filterType').addEventListener('change', (e) => { state.filterType = e.target.value; applyFilter(); });
$('#filterCountry').addEventListener('change', (e) => { state.filterCountry = e.target.value; applyFilter(); });
$('#filterMethod').addEventListener('change', (e) => { state.filterMethod = e.target.value; applyFilter(); });
$('#filterPort').addEventListener('change', (e) => { state.filterPort = e.target.value; applyFilter(); });
// drill from a BY COUNTRY / ATTACK METHODS bar into the live feed, filtered
function drillToFeed(kind, value) {
  state.filterType = ''; state.filterCountry = ''; state.filterPort = ''; state.filterMethod = ''; state.filterNew = false;
  $$('#filterNew .seg').forEach((s) => s.classList.toggle('on', s.dataset.new === '0'));
  if (kind === 'country') state.filterCountry = value; else if (kind === 'method') state.filterMethod = value;
  switchView('targets'); // renders the feed + syncs the toolbar selects to state
}
$('#countryBars').addEventListener('click', (e) => { const b = e.target.closest('.bar[data-key]'); if (b) drillToFeed('country', b.dataset.key); });
$('#methodBars').addEventListener('click', (e) => { const b = e.target.closest('.bar[data-key]'); if (b) drillToFeed('method', b.dataset.key); });
$('#filterNew').addEventListener('click', (e) => {
  const seg = e.target.closest('.seg'); if (!seg) return;
  state.filterNew = seg.dataset.new === '1';
  $$('#filterNew .seg').forEach((s) => s.classList.toggle('on', s === seg));
  applyFilter();
});
$('#refreshBtn').addEventListener('click', () => load());
document.addEventListener('click', (e) => {
  const g = e.target.closest('.seg[data-geo]'); if (g) { e.stopPropagation(); state.geoMode = g.dataset.geo; render(); return; }
  const hm = e.target.closest('.seg[data-hostmode]'); if (hm) { e.stopPropagation(); state.hostsMode = hm.dataset.hostmode; hostsAllKey = null; render(); }
});
// ---- custom in-style date picker ----
const calMin = () => (state.stats && state.stats.historyStart) || '2023-06-01';
const calMax = () => ((state.stats && state.stats.fetchedAt) || new Date().toISOString()).slice(0, 10);
const setDateField = (field, val) => { const b = $('#period' + (field === 'from' ? 'From' : 'To')); b.dataset.value = val; b.textContent = val; };
const getDateField = (field) => $('#period' + (field === 'from' ? 'From' : 'To')).dataset.value || '';
const cal = { field: null, y: 0, m: 0 };
function openCal(field, anchor) {
  cal.field = field;
  const cur = getDateField(field) || (field === 'from' ? calMin() : calMax());
  const d = new Date(cur + 'T00:00:00Z'); cal.y = d.getUTCFullYear(); cal.m = d.getUTCMonth();
  renderCal();
  const pop = $('#calPop'), a = anchor.getBoundingClientRect(), host = $('#periodCustom').getBoundingClientRect();
  pop.style.left = (a.left - host.left) + 'px';
  pop.hidden = false;
  $$('.date-in').forEach((b) => b.classList.toggle('open', b === anchor));
}
function closeCal() { $('#calPop').hidden = true; cal.field = null; $$('.date-in').forEach((b) => b.classList.remove('open')); }
function renderCal() {
  const min = calMin(), max = calMax();
  const first = new Date(Date.UTC(cal.y, cal.m, 1));
  const startDow = (first.getUTCDay() + 6) % 7; // Mon=0
  const days = new Date(Date.UTC(cal.y, cal.m + 1, 0)).getUTCDate();
  const sel = getDateField(cal.field);
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += '<span class="cal-d empty"></span>';
  for (let d = 1; d <= days; d++) {
    const iso = `${cal.y}-${String(cal.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dis = iso < min || iso > max;
    const cls = 'cal-d' + (dis ? ' dis' : '') + (iso === sel ? ' sel' : '') + (iso === max ? ' today' : '');
    cells += `<button type="button" class="${cls}" ${dis ? 'disabled' : ''} data-iso="${iso}">${d}</button>`;
  }
  const prevOk = `${cal.y}-${String(cal.m + 1).padStart(2, '0')}-01` > min;
  const nextOk = new Date(Date.UTC(cal.y, cal.m + 1, 1)).toISOString().slice(0, 10) <= max;
  $('#calPop').innerHTML = `
    <div class="cal-head">
      <button type="button" class="cal-nav" data-nav="-1" ${prevOk ? '' : 'disabled'}>‹</button>
      <span class="cal-title mono">${MONTHS[cal.m]} ${cal.y}</span>
      <button type="button" class="cal-nav" data-nav="1" ${nextOk ? '' : 'disabled'}>›</button>
    </div>
    <div class="cal-dow mono">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>`;
}
$('#calPop').addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { const step = Number(nav.dataset.nav); cal.m += step; if (cal.m < 0) { cal.m = 11; cal.y--; } if (cal.m > 11) { cal.m = 0; cal.y++; } renderCal(); return; }
  const day = e.target.closest('.cal-d[data-iso]');
  if (day) { setDateField(cal.field, day.dataset.iso); closeCal(); }
});
document.addEventListener('click', (e) => {
  if ($('#calPop').hidden) return;
  if (!e.target.closest('#calPop') && !e.target.closest('.date-in')) closeCal();
});
$('#periodFrom').addEventListener('click', (e) => { e.stopPropagation(); openCal('from', e.currentTarget); });
$('#periodTo').addEventListener('click', (e) => { e.stopPropagation(); openCal('to', e.currentTarget); });

// period switcher
$('#periodSeg').addEventListener('click', (e) => {
  const seg = e.target.closest('.seg[data-range]'); if (!seg) return;
  PERIOD.range = seg.dataset.range;
  $$('#periodSeg .seg').forEach((s) => s.classList.toggle('on', s === seg));
  const custom = PERIOD.range === 'custom';
  $('#periodCustom').hidden = !custom;
  closeCal();
  if (custom) {
    if (!getDateField('from')) setDateField('from', PERIOD.from || calMin());
    if (!getDateField('to')) setDateField('to', PERIOD.to || calMax());
  } else {
    persistPeriod();
    loadPeriod();
  }
});
$('#periodApply').addEventListener('click', () => {
  const f = getDateField('from'), t = getDateField('to');
  if (!f || !t) return;
  PERIOD.from = f; PERIOD.to = t; PERIOD.range = 'custom';
  persistPeriod();
  loadPeriod();
});

// map marker hover tooltip
(() => {
  const box = $('#mapBox'), tip = $('#mapTip'), map = $('#map');
  if (!box || !tip || !map) return;
  map.addEventListener('mouseover', (e) => {
    const mk = e.target.closest('.mk'); if (!mk) return;
    tip.innerHTML = `<div class="tt-h">${flag(mk.dataset.code)} ${esc(mk.dataset.country)}</div>
      <div class="tt-r"><span>hosts targeted</span><b>${mk.dataset.hosts}</b></div>
      <div class="tt-r"><span>target-requests</span><b>${mk.dataset.targets}</b></div>
      <div class="tt-hint">open the feed below for host-level detail</div>`;
    const r = mk.getBoundingClientRect(), b = box.getBoundingClientRect();
    tip.style.left = (r.left + r.width / 2 - b.left) + 'px';
    tip.style.top = (r.top - b.top) + 'px';
    tip.hidden = false;
  });
  map.addEventListener('mouseout', (e) => { if (e.target.closest('.mk')) tip.hidden = true; });
})();

// interactive trend chart (crosshair + tooltip)
(() => {
  const chart = $('#trendChart'), tip = $('#trendTip');
  if (!chart || !tip) return;
  chart.addEventListener('mousemove', (e) => {
    const g = trendGeom; if (!g) return;
    const svg = chart.querySelector('svg'); if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / g.W;
    const vx = (e.clientX - rect.left) / scale;
    let i = Math.round(((vx - g.pad) / (g.W - 2 * g.pad)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const d = g.trend[i], cx = g.xAt(i), cy = g.yAt(d.count);
    const cross = svg.querySelector('#tCross'), dot = svg.querySelector('#tDot');
    if (cross) { cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('opacity', '0.6'); }
    if (dot) { dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('opacity', '1'); }
    tip.innerHTML = `<div class="tt-day">${d.day}</div><div class="tt-cnt"><b>${d.count}</b> targets · ${d.hosts} hosts · ${d.ips} IPs</div>`;
    tip.hidden = false;
    tip.style.left = (cx * scale) + 'px';
    tip.style.top = Math.max(2, cy * scale - 8) + 'px';
  });
  chart.addEventListener('mouseleave', () => {
    tip.hidden = true;
    const svg = chart.querySelector('svg'); if (!svg) return;
    const c = svg.querySelector('#tCross'), d = svg.querySelector('#tDot');
    if (c) c.setAttribute('opacity', '0'); if (d) d.setAttribute('opacity', '0');
  });
  // re-fit the trend to the container width on resize (keeps it crisp, height fixed)
  let rzT; window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { if (state.view === 'ops' && lastTrend.length) renderTrend(chart, lastTrend, false); }, 160); });
})();
$('.sortbar').addEventListener('click', (e) => { const p = e.target.closest('.pill'); if (!p) return; state.hSort = p.dataset.hsort; $$('.sortbar .pill').forEach((x) => x.classList.toggle('active', x === p)); render(); });
$$('#targetsTable thead th').forEach((th) => th.addEventListener('click', () => { const k = th.dataset.sort; if (!k) return; if (state.tSortKey === k) state.tSortDir = state.tSortDir === 'asc' ? 'desc' : 'asc'; else { state.tSortKey = k; state.tSortDir = 'asc'; } render(); }));
$$('#opsFeed thead th').forEach((th) => th.addEventListener('click', () => { const k = th.dataset.sort; if (!k) return; if (state.fSortKey === k) state.fSortDir = state.fSortDir === 'asc' ? 'desc' : 'asc'; else { state.fSortKey = k; state.fSortDir = 'desc'; } render(); }));

$('#signinBtn').addEventListener('click', () => openAuth('login'));
$('#authClose').addEventListener('click', closeAuth);
$('#authOverlay').addEventListener('click', closeAuth);
$('#settingsBtn').addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
$('#settingsClose').addEventListener('click', closeSettings);
$('#settingsOverlay').addEventListener('click', closeSettings);
$('#confirmCancel').addEventListener('click', () => closeConfirm(false));
$('#confirmYes').addEventListener('click', () => closeConfirm(true));
$('#confirmOverlay').addEventListener('click', () => closeConfirm(false));
$$('.auth-tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
$('#authForm').addEventListener('submit', async (e) => { e.preventDefault(); const email = $('#authEmail').value.trim(), password = $('#authPass').value; try { await api('/api/' + (authMode === 'login' ? 'login' : 'register'), { method: 'POST', body: JSON.stringify({ email, password }) }); const want = pendingView; closeAuth(); $('#authForm').reset(); await loadMe(); toast(authMode === 'login' ? 'signed in' : 'account created'); switchView(want || 'assets'); } catch (err) { const el = $('#authErr'); el.textContent = err.message; el.hidden = false; } });
$('#logoutBtn').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } catch {} account.user = null; account.assets = []; account.alerts = []; account.unseen = 0; renderAccount(); $('#acctMenu').hidden = true; if (state.view === 'assets' || state.view === 'alerts') switchView('ops'); toast('logged out'); });
$('#bellBtn').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#bellMenu'); m.hidden = !m.hidden; $('#acctMenu').hidden = true; $('#exportMenu').hidden = true; });
$('#acctBtn').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#acctMenu'); m.hidden = !m.hidden; $('#bellMenu').hidden = true; $('#exportMenu').hidden = true; });
$('#bellSeen').addEventListener('click', (e) => { e.stopPropagation(); markSeen(); });
$('#alertsSeen').addEventListener('click', markSeen);
$('#addAssetForm').addEventListener('submit', async (e) => { e.preventDefault(); const value = $('#assetValue').value.trim(), label = $('#assetLabel').value.trim(); const err = $('#assetErr'); err.hidden = true; try { const d = await api('/api/assets', { method: 'POST', body: JSON.stringify({ value, label }) }); account.assets = d.assets || []; $('#addAssetForm').reset(); await loadAlerts(); renderAssets(); toast('asset added — monitoring active'); } catch (e2) { err.textContent = e2.message; err.hidden = false; } });
$('#saveSettings').addEventListener('click', async () => { try { const body = { webhook_url: $('#setWebhook').value.trim(), email_alerts: $('#setEmail').checked, inapp_alerts: $('#setInapp').checked }; await api('/api/settings', { method: 'POST', body: JSON.stringify(body) }); Object.assign(account.user, body); const ok = $('#saveOk'); ok.hidden = false; setTimeout(() => (ok.hidden = true), 1600); } catch (err) { toast(err.message); } });

$('#exportBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#exportMenu').hidden = !$('#exportMenu').hidden; $('#bellMenu').hidden = true; $('#acctMenu').hidden = true; });
document.addEventListener('click', () => { $('#exportMenu').hidden = true; $('#bellMenu').hidden = true; $('#acctMenu').hidden = true; });
document.addEventListener('click', async (e) => {
  const ex = e.target.closest('[data-export]'); if (ex) { e.stopPropagation(); exportData(ex.dataset.export); return; }
  const cp = e.target.closest('[data-copy]'); if (cp) { e.stopPropagation(); copy(cp.dataset.copy, 'value'); return; }
  const del = e.target.closest('[data-del]'); if (del) {
    const asset = account.assets.find((a) => String(a.id) === del.dataset.del);
    const ok = await askConfirm({ title: 'Remove asset?', msg: `Stop monitoring <b>${esc(asset ? asset.value : 'this asset')}</b>? Any alerts for it are removed too.`, yes: 'REMOVE' });
    if (!ok) return;
    try { const d = await api('/api/assets/' + del.dataset.del, { method: 'DELETE' }); account.assets = d.assets || []; renderAssets(); loadAlerts(); toast('asset removed'); } catch {}
    return;
  }
  const mv = e.target.closest('.menu-list [data-view], .bell-all[data-view]'); if (mv) { switchView(mv.dataset.view); return; }
  const he = e.target.closest('[data-host]'); if (he) openDrawer(he.dataset.host);
});
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerOverlay').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#confirmModal').hidden) { closeConfirm(false); return; } closeDrawer(); closeSettings(); closeAuth(); } if (e.key === '/' && document.activeElement !== $('#search') && document.activeElement !== $('#checkInput')) { e.preventDefault(); $('#search').focus(); } });

// ---------- boot ----------
tick(); setInterval(tick, 1000);
restorePeriod(); // restore the saved/shared time window before the first render
loadWorld();
loadProviders();
load(); loadMe();
setInterval(() => { load(); if (account.user) loadAlerts(); }, REFRESH_MS);
