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
    let all = '';
    for (const f of gj.features) { const d = geomToPath(f.g); all += d; if (f.c) world.byCode.set(f.c, (world.byCode.get(f.c) || '') + d); }
    world.all = all; world.loaded = true;
    if (state.view === 'ops' && state.stats) renderMap(state.stats.byCountry);
  } catch (e) { console.error('world map load failed', e.message); }
}

const state = { targets: [], stats: null, view: 'ops', search: '', filterType: '', filterCountry: '', filterPort: '', filterNew: false, tSortKey: 'host', tSortDir: 'asc', fSortKey: 'targetCount', fSortDir: 'desc', hSort: 'targetCount' };

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function flag(cc) { if (!cc || cc.length !== 2 || cc === 'XX') return '🏴'; return cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0))); }
function timeAgo(iso) { if (!iso) return '—'; const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`; }
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
function tick() { const d = new Date(); $('#clock').textContent = d.toISOString().slice(0, 16).replace('T', ' ') + 'Z'; }

// ---------- filtering ----------
function filtered() {
  const q = state.search.toLowerCase();
  return state.targets.filter((t) => {
    if (state.filterType && t.type !== state.filterType) return false;
    if (state.filterCountry && t.country !== state.filterCountry) return false;
    if (state.filterPort && String(t.port) !== state.filterPort) return false;
    if (state.filterNew && !isNew(t)) return false;
    if (q) { const h = `${t.host} ${t.ip} ${t.path} ${t.org} ${t.country} ${t.method} ${t.type}`.toLowerCase(); if (!h.includes(q)) return false; }
    return true;
  });
}
function groupHosts(rows) {
  const m = new Map();
  for (const t of rows) {
    let h = m.get(t.host);
    if (!h) { h = { host: t.host, country: t.country, countryCode: t.countryCode, city: t.city, org: t.org, ips: new Set(), types: {}, methods: new Set(), ports: new Set(), paths: new Set(), ssl: false, targetCount: 0, firstSeen: t.hostFirstSeen, vectors: [] }; m.set(t.host, h); }
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
  $('#toolbar').style.display = (state.view === 'ops' || state.view === 'hosts' || state.view === 'targets') ? '' : 'none';
  if (state.view === 'ops') renderOps(rows);
  if (state.view === 'hosts') renderHosts(rows);
  if (state.view === 'targets') renderTargets(rows);
  if (state.view === 'assets') renderAssets();
  if (state.view === 'alerts') renderAlerts();
}

function renderOps(rows) {
  const s = state.stats; if (!s || !s.totals) return;
  const T = s.totals;
  const delta = s.yesterdayCount != null ? T.targets - s.yesterdayCount : null;
  const dStr = delta == null ? '' : (delta === 0 ? '±0 vs yday' : (delta > 0 ? `▲ ${delta} vs yday` : `▼ ${-delta} vs yday`));
  const tiles = [
    { l: 'TARGETS', v: T.targets, d: dStr, dc: delta > 0 ? 'up' : 'down' },
    { l: 'HOSTS', v: T.hosts },
    { l: 'UNIQUE IPS', v: T.ips },
    { l: 'COUNTRIES', v: T.countries },
    { l: 'NEW / 24H', v: T.newHosts24h, d: T.newHosts24h ? 'fresh hosts' : '', dc: 'up' },
    { l: 'WAVE SINCE', v: (s.waveSince || '—'), sm: true, d: 'dominant onset' },
  ];
  $('#tiles').innerHTML = tiles.map((c) => `<div class="tile"><div class="l">${c.l}</div><div class="v ${c.sm ? 'sm' : ''}">${c.v}</div>${c.d ? `<div class="d ${c.dc || ''}">${c.d}</div>` : ''}</div>`).join('');

  renderMap(s.byCountry);
  $('#mapMeta').textContent = `${T.countries} countries · ${T.hosts} hosts`;
  bars($('#countryBars'), s.byCountry.slice(0, 6), (r) => `${flag(codeFor(r.key))} ${esc(r.key)}`, '#34e0d0');
  bars($('#methodBars'), s.byMethod.slice(0, 6), (r) => esc(r.key || '—'), '#f5b301');

  renderOpsFeed(rows);
  renderTrend($('#trendChart'), s.trend || []);
  $('#trendMeta').textContent = s.trendPeak?.day ? `peak ${s.trendPeak.count} · avg ${s.trendAvg}` : '';
  $('#iocIps').textContent = new Set(rows.map((r) => r.ip).filter(Boolean)).size;
  $('#iocPaths').textContent = new Set(rows.map((r) => r.path).filter(Boolean)).size;
}

function bars(el, rows, labelFn, color) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  el.innerHTML = rows.length ? rows.map((r) => `<div class="bar"><span class="n" title="${esc(r.key)}">${labelFn(r)}</span><span class="tk"><span class="fl" style="width:${(r.count / max * 100).toFixed(1)}%;background:${color}"></span></span><span class="p">${r.count}</span></div>`).join('') : '<div class="empty">no data</div>';
}

function renderMap(byCountry) {
  const W = MAP_W, H = MAP_H;
  const proj = (lng, lat) => [(lng + 180) / 360 * W, (90 - lat) / 180 * H];
  const max = Math.max(1, ...byCountry.map((c) => c.count));
  const targetedCodes = new Set(byCountry.map((c) => codeFor(c.key)).filter(Boolean));
  const hi = [...targetedCodes].map((cc) => world.byCode.get(cc)).filter(Boolean)
    .map((d) => `<path d="${d}" fill="rgba(255,85,102,0.14)" stroke="#8a3a45" stroke-width="0.5"/>`).join('');
  const markers = byCountry.map((c, i) => {
    const cc = codeFor(c.key); const ce = CENTROID[cc]; if (!ce) return '';
    const [x, y] = proj(ce[0], ce[1]);
    const r = 5 + Math.sqrt(c.count / max) * 22;
    return `${i === 0 ? `<circle cx="${x}" cy="${y}" r="${r}" fill="#ff5566" opacity="0.12"><animate attributeName="r" values="${r};${r + 16};${r}" dur="2.6s" repeatCount="indefinite"/></circle>` : ''}
      <circle cx="${x}" cy="${y}" r="${r}" fill="rgba(255,85,102,0.18)" stroke="#ff5566" stroke-width="1"/>
      <circle cx="${x}" cy="${y}" r="3" fill="#ff5566"/>
      <text x="${x}" y="${y - r - 6}" text-anchor="middle" fill="#dbe6f2" font-size="16" font-family="JetBrains Mono, monospace">${flag(cc)} ${c.count}</text>`;
  }).join('');
  const land = world.loaded
    ? `<path d="${world.all}" fill="#0e1a2a" stroke="#22384f" stroke-width="0.35"/>${hi}`
    : '';
  // crop to the populated latitude band (~ -60..85) so the ocean isn't mostly empty
  const y0 = (90 - 84) / 180 * H, y1 = (90 - -58) / 180 * H;
  $('#map').innerHTML = `<svg viewBox="0 ${y0.toFixed(0)} ${W} ${(y1 - y0).toFixed(0)}" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#070d16"/>
    ${land}
    ${markers}
  </svg>`;
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
      <td class="cc">${h.ports.join(' ')}</td>
      <td class="cc">${timeAgo(h.firstSeen)} ago</td>
    </tr>`;
  }).join('');
  markSort('#opsFeed', state.fSortKey, state.fSortDir);
}

