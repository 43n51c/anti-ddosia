// anti-DDoSia — frontend (analyst dashboard)
'use strict';

const REFRESH_MS = 60_000;
const DAY = 24 * 3600 * 1000;

const state = {
  targets: [],
  stats: null,
  view: 'overview',
  search: '',
  filterType: '',
  filterCountry: '',
  filterPort: '',
  filterNew: false,
  tSortKey: 'host',
  tSortDir: 'asc',
  hSort: 'targetCount',
};

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function flag(cc) {
  if (!cc || cc.length !== 2 || cc === 'XX') return '🏴';
  return cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}
function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const isNew = (t) => t.hostFirstSeen && (Date.now() - new Date(t.hostFirstSeen).getTime()) < DAY;
const typeCls = (ty) => (['http', 'http2', 'http3', 'tcp', 'udp', 'nginx_loris'].includes(ty) ? ty : 'default');

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 1800);
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied`); }
  catch { toast('Copy failed — clipboard blocked'); }
}
function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ---------- data ----------
async function load() {
  try {
    const [tRes, sRes] = await Promise.all([
      fetch('/api/targets').then((r) => r.json()),
      fetch('/api/stats').then((r) => r.json()),
    ]);
    state.targets = tRes.targets || [];
    state.stats = sRes;
    setStatus(tRes.ok, tRes);
    render();
  } catch (e) {
    setStatus(false, { error: e.message });
  }
}
function setStatus(ok, meta) {
  $('#statusDot').className = 'dot ' + (ok ? 'ok' : 'err');
  const txt = $('#statusText');
  if (ok) { txt.textContent = `live · updated ${timeAgo(meta.fetchedAt)}`; txt.title = `Feed last-modified: ${meta.feedLastModified || 'n/a'}`; }
  else { txt.textContent = `error: ${meta.error || 'unavailable'}`; }
}

// ---------- filtering (shared across views) ----------
function filtered() {
  const q = state.search.toLowerCase();
  return state.targets.filter((t) => {
    if (state.filterType && t.type !== state.filterType) return false;
    if (state.filterCountry && t.country !== state.filterCountry) return false;
    if (state.filterPort && String(t.port) !== state.filterPort) return false;
    if (state.filterNew && !isNew(t)) return false;
    if (q) {
      const hay = `${t.host} ${t.ip} ${t.path} ${t.org} ${t.country} ${t.method} ${t.type}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// group targets -> hosts
function groupHosts(rows) {
  const m = new Map();
  for (const t of rows) {
    let h = m.get(t.host);
    if (!h) {
      h = { host: t.host, country: t.country, countryCode: t.countryCode, city: t.city, org: t.org,
        ips: new Set(), types: {}, methods: new Set(), ports: new Set(), paths: new Set(),
        ssl: false, targetCount: 0, firstSeen: t.hostFirstSeen, vectors: [] };
      m.set(t.host, h);
    }
    if (t.ip) h.ips.add(t.ip);
    h.types[t.type] = (h.types[t.type] || 0) + 1;
    if (t.method) h.methods.add(t.method);
    if (t.port != null) h.ports.add(t.port);
    if (t.path) h.paths.add(t.path);
    if (t.use_ssl) h.ssl = true;
    h.targetCount++;
    h.vectors.push(t);
    if (t.hostFirstSeen && new Date(t.hostFirstSeen) < new Date(h.firstSeen)) h.firstSeen = t.hostFirstSeen;
  }
  return [...m.values()].map((h) => ({ ...h, ips: [...h.ips], methods: [...h.methods],
    ports: [...h.ports].sort((a, b) => a - b), paths: [...h.paths] }));
}

// ---------- render orchestrator ----------
function render() {
  syncFilters();
  const rows = filtered();
  $('#resultCount').textContent = `${rows.length} of ${state.targets.length} targets`;
  $('#badgeHosts').textContent = state.stats?.totals?.hosts ?? '';
  $('#badgeTargets').textContent = state.targets.length || '';
  $('#searchClear').hidden = !state.search;
  if (state.view === 'overview') renderOverview();
  if (state.view === 'hosts') renderHosts(rows);
  if (state.view === 'targets') renderTargets(rows);
}

