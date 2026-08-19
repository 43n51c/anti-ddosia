// anti-DDoSia — frontend (VertexGuard-style analyst dashboard)
'use strict';

const REFRESH_MS = 60_000;
const DAY = 24 * 3600 * 1000;
const TYPE_COLORS = { http: '#3b82f6', http2: '#6366f1', http3: '#8b5cf6', tcp: '#fbbf24', udp: '#f97316', nginx_loris: '#ec4899' };
const PALETTE = ['#8b5cf6', '#ec4899', '#3b82f6', '#fbbf24', '#22d3ee', '#f43f5e', '#34d399', '#a855f7'];

const ICONS = {
  target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.6" fill="#fff" stroke="none"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>',
  net: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7.6 7.7l3 8M16.4 7.7l-3 8M8 6h8"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V7a4 4 0 018 0v3.5"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3v6M12 15v6M3 12h6M15 12h6M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/></svg>',
};

const state = {
  targets: [], stats: null, view: 'overview',
  search: '', filterType: '', filterCountry: '', filterPort: '', filterNew: false,
  tSortKey: 'host', tSortDir: 'asc', hSort: 'targetCount',
};

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function flag(cc) { if (!cc || cc.length !== 2 || cc === 'XX') return '🏴'; return cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0))); }
function timeAgo(iso) { if (!iso) return '—'; const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`; }
function dateStr(iso) { if (!iso) return '—'; const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; }
const isNew = (t) => t.hostFirstSeen && (Date.now() - new Date(t.hostFirstSeen).getTime()) < DAY;
const typeCls = (ty) => (['http', 'http2', 'http3', 'tcp', 'udp', 'nginx_loris'].includes(ty) ? ty : 'default');

function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 1800); }
async function copy(text, label) { try { await navigator.clipboard.writeText(text); toast(`${label} copied`); } catch { toast('Copy failed — clipboard blocked'); } }
function download(name, text, mime) { const b = new Blob([text], { type: mime }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); }

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
  } catch (e) { setStatus(false, { error: e.message }); }
}
function setStatus(ok, meta) {
  $('#statusDot').className = 'dot ' + (ok ? 'ok' : 'err');
  $('#statusText').textContent = ok ? `live · ${timeAgo(meta.fetchedAt)}` : `error`;
}

// ---------- filtering ----------
function filtered() {
  const q = state.search.toLowerCase();
  return state.targets.filter((t) => {
    if (state.filterType && t.type !== state.filterType) return false;
    if (state.filterCountry && t.country !== state.filterCountry) return false;
    if (state.filterPort && String(t.port) !== state.filterPort) return false;
    if (state.filterNew && !isNew(t)) return false;
    if (q) { const hay = `${t.host} ${t.ip} ${t.path} ${t.org} ${t.country} ${t.method} ${t.type}`.toLowerCase(); if (!hay.includes(q)) return false; }
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
  if (state.view === 'assets') renderAssets();
  if (state.view === 'alerts') renderAlerts();
}

// ---------- overview ----------
function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

function renderOverview() {
  const s = state.stats; if (!s || !s.totals) return;
  const t = state.targets;
  const n = t.length || 1;
  const httpN = t.filter((x) => x.type.startsWith('http')).length;
  const netN = t.filter((x) => x.type === 'tcp' || x.type === 'udp').length;
  const sslN = t.filter((x) => x.use_ssl).length;

  // gradient stat cards
  const cards = [
    { ico: ICONS.target, g: 'g-pink', val: s.totals.targets, lbl: 'Total Targets' },
    { ico: ICONS.globe, g: 'g-purple', val: pct(httpN, n) + '%', lbl: 'HTTP-layer' },
    { ico: ICONS.net, g: 'g-magenta', val: pct(netN, n) + '%', lbl: 'Network (L4)' },
    { ico: ICONS.lock, g: 'g-blue', val: pct(sslN, n) + '%', lbl: 'Over SSL' },
    { ico: ICONS.spark, g: 'g-cyan', val: s.totals.newHosts24h, lbl: 'New Hosts 24h' },
  ];
  $('#statRow').innerHTML = cards.map((c) => `
    <div class="stat">
      <div class="stat-ico ${c.g}">${c.ico}</div>
      <div class="val">${c.val}</div>
      <div class="lbl">${c.lbl}</div>
    </div>`).join('');

  // gauge
  renderGauge($('#gauge'), s.totals);
  // trend
  renderTrend($('#trendChart'), s.trend || []);
  const days = s.historyDays || (s.trend || []).length;
  $('#trendRange').textContent = days > 40 ? `${days}-day` : `${days || 30}-day`;
  if (s.trendPeak && s.trendPeak.day) {
    $('#trendNote').textContent = `peak ${s.trendPeak.count} on ${s.trendPeak.day} · avg ${s.trendAvg}/day`;
  }
  // donut by type
  renderDonut(s.byType);
  // top hosts rail
  renderHostRail(s.topHosts, s.totals.targets);
  // breakdown bars
  bars($('#countryChart'), s.byCountry.slice(0, 6), (r) => `${flag(codeFor(r.key))} ${esc(r.key)}`);
  bars($('#portChart'), s.byPort.slice(0, 6), (r) => `Port ${esc(r.key)}`);
  bars($('#methodChart'), s.byMethod.slice(0, 6), (r) => esc(r.key || '—'));
  // threat details mini table (most recently first-seen)
  renderThreatDetails();
}

function bars(el, rows, labelFn) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  el.innerHTML = rows.length ? rows.map((r) => `
    <div class="bar-row"><span class="name" title="${esc(r.key)}">${labelFn(r)}</span>
      <span class="track"><span class="fill" style="width:${(r.count / max * 100).toFixed(1)}%"></span></span>
      <span class="num">${r.count}</span></div>`).join('') : '<div class="empty">No data</div>';
}
function codeFor(country) { const t = state.targets.find((x) => x.country === country); return t ? t.countryCode : 'XX'; }

// campaign-intensity score 0..1000 (data-driven, no randomness)
function intensityScore(tot) {
  const f = Math.min(1, (tot.targets / 500) * 0.5 + (tot.hosts / 60) * 0.3 + (tot.ips / 60) * 0.2);
  return Math.round(f * 1000);
}
function renderGauge(el, tot) {
  const score = intensityScore(tot);
  const frac = Math.min(1, score / 1000);
  const level = score > 700 ? { t: 'High', c: '#f43f5e' } : score > 400 ? { t: 'Medium', c: '#fbbf24' } : { t: 'Low', c: '#34d399' };
  const W = 240, H = 155, cx = 120, cy = 128, R = 96;
  const pol = (a) => [cx + R * Math.cos(a), cy - R * Math.sin(a)];
  const arc = (fromF, toF) => { const a0 = Math.PI * (1 - fromF), a1 = Math.PI * (1 - toF); const [x0, y0] = pol(a0), [x1, y1] = pol(a1); return `M ${x0} ${y0} A ${R} ${R} 0 0 1 ${x1} ${y1}`; };
  const [kx, ky] = pol(Math.PI * (1 - frac));
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="230">
      <defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#34d399"/><stop offset="50%" stop-color="#fb923c"/><stop offset="100%" stop-color="#f43f5e"/>
      </linearGradient></defs>
      <path d="${arc(0, 1)}" fill="none" stroke="#26263a" stroke-width="16" stroke-linecap="round"/>
      <path d="${arc(0, frac)}" fill="none" stroke="url(#gg)" stroke-width="16" stroke-linecap="round"/>
      <circle cx="${kx}" cy="${ky}" r="9" fill="#fff" stroke="${level.c}" stroke-width="3"/>
      <text x="${cx}" y="${cy - 34}" text-anchor="middle" fill="#8b8ca6" font-size="12">Score</text>
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#f2f3fa" font-size="34" font-weight="700">${score}</text>
      <text x="26" y="${cy + 20}" fill="#5d5e78" font-size="11">0</text>
      <text x="${W - 26}" y="${cy + 20}" text-anchor="end" fill="#5d5e78" font-size="11">1000</text>
    </svg>
    <div style="margin-top:-14px"><span class="tag" style="background:${level.c}22;color:${level.c};font-size:13px;padding:5px 16px">${level.t}</span></div>`;
}

