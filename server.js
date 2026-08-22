// anti-DDoSia — server
//
// Polls the public DDoSia Project target feed, enriches targets with GeoIP,
// stores history/first-seen in SQLite, matches targets against user-owned
// assets and raises alerts (in-app + webhook + email), and serves the JSON
// API + static dashboard. No third-party deps (Node >= 22 for node:sqlite).

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, sep } from 'node:path';
import * as dbx from './db.js';
import * as auth from './auth.js';
import * as oauth from './oauth.js';
import { deliverAlert, emailConfigured, webhookUrlIssue } from './notify.js';
import { parseAsset, hostMatchesAsset } from './match.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  feedUrl: process.env.FEED_URL || 'https://witha.name/data/last.json',
  pollMs: (Number(process.env.POLL_MINUTES) || 1) * 60 * 1000,
  geoipBatchUrl: 'http://ip-api.com/batch?fields=query,country,countryCode,city,regionName,org,as',
  // Self-healing history: rebuild from the archive on first boot (empty DB) and
  // on a slow cadence, so gaps from downtime/source-outages backfill over time.
  autoBackfill: process.env.AUTO_BACKFILL !== '0',
  backfillMs: Math.max(1, Number(process.env.BACKFILL_HOURS) || 24) * 3600 * 1000,
  // Periodic consistent snapshot of the SQLite DB, keeping the last N.
  backup: process.env.BACKUP_ENABLED !== '0',
  backupMs: Math.max(1, Number(process.env.BACKUP_HOURS) || 24) * 3600 * 1000,
  backupKeep: Math.max(1, Number(process.env.BACKUP_KEEP) || 7),
  backupDir: process.env.BACKUP_DIR || join(__dirname, 'data', 'backups'),
};
const BACKFILL_SCRIPT = join(__dirname, 'backfill.js');

// Only one writer touches the ingest tables at a time: the minute poll and the
// (long) backfill must never interleave their writes.
let ingestBusy = false;

// In-memory snapshot served to clients.
let current = { ok: false, fetchedAt: null, feedLastModified: null, error: 'not fetched yet', targets: [] };
let feedETag = null; // for conditional requests (avoid re-downloading unchanged feed)
let configsTotal = null; // total archived config files (from the /data/ index)
// buildStats() aggregates several full-table scans; the snapshot only changes
// once per successful poll, so cache the result and invalidate by version.
let dataVersion = 0;
let statsCache = null, statsCacheVer = -1;
async function refreshConfigCount() {
  try {
    const dir = new URL('.', CONFIG.feedUrl).href;
    const html = await fetch(dir, { headers: { 'User-Agent': 'anti-ddosia-monitor/1.0' } }).then((r) => r.text());
    const m = html.match(/href="[^"]*_DDoSia-target-list-full\.json"/g);
    if (m && m.length !== configsTotal) { configsTotal = m.length; dataVersion++; }
  } catch (e) { /* keep previous value */ }
}