function renderTrend(el, trend) {
  if (!trend.length) { el.innerHTML = '<div class="empty">history builds as the monitor runs…</div>'; return; }
  const W = 620, H = 150, pad = 30, bot = 22;
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
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
    <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3ddc84" stop-opacity="0.28"/><stop offset="100%" stop-color="#3ddc84" stop-opacity="0"/></linearGradient></defs>
    ${yt}${xl}
    <polygon points="${area}" fill="url(#tg)"/>
    <polyline points="${pts}" fill="none" stroke="#3ddc84" stroke-width="${many ? 1.4 : 2}"/>
    <circle cx="${px}" cy="${y(peak.count)}" r="3" fill="#ff5566"><title>peak ${peak.day}: ${peak.count}</title></circle>
    <text x="${W - pad}" y="11" text-anchor="end" fill="#c4d0de" font-size="10">last ${last.count}</text>
  </svg>`;
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
      el.className = 'verdict clear';
      el.innerHTML = `<div class="vhead">○ NOT on the current list</div><div class="vrow"><b>${esc(r.query)}</b> (${r.type}) is not among today's ${state.targets.length} targets. Add it to monitoring to catch future waves.</div>`;
    }
  } catch (err) { el.hidden = false; el.className = 'verdict'; el.innerHTML = `<div class="vrow">check failed: ${esc(err.message)}</div>`; }
});

