// anti-DDoSia — frontend
'use strict';

const REFRESH_MS = 60_000;

const state = {
  targets: [],
  stats: null,
  sortKey: 'host',
  sortDir: 'asc',
  search: '',
  filterType: '',
  filterCountry: '',
  filterNew: false,
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function flagEmoji(cc) {
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

const isNew = (t) => t.hostFirstSeen &&
  (Date.now() - new Date(t.hostFirstSeen).getTime()) < 24 * 3600 * 1000;

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
    renderAll();
  } catch (e) {
    setStatus(false, { error: e.message });
  }
}

function setStatus(ok, meta) {
  const dot = $('#statusDot');
  const txt = $('#statusText');
  dot.className = 'dot ' + (ok ? 'ok' : 'err');
  if (ok) {
    txt.textContent = `live · updated ${timeAgo(meta.fetchedAt)}`;
    txt.title = `Feed last-modified: ${meta.feedLastModified || 'n/a'}`;
  } else {
    txt.textContent = `error: ${meta.error || 'unavailable'}`;
  }
}

// ---------- render ----------
function renderAll() {
  renderCards();
  renderCharts();
  syncFilterOptions();
  renderTable();
}

function renderCards() {
  const s = state.stats;
  if (!s || !s.totals) return;
  const t = s.totals;
  const cards = [
    { label: 'Targets', value: t.targets, cls: 'accent' },
    { label: 'Unique hosts', value: t.hosts, cls: '' },
    { label: 'Unique IPs', value: t.ips, cls: 'blue' },
    { label: 'Countries', value: t.countries, cls: '' },
    { label: 'New hosts (24h)', value: t.newHosts24h, cls: 'amber' },
  ];
  $('#cards').innerHTML = cards.map((c) => `
    <div class="card ${c.cls}">
      <div class="value">${c.value ?? '—'}</div>
      <div class="label">${c.label}</div>
    </div>`).join('');
}

function barChart(el, rows, { labelFn = (r) => r.key } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  el.innerHTML = rows.length ? rows.map((r) => `
    <div class="bar-row">
      <span class="name" title="${esc(labelFn(r))}">${labelFn(r)}</span>
      <span class="track"><span class="fill" style="width:${(r.count / max * 100).toFixed(1)}%"></span></span>
      <span class="num">${r.count}</span>
    </div>`).join('') : '<div class="empty">No data</div>';
}

function renderCharts() {
  const s = state.stats;
  if (!s) return;
  barChart($('#typeChart'), s.byType, { labelFn: (r) => esc(r.key) });
  barChart($('#countryChart'), s.byCountry.slice(0, 10),
    { labelFn: (r) => `${flagEmoji(codeFor(r.key))} ${esc(r.key)}` });
  barChart($('#portChart'), s.byPort.slice(0, 10), { labelFn: (r) => `Port ${esc(r.key)}` });
  renderTrend($('#trendChart'), s.trend || []);
}

// derive a country code from country name using current targets (for flags in the chart)
function codeFor(countryName) {
  const t = state.targets.find((x) => x.country === countryName);
  return t ? t.countryCode : 'XX';
}