// ---------- GeoIP enrichment ----------
// fetch with a hard timeout so a stalled upstream can't wedge the ingest mutex
async function fetchT(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

async function enrichGeoIp(ips) {
  const missing = ips.filter((ip) => ip && !dbx.getGeo(ip));
  if (!missing.length) return;
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const res = await fetchT(CONFIG.geoipBatchUrl, {
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
  if (ingestBusy) return; // a backfill is rebuilding the tables — skip this tick
  ingestBusy = true;
  try {
    // Conditional request: only download the body when the feed actually changed.
    const headers = { 'User-Agent': 'anti-ddosia-monitor/1.0' };
    if (feedETag) headers['If-None-Match'] = feedETag;
    else if (current.feedLastModified) headers['If-Modified-Since'] = current.feedLastModified;

    const res = await fetchT(CONFIG.feedUrl, { headers });
    if (res.status === 304) { // unchanged — refresh the "last checked" time on both the snapshot and the cached stats
      const iso = new Date().toISOString();
      current.fetchedAt = iso;
      if (statsCache) statsCache.fetchedAt = iso;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feedETag = res.headers.get('etag') || feedETag;
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

    // Update attack sessions (start on first appearance, end on removal).
    // New stints are anchored to the config publication time (feed last-modified) for accurate onset.
    let openIso = nowIso;
    if (lastModified) { const d = new Date(lastModified); if (!isNaN(d)) openIso = d.toISOString(); }
    dbx.updateSessions([...new Set(raw.map((t) => t.host).filter(Boolean))], nowIso, openIso);

    // host-level lookups repeat across a host's many targets — resolve once per host
    const hostFS = new Map(), hostSS = new Map();
    const targets = raw.map((t) => {
      const geo = geoFor(t.ip);
      let hfs = hostFS.get(t.host);
      if (hfs === undefined) { hfs = dbx.getHostFirstSeen(t.host) || nowIso; hostFS.set(t.host, hfs); }
      let ss = hostSS.get(t.host);
      if (ss === undefined) { ss = dbx.activeSessionStart(t.host) || nowIso; hostSS.set(t.host, ss); }
      return {
        target_id: t.target_id, host: t.host, ip: t.ip, type: t.type, method: t.method,
        port: t.port, use_ssl: t.use_ssl, path: t.path || '', ...geo,
        firstSeen: dbx.getTargetFirstSeen(t.target_id) || nowIso,
        hostFirstSeen: hfs,
        sessionStart: ss,
      };
    });

    const day = nowIso.slice(0, 10);
    const typeCounts = {};
    for (const t of targets) typeCounts[t.type] = (typeCounts[t.type] || 0) + 1;
    dbx.putDay(day, nowIso, targets.length, new Set(targets.map((x) => x.host)).size, new Set(targets.map((x) => x.ip)).size, typeCounts);
    // accumulate today's distinct sets so windowed hosts/ips/countries stay accurate
    dbx.mergeDayAgg(day, [...new Set(targets.map((x) => x.host))], [...new Set(targets.map((x) => x.ip).filter(Boolean))], [...new Set(targets.map((x) => x.countryCode).filter((c) => c && c !== 'XX'))]);
    // today's representative breakdown (last poll wins): distinct host sets by
    // country / method, so period bars count hosts (matching the map)
    const ccHosts = {}, methodHosts = {};
    for (const t of targets) {
      if (t.countryCode && t.countryCode !== 'XX') (ccHosts[t.countryCode] ||= new Set()).add(t.host);
      if (t.method) (methodHosts[t.method] ||= new Set()).add(t.host);
    }
    const setsToLists = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v]]));
    dbx.putDayBreakdown(day, { cc: setsToLists(ccHosts), me: setsToLists(methodHosts) });
    // per-(host,day) surface so the current (ongoing) session has detail for today too
    const dayHostSurf = new Map();
    for (const t of raw) {
      if (!t.host) continue;
      let e = dayHostSurf.get(t.host);
      if (!e) { e = { p: new Map(), po: new Set(), ty: new Map(), me: new Set(), ip: new Set() }; dayHostSurf.set(t.host, e); }
      if (t.path && (e.p.size < 100 || e.p.has(t.path))) e.p.set(t.path, (e.p.get(t.path) || 0) + 1);
      if (t.port != null) e.po.add(t.port);
      if (t.type) e.ty.set(t.type, (e.ty.get(t.type) || 0) + 1);
      if (t.method) e.me.add(t.method);
      if (t.ip) e.ip.add(t.ip);
    }
    dbx.tx(() => { for (const [hn, e] of dayHostSurf) dbx.putHostDay(hn, day, { p: [...e.p.entries()], po: [...e.po].sort((a, b) => a - b), ty: Object.fromEntries(e.ty), me: [...e.me], ip: [...e.ip] }); });

    current = { ok: true, fetchedAt: nowIso, feedLastModified: lastModified, error: null, targets };
    dataVersion++; // snapshot + aggregates changed → invalidate the stats cache
    console.log(`[poll] ${nowIso} ok — ${targets.length} targets, ${new Set(targets.map((x) => x.host)).size} hosts`);

    runMatching();
  } catch (e) {
    console.error('[poll] failed:', e.message);
    if (!current.ok) current = { ...current, error: e.message, fetchedAt: new Date().toISOString() };
  } finally {
    ingestBusy = false;
  }
}