// ---------- overview ----------
function renderOverview() {
  const s = state.stats;
  if (!s || !s.totals) return;
  const t = s.totals;
  const vectors = state.targets.length;
  const cards = [
    { label: 'Targets', value: vectors, cls: 'accent' },
    { label: 'Unique hosts', value: t.hosts, cls: '' },
    { label: 'Unique IPs', value: t.ips, cls: 'blue' },
    { label: 'Countries', value: t.countries, cls: '' },
    { label: 'Attacked paths', value: (s.topPaths || []).length ? new Set(state.targets.filter(x=>x.path).map(x=>x.path)).size : 0, cls: 'purple' },
    { label: 'New hosts (24h)', value: t.newHosts24h, cls: 'amber' },
  ];
  $('#cards').innerHTML = cards.map((c) => `
    <div class="card ${c.cls}"><div class="value">${c.value ?? '—'}</div><div class="label">${c.label}</div></div>`).join('');

  renderTrend($('#trendChart'), s.trend || []);
  bars($('#typeChart'), s.byType, (r) => esc(r.key), true);
  bars($('#countryChart'), s.byCountry.slice(0, 8), (r) => `${flag(codeFor(r.key))} ${esc(r.key)}`);
  bars($('#portChart'), s.byPort.slice(0, 8), (r) => `Port ${esc(r.key)}`);
  bars($('#methodChart'), s.byMethod.slice(0, 8), (r) => esc(r.key || '—'));

  // top hosts (clickable -> drawer)
  const th = s.topHosts.slice(0, 10);
  const max = Math.max(1, ...th.map((r) => r.count));
  $('#topHosts').innerHTML = th.map((r) => `
    <div class="bar-row click" data-host="${esc(r.key)}">
      <span class="name" title="${esc(r.key)}">${esc(r.key)}</span>
      <span class="track"><span class="fill" style="width:${(r.count / max * 100).toFixed(1)}%"></span></span>
      <span class="num">${r.count}</span>
    </div>`).join('') || '<div class="empty">No data</div>';

  // top paths
  $('#topPaths').innerHTML = (s.topPaths || []).map((p) => `
    <div class="path-item">
      <span class="p" title="${esc(p.path)}">${esc(p.path)}</span>
      <span class="meta">${p.count}× · ${p.hosts} host${p.hosts > 1 ? 's' : ''}</span>
      <button class="mini-copy" data-copy="${esc(p.path)}">copy</button>
    </div>`).join('') || '<div class="empty">No path-based targets</div>';
}

function bars(el, rows, labelFn, clickType = false) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  el.innerHTML = rows.length ? rows.map((r) => `
    <div class="bar-row ${clickType ? 'click' : ''}" ${clickType ? `data-type="${esc(r.key)}"` : ''}>
      <span class="name" title="${esc(typeof labelFn === 'function' ? r.key : r.key)}">${labelFn(r)}</span>
      <span class="track"><span class="fill" style="width:${(r.count / max * 100).toFixed(1)}%"></span></span>
      <span class="num">${r.count}</span>
    </div>`).join('') : '<div class="empty">No data</div>';
}
function codeFor(country) { const t = state.targets.find((x) => x.country === country); return t ? t.countryCode : 'XX'; }