function renderDonut(byType) {
  const data = byType.slice(0, 6);
  const total = data.reduce((s, d) => s + d.count, 0) || 1;
  const R = 58, cx = 75, cy = 75, sw = 16, C = 2 * Math.PI * R, gap = 3;
  let off = 0;
  const segs = data.map((d, i) => {
    const len = (d.count / total) * C;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${TYPE_COLORS[d.key] || PALETTE[i % PALETTE.length]}" stroke-width="${sw}" stroke-dasharray="${Math.max(0, len - gap)} ${C - Math.max(0, len - gap)}" stroke-dashoffset="${-off}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += len; return seg;
  }).join('');
  const topShare = pct(data[0]?.count || 0, total);
  $('#typeDonut').innerHTML = `<svg viewBox="0 0 150 150" width="100%">
    ${segs}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#8b8ca6" font-size="11">Top type</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="#f2f3fa" font-size="22" font-weight="700">${topShare}%</text>
  </svg>`;
  $('#typeLegend').innerHTML = data.map((d, i) => `
    <div class="li"><span class="sw" style="background:${TYPE_COLORS[d.key] || PALETTE[i % PALETTE.length]}"></span>${esc(d.key)} <b>${d.count}</b></div>`).join('');
}

function ring(frac, color) {
  const R = 15, C = 2 * Math.PI * R, len = frac * C;
  return `<svg viewBox="0 0 42 42" class="hr-ring">
    <circle cx="21" cy="21" r="${R}" fill="none" stroke="#26263a" stroke-width="5"/>
    <circle cx="21" cy="21" r="${R}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${len} ${C - len}" transform="rotate(-90 21 21)"/>
    <text x="21" y="25" text-anchor="middle" fill="#f2f3fa" font-size="11" font-weight="600">${Math.round(frac * 100)}</text>
  </svg>`;
}
function renderHostRail(topHosts, total) {
  const rows = topHosts.slice(0, 6);
  $('#topHosts').innerHTML = rows.map((r, i) => `
    <div class="hr" data-host="${esc(r.key)}">
      <div class="hr-ico">🖥️</div>
      <div class="hr-name"><div class="t">Host</div><div class="h" title="${esc(r.key)}">${esc(r.key)}</div></div>
      ${ring((r.count / (total || 1)), PALETTE[i % PALETTE.length])}
    </div>`).join('') || '<div class="empty">No data</div>';
}