// ---------- history backfill (self-healing) ----------
// Runs on first boot (empty DB) and on a slow cadence so downtime/source-outage
// gaps fill in over time. The backfill downloads only NEW archived configs (the
// rest come from its on-disk cache) and its own guard refuses to apply a
// drastically-shrunken (degraded) fetch. It runs in a CHILD PROCESS so its
// CPU-heavy synchronous rebuild never blocks this server's event loop; the
// ingest mutex is held for its whole lifetime so the poll won't write meanwhile.
function backfillNow(reason) {
  return new Promise((resolve) => {
    if (ingestBusy) { console.log(`[backfill] skipped (${reason}) — ingest busy`); return resolve(); }
    ingestBusy = true;
    const t0 = Date.now();
    console.log(`[backfill] start (${reason}) → child process`);
    let child;
    try {
      child = spawn(process.execPath, [BACKFILL_SCRIPT, 'all'], { stdio: 'inherit', env: process.env });
    } catch (e) {
      console.error('[backfill] spawn failed:', e.message, '— existing data kept');
      ingestBusy = false; return resolve();
    }
    let done = false;
    const finish = (msg, level = 'log') => { if (done) return; done = true; if (msg) console[level]('[backfill]', msg); ingestBusy = false; resolve(); };
    child.on('error', (e) => finish(`child error: ${e.message} — existing data kept`, 'error'));
    child.on('exit', (code) => {
      if (code === 0) { dataVersion++; finish(`applied (${reason}) in ${Math.round((Date.now() - t0) / 1000)}s`); }
      else if (code === 2) finish('not applied (source degraded) — existing data kept', 'warn');
      else finish(`child exited ${code} — existing data kept`, 'error');
    });
  });
}

