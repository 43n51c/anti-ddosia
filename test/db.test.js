import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbFile, cleanupDb } from './helpers.js';

const DB = tempDbFile();
const dbx = await import('../db.js');

after(() => cleanupDb(DB));

test('createUser + getUserByEmail + getUserById', () => {
  const id = dbx.createUser('a@example.com', 'scrypt$aa$bb', '2026-01-01T00:00:00Z');
  assert.ok(id > 0);
  const byEmail = dbx.getUserByEmail('a@example.com');
  assert.equal(byEmail.id, id);
  assert.equal(dbx.getUserById(id).email, 'a@example.com');
});

test('duplicate email is rejected', () => {
  dbx.createUser('dup@example.com', 'h', '2026-01-01T00:00:00Z');
  assert.throws(() => dbx.createUser('dup@example.com', 'h', '2026-01-01T00:00:00Z'));
});

test('OAuth user create + findOrCreate is idempotent', () => {
  const id1 = dbx.findOrCreateOAuthUser('oauth@example.com', 'google', '2026-01-01T00:00:00Z');
  const id2 = dbx.findOrCreateOAuthUser('oauth@example.com', 'google', '2026-02-01T00:00:00Z');
  assert.equal(id1, id2);
});

test('sessions: create, get, expire-gc, delete', () => {
  const uid = dbx.createUser('s@example.com', 'h', '2026-01-01T00:00:00Z');
  dbx.createSession('tok-live', uid, '2026-01-01T00:00:00Z', '2999-01-01T00:00:00Z');
  dbx.createSession('tok-dead', uid, '2026-01-01T00:00:00Z', '2000-01-01T00:00:00Z');
  assert.equal(dbx.getSession('tok-live').user_id, uid);
  assert.equal(dbx.getSession('tok-live').email, 's@example.com'); // joined
  dbx.gcSessions('2026-08-20T00:00:00Z');
  assert.equal(dbx.getSession('tok-dead'), undefined);
  assert.ok(dbx.getSession('tok-live'));
  dbx.deleteSession('tok-live');
  assert.equal(dbx.getSession('tok-live'), undefined);
});

test('assets: add (dedup), list, delete scoped to owner', () => {
  const u1 = dbx.createUser('o1@example.com', 'h', '2026-01-01T00:00:00Z');
  const u2 = dbx.createUser('o2@example.com', 'h', '2026-01-01T00:00:00Z');
  assert.equal(dbx.addAsset(u1, 'domain', 'a.com', 'mine', '2026-01-01T00:00:00Z'), true);
  assert.equal(dbx.addAsset(u1, 'domain', 'a.com', 'dup', '2026-01-01T00:00:00Z'), false); // duplicate for same user
  assert.equal(dbx.addAsset(u2, 'domain', 'a.com', 'theirs', '2026-01-01T00:00:00Z'), true); // ok for another user
  assert.equal(dbx.listAssets(u1).length, 1);
  const assetId = dbx.listAssets(u1)[0].id;
  assert.equal(dbx.deleteAsset(assetId, u2), false); // wrong owner cannot delete
  assert.equal(dbx.deleteAsset(assetId, u1), true);
  assert.equal(dbx.listAssets(u1).length, 0);
});