function renderThreatDetails() {
  const rows = [...filtered()].sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen)).slice(0, 8);
  $('#tdCount').textContent = `${filtered().length} shown`;
  $('#tdBody').innerHTML = rows.length ? rows.map((t) => `
    <tr data-host="${esc(t.host)}">
      <td class="mono">${dateStr(t.firstSeen)}</td>
      <td><b>${esc(t.host)}</b>${isNew(t) ? ' <span class="new-badge">NEW</span>' : ''}</td>
      <td class="mono">${esc(t.ip)}</td>
      <td><span class="tag ${typeCls(t.type)}">${esc(t.type)}</span></td>
      <td class="mono">${esc(t.port)}</td>
      <td class="path mono" title="${esc(t.path)}">${esc(t.path || '—')}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">No targets match your filters</td></tr>';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function renderTrend(el, trend) {
  if (!trend.length) { el.innerHTML = '<div class="empty">History builds as the monitor runs…</div>'; return; }
  const W = 700, H = 230, pad = 38, botPad = 26;
  const max = Math.max(...trend.map((d) => d.count)) * 1.15 || 1;
  const many = trend.length > 40;
  const x = (i) => pad + (i / Math.max(1, trend.length - 1)) * (W - pad * 2);
  const y = (v) => H - botPad - (v / max) * (H - pad - botPad);
  const pts = trend.map((d, i) => `${x(i)},${y(d.count)}`).join(' ');
  const area = `${pad},${H - botPad} ${pts} ${x(trend.length - 1)},${H - botPad}`;
  const yticks = [0, 0.5, 1].map((f) => { const v = Math.round(max * f); return `<line x1="${pad}" y1="${y(v)}" x2="${W - pad}" y2="${y(v)}" stroke="#20202f" stroke-dasharray="3 4"/><text x="6" y="${y(v) + 4}" fill="#5d5e78" font-size="10">${v}</text>`; }).join('');

  // x-axis labels: month boundaries when there's a lot of data, else first/last day.
  let xlabels = '';
  if (many) {
    const years = new Set(trend.map((d) => d.day.slice(0, 4)));
    const multiYear = years.size > 1;
    // With several years, label quarterly (Jan/Apr/Jul/Oct) to avoid crowding; else every month.
    const labelEvery = trend.length > 500 ? 3 : 1;
    let lastMonth = -1;
    xlabels = trend.map((d, i) => {
      const m = Number(d.day.slice(5, 7)) - 1;
      if (m === lastMonth) return '';
      lastMonth = m;
      const isYearStart = m === 0;
      const showText = m % labelEvery === 0;
      const label = multiYear ? `${MONTHS[m]} '${d.day.slice(2, 4)}` : MONTHS[m];
      const line = `<line x1="${x(i)}" y1="${pad - 8}" x2="${x(i)}" y2="${H - botPad}" stroke="${isYearStart ? '#2a2a40' : '#1c1c2b'}"/>`;
      const text = showText ? `<text x="${x(i) + 3}" y="${H - 9}" fill="#5d5e78" font-size="10">${label}</text>` : '';
      return line + text;
    }).join('');
  } else {
    xlabels = `<text x="${pad}" y="${H - 9}" fill="#5d5e78" font-size="10">${trend[0].day}</text>
      <text x="${W - pad}" y="${H - 9}" text-anchor="end" fill="#5d5e78" font-size="10">${trend[trend.length - 1].day}</text>`;
  }

  const last = trend[trend.length - 1];
  const peak = trend.reduce((m, d) => (d.count > m.count ? d : m), trend[0]);
  const peakX = x(trend.indexOf(peak));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
    <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a855f7" stop-opacity="0.4"/><stop offset="100%" stop-color="#a855f7" stop-opacity="0"/></linearGradient></defs>
    ${yticks}${xlabels}
    <polygon points="${area}" fill="url(#tg)"/>
    <polyline points="${pts}" fill="none" stroke="#c084fc" stroke-width="${many ? 1.8 : 2.5}"/>
    ${many ? '' : trend.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.count)}" r="3" fill="#c084fc"><title>${d.day}: ${d.count} targets</title></circle>`).join('')}
    <circle cx="${peakX}" cy="${y(peak.count)}" r="3.5" fill="#f43f5e"><title>Peak ${peak.day}: ${peak.count}</title></circle>
    <text x="${peakX}" y="${y(peak.count) - 8}" text-anchor="middle" fill="#f43f5e" font-size="10">peak ${peak.count}</text>
    <text x="${W - pad}" y="14" text-anchor="end" fill="#f2f3fa" font-size="11">latest: ${last.count}</text>
  </svg>`;
}

// ---------- hosts view ----------
function renderHosts(rows) {
  let hosts = groupHosts(rows);
  hosts.sort((a, b) => {
    if (state.hSort === 'host') return a.host.localeCompare(b.host);
    if (state.hSort === 'firstSeen') return new Date(b.firstSeen) - new Date(a.firstSeen);
    if (state.hSort === 'ports') return (b.ports.length + b.paths.length) - (a.ports.length + a.paths.length);
    return b.targetCount - a.targetCount;
  });
  const grid = $('#hostGrid');
  if (!hosts.length) { grid.innerHTML = '<div class="empty">No hosts match your filters</div>'; return; }
  grid.innerHTML = hosts.map((h) => {
    const chips = Object.entries(h.types).sort((a, b) => b[1] - a[1]).map(([ty, c]) => `<span class="tag ${typeCls(ty)}">${esc(ty)} ${c}</span>`).join('');
    const fresh = h.firstSeen && (Date.now() - new Date(h.firstSeen).getTime()) < DAY;
    return `<div class="host-card ${fresh ? 'new' : ''}" data-host="${esc(h.host)}">
      <div class="hc-top">
        <div><div class="hc-name">${esc(h.host)} ${fresh ? '<span class="new-badge">NEW</span>' : ''}</div>
          <div class="hc-geo">${flag(h.countryCode)} ${esc(h.country)}${h.city ? ` · ${esc(h.city)}` : ''}</div>
          ${h.org ? `<div class="hc-org">${esc(h.org)}</div>` : ''}</div>
        <div class="hc-count"><div class="n">${h.targetCount}</div><div class="l">vectors</div></div>
      </div>
      <div class="hc-chips">${chips}</div>
      <div class="hc-surface"><span><b>${h.ips.length}</b> IP</span><span><b>${h.ports.length}</b> ports</span><span><b>${h.paths.length}</b> paths</span><span>${h.ssl ? '🔒 SSL' : 'no SSL'}</span></div>
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
      <td class="mono">${esc(t.ip)}</td><td>${flag(t.countryCode)} ${esc(t.country)}</td>
      <td><span class="tag ${typeCls(t.type)}">${esc(t.type)}</span></td>
      <td class="mono">${esc(t.method || '—')}</td><td class="mono">${esc(t.port)}</td>
      <td class="${t.use_ssl ? 'ssl-yes' : 'ssl-no'}">${t.use_ssl ? '🔒' : '—'}</td>
      <td class="path mono" title="${esc(t.path)}">${esc(t.path || '—')}</td>
    </tr>`).join('');
}

// ---------- drawer ----------
function openDrawer(host) {
  const rows = state.targets.filter((t) => t.host === host); if (!rows.length) return;
  const h = groupHosts(rows)[0];
  const proto = h.ssl ? 'https' : 'http';
  $('#drawerHost').innerHTML = `${esc(h.host)} <a href="${proto}://${esc(h.host)}" target="_blank" rel="noopener" style="font-size:13px">↗</a>`;
  $('#drawerSub').textContent = `${h.country}${h.city ? ' · ' + h.city : ''}${h.org ? ' · ' + h.org : ''}`;
  const facts = [['Attack vectors', h.targetCount], ['Unique IPs', h.ips.length], ['Ports', h.ports.join(', ') || '—'], ['First seen', timeAgo(h.firstSeen)]];
  const factsHtml = facts.map(([k, v]) => `<div class="fact"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('');
  const ipsHtml = h.ips.map((ip) => `<div class="ioc-row"><span class="val">${esc(ip)}</span><button class="mini-copy" data-copy="${esc(ip)}">copy</button></div>`).join('');
  const paths = h.paths.filter(Boolean);
  const pathsHtml = paths.length ? paths.map((p) => `<div class="ioc-row"><span class="val" title="${esc(p)}">${esc(p)}</span><button class="mini-copy" data-copy="${esc(p)}">copy</button></div>`).join('') : '<div class="empty">No path-based vectors.</div>';
  const vecHtml = h.vectors.map((v) => `<tr><td><span class="tag ${typeCls(v.type)}">${esc(v.type)}</span></td><td class="mono">${esc(v.method || '—')}</td><td class="mono">${esc(v.port)}</td><td>${v.use_ssl ? '🔒' : '—'}</td><td class="p mono" title="${esc(v.path)}">${esc(v.path || '—')}</td></tr>`).join('');
  $('#drawerBody').innerHTML = `
    <div class="facts">${factsHtml}</div>
    <div class="drawer-section"><h3>IP addresses <button class="mini-copy" data-copy="${esc(h.ips.join('\n'))}">copy all</button></h3>${ipsHtml}</div>
    <div class="drawer-section"><h3>Targeted paths ${paths.length ? `<button class="mini-copy" data-copy="${esc(paths.join('\n'))}">copy all</button>` : ''}</h3>${pathsHtml}</div>
    <div class="drawer-section"><h3>All attack vectors (${h.vectors.length})</h3>
      <table class="vec-table"><thead><tr><th>Type</th><th>Method</th><th>Port</th><th>SSL</th><th>Path</th></tr></thead><tbody>${vecHtml}</tbody></table></div>`;
  $('#drawer').hidden = false; $('#drawerOverlay').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawerOverlay').hidden = true; }

