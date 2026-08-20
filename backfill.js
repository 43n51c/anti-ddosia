// anti-DDoSia — history backfill
//
// Downloads one archived DDoSia target-list snapshot per day for the given
// year (default 2026) from witha.name, computes daily stats + per-host
// first-seen dates, and writes the result into the SQLite DB so the
// dashboard's trend chart and "new host" logic reflect real history.
//
//   node backfill.js            # backfill 2026
//   node backfill.js 2025       # backfill a different year
//   node backfill.js all        # backfill the entire archive (every year)
//
// Safe to re-run: history days are overwritten and first-seen is earliest-wins.

import * as dbx from './db.js';

const BASE = 'https://witha.name/data/';
const YEAR = process.argv[2] || '2026'; // a 4-digit year, or "all" for the whole archive
const ALL = /^all$/i.test(YEAR);
const CONCURRENCY = 10;

const GEOIP_URL = 'http://ip-api.com/batch?fields=query,country,countryCode,city,regionName,org,as';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GeoIP unique IPs not already cached (rate-limited for ip-api free tier)
async function enrichGeoIp(ips) {
  const missing = ips.filter((ip) => ip && !dbx.getGeo(ip));
  if (!missing.length) return;
  console.log(`  geoip: resolving ${missing.length} new IPs…`);
  let done = 0;
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(GEOIP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chunk.map((q) => ({ query: q }))) });
        if (res.status === 429) { await sleep(6000); continue; } // rate limited — back off and retry same chunk
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        dbx.tx(() => { for (const r of rows) if (r && r.query) dbx.putGeo(r.query, r); });
        done += chunk.length;
        break;
      } catch (e) { if (attempt === 4) console.error('  [warn] geoip chunk gave up:', e.message); else await sleep(3000); }
    }
    if (done % 500 < 100) process.stdout.write(`\r  geoip: ${done}/${missing.length}…`);
    await sleep(1600); // stay under ip-api's 45 req/min
  }
  process.stdout.write('\n');
}

async function fetchText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'anti-ddosia-backfill/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