// ---------- periodic backups (consistent SQLite snapshot, keep last N) ----------
function backupNow() {
  try {
    if (!existsSync(CONFIG.backupDir)) mkdirSync(CONFIG.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(CONFIG.backupDir, `ddosia-${stamp}.db`);
    dbx.backupTo(dest); // VACUUM INTO — consistent single-file copy, safe under concurrent writes
    const keep = readdirSync(CONFIG.backupDir).filter((f) => /^ddosia-.*\.db$/.test(f)).sort();
    for (const old of keep.slice(0, Math.max(0, keep.length - CONFIG.backupKeep))) {
      try { rmSync(join(CONFIG.backupDir, old)); } catch { /* ignore */ }
    }
    console.log(`[backup] wrote ${dest} (keeping last ${CONFIG.backupKeep})`);
  } catch (e) {
    console.error('[backup] failed:', e.message);
  }
}

// ---------- asset matching / alerts ----------
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
      const notify = (verb) => {
        const alert = { asset_value: asset.value, target_host: h.host, target_ips: ipsStr, vectors: h.targetCount, types: typesStr, first_matched: nowIso };
        deliverAlert({ email: asset.email, webhook_url: asset.webhook_url, email_alerts: asset.email_alerts }, alert);
        console.log(`[match] ${verb} ${asset.email}: asset "${asset.value}" matches ${h.host}`);
      };
      if (dbx.alertPairExists(asset.id, h.host)) {
        // a resolved alert coming back is a fresh event → notify again, not just bump the badge
        const wasResolved = dbx.alertActive(asset.id, h.host) === 0;
        dbx.upsertAlertSeen(asset.id, h.host, ipsStr, h.targetCount, typesStr, nowIso);
        if (wasResolved) notify('RE-ALERT');
      } else {
        if (dbx.insertAlert({
          userId: asset.user_id, assetId: asset.id, assetValue: asset.value,
          host: h.host, ips: ipsStr, vectors: h.targetCount, types: typesStr,
          firstMatched: nowIso, lastSeen: nowIso,
        })) notify('ALERT');
      }
    }
  }
  // Alerts not touched this pass (target dropped off the list) are now resolved.
  const resolved = dbx.resolveStaleAlerts(nowIso);
  if (resolved) console.log(`[match] resolved ${resolved} alert(s) — targets left the list`);
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
  if (statsCache && statsCacheVer === dataVersion) return statsCache;
  const t = current.targets;
  const dayCutoff = Date.now() - 24 * 3600 * 1000;
  const newHosts = [...new Set(t.filter((x) => new Date(x.hostFirstSeen).getTime() >= dayCutoff).map((x) => x.host))];
  const trend = dbx.getTrend().slice(-2000).map((h) => ({ day: h.day, count: h.count, hosts: h.hosts, ips: h.ips }));
  const peak = trend.reduce((m, d) => (d.count > m.count ? d : m), { count: 0, day: null });
  const avg = trend.length ? Math.round(trend.reduce((s, d) => s + d.count, 0) / trend.length) : 0;
  const yesterdayCount = trend.length >= 2 ? trend[trend.length - 2].count : null;

  // Current "wave": the day the most of today's hosts first appeared.
  const perFirstDay = new Map(), seenHost = new Set();
  for (const x of t) {
    if (seenHost.has(x.host) || !x.hostFirstSeen) continue;
    seenHost.add(x.host);
    const d = x.hostFirstSeen.slice(0, 10);
    perFirstDay.set(d, (perFirstDay.get(d) || 0) + 1);
  }
  const waveSince = [...perFirstDay.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] || null;
  // Host rankings are ALL-TIME (a short window makes every host look identical —
  // 1 day on the list / one short stint / one wave), so compute them over the
  // full archive here rather than following the period switcher.
  const hb = dbx.historyBounds();
  const at = hb.min ? dbx.periodStats(hb.min, hb.max, hb.min + 'T00:00:00.000Z', hb.max + 'T23:59:59.999Z') : { mostTargeted: [], longestAttacks: [], mostWaves: [] };
  statsCache = {
    ok: current.ok, fetchedAt: current.fetchedAt, feedLastModified: current.feedLastModified,
    totals: { targets: t.length, hosts: new Set(t.map((x) => x.host)).size, ips: new Set(t.map((x) => x.ip)).size, countries: new Set(t.map((x) => x.countryCode)).size, newHosts24h: newHosts.length },
    byType: tally(t, 'type'), byCountry: tally(t, 'country'), byPort: tally(t, 'port'), byMethod: tally(t, 'method'),
    topHosts: tally(t, 'host').slice(0, 15), topPaths: topPaths(t), newHosts,
    trend, trendPeak: peak, trendAvg: avg, historyDays: trend.length,
    historyStart: dbx.historyBounds().min,
    yesterdayCount, waveSince,
    byCountryAllTime: dbx.allCountries().map((c) => ({ key: c.country, code: c.code, count: c.targets, hosts: c.hosts })),
    cumulative: { ...dbx.cumulative(), configs: configsTotal },
    ranks: { persistent: at.mostTargeted, longest: at.longestAttacks, recurring: at.mostWaves },
  };
  statsCacheVer = dataVersion;
  return statsCache;
}

// ---------- HTTP helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function sendJson(res, obj, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function isSecure(req) { return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https'; }
// X-Forwarded-For is client-controlled and only meaningful behind a trusted
// reverse proxy; trusting it when directly exposed lets an attacker forge a
// fresh IP per request and bypass the rate limiter. Opt in with TRUST_PROXY=1.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
function clientIp(req) {
  if (TRUST_PROXY) { const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (xff) return xff; }
  return req.socket.remoteAddress || 'unknown';
}