// ---------- export ----------
function exportData(kind) {
  const rows = filtered();
  if (kind === 'json') download('ddosia-targets.json', JSON.stringify(rows, null, 2), 'application/json');
  else if (kind === 'csv') {
    const cols = ['host', 'ip', 'country', 'city', 'org', 'type', 'method', 'port', 'use_ssl', 'path'];
    const escC = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    download('ddosia-targets.csv', [cols.join(','), ...rows.map((r) => cols.map((c) => escC(r[c])).join(','))].join('\n'), 'text/csv');
  } else if (kind === 'ips') copy([...new Set(rows.map((r) => r.ip).filter(Boolean))].join('\n'), 'IPs');
  else if (kind === 'paths') copy([...new Set(rows.map((r) => r.path).filter(Boolean))].join('\n'), 'Paths');
  $('#exportMenu').hidden = true;
}

// ---------- filters ----------
function syncFilters() {
  const s = state.stats; if (!s) return;
  const fill = (sel, items, all, fmt) => { const cur = sel.value; sel.innerHTML = [`<option value="">${all}</option>`].concat(items.map((r) => `<option value="${esc(r.key)}">${fmt(r)}</option>`)).join(''); sel.value = cur; };
  fill($('#filterType'), s.byType, 'All types', (r) => `${r.key} (${r.count})`);
  fill($('#filterCountry'), s.byCountry, 'All countries', (r) => `${r.key} (${r.count})`);
  fill($('#filterPort'), s.byPort, 'All ports', (r) => `${r.key} (${r.count})`);
}

