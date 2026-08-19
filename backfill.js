// anti-DDoSia — history backfill
//
// Downloads one archived DDoSia target-list snapshot per day for the given
// year (default 2026) from witha.name, computes daily stats + per-host
// first-seen dates, and merges the result into data/state.json so the
// dashboard's trend chart and "new host" logic reflect real history.
//
//   node backfill.js            # backfill 2026
//   node backfill.js 2025       # backfill a different year
//
// Safe to re-run: it merges (earliest-wins for first-seen, overwrites the
// day's history point).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const STATE_FILE = join(DATA_DIR, 'state.json');
const BASE = 'https://witha.name/data/';
const YEAR = process.argv[2] || '2026';
const CONCURRENCY = 8;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

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
  console.log(`Backfilling ${YEAR} from ${BASE}\n`);

  console.log('Fetching archive index…');
  const html = await fetchText(BASE);
  const files = [...html.matchAll(/href="(\d{4}-\d{2}-\d{2}_[\d-]+_DDoSia-target-list-full\.json)"/g)].map((m) => m[1]);
  const yearFiles = files.filter((f) => f.startsWith(`${YEAR}-`));

  // One file per day: the earliest snapshot that day.
  const perDay = new Map();
  for (const f of yearFiles) {
    const day = f.slice(0, 10);
    if (!perDay.has(day)) perDay.set(day, f); // files are listed chronologically
  }
  const days = [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`Found ${yearFiles.length} snapshots across ${days.length} days in ${YEAR}.\n`);
  if (!days.length) { console.log('Nothing to backfill.'); return; }

  const firstSeenHost = {}; // host -> earliest day ISO
  const history = [];

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
    for (const t of targets) {
      if (t.host) { hosts.add(t.host); if (!firstSeenHost[t.host] || dayStartIso < firstSeenHost[t.host]) firstSeenHost[t.host] = dayStartIso; }
      if (t.ip) ips.add(t.ip);
      if (t.type) types[t.type] = (types[t.type] || 0) + 1;
    }
    history.push({ t: `${day}T12:00:00.000Z`, count: targets.length, hosts: hosts.size, ips: ips.size, types });
  }, CONCURRENCY);

  history.sort((a, b) => a.t.localeCompare(b.t));

  // ----- merge into state.json -----
  const state = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    : { firstSeenHost: {}, firstSeenTarget: {}, history: [] };

  // First-seen: earliest wins.
  for (const [host, iso] of Object.entries(firstSeenHost)) {
    if (!state.firstSeenHost[host] || iso < state.firstSeenHost[host]) state.firstSeenHost[host] = iso;
  }

  // History: drop existing points for the backfilled days, then add ours.
  const backfilledDays = new Set(history.map((h) => h.t.slice(0, 10)));
  const kept = (state.history || []).filter((h) => !backfilledDays.has(h.t.slice(0, 10)));
  state.history = [...kept, ...history].sort((a, b) => a.t.localeCompare(b.t));

  writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');

  const totalTargets = history.reduce((s, h) => s + h.count, 0);
  const peak = history.reduce((m, h) => (h.count > m.count ? h : m), history[0]);
  console.log(`\nDone. Merged ${history.length} daily points into ${STATE_FILE}`);
  console.log(`  Hosts tracked in ${YEAR}: ${Object.keys(firstSeenHost).length}`);
  console.log(`  Peak day: ${peak.t.slice(0, 10)} with ${peak.count} targets`);
  console.log(`  Avg targets/day: ${Math.round(totalTargets / history.length)}`);
}

main().catch((e) => { console.error('\nBackfill failed:', e.message); process.exit(1); });
