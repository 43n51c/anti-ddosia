// anti-DDoSia — server
//
// Polls the public DDoSia Project target feed, enriches targets with GeoIP,
// tracks history / first-seen state on disk, and serves a JSON API + the
// static dashboard. Zero external dependencies (Node >= 18, native fetch).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DATA_DIR = join(__dirname, 'data');

const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  feedUrl: process.env.FEED_URL || 'https://witha.name/data/last.json',
  pollMs: (Number(process.env.POLL_MINUTES) || 5) * 60 * 1000,
  geoipBatchUrl: 'http://ip-api.com/batch?fields=query,country,countryCode,city,regionName,org,as',
  historyMax: 4000, // ~2 weeks at 5-min polls
};

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const GEOIP_FILE = join(DATA_DIR, 'geoip-cache.json');
const STATE_FILE = join(DATA_DIR, 'state.json');

// ---------- persistence helpers ----------
function loadJson(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[warn] could not read ${file}:`, e.message);
  }
  return fallback;
}
function saveJson(file, data) {
  try {
    writeFileSync(file, JSON.stringify(data), 'utf8');
  } catch (e) {
    console.error(`[warn] could not write ${file}:`, e.message);
  }
}

let geoipCache = loadJson(GEOIP_FILE, {}); // ip -> { country, countryCode, city, regionName, org, as }
let state = loadJson(STATE_FILE, {
  firstSeenHost: {},     // host -> ISO date first observed
  firstSeenTarget: {},   // target_id -> ISO date first observed
  history: [],           // [{ t, count, hosts, ips }]
});

// In-memory snapshot served to clients.
let current = {
  ok: false,
  fetchedAt: null,
  feedLastModified: null,
  error: 'not fetched yet',
  targets: [],
};

// ---------- GeoIP enrichment ----------
async function enrichGeoIp(ips) {
  const missing = ips.filter((ip) => ip && !geoipCache[ip]);
  if (missing.length === 0) return;

  // ip-api batch: up to 100 IPs per request.
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const res = await fetch(CONFIG.geoipBatchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map((q) => ({ query: q }))),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      for (const r of rows) {
        if (!r || !r.query) continue;
        geoipCache[r.query] = {
          country: r.country || 'Unknown',
          countryCode: r.countryCode || 'XX',
          city: r.city || '',
          regionName: r.regionName || '',
          org: r.org || '',
          as: r.as || '',
        };
      }
    } catch (e) {
      console.error('[warn] geoip lookup failed:', e.message);
    }
  }
  saveJson(GEOIP_FILE, geoipCache);
}

// ---------- feed polling ----------
async function poll() {
  try {
    const res = await fetch(CONFIG.feedUrl, {
      headers: { 'User-Agent': 'anti-ddosia-monitor/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lastModified = res.headers.get('last-modified');
    const json = await res.json();
    const raw = Array.isArray(json) ? json : json.targets || [];

    const uniqueIps = [...new Set(raw.map((t) => t.ip).filter(Boolean))];
    await enrichGeoIp(uniqueIps);

    const nowIso = new Date().toISOString();

    // Update first-seen bookkeeping.
    for (const t of raw) {
      if (t.host && !state.firstSeenHost[t.host]) state.firstSeenHost[t.host] = nowIso;
      if (t.target_id && !state.firstSeenTarget[t.target_id]) state.firstSeenTarget[t.target_id] = nowIso;
    }

    const targets = raw.map((t) => {
      const geo = geoipCache[t.ip] || {};
      return {
        target_id: t.target_id,
        host: t.host,
        ip: t.ip,
        type: t.type,
        method: t.method,
        port: t.port,
        use_ssl: t.use_ssl,
        path: t.path || '',
        country: geo.country || 'Unknown',
        countryCode: geo.countryCode || 'XX',
        city: geo.city || '',
        org: geo.org || geo.as || '',
        firstSeen: state.firstSeenTarget[t.target_id] || nowIso,
        hostFirstSeen: state.firstSeenHost[t.host] || nowIso,
      };
    });

    // Record history point.
    state.history.push({
      t: nowIso,
      count: targets.length,
      hosts: new Set(targets.map((x) => x.host)).size,
      ips: new Set(targets.map((x) => x.ip)).size,
    });
    if (state.history.length > CONFIG.historyMax) {
      state.history = state.history.slice(-CONFIG.historyMax);
    }
    saveJson(STATE_FILE, state);

    current = {
      ok: true,
      fetchedAt: nowIso,
      feedLastModified: lastModified,
      error: null,
      targets,
    };
    console.log(`[poll] ${nowIso} ok — ${targets.length} targets, ` +
      `${current.targets ? new Set(targets.map((x) => x.host)).size : 0} hosts`);
  } catch (e) {
    console.error('[poll] failed:', e.message);
    // Keep last good data; only flag error if we never had any.
    if (!current.ok) current = { ...current, error: e.message, fetchedAt: new Date().toISOString() };
  }
}

// ---------- aggregations for /api/stats ----------
function tally(items, key) {
  const m = new Map();
  for (const x of items) {
    const k = x[key] ?? 'Unknown';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count);
}

function topPaths(items, limit = 20) {
  const m = new Map();
  for (const x of items) {
    if (!x.path) continue;
    let e = m.get(x.path);
    if (!e) { e = { path: x.path, count: 0, hosts: new Set() }; m.set(x.path, e); }
    e.count++;
    e.hosts.add(x.host);
  }
  return [...m.values()]
    .map((e) => ({ path: e.path, count: e.count, hosts: e.hosts.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// Host-centric aggregation: one entry per host with its full attack surface.
function buildHosts() {
  const map = new Map();
  for (const t of current.targets) {
    let h = map.get(t.host);
    if (!h) {
      h = {
        host: t.host,
        country: t.country,
        countryCode: t.countryCode,
        city: t.city,
        org: t.org,
        ips: new Set(),
        types: {},
        methods: new Set(),
        ports: new Set(),
        paths: new Set(),
        ssl: false,
        targetCount: 0,
        firstSeen: t.hostFirstSeen,
        vectors: [],
      };
      map.set(t.host, h);
    }
    if (t.ip) h.ips.add(t.ip);
    h.types[t.type] = (h.types[t.type] || 0) + 1;
    if (t.method) h.methods.add(t.method);
    if (t.port != null) h.ports.add(t.port);
    if (t.path) h.paths.add(t.path);
    if (t.use_ssl) h.ssl = true;
    h.targetCount++;
    h.vectors.push({ type: t.type, method: t.method, port: t.port, use_ssl: t.use_ssl, path: t.path, ip: t.ip });
    if (t.hostFirstSeen && new Date(t.hostFirstSeen) < new Date(h.firstSeen)) h.firstSeen = t.hostFirstSeen;
  }
  return [...map.values()]
    .map((h) => ({
      ...h,
      ips: [...h.ips],
      methods: [...h.methods],
      ports: [...h.ports].sort((a, b) => a - b),
      paths: [...h.paths],
    }))
    .sort((a, b) => b.targetCount - a.targetCount);
}

function buildStats() {
  const t = current.targets;
  const dayCutoff = Date.now() - 24 * 3600 * 1000;
  const newHosts = [...new Set(t
    .filter((x) => new Date(x.hostFirstSeen).getTime() >= dayCutoff)
    .map((x) => x.host))];

  // Daily trend: last count seen per calendar day (full available range).
  const perDay = new Map();
  for (const h of state.history) {
    const day = h.t.slice(0, 10);
    perDay.set(day, h); // later entries overwrite -> last of day
  }
  const trend = [...perDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-400)
    .map(([day, h]) => ({ day, count: h.count, hosts: h.hosts, ips: h.ips }));

  // Peak / average across the shown range (for the overview headline stats).
  const peak = trend.reduce((m, d) => (d.count > m.count ? d : m), { count: 0, day: null });
  const avg = trend.length ? Math.round(trend.reduce((s, d) => s + d.count, 0) / trend.length) : 0;

  return {
    ok: current.ok,
    fetchedAt: current.fetchedAt,
    feedLastModified: current.feedLastModified,
    totals: {
      targets: t.length,
      hosts: new Set(t.map((x) => x.host)).size,
      ips: new Set(t.map((x) => x.ip)).size,
      countries: new Set(t.map((x) => x.countryCode)).size,
      newHosts24h: newHosts.length,
    },
    byType: tally(t, 'type'),
    byCountry: tally(t, 'country'),
    byPort: tally(t, 'port'),
    byMethod: tally(t, 'method'),
    topHosts: tally(t, 'host').slice(0, 15),
    topPaths: topPaths(t),
    newHosts,
    trend,
    trendPeak: peak,
    trendAvg: avg,
    historyDays: trend.length,
  };
}

// ---------- static file serving ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = normalize(join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/targets') {
    return sendJson(res, current);
  }
  if (pathname === '/api/stats') {
    return sendJson(res, buildStats());
  }
  if (pathname === '/api/hosts') {
    return sendJson(res, { ok: current.ok, fetchedAt: current.fetchedAt, hosts: buildHosts() });
  }
  if (pathname === '/api/health') {
    return sendJson(res, { ok: current.ok, fetchedAt: current.fetchedAt, error: current.error });
  }
  return serveStatic(req, res);
});

server.listen(CONFIG.port, () => {
  console.log(`anti-DDoSia running → http://localhost:${CONFIG.port}`);
  console.log(`feed: ${CONFIG.feedUrl}  poll: every ${CONFIG.pollMs / 60000} min`);
  poll();
  setInterval(poll, CONFIG.pollMs);
});