// ---------- hosts view ----------
function renderHosts(rows) {
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
      <div class="hc-surf"><span><b>${h.ips.length}</b> IP</span><span><b>${h.ports.length}</b> ports</span><span><b>${h.paths.length}</b> paths</span><span>${h.ssl ? '🔒' : 'no ssl'}</span></div>
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
    <td class="${t.use_ssl ? 'ssl1' : 'ssl0'}">${t.use_ssl ? '🔒' : '—'}</td><td class="path">${esc(t.path || '—')}</td></tr>`).join('');
  markSort('#targetsTable', state.tSortKey, state.tSortDir);
}
function markSort(sel, key, dir) { $$(`${sel} thead th`).forEach((h) => h.classList.remove('sa', 'sd')); const th = $(`${sel} thead th[data-sort="${key}"]`); if (th) th.classList.add(dir === 'asc' ? 'sa' : 'sd'); }

// ---------- drawer ----------
function openDrawer(host) {
  const rows = state.targets.filter((t) => t.host === host); if (!rows.length) return;
  const h = groupHosts(rows)[0];
  const proto = h.ssl ? 'https' : 'http';
  $('#drawerHost').innerHTML = `${esc(h.host)} <a href="${proto}://${esc(h.host)}" target="_blank" rel="noopener">↗</a>`;
  $('#drawerSub').textContent = `${flag(h.countryCode)} ${h.country}${h.city ? ' · ' + h.city : ''}${h.org ? ' · ' + h.org : ''}`;
  const facts = [['vectors', h.targetCount], ['unique IPs', h.ips.length], ['ports', h.ports.join(', ') || '—'], ['first seen', timeAgo(h.firstSeen) + ' ago']];
  const paths = h.paths.filter(Boolean);
  $('#drawerBody').innerHTML = `
    <div class="facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
    <div class="dsec"><h3>IP ADDRESSES <button class="mini-copy" data-copy="${esc(h.ips.join('\n'))}">copy all</button></h3>${h.ips.map((ip) => `<div class="ioc-row"><span class="val">${esc(ip)}</span><button class="mini-copy" data-copy="${esc(ip)}">copy</button></div>`).join('')}</div>
    <div class="dsec"><h3>TARGETED PATHS ${paths.length ? `<button class="mini-copy" data-copy="${esc(paths.join('\n'))}">copy all</button>` : ''}</h3>${paths.length ? paths.map((p) => `<div class="ioc-row"><span class="val" title="${esc(p)}">${esc(p)}</span><button class="mini-copy" data-copy="${esc(p)}">copy</button></div>`).join('') : '<div class="empty">no path-based vectors</div>'}</div>
    <div class="dsec"><h3>ALL VECTORS (${h.vectors.length})</h3><table class="vec-tbl"><thead><tr><th>type</th><th>method</th><th>port</th><th>ssl</th><th>path</th></tr></thead><tbody>${h.vectors.map((v) => `<tr><td><span class="tag ${typeCls(v.type)}">${esc(v.type)}</span></td><td class="cc">${esc(v.method || '—')}</td><td class="cc">${esc(v.port)}</td><td>${v.use_ssl ? '🔒' : '—'}</td><td class="p">${esc(v.path || '—')}</td></tr>`).join('')}</tbody></table></div>`;
  $('#drawer').hidden = false; $('#drawerOverlay').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawerOverlay').hidden = true; }

// ---------- export ----------
function exportData(kind) {
  const rows = filtered();
  if (kind === 'json') download('ddosia-targets.json', JSON.stringify(rows, null, 2), 'application/json');
  else if (kind === 'csv') { const cols = ['host', 'ip', 'country', 'city', 'org', 'type', 'method', 'port', 'use_ssl', 'path']; const e = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`; download('ddosia-targets.csv', [cols.join(','), ...rows.map((r) => cols.map((c) => e(r[c])).join(','))].join('\n'), 'text/csv'); }
  else if (kind === 'ips') copy([...new Set(rows.map((r) => r.ip).filter(Boolean))].join('\n'), 'IPs');
  else if (kind === 'paths') copy([...new Set(rows.map((r) => r.path).filter(Boolean))].join('\n'), 'Paths');
  $('#exportMenu').hidden = true;
}

