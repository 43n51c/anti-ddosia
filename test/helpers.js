// Test helpers: give each test process an isolated throwaway SQLite file so
// importing db.js never touches the real data/ddosia.db.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

let counter = 0;
export function tempDbFile() {
  const p = join(tmpdir(), `ddosia-test-${process.pid}-${counter++}-${Date.now()}.db`);
  process.env.DB_FILE = p;
  return p;
}

export function cleanupDb(path) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(path + suffix, { force: true }); } catch { /* ignore */ }
  }
}
