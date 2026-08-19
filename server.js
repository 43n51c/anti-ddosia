// anti-DDoSia — server
//
// Polls the public DDoSia Project target feed, enriches targets with GeoIP,
// stores history/first-seen in SQLite, matches targets against user-owned
// assets and raises alerts (in-app + webhook + email), and serves the JSON
// API + static dashboard. No third-party deps (Node >= 22 for node:sqlite).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import * as dbx from './db.js';
import * as auth from './auth.js';
import { deliverAlert, emailConfigured } from './notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  feedUrl: process.env.FEED_URL || 'https://witha.name/data/last.json',
  pollMs: (Number(process.env.POLL_MINUTES) || 5) * 60 * 1000,
  geoipBatchUrl: 'http://ip-api.com/batch?fields=query,country,countryCode,city,regionName,org,as',
};

// In-memory snapshot served to clients.
let current = { ok: false, fetchedAt: null, feedLastModified: null, error: 'not fetched yet', targets: [] };

// ---------- GeoIP enrichment ----------
async function enrichGeoIp(ips) {
  const missing = ips.filter((ip) => ip && !dbx.getGeo(ip));
  if (!missing.length) return;
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const res = await fetch(CONFIG.geoipBatchUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map((q) => ({ query: q }))),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const r of await res.json()) if (r && r.query) dbx.putGeo(r.query, r);
    } catch (e) { console.error('[warn] geoip lookup failed:', e.message); }
  }
}

function geoFor(ip) {
  const g = dbx.getGeo(ip) || {};
  return { country: g.country || 'Unknown', countryCode: g.country_code || 'XX', city: g.city || '', org: g.org || g.asn || '' };
}

