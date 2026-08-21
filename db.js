// anti-DDoSia — data layer (SQLite via built-in node:sqlite)
//
// One file: data/ddosia.db. Holds operational data (GeoIP cache, daily
// history, host/target first-seen) and product data (users, sessions,
// assets, alerts). On first run it migrates any existing data/*.json
// (from earlier JSON-file versions / backfill) into the DB.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || join(DATA_DIR, 'ddosia.db');

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS geoip (
  ip TEXT PRIMARY KEY, country TEXT, country_code TEXT, city TEXT,
  region_name TEXT, org TEXT, asn TEXT
);
CREATE TABLE IF NOT EXISTS history (
  day TEXT PRIMARY KEY, t TEXT, count INTEGER, hosts INTEGER, ips INTEGER, types_json TEXT
);
-- per-day distinct sets, so hosts/ips/countries can be counted over any window
CREATE TABLE IF NOT EXISTS day_agg (
  day TEXT PRIMARY KEY, hosts TEXT NOT NULL DEFAULT '[]', ips TEXT NOT NULL DEFAULT '[]', ccs TEXT NOT NULL DEFAULT '[]'
);
-- per-day count breakdowns (representative snapshot of the day) for windowed bars
CREATE TABLE IF NOT EXISTS day_breakdown (
  day TEXT PRIMARY KEY, cc_counts TEXT NOT NULL DEFAULT '{}', method_counts TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS host_first_seen ( host TEXT PRIMARY KEY, first_seen TEXT );
CREATE TABLE IF NOT EXISTS target_first_seen ( target_id TEXT PRIMARY KEY, first_seen TEXT );
CREATE TABLE IF NOT EXISTS country_alltime ( code TEXT PRIMARY KEY, country TEXT, hosts INTEGER, targets INTEGER );
CREATE TABLE IF NOT EXISTS attack_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL, started TEXT NOT NULL, last_seen TEXT NOT NULL, ended TEXT
);
CREATE INDEX IF NOT EXISTS idx_as_host ON attack_session(host);
CREATE INDEX IF NOT EXISTS idx_as_active ON attack_session(host) WHERE ended IS NULL;
CREATE TABLE IF NOT EXISTS host_country ( host TEXT PRIMARY KEY, code TEXT, country TEXT );
CREATE TABLE IF NOT EXISTS host_surface ( host TEXT PRIMARY KEY, paths TEXT, ports TEXT, types TEXT, methods TEXT );
CREATE TABLE IF NOT EXISTS host_day_surface ( host TEXT, day TEXT, data TEXT, PRIMARY KEY(host, day) );
CREATE INDEX IF NOT EXISTS idx_hds_host ON host_day_surface(host);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  webhook_url TEXT,
  email_alerts INTEGER NOT NULL DEFAULT 1,
  inapp_alerts INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,            -- 'domain' | 'ip'
  value TEXT NOT NULL,          -- normalised (lowercase host / ip)
  label TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, type, value)
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  asset_value TEXT NOT NULL,
  target_host TEXT NOT NULL,
  target_ips TEXT,
  vectors INTEGER,
  types TEXT,
  first_matched TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  UNIQUE(asset_id, target_host)
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, first_matched DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);
try { db.exec('ALTER TABLE users ADD COLUMN provider TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE host_surface ADD COLUMN ips TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE host_surface ADD COLUMN by_ip TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE alerts ADD COLUMN active INTEGER NOT NULL DEFAULT 1'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE alerts ADD COLUMN resolved_at TEXT'); } catch { /* column exists */ }

// ---------------- one-time migration from JSON ----------------
(function migrateFromJson() {
  if (process.env.DB_FILE) return; // custom DB (e.g. tests) — don't import the app's JSON
  const have = db.prepare('SELECT COUNT(*) c FROM history').get().c;
  if (have > 0) return;
  const stateFile = join(DATA_DIR, 'state.json');
  const geoFile = join(DATA_DIR, 'geoip-cache.json');
  let migrated = false;
  try {
    if (existsSync(geoFile)) {
      const g = JSON.parse(readFileSync(geoFile, 'utf8'));
      const stmt = db.prepare('INSERT OR REPLACE INTO geoip(ip,country,country_code,city,region_name,org,asn) VALUES(?,?,?,?,?,?,?)');
      const tx = db.prepare('BEGIN'); tx.run();
      for (const [ip, v] of Object.entries(g)) stmt.run(ip, v.country || '', v.countryCode || '', v.city || '', v.regionName || '', v.org || '', v.as || '');
      db.prepare('COMMIT').run();
      migrated = true;
    }
    if (existsSync(stateFile)) {
      const s = JSON.parse(readFileSync(stateFile, 'utf8'));
      db.prepare('BEGIN').run();
      const hstmt = db.prepare('INSERT OR REPLACE INTO history(day,t,count,hosts,ips,types_json) VALUES(?,?,?,?,?,?)');
      for (const h of s.history || []) hstmt.run(h.t.slice(0, 10), h.t, h.count, h.hosts, h.ips, JSON.stringify(h.types || {}));
      const fstmt = db.prepare('INSERT OR REPLACE INTO host_first_seen(host,first_seen) VALUES(?,?)');
      for (const [host, iso] of Object.entries(s.firstSeenHost || {})) fstmt.run(host, iso);
      const tstmt = db.prepare('INSERT OR REPLACE INTO target_first_seen(target_id,first_seen) VALUES(?,?)');
      for (const [tid, iso] of Object.entries(s.firstSeenTarget || {})) tstmt.run(tid, iso);
      db.prepare('COMMIT').run();
      migrated = true;
    }
  } catch (e) {
    console.error('[db] JSON migration warning:', e.message);
  }
  if (migrated) console.log('[db] migrated existing JSON data into SQLite');
})();

// ---------------- prepared statements ----------------
const S = {
  geoGet: db.prepare('SELECT * FROM geoip WHERE ip = ?'),
  geoPut: db.prepare('INSERT OR REPLACE INTO geoip(ip,country,country_code,city,region_name,org,asn) VALUES(?,?,?,?,?,?,?)'),
  histPut: db.prepare('INSERT OR REPLACE INTO history(day,t,count,hosts,ips,types_json) VALUES(?,?,?,?,?,?)'),
  histTrend: db.prepare('SELECT day,count,hosts,ips FROM history ORDER BY day ASC'),
  histBounds: db.prepare('SELECT MIN(day) mn, MAX(day) mx FROM history'),
  histRange: db.prepare('SELECT day, count, hosts, ips FROM history WHERE day BETWEEN ? AND ? ORDER BY day ASC'),
  dayAggGet: db.prepare('SELECT hosts, ips, ccs FROM day_agg WHERE day = ?'),
  dayAggPut: db.prepare('INSERT OR REPLACE INTO day_agg(day,hosts,ips,ccs) VALUES(?,?,?,?)'),
  dayAggRange: db.prepare('SELECT hosts, ips, ccs FROM day_agg WHERE day BETWEEN ? AND ?'),
  dayAggClear: db.prepare('DELETE FROM day_agg'),
  dayBrkPut: db.prepare('INSERT OR REPLACE INTO day_breakdown(day,cc_counts,method_counts) VALUES(?,?,?)'),
  dayBrkRange: db.prepare('SELECT cc_counts, method_counts FROM day_breakdown WHERE day BETWEEN ? AND ?'),
  dayBrkClear: db.prepare('DELETE FROM day_breakdown'),
  newHostsBetween: db.prepare('SELECT COUNT(*) c FROM host_first_seen WHERE first_seen BETWEEN ? AND ?'),
  hfsGet: db.prepare('SELECT first_seen FROM host_first_seen WHERE host = ?'),
  // earliest-wins upsert: keeps the minimum date seen for a host/target
  hfsPut: db.prepare('INSERT INTO host_first_seen(host,first_seen) VALUES(?,?) ON CONFLICT(host) DO UPDATE SET first_seen=excluded.first_seen WHERE excluded.first_seen < host_first_seen.first_seen'),
  tfsGet: db.prepare('SELECT first_seen FROM target_first_seen WHERE target_id = ?'),
  tfsPut: db.prepare('INSERT INTO target_first_seen(target_id,first_seen) VALUES(?,?) ON CONFLICT(target_id) DO UPDATE SET first_seen=excluded.first_seen WHERE excluded.first_seen < target_first_seen.first_seen'),

  userCreate: db.prepare('INSERT INTO users(email,pass_hash,created_at) VALUES(?,?,?)'),
  userCreateOAuth: db.prepare("INSERT INTO users(email,pass_hash,created_at,provider) VALUES(?,'',?,?)"),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userSettings: db.prepare('UPDATE users SET webhook_url=?, email_alerts=?, inapp_alerts=? WHERE id=?'),

  sessCreate: db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)'),
  sessGet: db.prepare('SELECT s.*, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE token = ?'),
  sessDel: db.prepare('DELETE FROM sessions WHERE token = ?'),
  sessGc: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

  assetAdd: db.prepare('INSERT OR IGNORE INTO assets(user_id,type,value,label,created_at) VALUES(?,?,?,?,?)'),
  assetList: db.prepare('SELECT * FROM assets WHERE user_id = ? ORDER BY created_at DESC'),
  assetDel: db.prepare('DELETE FROM assets WHERE id = ? AND user_id = ?'),
  assetAll: db.prepare('SELECT a.*, u.email, u.webhook_url, u.email_alerts, u.inapp_alerts FROM assets a JOIN users u ON u.id=a.user_id'),

  // re-match: refresh detail, bump last_seen, and re-open if it had resolved (fresh unseen ping too)
  alertUpsertSeen: db.prepare('UPDATE alerts SET last_seen=?, target_ips=?, vectors=?, types=?, active=1, resolved_at=NULL, seen=CASE WHEN active=0 THEN 0 ELSE seen END WHERE asset_id=? AND target_host=?'),
  alertInsert: db.prepare('INSERT OR IGNORE INTO alerts(user_id,asset_id,asset_value,target_host,target_ips,vectors,types,first_matched,last_seen,active) VALUES(?,?,?,?,?,?,?,?,?,1)'),
  alertGetPair: db.prepare('SELECT id FROM alerts WHERE asset_id=? AND target_host=?'),
  alertList: db.prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY active DESC, COALESCE(resolved_at, last_seen) DESC, first_matched DESC LIMIT 200'),
  alertUnseen: db.prepare('SELECT COUNT(*) c FROM alerts WHERE user_id = ? AND seen = 0'),
  alertActiveCount: db.prepare('SELECT COUNT(*) c FROM alerts WHERE user_id = ? AND active = 1'),
  alertMarkSeen: db.prepare('UPDATE alerts SET seen = 1 WHERE user_id = ?'),
  // after a matching pass: anything still active but not touched this run has left the list
  alertResolveStale: db.prepare('UPDATE alerts SET active=0, resolved_at=? WHERE active=1 AND last_seen<>?'),

  countryPut: db.prepare('INSERT OR REPLACE INTO country_alltime(code,country,hosts,targets) VALUES(?,?,?,?)'),
  countryAll: db.prepare('SELECT code,country,hosts,targets FROM country_alltime ORDER BY targets DESC'),
  countryClear: db.prepare('DELETE FROM country_alltime'),

  asActiveStart: db.prepare('SELECT started FROM attack_session WHERE host = ? AND ended IS NULL ORDER BY started DESC LIMIT 1'),
  asActiveHosts: db.prepare('SELECT host FROM attack_session WHERE ended IS NULL'),
  asOpen: db.prepare('INSERT INTO attack_session(host,started,last_seen) VALUES(?,?,?)'),
  asTouch: db.prepare('UPDATE attack_session SET last_seen = ? WHERE host = ? AND ended IS NULL'),
  asClose: db.prepare('UPDATE attack_session SET ended = last_seen WHERE host = ? AND ended IS NULL'),
  asInsertFull: db.prepare('INSERT INTO attack_session(host,started,last_seen,ended) VALUES(?,?,?,?)'),
  asClear: db.prepare('DELETE FROM attack_session'),
  asMost: db.prepare('SELECT host, COUNT(*) sessions, MAX(COALESCE(ended,last_seen)) last_seen, SUM(ended IS NULL) active FROM attack_session GROUP BY host ORDER BY sessions DESC, last_seen DESC LIMIT ?'),
  asLongest: db.prepare("SELECT host, started, ended, (julianday(COALESCE(ended,'now')) - julianday(started)) days FROM attack_session ORDER BY days DESC LIMIT ?"),
  // windowed: longest stints overlapping [fromIso, toIso]  (started <= to AND end >= from)
  asLongestWin: db.prepare("SELECT host, started, ended, (julianday(COALESCE(ended,'now')) - julianday(started)) days FROM attack_session WHERE started <= ? AND COALESCE(ended,'9999-12-31T23:59:59Z') >= ? ORDER BY days DESC LIMIT ?"),
  asByHost: db.prepare("SELECT started, ended, last_seen, (julianday(COALESCE(ended,'now')) - julianday(started)) days FROM attack_session WHERE host = ? ORDER BY started DESC LIMIT ?"),
  asAll: (() => {
    const cols = "a.host host, MAX(hc.code) code, MAX(hc.country) country, COUNT(*) sessions, MAX(COALESCE(a.ended,a.last_seen)) last, SUM(julianday(COALESCE(a.ended,'now'))-julianday(a.started)) total, MAX(julianday(COALESCE(a.ended,'now'))-julianday(a.started)) longest, SUM(a.ended IS NULL) active";
    const from = "FROM attack_session a LEFT JOIN host_country hc ON hc.host = a.host WHERE a.host LIKE ? ESCAPE '\\' AND (? = '' OR hc.code = ?) GROUP BY a.host ";
    return {
      sessions: db.prepare(`SELECT ${cols} ${from} ORDER BY sessions DESC, last DESC LIMIT ?`),
      recent: db.prepare(`SELECT ${cols} ${from} ORDER BY last DESC LIMIT ?`),
      longest: db.prepare(`SELECT ${cols} ${from} ORDER BY longest DESC LIMIT ?`),
      name: db.prepare(`SELECT ${cols} ${from} ORDER BY a.host ASC LIMIT ?`),
    };
  })(),
  hcPut: db.prepare('INSERT OR REPLACE INTO host_country(host,code,country) VALUES(?,?,?)'),
  hcClear: db.prepare('DELETE FROM host_country'),
  hsurfGet: db.prepare('SELECT paths, ports, types, methods, ips, by_ip FROM host_surface WHERE host = ?'),
  hsurfPut: db.prepare('INSERT OR REPLACE INTO host_surface(host,paths,ports,types,methods,ips,by_ip) VALUES(?,?,?,?,?,?,?)'),
  hsurfClear: db.prepare('DELETE FROM host_surface'),
  hdsPut: db.prepare('INSERT OR REPLACE INTO host_day_surface(host,day,data) VALUES(?,?,?)'),
  hdsClear: db.prepare('DELETE FROM host_day_surface'),
  hdsRange: db.prepare('SELECT data FROM host_day_surface WHERE host = ? AND day >= ? AND day <= ?'),

  cntHosts: db.prepare('SELECT COUNT(*) c FROM host_first_seen'),
  cntGeo: db.prepare('SELECT COUNT(*) c FROM geoip'),
  sumReq: db.prepare('SELECT COALESCE(SUM(targets),0) s FROM country_alltime'),
  cntDays: db.prepare('SELECT COUNT(*) c FROM history'),
};

// GeoIP
export function getGeo(ip) { return S.geoGet.get(ip); }
export function putGeo(ip, v) { S.geoPut.run(ip, v.country || '', v.countryCode || '', v.city || '', v.regionName || '', v.org || '', v.as || ''); }

// history + first-seen
export function putDay(day, t, count, hosts, ips, types) { S.histPut.run(day, t, count, hosts, ips, JSON.stringify(types || {})); }
export function getTrend() { return S.histTrend.all(); }
export function historyBounds() { const r = S.histBounds.get(); return { min: r?.mn || null, max: r?.mx || null }; }

// ---- per-day distinct sets (for windowed hosts/ips/countries) ----
export function clearDayAgg() { S.dayAggClear.run(); }
export function putDayAgg(day, hosts, ips, ccs) { S.dayAggPut.run(day, JSON.stringify(hosts || []), JSON.stringify(ips || []), JSON.stringify(ccs || [])); }
// union today's snapshot into the stored per-day set (accumulate across polls)
export function mergeDayAgg(day, hosts, ips, ccs) {
  const cur = S.dayAggGet.get(day);
  const H = new Set(cur ? JSON.parse(cur.hosts) : []); for (const h of hosts) H.add(h);
  const I = new Set(cur ? JSON.parse(cur.ips) : []); for (const i of ips) I.add(i);
  const C = new Set(cur ? JSON.parse(cur.ccs) : []); for (const c of ccs) C.add(c);
  S.dayAggPut.run(day, JSON.stringify([...H]), JSON.stringify([...I]), JSON.stringify([...C]));
}
export function clearDayBreakdown() { S.dayBrkClear.run(); }
export function putDayBreakdown(day, ccCounts, methodCounts) { S.dayBrkPut.run(day, JSON.stringify(ccCounts || {}), JSON.stringify(methodCounts || {})); }

// aggregate distinct hosts/ips/countries + request totals + country/method
// breakdowns over an inclusive day range
export function periodStats(fromDay, toDay, fromIso, toIso) {
  const H = new Set(), I = new Set(), C = new Set(), hostDays = new Map();
  for (const r of S.dayAggRange.all(fromDay, toDay)) {
    try {
      for (const h of JSON.parse(r.hosts)) { H.add(h); hostDays.set(h, (hostDays.get(h) || 0) + 1); }
      for (const i of JSON.parse(r.ips)) I.add(i);
      for (const c of JSON.parse(r.ccs)) C.add(c);
    } catch { /* skip */ }
  }
  const hist = S.histRange.all(fromDay, toDay);
  let requests = 0, peak = { day: null, count: 0 };
  for (const d of hist) { requests += d.count || 0; if ((d.count || 0) > peak.count) peak = { day: d.day, count: d.count }; }
  const avg = hist.length ? Math.round(requests / hist.length) : 0;
  const newHosts = S.newHostsBetween.get(fromIso, toIso).c;

  // summed country/method breakdowns over the window
  const cc = new Map(), me = new Map();
  for (const r of S.dayBrkRange.all(fromDay, toDay)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(r.cc_counts))) cc.set(k, (cc.get(k) || 0) + v);
      for (const [k, v] of Object.entries(JSON.parse(r.method_counts))) me.set(k, (me.get(k) || 0) + v);
    } catch { /* skip */ }
  }
  const names = new Map(S.countryAll.all().map((c) => [c.code, c.country]));
  const byCountry = [...cc.entries()].map(([code, count]) => ({ code, key: names.get(code) || code, count })).sort((a, b) => b.count - a.count).slice(0, 10);
  const byMethod = [...me.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  const trend = hist.map((d) => ({ day: d.day, count: d.count, hosts: d.hosts, ips: d.ips }));
  // most-targeted over a window = most days present on the list (discriminates at any window size)
  const mostTargeted = [...hostDays.entries()].map(([host, days]) => ({ host, days })).sort((a, b) => b.days - a.days).slice(0, 10);
  const longestAttacks = S.asLongestWin.all(toIso, fromIso, 10);
  return { hosts: H.size, ips: I.size, countries: C.size, requests, peak, avg, days: hist.length, newHosts, byCountry, byMethod, trend, mostTargeted, longestAttacks };
}
export function getHostFirstSeen(host) { return S.hfsGet.get(host)?.first_seen || null; }
export function putHostFirstSeen(host, iso) { S.hfsPut.run(host, iso); }
export function getTargetFirstSeen(id) { return S.tfsGet.get(id)?.first_seen || null; }
export function putTargetFirstSeen(id, iso) { S.tfsPut.run(id, iso); }
export function tx(fn) { db.prepare('BEGIN').run(); try { fn(); db.prepare('COMMIT').run(); } catch (e) { db.prepare('ROLLBACK').run(); throw e; } }