function renderTrend(el, trend) {
  if (!trend.length) { el.innerHTML = '<div class="empty">History builds as the monitor runs…</div>'; return; }
  const W = 640, H = 210, pad = 34;
  const max = Math.max(...trend.map((d) => d.count)) * 1.15 || 1;
  const x = (i) => pad + (i / Math.max(1, trend.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - (v / max) * (H - pad * 2);
  const pts = trend.map((d, i) => `${x(i)},${y(d.count)}`).join(' ');
  const area = `${pad},${H - pad} ${pts} ${x(trend.length - 1)},${H - pad}`;
  const ticks = [0, 0.5, 1].map((f) => {
    const v = Math.round(max * f);
    return `<line x1="${pad}" y1="${y(v)}" x2="${W - pad}" y2="${y(v)}" stroke="#22304a"/>
            <text x="6" y="${y(v) + 4}" fill="#8ea1bd" font-size="10">${v}</text>`;
  }).join('');
  const last = trend[trend.length - 1];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
    <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ff4d5e" stop-opacity="0.35"/><stop offset="100%" stop-color="#ff4d5e" stop-opacity="0"/>
    </linearGradient></defs>
    ${ticks}
    <polygon points="${area}" fill="url(#tg)"/>
    <polyline points="${pts}" fill="none" stroke="#ff4d5e" stroke-width="2"/>
    ${trend.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.count)}" r="2.5" fill="#ff4d5e"><title>${d.day}: ${d.count} targets</title></circle>`).join('')}
    <text x="${W - pad}" y="14" text-anchor="end" fill="#e6edf6" font-size="11">latest: ${last.count}</text>
    <text x="${pad}" y="${H - 8}" fill="#8ea1bd" font-size="10">${trend[0].day}</text>
    <text x="${W - pad}" y="${H - 8}" text-anchor="end" fill="#8ea1bd" font-size="10">${last.day}</text>
  </svg>`;
}

// ---------- hosts view ----------
function renderHosts(rows) {
  let hosts = groupHosts(rows);
  const dir = state.hSort === 'host' ? 1 : -1;
  hosts.sort((a, b) => {
    if (state.hSort === 'host') return a.host.localeCompare(b.host);
    if (state.hSort === 'firstSeen') return new Date(b.firstSeen) - new Date(a.firstSeen);
    if (state.hSort === 'ports') return (b.ports.length + b.paths.length) - (a.ports.length + a.paths.length);
    return b.targetCount - a.targetCount;
  });
  const grid = $('#hostGrid');
  if (!hosts.length) { grid.innerHTML = '<div class="empty">No hosts match your filters</div>'; return; }
  grid.innerHTML = hosts.map((h) => {
    const chips = Object.entries(h.types).sort((a, b) => b[1] - a[1])
      .map(([ty, n]) => `<span class="tag ${typeCls(ty)}">${esc(ty)} ${n}</span>`).join('');
    const fresh = h.firstSeen && (Date.now() - new Date(h.firstSeen).getTime()) < DAY;
    return `<div class="host-card ${fresh ? 'new' : ''}" data-host="${esc(h.host)}">
      <div class="hc-top">
        <div>
          <div class="hc-name">${esc(h.host)} ${fresh ? '<span class="new-badge">NEW</span>' : ''}</div>
          <div class="hc-geo">${flag(h.countryCode)} ${esc(h.country)}${h.city ? ` · ${esc(h.city)}` : ''}</div>
          ${h.org ? `<div class="hc-org">${esc(h.org)}</div>` : ''}
        </div>
        <div class="hc-count"><div class="n">${h.targetCount}</div><div class="l">vectors</div></div>
      </div>
      <div class="hc-chips">${chips}</div>
      <div class="hc-surface">
        <span><b>${h.ips.length}</b> IP${h.ips.length > 1 ? 's' : ''}</span>
        <span><b>${h.ports.length}</b> port${h.ports.length > 1 ? 's' : ''}</span>
        <span><b>${h.paths.length}</b> path${h.paths.length > 1 ? 's' : ''}</span>
        <span>${h.ssl ? '🔒 SSL' : 'no SSL'}</span>
      </div>
    </div>`;
  }).join('');
}

// ---------- targets view ----------
function renderTargets(rows) {
  const { tSortKey: k, tSortDir: dir } = state;
  rows = [...rows].sort((a, b) => {
    let va = a[k], vb = b[k];
    if (typeof va === 'boolean') { va = +va; vb = +vb; }
    if (typeof va === 'number' && typeof vb === 'number') return dir === 'asc' ? va - vb : vb - va;
    va = String(va ?? '').toLowerCase(); vb = String(vb ?? '').toLowerCase();
    return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  });
  const body = $('#targetsBody');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="empty">No targets match your filters</td></tr>'; return; }
  body.innerHTML = rows.map((t) => `
    <tr class="${isNew(t) ? 'new' : ''}" data-host="${esc(t.host)}">
      <td><b>${esc(t.host)}</b>${isNew(t) ? ' <span class="new-badge">NEW</span>' : ''}</td>
      <td class="mono">${esc(t.ip)}</td>
      <td>${flag(t.countryCode)} ${esc(t.country)}</td>
      <td><span class="tag ${typeCls(t.type)}">${esc(t.type)}</span></td>
      <td class="mono">${esc(t.method || '—')}</td>
      <td class="mono">${esc(t.port)}</td>
      <td class="${t.use_ssl ? 'ssl-yes' : 'ssl-no'}">${t.use_ssl ? '🔒' : '—'}</td>
      <td class="path mono" title="${esc(t.path)}">${esc(t.path || '—')}</td>
    </tr>`).join('');
}

// ---------- drawer ----------
function openDrawer(host) {
  const rows = state.targets.filter((t) => t.host === host);
  if (!rows.length) return;
  const h = groupHosts(rows)[0];
  const proto = h.ssl ? 'https' : 'http';
  $('#drawerHost').innerHTML = `${esc(h.host)} <a href="${proto}://${esc(h.host)}" target="_blank" rel="noopener" style="font-size:13px">↗</a>`;
  $('#drawerSub').textContent = `${h.country}${h.city ? ' · ' + h.city : ''}${h.org ? ' · ' + h.org : ''}`;

  const facts = [
    ['Attack vectors', h.targetCount],
    ['Unique IPs', h.ips.length],
    ['Ports', h.ports.join(', ') || '—'],
    ['First seen', timeAgo(h.firstSeen)],
  ];
  const factsHtml = facts.map(([k, v]) => `<div class="fact"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('');

  const ipsHtml = h.ips.map((ip) => `<div class="ioc-row"><span class="val">${esc(ip)}</span>
    <button class="mini-copy" data-copy="${esc(ip)}">copy</button></div>`).join('');

  const paths = h.paths.filter(Boolean);
  const pathsHtml = paths.length ? paths.map((p) => `<div class="ioc-row"><span class="val" title="${esc(p)}">${esc(p)}</span>
    <button class="mini-copy" data-copy="${esc(p)}">copy</button></div>`).join('') : '<div class="hint">No path-based vectors.</div>';

  const vecHtml = h.vectors.map((v) => `<tr>
    <td><span class="tag ${typeCls(v.type)}">${esc(v.type)}</span></td>
    <td class="mono">${esc(v.method || '—')}</td>
    <td class="mono">${esc(v.port)}</td>
    <td>${v.use_ssl ? '🔒' : '—'}</td>
    <td class="p mono" title="${esc(v.path)}">${esc(v.path || '—')}</td>
  </tr>`).join('');

  $('#drawerBody').innerHTML = `
    <div class="facts">${factsHtml}</div>
    <div class="drawer-section">
      <h3>IP addresses <button class="mini-copy" data-copy="${esc(h.ips.join('\n'))}">copy all</button></h3>
      ${ipsHtml}
    </div>
    <div class="drawer-section">
      <h3>Targeted paths ${paths.length ? `<button class="mini-copy" data-copy="${esc(paths.join('\n'))}">copy all</button>` : ''}</h3>
      ${pathsHtml}
    </div>
    <div class="drawer-section">
      <h3>All attack vectors (${h.vectors.length})</h3>
      <table class="vec-table">
        <thead><tr><th>Type</th><th>Method</th><th>Port</th><th>SSL</th><th>Path</th></tr></thead>
        <tbody>${vecHtml}</tbody>
      </table>
    </div>`;

  $('#drawer').hidden = false;
  $('#drawerOverlay').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawerOverlay').hidden = true; }

// ---------- export ----------
function exportData(kind) {
  const rows = filtered();
  if (kind === 'json') {
    download('ddosia-targets.json', JSON.stringify(rows, null, 2), 'application/json');
  } else if (kind === 'csv') {
    const cols = ['host', 'ip', 'country', 'city', 'org', 'type', 'method', 'port', 'use_ssl', 'path'];
    const escC = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => escC(r[c])).join(','))].join('\n');
    download('ddosia-targets.csv', csv, 'text/csv');
  } else if (kind === 'ips') {
    copy([...new Set(rows.map((r) => r.ip).filter(Boolean))].join('\n'), 'IPs');
  } else if (kind === 'paths') {
    copy([...new Set(rows.map((r) => r.path).filter(Boolean))].join('\n'), 'Paths');
  }
  $('#exportMenu').hidden = true;
}