function renderTrend(el, trend) {
  if (!trend.length) { el.innerHTML = '<div class="empty">History builds as the monitor runs…</div>'; return; }
  const W = 640, H = 200, pad = 30;
  const max = Math.max(...trend.map((d) => d.count)) * 1.15 || 1;
  const min = 0;
  const x = (i) => pad + (i / Math.max(1, trend.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - min) / (max - min)) * (H - pad * 2);
  const pts = trend.map((d, i) => `${x(i)},${y(d.count)}`).join(' ');
  const area = `${pad},${H - pad} ${pts} ${x(trend.length - 1)},${H - pad}`;
  const ticks = [0, 0.5, 1].map((f) => {
    const v = Math.round(max * f);
    return `<line x1="${pad}" y1="${y(v)}" x2="${W - pad}" y2="${y(v)}" stroke="#22304a" stroke-width="1"/>
            <text x="4" y="${y(v) + 4}" fill="#8ea1bd" font-size="10">${v}</text>`;
  }).join('');
  const lastLabel = trend[trend.length - 1];
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff4d5e" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#ff4d5e" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${ticks}
      <polygon points="${area}" fill="url(#tg)"/>
      <polyline points="${pts}" fill="none" stroke="#ff4d5e" stroke-width="2"/>
      ${trend.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.count)}" r="2.5" fill="#ff4d5e"><title>${d.day}: ${d.count} targets</title></circle>`).join('')}
      <text x="${W - pad}" y="14" text-anchor="end" fill="#e6edf6" font-size="11">latest: ${lastLabel.count}</text>
      <text x="${pad}" y="${H - 8}" fill="#8ea1bd" font-size="10">${trend[0].day}</text>
      <text x="${W - pad}" y="${H - 8}" text-anchor="end" fill="#8ea1bd" font-size="10">${lastLabel.day}</text>
    </svg>`;
}

function syncFilterOptions() {
  const s = state.stats;
  if (!s) return;
  const typeSel = $('#filterType');
  const countrySel = $('#filterCountry');
  if (typeSel.options.length <= 1) {
    for (const r of s.byType) typeSel.add(new Option(`${r.key} (${r.count})`, r.key));
  }
  // rebuild country list (can grow over time)
  const cur = countrySel.value;
  countrySel.innerHTML = '<option value="">All countries</option>';
  for (const r of s.byCountry) countrySel.add(new Option(`${r.key} (${r.count})`, r.key));
  countrySel.value = cur;
}

function filteredSorted() {
  const q = state.search.toLowerCase();
  let rows = state.targets.filter((t) => {
    if (state.filterType && t.type !== state.filterType) return false;
    if (state.filterCountry && t.country !== state.filterCountry) return false;
    if (state.filterNew && !isNew(t)) return false;
    if (q) {
      const hay = `${t.host} ${t.ip} ${t.path} ${t.org} ${t.country} ${t.method}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const { sortKey, sortDir } = state;
  rows.sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'boolean') { va = va ? 1 : 0; vb = vb ? 1 : 0; }
    if (typeof va === 'number' && typeof vb === 'number') return sortDir === 'asc' ? va - vb : vb - va;
    va = String(va ?? '').toLowerCase(); vb = String(vb ?? '').toLowerCase();
    return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  });
  return rows;
}

function renderTable() {
  const rows = filteredSorted();
  $('#tableCount').textContent = `— ${rows.length} of ${state.targets.length}`;
  const body = $('#targetsBody');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="empty">No targets match your filters</td></tr>'; return; }

  body.innerHTML = rows.map((t) => {
    const proto = t.use_ssl ? 'https' : 'http';
    const url = `${proto}://${t.host}${t.path && !t.path.includes('$') ? t.path : ''}`;
    const typeCls = ['http', 'http2', 'http3', 'tcp', 'udp', 'nginx_loris'].includes(t.type) ? t.type : 'default';
    return `<tr class="${isNew(t) ? 'new' : ''}">
      <td class="host">
        <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t.host)}</a>
        ${isNew(t) ? '<span class="new-badge">NEW</span>' : ''}
        ${t.org ? `<div class="hint" style="font-size:11px">${esc(t.org)}</div>` : ''}
      </td>
      <td class="mono">${esc(t.ip)}</td>
      <td>${flagEmoji(t.countryCode)} ${esc(t.country)}${t.city ? `<span class="hint"> · ${esc(t.city)}</span>` : ''}</td>
      <td><span class="tag ${typeCls}">${esc(t.type)}</span></td>
      <td class="mono">${esc(t.method || '—')}</td>
      <td class="mono">${esc(t.port)}</td>
      <td class="${t.use_ssl ? 'ssl-yes' : 'ssl-no'}">${t.use_ssl ? '🔒 yes' : 'no'}</td>
      <td class="path mono" title="${esc(t.path)}">${esc(t.path || '—')}</td>
    </tr>`;
  }).join('');
}

// ---------- events ----------
$('#search').addEventListener('input', (e) => { state.search = e.target.value; renderTable(); });
$('#filterType').addEventListener('change', (e) => { state.filterType = e.target.value; renderTable(); });
$('#filterCountry').addEventListener('change', (e) => { state.filterCountry = e.target.value; renderTable(); });
$('#filterNew').addEventListener('change', (e) => { state.filterNew = e.target.checked; renderTable(); });

document.querySelectorAll('thead th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key; state.sortDir = 'asc';
    }
    document.querySelectorAll('thead th').forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
    th.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    renderTable();
  });
});

// ---------- boot ----------
load();
setInterval(load, REFRESH_MS);