// ---------- account / auth / assets / alerts ----------
const account = { user: null, unseen: 0, emailConfigured: false, assets: [], alerts: [] };
let pendingView = null;

async function api(path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadMe() {
  try {
    const d = await api('/api/me');
    account.user = d.user;
    account.unseen = d.unseen || 0;
    account.emailConfigured = !!d.emailConfigured;
    renderAccount();
    if (account.user) { await Promise.all([loadAssets(), loadAlerts()]); }
    if (state.view === 'assets' || state.view === 'alerts') render();
  } catch {}
}
function renderAccount() {
  const logged = !!account.user;
  $('#signinBtn').hidden = logged;
  $('#acctWrap').hidden = !logged;
  $('#bellWrap').hidden = !logged;
  if (logged) {
    $('#acctAvatar').textContent = (account.user.email[0] || '?');
    $('#acctEmail').textContent = account.user.email;
    const bb = $('#bellBadge'); bb.hidden = !account.unseen; bb.textContent = account.unseen;
  }
  const nb = $('#badgeAlerts'); nb.hidden = !(logged && account.unseen); nb.textContent = account.unseen;
}

// auth modal
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('#authSubmit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#authLead').textContent = mode === 'login' ? 'Sign in to monitor your assets and get alerts.' : 'Create an account to monitor your assets and get alerts.';
  $('#authErr').hidden = true;
}
function openAuth(mode = 'login') { setAuthMode(mode); $('#authModal').hidden = false; $('#authOverlay').hidden = false; setTimeout(() => $('#authEmail').focus(), 50); }
function closeAuth() { $('#authModal').hidden = true; $('#authOverlay').hidden = true; pendingView = null; }

