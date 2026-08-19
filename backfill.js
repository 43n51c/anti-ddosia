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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        if (t.ip) ips.add(t.ip);
        if (t.type) types[t.type] = (types[t.type] || 0) + 1;
      }
      dbx.putDay(day, `${day}T12:00:00.000Z`, targets.length, hosts.size, ips.size, types);
    });
    summary.push({ day, count: targets.length });
  }, CONCURRENCY);

  summary.sort((a, b) => a.day.localeCompare(b.day));
  const totalTargets = summary.reduce((s, h) => s + h.count, 0);
  const peak = summary.reduce((m, h) => (h.count > m.count ? h : m), summary[0] || { count: 0, day: '—' });
  console.log(`\nDone. Wrote ${summary.length} daily points to SQLite (data/ddosia.db)`);
  console.log(`  Distinct hosts tracked: ${hostSet.size}`);
  console.log(`  Peak day: ${peak.day} with ${peak.count} targets`);
  console.log(`  Avg targets/day: ${summary.length ? Math.round(totalTargets / summary.length) : 0}`);
}

main().catch((e) => { console.error('\nBackfill failed:', e.message); process.exit(1); });