const CSP = [
  "default-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'", "object-src 'none'",
  // the sha256 allows the tiny inline boot script in index.html that applies the
  // URL-hash view before first paint (keep in sync if that script changes)
  "img-src 'self' data:", "script-src 'self' 'sha256-EPbtDCqJWKykUvOQBsOW73uQD7UCjbj1JIxPnkAbIlI='", "connect-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
].join('; ');
function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

// simple in-memory fixed-window rate limiter (per key)
const rlHits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (rlHits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); rlHits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, arr] of rlHits) { const keep = arr.filter((t) => now - t < 3600000); if (keep.length) rlHits.set(k, keep); else rlHits.delete(k); } }, 600000).unref?.();
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0; let over = false;
    req.on('data', (c) => {
      if (over) return; // stop buffering once past the limit; drain quietly so a clean 400 can still be sent
      size += c.length;
      if (size > limit) { over = true; reject(new Error('body too large')); return; }
      data += c;
    });
    req.on('end', () => { if (over) return; try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
async function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return void res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request'); } // malformed %-encoding
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = normalize(join(PUBLIC_DIR, urlPath));
  // Must resolve to PUBLIC_DIR itself or a path strictly beneath it — the
  // trailing separator prevents escaping to sibling dirs like /app/public-secret.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) return void res.writeHead(403).end('Forbidden');
  try {
    // no-cache = the browser may store it but must revalidate before use, so a
    // deploy is picked up immediately; Last-Modified makes that revalidation a
    // cheap 304 when the file hasn't changed.
    const st = await stat(filePath);
    const lastMod = st.mtime.toUTCString();
    const headers = { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Last-Modified': lastMod };
    const ims = Date.parse(req.headers['if-modified-since'] || '');
    if (!Number.isNaN(ims) && ims >= Math.floor(st.mtimeMs / 1000) * 1000) return void res.writeHead(304, headers).end();
    res.writeHead(200, headers);
    res.end(await readFile(filePath));
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
}

// public "am I a target?" check — no auth needed
function checkTarget(raw) {
  const parsed = parseAsset(raw);
  if (!parsed) return { ok: false, error: 'Enter a valid domain or IPv4', query: raw };
  const hosts = buildHosts();
  const matches = hosts
    .filter((h) => (parsed.type === 'ip' ? h.ips.includes(parsed.value) : (h.host === parsed.value || h.host.endsWith('.' + parsed.value))))
    .map((h) => ({ host: h.host, ips: h.ips, vectors: h.targetCount, types: Object.keys(h.types), ports: h.ports, country: h.country, city: h.city }));
  return { ok: true, query: parsed.value, type: parsed.type, targeted: matches.length > 0, matches };
}

// ---------- API ----------
async function handleApi(req, res, pathname) {
  const method = req.method;

  // --- auth ---
  if ((pathname === '/api/register' || pathname === '/api/login') && method === 'POST') {
    if (rateLimited('auth:' + clientIp(req), 12, 5 * 60 * 1000)) return sendJson(res, { error: 'Too many attempts — try again in a few minutes' }, 429);
  }
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
    // always run one scrypt (against a dummy hash when there's no user / no
    // password) so response time doesn't reveal whether the account exists
    const ok = auth.verifyPassword(b.password || '', (user && user.pass_hash) || auth.DUMMY_HASH);
    if (!user || !user.pass_hash || !ok) return sendJson(res, { error: 'Wrong email or password' }, 401);
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
      unseen: dbx.unseenCount(u.id), activeAlerts: dbx.activeAlertCount(u.id), emailConfigured: emailConfigured(), providers: oauth.enabledProviders(),
    });
  }
  if (pathname === '/api/providers') return sendJson(res, { providers: oauth.enabledProviders() });

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
  if (pathname === '/api/alerts' && method === 'GET') return sendJson(res, { alerts: dbx.listAlerts(user.id), unseen: dbx.unseenCount(user.id), active: dbx.activeAlertCount(user.id) });
  if (pathname === '/api/alerts/seen' && method === 'POST') { dbx.markAlertsSeen(user.id); return sendJson(res, { ok: true }); }
  if (pathname === '/api/settings' && method === 'POST') {
    const b = await readBody(req);
    let webhook = String(b.webhook_url || '').trim();
    if (webhook) { const issue = webhookUrlIssue(webhook); if (issue) return sendJson(res, { error: `Webhook ${issue}` }, 400); }
    dbx.updateUserSettings(user.id, webhook, b.email_alerts ? 1 : 0, b.inapp_alerts ? 1 : 0);
    return sendJson(res, { ok: true });
  }

  // public data endpoints — unauthenticated but each does a scan/DB query, so
  // cap per-IP throughput to blunt trivial hammering / enumeration.
  if (rateLimited('read:' + clientIp(req), 240, 60 * 1000)) return sendJson(res, { error: 'Too many requests — slow down' }, 429);
  if (pathname === '/api/targets') return sendJson(res, current);
  if (pathname === '/api/stats') return sendJson(res, buildStats());
  if (pathname === '/api/period') {
    const u = new URL(req.url, 'http://localhost').searchParams;
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    const bounds = dbx.historyBounds();
    let from = u.get('from') || '', to = u.get('to') || '';
    if (!dayRe.test(from)) from = bounds.min || '2023-06-01';
    if (!dayRe.test(to)) to = bounds.max || new Date().toISOString().slice(0, 10);
    if (from > to) { const t = from; from = to; to = t; }
    const stats = dbx.periodStats(from, to, from + 'T00:00:00.000Z', to + 'T23:59:59.999Z');
    return sendJson(res, { from, to, ...stats });
  }
  if (pathname === '/api/check') {
    const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
    return sendJson(res, checkTarget(q));
  }
  if (pathname === '/api/host-sessions') {
    const host = (new URL(req.url, 'http://localhost').searchParams.get('host') || '').toLowerCase().trim();
    return sendJson(res, dbx.hostSessions(host));
  }
  if (pathname === '/api/hosts-all') {
    const u = new URL(req.url, 'http://localhost').searchParams;
    return sendJson(res, dbx.hostsAll(u.get('q') || '', u.get('sort') || 'sessions', u.get('country') || '', 300));
  }
  if (pathname === '/api/session-detail') {
    const u = new URL(req.url, 'http://localhost').searchParams;
    return sendJson(res, dbx.sessionDetail((u.get('host') || '').toLowerCase(), u.get('from') || '', u.get('to') || ''));
  }
  if (pathname === '/api/hosts') return sendJson(res, { ok: current.ok, fetchedAt: current.fetchedAt, hosts: buildHosts() });
  // Liveness: is the process serving? Always ok while HTTP responds — a source
  // outage must NOT mark the container unhealthy (we still serve last-known data).
  if (pathname === '/api/health') return sendJson(res, { ok: true, feed: current.ok, fetchedAt: current.fetchedAt, ingesting: ingestBusy, error: current.error });
  // Readiness: do we have something to serve (live feed or stored history)?
  if (pathname === '/api/ready') { const ready = current.ok || dbx.historyBounds().min !== null; return sendJson(res, { ok: ready, feed: current.ok }, ready ? 200 : 503); }

  return sendJson(res, { error: 'Not found' }, 404);
}