// assets
async function loadAssets() { try { account.assets = (await api('/api/assets')).assets || []; } catch { account.assets = []; } }
function assetTargeted(a) {
  for (const t of state.targets) {
    if (a.type === 'ip') { if (t.ip === a.value) return t.host; }
    else if (t.host === a.value || t.host.endsWith('.' + a.value)) return t.host;
  }
  return null;
}
function renderAssets() {
  $('#assetCount').textContent = account.assets.length ? `(${account.assets.length})` : '';
  const el = $('#assetList');
  if (!account.assets.length) { el.innerHTML = '<div class="empty">No assets yet. Add a domain or IP above to start monitoring.</div>'; return; }
  el.innerHTML = account.assets.map((a) => {
    const hit = assetTargeted(a);
    return `<div class="asset-row">
      <span class="a-type">${a.type}</span>
      <div><div class="a-val">${esc(a.value)}</div>${a.label ? `<div class="a-label">${esc(a.label)}</div>` : ''}</div>
      <span class="a-status ${hit ? 'status-hit' : 'status-clear'}" ${hit ? `data-host="${esc(hit)}"` : ''}>${hit ? '● Targeted now' : '○ Clear'}</span>
      <button class="a-del" data-del="${a.id}" title="Remove">✕</button>
    </div>`;
  }).join('');
}