// ---------- filters ----------
function syncFilters() {
  const s = state.stats; if (!s) return;
  const fill = (sel, items, all, fmt) => { const cur = sel.value; sel.innerHTML = [`<option value="">${all}</option>`].concat(items.map((r) => `<option value="${esc(r.key)}">${fmt(r)}</option>`)).join(''); sel.value = cur; };
  fill($('#filterType'), s.byType, 'type: all', (r) => `${r.key} (${r.count})`);
  fill($('#filterCountry'), s.byCountry, 'country: all', (r) => `${r.key} (${r.count})`);
  fill($('#filterPort'), s.byPort, 'port: all', (r) => `${r.key} (${r.count})`);
}

// ==================== account / auth / assets / alerts ====================
const account = { user: null, unseen: 0, emailConfigured: false, assets: [], alerts: [] };
let pendingView = null;
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
function openAuth(m = 'login') { setAuthMode(m); $('#authModal').hidden = false; $('#authOverlay').hidden = false; setTimeout(() => $('#authEmail').focus(), 50); }
function closeAuth() { $('#authModal').hidden = true; $('#authOverlay').hidden = true; pendingView = null; }
async function loadAssets() { try { account.assets = (await api('/api/assets')).assets || []; } catch { account.assets = []; } }
function assetTargeted(a) { for (const t of state.targets) { if (a.type === 'ip') { if (t.ip === a.value) return t.host; } else if (t.host === a.value || t.host.endsWith('.' + a.value)) return t.host; } return null; }
function renderAssets() {
  $('#assetCount').textContent = account.assets.length ? `(${account.assets.length})` : '';
  const el = $('#assetList');
  if (!account.assets.length) { el.innerHTML = '<div class="empty">no assets yet — add a domain or IP above</div>'; return; }
  el.innerHTML = account.assets.map((a) => { const hit = assetTargeted(a); return `<div class="asset-row"><span class="a-type">${a.type}</span><div><div class="a-val">${esc(a.value)}</div>${a.label ? `<div class="a-label">${esc(a.label)}</div>` : ''}</div><span class="a-status ${hit ? 'a-hit' : 'a-clear'}" ${hit ? `data-host="${esc(hit)}"` : ''}>${hit ? '● targeted now' : '○ clear'}</span><button class="a-del" data-del="${a.id}">×</button></div>`; }).join('');
}
async function loadAlerts() { try { const d = await api('/api/alerts'); account.alerts = d.alerts || []; account.unseen = d.unseen || 0; renderAccount(); renderBell(); } catch {} }
function renderBell() { const el = $('#bellList'); const it = account.alerts.slice(0, 6); el.innerHTML = it.length ? it.map((a) => `<div class="bell-item ${a.seen ? '' : 'unseen'}" data-host="${esc(a.target_host)}"><div class="h">${esc(a.target_host)}</div><div class="m">${esc(a.asset_value)} · ${a.vectors} vec · ${timeAgo(a.first_matched)} ago</div></div>`).join('') : '<div class="bell-empty">no alerts yet</div>'; }
function renderAlerts() {
  if (account.user) loadSettingsForm();
  $('#alertsCount').textContent = account.alerts.length ? `(${account.alerts.length})` : '';
  const el = $('#alertsList');
  el.innerHTML = account.alerts.length ? account.alerts.map((a) => `<div class="alert-row ${a.seen ? '' : 'unseen'}"><div class="alert-ico">◎</div><div class="alert-b"><div class="alert-t">asset <b>${esc(a.asset_value)}</b><span class="arw">→</span><span class="host" data-host="${esc(a.target_host)}">${esc(a.target_host)}</span></div><div class="alert-m">${a.vectors} vectors · ${esc(a.types || '')} · IPs ${esc(a.target_ips || '')}</div></div><div class="alert-time">${timeAgo(a.first_matched)} ago</div></div>`).join('') : '<div class="empty">no alerts yet — when a monitored asset hits the list it shows here</div>';
}
function loadSettingsForm() { const u = account.user; if (!u) return; $('#setWebhook').value = u.webhook_url || ''; $('#setEmail').checked = !!u.email_alerts; $('#setInapp').checked = !!u.inapp_alerts; const em = $('#setEmail'), h = $('#emailHint'); if (!account.emailConfigured) { em.disabled = true; h.textContent = '(server SMTP off — webhook/in-app still work)'; } else { em.disabled = false; h.textContent = ''; } }
async function markSeen() { try { await api('/api/alerts/seen', { method: 'POST' }); account.unseen = 0; account.alerts = account.alerts.map((a) => ({ ...a, seen: 1 })); renderAccount(); renderBell(); if (state.view === 'alerts') renderAlerts(); } catch {} }