test('alerts: insert once per (asset,host), upsert on repeat, unseen count', () => {
  const uid = dbx.createUser('al@example.com', 'h', '2026-01-01T00:00:00Z');
  dbx.addAsset(uid, 'domain', 'target.com', null, '2026-01-01T00:00:00Z');
  const assetId = dbx.listAssets(uid)[0].id;
  const base = { userId: uid, assetId, assetValue: 'target.com', host: 'target.com', ips: '1.2.3.4', vectors: 3, types: 'http', firstMatched: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z' };
  assert.equal(dbx.alertPairExists(assetId, 'target.com'), false);
  assert.equal(dbx.insertAlert(base), true);
  assert.equal(dbx.alertPairExists(assetId, 'target.com'), true);
  assert.equal(dbx.insertAlert(base), false); // second insert is a no-op (unique)
  dbx.upsertAlertSeen(assetId, 'target.com', '1.2.3.4, 5.6.7.8', 5, 'http, http2', '2026-01-02T00:00:00Z');
  assert.equal(dbx.unseenCount(uid), 1);
  dbx.markAlertsSeen(uid);
  assert.equal(dbx.unseenCount(uid), 0);
  assert.equal(dbx.listAlerts(uid).length, 1);
});

test('alert lifecycle: resolve when target leaves, reactivate on re-match', () => {
  const uid = dbx.createUser('life@example.com', 'h', '2026-01-01T00:00:00Z');
  dbx.addAsset(uid, 'domain', 'lc.com', null, '2026-01-01T00:00:00Z');
  const assetId = dbx.listAssets(uid)[0].id;
  const base = { userId: uid, assetId, assetValue: 'lc.com', host: 'lc.com', ips: '1.2.3.4', vectors: 2, types: 'http', firstMatched: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z' };
  dbx.insertAlert(base);
  assert.equal(dbx.activeAlertCount(uid), 1);

  // a later poll where lc.com is NOT touched → its last_seen stays old → resolved
  const poll2 = '2026-01-02T00:00:00Z';
  const changed = dbx.resolveStaleAlerts(poll2);
  assert.ok(changed >= 1);
  assert.equal(dbx.activeAlertCount(uid), 0);
  const a = dbx.listAlerts(uid).find((r) => r.target_host === 'lc.com');
  assert.equal(a.active, 0);
  assert.equal(a.resolved_at, poll2);

  // target reappears → upsertAlertSeen reactivates and clears resolved_at + re-pings unseen
  dbx.markAlertsSeen(uid);
  const poll3 = '2026-01-03T00:00:00Z';
  dbx.upsertAlertSeen(assetId, 'lc.com', '1.2.3.4', 4, 'http', poll3);
  assert.equal(dbx.activeAlertCount(uid), 1);
  const b = dbx.listAlerts(uid).find((r) => r.target_host === 'lc.com');
  assert.equal(b.active, 1);
  assert.equal(b.resolved_at, null);
  assert.equal(b.seen, 0); // reopened → unseen again
});

test('updateSessions: opens at publish time, touches, and closes stints', () => {
  dbx.clearSessions();
  // first config publication: two hosts appear
  dbx.updateSessions(['h1.com', 'h2.com'], '2026-01-01T00:05:00Z', '2026-01-01T00:00:00Z');
  assert.equal(dbx.activeSessionStart('h1.com'), '2026-01-01T00:00:00Z'); // started at openIso
  // next poll: h1 stays, h2 drops, h3 new
  dbx.updateSessions(['h1.com', 'h3.com'], '2026-01-02T00:05:00Z', '2026-01-02T00:00:00Z');
  assert.equal(dbx.activeSessionStart('h1.com'), '2026-01-01T00:00:00Z'); // same stint continues
  assert.equal(dbx.activeSessionStart('h2.com'), null); // closed
  assert.equal(dbx.activeSessionStart('h3.com'), '2026-01-02T00:00:00Z'); // new stint
  const hs = dbx.hostSessions('h1.com');
  assert.equal(hs.summary.active, true);
  assert.ok(hs.summary.count >= 1);
});

test('periodStats: distinct union across days + windowing', () => {
  dbx.clearDayAgg();
  // day 1: hosts a,b / ips 1.1.1.1 / cc US ; day 2: hosts b,c / ips 2.2.2.2 / cc US,CA
  dbx.putDayAgg('2026-03-01', ['a.com', 'b.com'], ['1.1.1.1'], ['US']);
  dbx.putDayAgg('2026-03-02', ['b.com', 'c.com'], ['2.2.2.2'], ['US', 'CA']);
  dbx.putDay('2026-03-01', '2026-03-01T12:00:00Z', 10, 2, 1, {});
  dbx.putDay('2026-03-02', '2026-03-02T12:00:00Z', 30, 2, 1, {});
  // host_first_seen for "new in window"
  dbx.putHostFirstSeen('a.com', '2026-03-01T00:00:00Z');
  dbx.putHostFirstSeen('c.com', '2026-03-02T00:00:00Z');

  const both = dbx.periodStats('2026-03-01', '2026-03-02', '2026-03-01T00:00:00Z', '2026-03-02T23:59:59Z');
  assert.equal(both.hosts, 3);       // a,b,c distinct across the window
  assert.equal(both.ips, 2);
  assert.equal(both.countries, 2);   // US,CA
  assert.equal(both.requests, 40);   // 10 + 30
  assert.equal(both.peak.count, 30);
  assert.equal(both.peak.day, '2026-03-02');
  assert.equal(both.avg, 20);
  assert.equal(both.days, 2);
  assert.equal(both.newHosts, 2);

  const d1 = dbx.periodStats('2026-03-01', '2026-03-01', '2026-03-01T00:00:00Z', '2026-03-01T23:59:59Z');
  assert.equal(d1.hosts, 2);         // only a,b
  assert.equal(d1.countries, 1);     // US
  assert.equal(d1.newHosts, 1);      // only a.com first-seen that day
});

test('mergeDayAgg unions into an existing day without dropping prior entries', () => {
  dbx.clearDayAgg();
  dbx.putDayAgg('2026-04-01', ['x.com'], ['1.1.1.1'], ['US']);
  dbx.mergeDayAgg('2026-04-01', ['y.com'], ['2.2.2.2'], ['CA']);
  const p = dbx.periodStats('2026-04-01', '2026-04-01', '2026-04-01T00:00:00Z', '2026-04-01T23:59:59Z');
  assert.equal(p.hosts, 2); // x + y
  assert.equal(p.ips, 2);
  assert.equal(p.countries, 2);
});

test('hostsAll: LIKE query escapes wildcards (no injection via %/_)', () => {
  dbx.clearSessions();
  dbx.insertSession('alpha.com', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
  dbx.insertSession('beta.com', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
  // '%' as a literal must not match everything
  assert.equal(dbx.hostsAll('%', 'sessions', '', 50).hosts.length, 0);
  assert.equal(dbx.hostsAll('alpha', 'sessions', '', 50).hosts.length, 1);
});