// ---------- feed polling ----------
async function poll() {
  try {
    const res = await fetch(CONFIG.feedUrl, { headers: { 'User-Agent': 'anti-ddosia-monitor/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lastModified = res.headers.get('last-modified');
    const json = await res.json();
    const raw = Array.isArray(json) ? json : json.targets || [];

    await enrichGeoIp([...new Set(raw.map((t) => t.ip).filter(Boolean))]);
    const nowIso = new Date().toISOString();

    dbx.tx(() => {
      for (const t of raw) {
        if (t.host) dbx.putHostFirstSeen(t.host, nowIso);
        if (t.target_id) dbx.putTargetFirstSeen(t.target_id, nowIso);
      }
    });

    const targets = raw.map((t) => {
      const geo = geoFor(t.ip);
      return {
        target_id: t.target_id, host: t.host, ip: t.ip, type: t.type, method: t.method,
        port: t.port, use_ssl: t.use_ssl, path: t.path || '', ...geo,
        firstSeen: dbx.getTargetFirstSeen(t.target_id) || nowIso,
        hostFirstSeen: dbx.getHostFirstSeen(t.host) || nowIso,
      };
    });

    const day = nowIso.slice(0, 10);
    const typeCounts = {};
    for (const t of targets) typeCounts[t.type] = (typeCounts[t.type] || 0) + 1;
    dbx.putDay(day, nowIso, targets.length, new Set(targets.map((x) => x.host)).size, new Set(targets.map((x) => x.ip)).size, typeCounts);

    current = { ok: true, fetchedAt: nowIso, feedLastModified: lastModified, error: null, targets };
    console.log(`[poll] ${nowIso} ok — ${targets.length} targets, ${new Set(targets.map((x) => x.host)).size} hosts`);

    runMatching();
  } catch (e) {
    console.error('[poll] failed:', e.message);
    if (!current.ok) current = { ...current, error: e.message, fetchedAt: new Date().toISOString() };
  }
}

// ---------- asset matching / alerts ----------
function hostMatchesAsset(host, hostIps, asset) {
  const v = asset.value;
  if (asset.type === 'ip') return hostIps.includes(v);
  // domain: exact or subdomain
  return host === v || host.endsWith('.' + v);
}

function runMatching() {
  let assets;
  try { assets = dbx.allAssets(); } catch (e) { console.error('[match] load assets failed:', e.message); return; }
  if (!assets.length) return;
  const hosts = buildHosts(); // [{host, ips[], targetCount, types{}}]
  const nowIso = new Date().toISOString();

  for (const asset of assets) {
    for (const h of hosts) {
      if (!hostMatchesAsset(h.host, h.ips, asset)) continue;
      const ipsStr = h.ips.join(', ');
      const typesStr = Object.keys(h.types).join(', ');
      if (dbx.alertPairExists(asset.id, h.host)) {
        dbx.upsertAlertSeen(asset.id, h.host, ipsStr, h.targetCount, typesStr, nowIso);
      } else {
        const created = dbx.insertAlert({
          userId: asset.user_id, assetId: asset.id, assetValue: asset.value,
          host: h.host, ips: ipsStr, vectors: h.targetCount, types: typesStr,
          firstMatched: nowIso, lastSeen: nowIso,
        });
        if (created) {
          const alert = { asset_value: asset.value, target_host: h.host, target_ips: ipsStr, vectors: h.targetCount, types: typesStr, first_matched: nowIso };
          deliverAlert({ email: asset.email, webhook_url: asset.webhook_url, email_alerts: asset.email_alerts }, alert);
          console.log(`[match] ALERT ${asset.email}: asset "${asset.value}" matches ${h.host}`);
        }
      }
    }
  }
}

// ---------- aggregations ----------
function tally(items, key) {
  const m = new Map();
  for (const x of items) { const k = x[key] ?? 'Unknown'; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count);
}
function topPaths(items, limit = 20) {
  const m = new Map();
  for (const x of items) {
    if (!x.path) continue;
    let e = m.get(x.path);
    if (!e) { e = { path: x.path, count: 0, hosts: new Set() }; m.set(x.path, e); }
    e.count++; e.hosts.add(x.host);
  }
  return [...m.values()].map((e) => ({ path: e.path, count: e.count, hosts: e.hosts.size })).sort((a, b) => b.count - a.count).slice(0, limit);
}
function buildHosts() {
  const map = new Map();
  for (const t of current.targets) {
    let h = map.get(t.host);
    if (!h) { h = { host: t.host, country: t.country, countryCode: t.countryCode, city: t.city, org: t.org, ips: new Set(), types: {}, methods: new Set(), ports: new Set(), paths: new Set(), ssl: false, targetCount: 0, firstSeen: t.hostFirstSeen, vectors: [] }; map.set(t.host, h); }
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
  return [...map.values()].map((h) => ({ ...h, ips: [...h.ips], methods: [...h.methods], ports: [...h.ports].sort((a, b) => a - b), paths: [...h.paths] })).sort((a, b) => b.targetCount - a.targetCount);
}
function buildStats() {
  const t = current.targets;
  const dayCutoff = Date.now() - 24 * 3600 * 1000;
  const newHosts = [...new Set(t.filter((x) => new Date(x.hostFirstSeen).getTime() >= dayCutoff).map((x) => x.host))];
  const trend = dbx.getTrend().slice(-2000).map((h) => ({ day: h.day, count: h.count, hosts: h.hosts, ips: h.ips }));
  const peak = trend.reduce((m, d) => (d.count > m.count ? d : m), { count: 0, day: null });
  const avg = trend.length ? Math.round(trend.reduce((s, d) => s + d.count, 0) / trend.length) : 0;
  return {
    ok: current.ok, fetchedAt: current.fetchedAt, feedLastModified: current.feedLastModified,
    totals: { targets: t.length, hosts: new Set(t.map((x) => x.host)).size, ips: new Set(t.map((x) => x.ip)).size, countries: new Set(t.map((x) => x.countryCode)).size, newHosts24h: newHosts.length },
    byType: tally(t, 'type'), byCountry: tally(t, 'country'), byPort: tally(t, 'port'), byMethod: tally(t, 'method'),
    topHosts: tally(t, 'host').slice(0, 15), topPaths: topPaths(t), newHosts,
    trend, trendPeak: peak, trendAvg: avg, historyDays: trend.length,
  };
}

// ---------- HTTP helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function sendJson(res, obj, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function isSecure(req) { return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https'; }
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = normalize(join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return void res.writeHead(403).end('Forbidden');
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
}

// asset value normalisation
function parseAsset(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((o) => Number(o) <= 255)) return { type: 'ip', value: v };
  const host = v.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/\.$/, '');
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && host.length <= 253) return { type: 'domain', value: host };
  return null;
}

// ---------- API ----------
async function handleApi(req, res, pathname) {
  const method = req.method;

  // --- auth ---
  if (pathname === '/api/register' && method === 'POST') {
    const b = await readBody(req);
    if (!auth.validEmail(b.email)) return sendJson(res, { error: 'Invalid email' }, 400);
    if (!auth.validPassword(b.password)) return sendJson(res, { error: 'Password must be at least 8 characters' }, 400);
    const email = b.email.trim().toLowerCase();
    if (dbx.getUserByEmail(email)) return sendJson(res, { error: 'Email already registered' }, 409);
    const id = dbx.createUser(email, auth.hashPassword(b.password), new Date().toISOString());
    const { token, exp } = auth.startSession(id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, exp, isSecure(req)));
    return sendJson(res, { email });
  }
  if (pathname === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const user = dbx.getUserByEmail(email);
    if (!user || !auth.verifyPassword(b.password || '', user.pass_hash)) return sendJson(res, { error: 'Wrong email or password' }, 401);
    const { token, exp } = auth.startSession(user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, exp, isSecure(req)));
    return sendJson(res, { email: user.email });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    const u = auth.currentUser(req);
    if (u) auth.endSession(u.token);
    res.setHeader('Set-Cookie', auth.clearCookie());
    return sendJson(res, { ok: true });
  }
  if (pathname === '/api/me') {
    const u = auth.currentUser(req);
    if (!u) return sendJson(res, { user: null });
    const full = dbx.getUserById(u.id);
    return sendJson(res, {
      user: { email: full.email, webhook_url: full.webhook_url || '', email_alerts: !!full.email_alerts, inapp_alerts: !!full.inapp_alerts },
      unseen: dbx.unseenCount(u.id), emailConfigured: emailConfigured(),
    });
  }

  // everything below requires auth
  const user = auth.currentUser(req);
  const needsAuth = ['/api/assets', '/api/alerts', '/api/settings'].some((p) => pathname.startsWith(p));
  if (needsAuth && !user) return sendJson(res, { error: 'Not authenticated' }, 401);

  if (pathname === '/api/assets' && method === 'GET') return sendJson(res, { assets: dbx.listAssets(user.id) });
  if (pathname === '/api/assets' && method === 'POST') {
    const b = await readBody(req);
    const parsed = parseAsset(b.value);
    if (!parsed) return sendJson(res, { error: 'Enter a valid domain (example.com) or IPv4 address' }, 400);
    const added = dbx.addAsset(user.id, parsed.type, parsed.value, (b.label || '').slice(0, 80), new Date().toISOString());
    if (!added) return sendJson(res, { error: 'Asset already on your list' }, 409);
    runMatching(); // alert immediately if it's already being targeted
    return sendJson(res, { assets: dbx.listAssets(user.id) });
  }
  if (pathname.startsWith('/api/assets/') && method === 'DELETE') {
    const id = Number(pathname.split('/').pop());
    dbx.deleteAsset(id, user.id);
    return sendJson(res, { assets: dbx.listAssets(user.id) });
  }
  if (pathname === '/api/alerts' && method === 'GET') return sendJson(res, { alerts: dbx.listAlerts(user.id), unseen: dbx.unseenCount(user.id) });
  if (pathname === '/api/alerts/seen' && method === 'POST') { dbx.markAlertsSeen(user.id); return sendJson(res, { ok: true }); }
  if (pathname === '/api/settings' && method === 'POST') {
    const b = await readBody(req);
    let webhook = String(b.webhook_url || '').trim();
    if (webhook && !/^https?:\/\//i.test(webhook)) return sendJson(res, { error: 'Webhook must be an http(s) URL' }, 400);
    dbx.updateUserSettings(user.id, webhook, b.email_alerts ? 1 : 0, b.inapp_alerts ? 1 : 0);
    return sendJson(res, { ok: true });
  }

  // public data endpoints
  if (pathname === '/api/targets') return sendJson(res, current);
  if (pathname === '/api/stats') return sendJson(res, buildStats());
  if (pathname === '/api/hosts') return sendJson(res, { ok: current.ok, fetchedAt: current.fetchedAt, hosts: buildHosts() });
  if (pathname === '/api/health') return sendJson(res, { ok: current.ok, fetchedAt: current.fetchedAt, error: current.error });

  return sendJson(res, { error: 'Not found' }, 404);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return serveStatic(req, res);
  } catch (e) {
    sendJson(res, { error: e.message || 'server error' }, e.message === 'invalid JSON' || e.message === 'body too large' ? 400 : 500);
  }
});

server.listen(CONFIG.port, () => {
  console.log(`anti-DDoSia running → http://localhost:${CONFIG.port}`);
  console.log(`feed: ${CONFIG.feedUrl}  poll: every ${CONFIG.pollMs / 60000} min  email: ${emailConfigured() ? 'configured' : 'off'}`);
  dbx.gcSessions(new Date().toISOString());
  poll();
  setInterval(poll, CONFIG.pollMs);
  setInterval(() => dbx.gcSessions(new Date().toISOString()), 3600 * 1000);
});