// ---------- events ----------
function switchView(v) {
  if ((v === 'assets' || v === 'alerts') && !account.user) { pendingView = v; openAuth('login'); return; }
  state.view = v;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === v));
  $$('.view').forEach((s) => { s.hidden = s.id !== `view-${v}`; });
  render();
}
$$('.nav-item').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));
$('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
$('#searchClear').addEventListener('click', () => { state.search = ''; $('#search').value = ''; render(); });
$('#filterType').addEventListener('change', (e) => { state.filterType = e.target.value; render(); });
$('#filterCountry').addEventListener('change', (e) => { state.filterCountry = e.target.value; render(); });
$('#filterPort').addEventListener('change', (e) => { state.filterPort = e.target.value; render(); });
$('#filterNew').addEventListener('change', (e) => { state.filterNew = e.target.checked; render(); });
$('#refreshBtn').addEventListener('click', () => load());
$('.sortbar').addEventListener('click', (e) => { const p = e.target.closest('.pill'); if (!p) return; state.hSort = p.dataset.hsort; $$('.sortbar .pill').forEach((x) => x.classList.toggle('active', x === p)); render(); });
$$('#targetsTable thead th').forEach((th) => th.addEventListener('click', () => { const k = th.dataset.sort; if (!k) return; if (state.tSortKey === k) state.tSortDir = state.tSortDir === 'asc' ? 'desc' : 'asc'; else { state.tSortKey = k; state.tSortDir = 'asc'; } render(); }));
$$('#opsFeed thead th').forEach((th) => th.addEventListener('click', () => { const k = th.dataset.sort; if (!k) return; if (state.fSortKey === k) state.fSortDir = state.fSortDir === 'asc' ? 'desc' : 'asc'; else { state.fSortKey = k; state.fSortDir = 'desc'; } render(); }));

$('#signinBtn').addEventListener('click', () => openAuth('login'));
$('#authClose').addEventListener('click', closeAuth);
$('#authOverlay').addEventListener('click', closeAuth);
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
  const del = e.target.closest('[data-del]'); if (del) { try { const d = await api('/api/assets/' + del.dataset.del, { method: 'DELETE' }); account.assets = d.assets || []; renderAssets(); } catch {} return; }
  const mv = e.target.closest('.menu-list [data-view], .bell-all[data-view]'); if (mv) { switchView(mv.dataset.view); return; }
  const he = e.target.closest('[data-host]'); if (he) openDrawer(he.dataset.host);
});
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerOverlay').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); if (e.key === '/' && document.activeElement !== $('#search') && document.activeElement !== $('#checkInput')) { e.preventDefault(); $('#search').focus(); } });

// ---------- boot ----------
tick(); setInterval(tick, 1000);
loadWorld();
load(); loadMe();
setInterval(() => { load(); if (account.user) loadAlerts(); }, REFRESH_MS);