// ---------- OAuth (Google / GitHub) ----------
async function handleOAuth(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['auth','google'(,'callback')]
  const provider = parts[1];
  if (!oauth.isEnabled(provider)) return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Provider not enabled');
  const secure = isSecure(req);

  if (parts.length === 2) { // start the flow
    const state = oauth.newState();
    res.setHeader('Set-Cookie', `oauth_state=${provider}:${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure ? '; Secure' : ''}`);
    return void res.writeHead(302, { Location: oauth.authorizeUrl(provider, state) }).end();
  }
  if (parts[2] === 'callback') {
    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookie = auth.parseCookies(req).oauth_state || '';
    const clear = 'oauth_state=; HttpOnly; Path=/; Max-Age=0';
    if (!code || !state || cookie !== `${provider}:${state}`) {
      res.setHeader('Set-Cookie', clear);
      return void res.writeHead(302, { Location: '/?auth=state' }).end();
    }
    try {
      const token = await oauth.exchangeCode(provider, code);
      const email = ((await oauth.emailForToken(provider, token)) || '').toLowerCase();
      if (!email) { res.setHeader('Set-Cookie', clear); return void res.writeHead(302, { Location: '/?auth=noemail' }).end(); }
      const uid = dbx.findOrCreateOAuthUser(email, provider, new Date().toISOString());
      const { token: sess, exp } = auth.startSession(uid);
      res.setHeader('Set-Cookie', [clear, auth.sessionCookie(sess, exp, secure)]);
      return void res.writeHead(302, { Location: '/' }).end();
    } catch (e) {
      console.error('[oauth] callback failed:', e.message);
      res.setHeader('Set-Cookie', clear);
      return void res.writeHead(302, { Location: '/?auth=error' }).end();
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
}

const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(res);
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (pathname.startsWith('/auth/')) return await handleOAuth(req, res, pathname);
    return serveStatic(req, res);
  } catch (e) {
    const bad = e.message === 'invalid JSON' || e.message === 'body too large';
    sendJson(res, { error: e.message || 'server error' }, bad ? 400 : 500);
    if (e.message === 'body too large') req.destroy(); // stop a client trickling more after the 400
  }
});