// users
export function createUser(email, passHash, iso) { const r = S.userCreate.run(email, passHash, iso); return Number(r.lastInsertRowid); }
export function createOAuthUser(email, provider, iso) { const r = S.userCreateOAuth.run(email, iso, provider); return Number(r.lastInsertRowid); }
export function findOrCreateOAuthUser(email, provider, iso) { const u = S.userByEmail.get(email); if (u) return u.id; return createOAuthUser(email, provider, iso); }
export function getUserByEmail(email) { return S.userByEmail.get(email); }
export function getUserById(id) { return S.userById.get(id); }
export function updateUserSettings(id, webhookUrl, emailAlerts, inappAlerts) { S.userSettings.run(webhookUrl || null, emailAlerts ? 1 : 0, inappAlerts ? 1 : 0, id); }

// sessions
export function createSession(token, userId, createdIso, expiresIso) { S.sessCreate.run(token, userId, createdIso, expiresIso); }
export function getSession(token) { return S.sessGet.get(token); }
export function deleteSession(token) { S.sessDel.run(token); }
export function gcSessions(nowIso) { S.sessGc.run(nowIso); }

// assets
export function addAsset(userId, type, value, label, iso) { const r = S.assetAdd.run(userId, type, value, label || null, iso); return Number(r.changes) > 0; }
export function listAssets(userId) { return S.assetList.all(userId); }
export function deleteAsset(id, userId) { return Number(S.assetDel.run(id, userId).changes) > 0; }
export function allAssets() { return S.assetAll.all(); }