// alerts
async function loadAlerts() { try { const d = await api('/api/alerts'); account.alerts = d.alerts || []; account.unseen = d.unseen || 0; renderAccount(); renderBell(); } catch {} }
function renderBell() {
  const list = $('#bellList');
  const items = account.alerts.slice(0, 6);
  list.innerHTML = items.length ? items.map((a) => `<div class="bell-item ${a.seen ? '' : 'unseen'}" data-host="${esc(a.target_host)}">
    <div class="bi-host">${esc(a.target_host)}</div>
    <div class="bi-meta">asset ${esc(a.asset_value)} · ${a.vectors} vectors · ${timeAgo(a.first_matched)}</div></div>`).join('')
    : '<div class="bell-empty">No alerts yet.</div>';
}
function renderAlerts() {
  if (account.user) loadSettingsForm();
  $('#alertsCount').textContent = account.alerts.length ? `(${account.alerts.length})` : '';
  const el = $('#alertsList');
  el.innerHTML = account.alerts.length ? account.alerts.map((a) => `<div class="alert-row ${a.seen ? '' : 'unseen'}">
    <div class="alert-ico">🎯</div>
    <div class="alert-body">
      <div class="alert-title">Asset <b>${esc(a.asset_value)}</b><span class="arrow">→</span><span class="host" data-host="${esc(a.target_host)}">${esc(a.target_host)}</span></div>
      <div class="alert-meta">${a.vectors} vectors · ${esc(a.types || '')} · IPs: ${esc(a.target_ips || '')}</div>
    </div>
    <div class="alert-time">${timeAgo(a.first_matched)}</div>
  </div>`).join('') : '<div class="empty">No alerts yet. When a monitored asset appears on the target list, it shows here (and via your chosen channels).</div>';
}
function loadSettingsForm() {
  const u = account.user; if (!u) return;
  $('#setWebhook').value = u.webhook_url || '';
  $('#setEmail').checked = !!u.email_alerts;
  $('#setInapp').checked = !!u.inapp_alerts;
  const em = $('#setEmail'), hint = $('#emailHint');
  if (!account.emailConfigured) { em.disabled = true; hint.textContent = '(server SMTP not configured — webhook/in-app still work)'; }
  else { em.disabled = false; hint.textContent = ''; }
}
async function markSeen() {
  try { await api('/api/alerts/seen', { method: 'POST' }); account.unseen = 0; account.alerts = account.alerts.map((a) => ({ ...a, seen: 1 })); renderAccount(); renderBell(); if (state.view === 'alerts') renderAlerts(); } catch {}
}

// ---------- events ----------
function switchView(view) {
  if ((view === 'assets' || view === 'alerts') && !account.user) { pendingView = view; openAuth('login'); return; }
  state.view = view;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  render();
}
$$('.nav-item').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));

// account/auth events
$('#signinBtn').addEventListener('click', () => openAuth('login'));
$('#authClose').addEventListener('click', closeAuth);
$('#authOverlay').addEventListener('click', closeAuth);
$$('.auth-tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#authEmail').value.trim(), password = $('#authPass').value;
  try {
    await api('/api/' + (authMode === 'login' ? 'login' : 'register'), { method: 'POST', body: JSON.stringify({ email, password }) });
    const want = pendingView;
    closeAuth(); $('#authForm').reset();
    await loadMe();
    toast(authMode === 'login' ? 'Signed in' : 'Account created');
    switchView(want || 'assets');
  } catch (err) { const el = $('#authErr'); el.textContent = err.message; el.hidden = false; }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  account.user = null; account.assets = []; account.alerts = []; account.unseen = 0;
  renderAccount(); $('#acctMenu').hidden = true;
  if (state.view === 'assets' || state.view === 'alerts') switchView('overview');
  toast('Logged out');
});
$('#bellBtn').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#bellMenu'); m.hidden = !m.hidden; $('#acctMenu').hidden = true; $('#exportMenu').hidden = true; });
$('#acctBtn').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#acctMenu'); m.hidden = !m.hidden; $('#bellMenu').hidden = true; $('#exportMenu').hidden = true; });
$('#bellSeen').addEventListener('click', (e) => { e.stopPropagation(); markSeen(); });
$('#alertsSeen').addEventListener('click', markSeen);