// ---------- filters sync ----------
function syncFilters() {
  const s = state.stats;
  if (!s) return;
  const fill = (sel, items, fmt) => {
    const cur = sel.value;
    const opts = ['<option value="">' + sel.dataset.all + '</option>']
      .concat(items.map((r) => `<option value="${esc(r.key)}">${fmt(r)}</option>`));
    sel.innerHTML = opts.join('');
    sel.value = cur;
  };
  const ft = $('#filterType'), fc = $('#filterCountry'), fp = $('#filterPort');
  ft.dataset.all = 'All types'; fc.dataset.all = 'All countries'; fp.dataset.all = 'All ports';
  fill(ft, s.byType, (r) => `${r.key} (${r.count})`);
  fill(fc, s.byCountry, (r) => `${r.key} (${r.count})`);
  fill(fp, s.byPort, (r) => `${r.key} (${r.count})`);
}

// ---------- events ----------
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  state.view = btn.dataset.view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${state.view}`; });
  render();
});

$('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
$('#searchClear').addEventListener('click', () => { state.search = ''; $('#search').value = ''; render(); });
$('#filterType').addEventListener('change', (e) => { state.filterType = e.target.value; render(); });
$('#filterCountry').addEventListener('change', (e) => { state.filterCountry = e.target.value; render(); });
$('#filterPort').addEventListener('change', (e) => { state.filterPort = e.target.value; render(); });
$('#filterNew').addEventListener('change', (e) => { state.filterNew = e.target.checked; render(); });

// host sort pills
$('.sortbar')?.addEventListener('click', (e) => {
  const p = e.target.closest('.pill'); if (!p) return;
  state.hSort = p.dataset.hsort;
  $$('.sortbar .pill').forEach((x) => x.classList.toggle('active', x === p));
  render();
});

// targets table sorting
$$('#targetsTable thead th').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.tSortKey === k) state.tSortDir = state.tSortDir === 'asc' ? 'desc' : 'asc';
    else { state.tSortKey = k; state.tSortDir = 'asc'; }
    $$('#targetsTable thead th').forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
    th.classList.add(state.tSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    render();
  });
});

// export menu
$('#exportBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#exportMenu').hidden = !$('#exportMenu').hidden; });
$('#exportMenu').addEventListener('click', (e) => { const b = e.target.closest('[data-export]'); if (b) exportData(b.dataset.export); });
document.addEventListener('click', () => { $('#exportMenu').hidden = true; });

// delegated clicks: open drawer / copy / filter-by-chart
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) { e.stopPropagation(); copy(copyBtn.dataset.copy, 'Value'); return; }
  const hostEl = e.target.closest('[data-host]');
  if (hostEl) { openDrawer(hostEl.dataset.host); return; }
  const typeEl = e.target.closest('[data-type]');
  if (typeEl) { state.filterType = typeEl.dataset.type; $('#filterType').value = typeEl.dataset.type;
    state.view = 'hosts'; $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === 'hosts'));
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-hosts'; }); render(); }
});

$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerOverlay').addEventListener('click', closeDrawer);

// hotkeys
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
  if (e.key === '/' && document.activeElement !== $('#search')) { e.preventDefault(); $('#search').focus(); }
});

// ---------- boot ----------
load();
setInterval(load, REFRESH_MS);