// Run tasks with a bounded worker pool, preserving result order.
async function pool(items, worker, size) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
      done++;
      if (done % 20 === 0 || done === items.length) {
        process.stdout.write(`\r  processed ${done}/${items.length} days…`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  process.stdout.write('\n');
  return results;
}

async function main() {
  console.log(`Backfilling ${ALL ? 'the entire archive' : YEAR} from ${BASE}\n`);

  console.log('Fetching archive index…');
  const html = await fetchText(BASE);
  const files = [...html.matchAll(/href="(\d{4}-\d{2}-\d{2}_[\d-]+_DDoSia-target-list-full\.json)"/g)].map((m) => m[1]);
  const yearFiles = ALL ? files : files.filter((f) => f.startsWith(`${YEAR}-`));

  // One file per day: the earliest snapshot that day.
  const perDay = new Map();
  for (const f of yearFiles) {
    const day = f.slice(0, 10);
    if (!perDay.has(day)) perDay.set(day, f); // files are listed chronologically
  }
  const days = [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const range = days.length ? `${days[0][0]} … ${days[days.length - 1][0]}` : '—';
  console.log(`Found ${yearFiles.length} snapshots across ${days.length} days (${range}).\n`);
  if (!days.length) { console.log('Nothing to backfill.'); return; }

  const hostSet = new Set();
  const summary = [];
  const recs = [];          // [host, ip] per target appearance across all days
  const uniqIps = new Set();
  const hostDays = new Map(); // host -> Set(day) for attack-session reconstruction

  await pool(days, async ([day, file]) => {
    let targets = [];
    try {
      const json = JSON.parse(await fetchText(BASE + file));
      targets = Array.isArray(json) ? json : json.targets || [];
    } catch (e) {
      console.error(`\n  [warn] ${file}: ${e.message}`);
      return;
    }
    const hosts = new Set();
    const ips = new Set();
    const types = {};
    const dayStartIso = `${day}T00:00:00.000Z`;
    dbx.tx(() => {
      for (const t of targets) {
        if (t.host) { hosts.add(t.host); hostSet.add(t.host); dbx.putHostFirstSeen(t.host, dayStartIso); }
        if (t.ip) { ips.add(t.ip); uniqIps.add(t.ip); }
        if (t.type) types[t.type] = (types[t.type] || 0) + 1;
        if (t.host && t.ip) recs.push([t.host, t.ip]);
      }
      dbx.putDay(day, `${day}T12:00:00.000Z`, targets.length, hosts.size, ips.size, types);
    });
    for (const host of hosts) { let hs = hostDays.get(host); if (!hs) { hs = new Set(); hostDays.set(host, hs); } hs.add(day); }
    summary.push({ day, count: targets.length });
  }, CONCURRENCY);

  summary.sort((a, b) => a.day.localeCompare(b.day));
  const totalTargets = summary.reduce((s, h) => s + h.count, 0);
  const peak = summary.reduce((m, h) => (h.count > m.count ? h : m), summary[0] || { count: 0, day: '—' });

  // ---- all-time country aggregation (needs GeoIP of every historical IP) ----
  await enrichGeoIp([...uniqIps]);
  const byCode = new Map(); // code -> { country, hosts:Set, targets }
  for (const [host, ip] of recs) {
    const g = dbx.getGeo(ip); if (!g) continue;
    const code = g.country_code || 'XX';
    let e = byCode.get(code);
    if (!e) { e = { country: g.country || 'Unknown', hosts: new Set(), targets: 0 }; byCode.set(code, e); }
    e.hosts.add(host); e.targets++;
  }
  dbx.clearCountries();
  dbx.tx(() => { for (const [code, e] of byCode) dbx.putCountry(code, e.country, e.hosts.size, e.targets); });

  // ---- host -> country (most common country among the host's IPs) ----
  const hostCC = new Map(); // host -> Map(code -> count)
  for (const [host, ip] of recs) {
    const g = dbx.getGeo(ip); if (!g) continue;
    let m = hostCC.get(host); if (!m) { m = new Map(); hostCC.set(host, m); }
    m.set(g.country_code || 'XX', (m.get(g.country_code || 'XX') || 0) + 1);
  }
  dbx.clearHostCountry();
  dbx.tx(() => {
    for (const [host, m] of hostCC) {
      let best = 'XX', bestN = -1;
      for (const [code, n] of m) if (n > bestN) { best = code; bestN = n; }
      const cn = byCode.get(best)?.country || best;
      dbx.putHostCountry(host, best, cn);
    }
  });

  // ---- reconstruct attack sessions (runs of consecutive days on the list) ----
  const GAP = 2; // tolerate up to 2 missing archived days within one stint
  const latest = days[days.length - 1][0];
  const toNum = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
  let sessCount = 0, longest = { host: '—', days: 0 };
  dbx.clearSessions();
  dbx.tx(() => {
    for (const [host, set] of hostDays) {
      const ds = [...set].sort();
      let runStart = ds[0], prev = ds[0];
      const flush = (endDay) => {
        const ongoing = endDay === latest;
        dbx.insertSession(host, `${runStart}T00:00:00.000Z`, `${endDay}T12:00:00.000Z`, ongoing ? null : `${endDay}T12:00:00.000Z`);
        const len = toNum(endDay) - toNum(runStart) + 1;
        if (len > longest.days) longest = { host, days: len };
        sessCount++;
      };
      for (let i = 1; i < ds.length; i++) { if (toNum(ds[i]) - toNum(prev) > GAP) { flush(prev); runStart = ds[i]; } prev = ds[i]; }
      flush(prev);
    }
  });

  console.log(`\nDone. Wrote ${summary.length} daily points to SQLite (data/ddosia.db)`);
  console.log(`  Distinct hosts tracked: ${hostSet.size}`);
  console.log(`  Countries targeted all-time: ${byCode.size}`);
  console.log(`  Attack sessions reconstructed: ${sessCount} (longest: ${longest.host} ~${Math.round(longest.days)}d)`);
  console.log(`  Peak day: ${peak.day} with ${peak.count} targets`);
  console.log(`  Avg targets/day: ${summary.length ? Math.round(totalTargets / summary.length) : 0}`);
}

main().catch((e) => { console.error('\nBackfill failed:', e.message); process.exit(1); });