// asset add / delete
$('#addAssetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('#assetValue').value.trim(), label = $('#assetLabel').value.trim();
  const errEl = $('#assetErr'); errEl.hidden = true;
  try {
    const d = await api('/api/assets', { method: 'POST', body: JSON.stringify({ value, label }) });
    account.assets = d.assets || []; $('#addAssetForm').reset();
    await loadAlerts(); renderAssets();
    toast('Asset added — monitoring active');
  } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
});

// settings save
$('#saveSettings').addEventListener('click', async () => {
  try {
    const body = { webhook_url: $('#setWebhook').value.trim(), email_alerts: $('#setEmail').checked, inapp_alerts: $('#setInapp').checked };
    await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
    Object.assign(account.user, body);
    const ok = $('#saveOk'); ok.hidden = false; setTimeout(() => (ok.hidden = true), 1600);
  } catch (err) { toast(err.message); }
});

$('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
$('#searchClear').addEventListener('click', () => { state.search = ''; $('#search').value = ''; render(); });
$('#filterType').addEventListener('change', (e) => { state.filterType = e.target.value; render(); });
$('#filterCountry').addEventListener('change', (e) => { state.filterCountry = e.target.value; render(); });
$('#filterPort').addEventListener('change', (e) => { state.filterPort = e.target.value; render(); });
$('#filterNew').addEventListener('change', (e) => { state.filterNew = e.target.checked; render(); });
$('#refreshBtn').addEventListener('click', () => { $('#refreshBtn').style.transform = 'rotate(360deg)'; setTimeout(() => $('#refreshBtn').style.transform = '', 400); load(); });

$('.sortbar').addEventListener('click', (e) => { const p = e.target.closest('.pill'); if (!p) return; state.hSort = p.dataset.hsort; $$('.sortbar .pill').forEach((x) => x.classList.toggle('active', x === p)); render(); });
$$('#targetsTable thead th').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.sort; if (state.tSortKey === k) state.tSortDir = state.tSortDir === 'asc' ? 'desc' : 'asc'; else { state.tSortKey = k; state.tSortDir = 'asc'; }
  $$('#targetsTable thead th').forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc')); th.classList.add(state.tSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc'); render();
}));

$('#exportBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#exportMenu').hidden = !$('#exportMenu').hidden; $('#bellMenu').hidden = true; $('#acctMenu').hidden = true; });
$('#exportMenu').addEventListener('click', (e) => { const b = e.target.closest('[data-export]'); if (b) exportData(b.dataset.export); });
document.addEventListener('click', () => { $('#exportMenu').hidden = true; $('#bellMenu').hidden = true; $('#acctMenu').hidden = true; });

document.addEventListener('click', async (e) => {
  const cp = e.target.closest('[data-copy]'); if (cp) { e.stopPropagation(); copy(cp.dataset.copy, 'Value'); return; }
  const del = e.target.closest('[data-del]');
  if (del) { try { const d = await api('/api/assets/' + del.dataset.del, { method: 'DELETE' }); account.assets = d.assets || []; renderAssets(); } catch {} return; }
  const mv = e.target.closest('.menu-list [data-view], .bell-all[data-view]');
  if (mv) { switchView(mv.dataset.view); return; }
  const he = e.target.closest('[data-host]'); if (he) { openDrawer(he.dataset.host); }
});
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerOverlay').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); if (e.key === '/' && document.activeElement !== $('#search')) { e.preventDefault(); $('#search').focus(); } });

// ---------- boot ----------
load();
loadMe();
setInterval(() => { load(); if (account.user) loadAlerts(); }, REFRESH_MS);