// alerts
export function alertPairExists(assetId, host) { return !!S.alertGetPair.get(assetId, host); }
export function upsertAlertSeen(assetId, host, ips, vectors, types, lastSeen) { S.alertUpsertSeen.run(lastSeen, ips, vectors, types, assetId, host); }
export function insertAlert(a) { const r = S.alertInsert.run(a.userId, a.assetId, a.assetValue, a.host, a.ips, a.vectors, a.types, a.firstMatched, a.lastSeen); return Number(r.changes) > 0; }
export function listAlerts(userId) { return S.alertList.all(userId); }
export function unseenCount(userId) { return S.alertUnseen.get(userId).c; }
export function activeAlertCount(userId) { return S.alertActiveCount.get(userId).c; }
export function markAlertsSeen(userId) { S.alertMarkSeen.run(userId); }
// Resolve alerts whose target left the list this poll (last_seen older than nowIso).
export function resolveStaleAlerts(nowIso) { return Number(S.alertResolveStale.run(nowIso, nowIso).changes); }

// all-time country aggregation
export function putCountry(code, country, hosts, targets) { S.countryPut.run(code, country, hosts, targets); }
export function allCountries() { return S.countryAll.all(); }
export function clearCountries() { S.countryClear.run(); }

// attack sessions (a host's continuous stint on the target list)
export function activeSessionStart(host) { return S.asActiveStart.get(host)?.started || null; }
export function updateSessions(currentHosts, nowIso, openIso) {
  const startIso = openIso || nowIso; // new stints start when the config was published, not "now"
  tx(() => {
    const active = new Set(S.asActiveHosts.all().map((r) => r.host));
    for (const h of currentHosts) { if (active.has(h)) S.asTouch.run(nowIso, h); else S.asOpen.run(h, startIso, nowIso); }
    const cur = new Set(currentHosts);
    for (const h of active) if (!cur.has(h)) S.asClose.run(h);
  });
}
export function clearSessions() { S.asClear.run(); }
export function insertSession(host, started, lastSeen, ended) { S.asInsertFull.run(host, started, lastSeen, ended); }
export function mostTargeted(limit = 10) { return S.asMost.all(limit); }
export function longestAttacks(limit = 10) { return S.asLongest.all(limit); }
export function hostsAll(q = '', sort = 'sessions', country = '', limit = 200) {
  const like = '%' + String(q || '').replace(/[%_\\]/g, (c) => '\\' + c) + '%';
  const stmt = S.asAll[sort] || S.asAll.sessions;
  const cc = String(country || '').toUpperCase();
  return { hosts: stmt.all(like, cc, cc, limit) };
}
export function putHostCountry(host, code, country) { S.hcPut.run(host, code, country); }
export function clearHostCountry() { S.hcClear.run(); }
export function putHostSurface(host, paths, ports, types, methods, ips, byIp) { S.hsurfPut.run(host, JSON.stringify(paths), JSON.stringify(ports), JSON.stringify(types), JSON.stringify(methods), JSON.stringify(ips || []), JSON.stringify(byIp || {})); }
export function clearHostSurface() { S.hsurfClear.run(); }
// per-day surface (for per-session attack detail); data = {p:[[path,count]],po:[ports],ty:{type:count},me:[methods],ip:[ips]}
export function putHostDay(host, day, data) { S.hdsPut.run(host, day, JSON.stringify(data)); }
export function clearHostDay() { S.hdsClear.run(); }
export function sessionDetail(host, from, to) {
  const rows = S.hdsRange.all(host, from, to);
  const paths = new Map(), ports = new Set(), types = {}, methods = new Set(), ips = new Set();
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    for (const [p, c] of (d.p || [])) paths.set(p, (paths.get(p) || 0) + c);
    for (const x of (d.po || [])) ports.add(x);
    for (const [t, c] of Object.entries(d.ty || {})) types[t] = (types[t] || 0) + c;
    for (const m of (d.me || [])) methods.add(m);
    for (const i of (d.ip || [])) ips.add(i);
  }
  return { days: rows.length, paths: [...paths.entries()].sort((a, b) => b[1] - a[1]), ports: [...ports].sort((a, b) => a - b), types, methods: [...methods], ips: [...ips] };
}
export function getHostSurface(host) {
  const r = S.hsurfGet.get(host);
  if (!r) return null;
  try { return { paths: JSON.parse(r.paths || '[]'), ports: JSON.parse(r.ports || '[]'), types: JSON.parse(r.types || '{}'), methods: JSON.parse(r.methods || '[]'), ips: JSON.parse(r.ips || '[]'), byIp: JSON.parse(r.by_ip || '{}') }; } catch { return null; }
}
export function hostSessions(host, limit = 200) {
  const sessions = S.asByHost.all(host, limit);
  const summary = {
    count: sessions.length,
    totalDays: sessions.reduce((s, r) => s + r.days, 0),
    longest: sessions.reduce((m, r) => Math.max(m, r.days), 0),
    firstSeen: sessions.length ? sessions[sessions.length - 1].started : null,
    lastSeen: sessions.length ? (sessions[0].ended || sessions[0].last_seen) : null,
    active: sessions.some((r) => !r.ended),
  };
  return { host, sessions, summary, surface: getHostSurface(host) };
}

// cumulative all-time counts
export function cumulative() {
  return {
    hosts: S.cntHosts.get().c,
    ips: S.cntGeo.get().c,
    requests: S.sumReq.get().s,
    days: S.cntDays.get().c,
  };
}