// Bootstrap network + timers only when run as the app entrypoint.
// Tests import this module with NO_LISTEN=1 to exercise handlers without side effects.
if (!process.env.NO_LISTEN) {
  server.listen(CONFIG.port, () => {
    console.log(`anti-DDoSia running → http://localhost:${CONFIG.port}`);
    console.log(`feed: ${CONFIG.feedUrl}  poll: every ${CONFIG.pollMs / 60000} min  email: ${emailConfigured() ? 'configured' : 'off'}`);
    console.log(`auto-backfill: ${CONFIG.autoBackfill ? `every ${CONFIG.backfillMs / 3600000}h` : 'off'}  backups: ${CONFIG.backup ? `every ${CONFIG.backupMs / 3600000}h, keep ${CONFIG.backupKeep}` : 'off'}`);
    dbx.gcSessions(new Date().toISOString());
    refreshConfigCount();
    setInterval(refreshConfigCount, 6 * 3600 * 1000);
    setInterval(() => dbx.gcSessions(new Date().toISOString()), 3600 * 1000);

    // First boot with an empty DB: build the whole archive in the background,
    // then start polling. Otherwise poll right away. Either way, re-backfill on
    // a slow cadence so gaps left by downtime/outages self-heal over time.
    const historyEmpty = dbx.historyBounds().min === null;
    if (CONFIG.autoBackfill && historyEmpty) {
      console.log('[boot] empty history — building the full archive in the background…');
      backfillNow('first-boot').finally(() => poll());
    } else {
      poll();
    }
    setInterval(poll, CONFIG.pollMs);
    if (CONFIG.autoBackfill) setInterval(() => backfillNow('scheduled'), CONFIG.backfillMs);

    // Periodic consistent snapshots (skip the empty-DB first-boot window).
    if (CONFIG.backup) {
      if (!historyEmpty) backupNow();
      setInterval(backupNow, CONFIG.backupMs);
    }
  });

  // Graceful shutdown: stop accepting, fold the WAL back, close cleanly.
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return; shuttingDown = true;
    console.log(`[shutdown] ${sig} — closing…`);
    server.close(() => { dbx.closeDb(); process.exit(0); });
    setTimeout(() => { dbx.closeDb(); process.exit(0); }, 8000).unref(); // force-exit if close hangs
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { server, checkTarget, buildStats, buildHosts };
