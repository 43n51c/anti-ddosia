import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbFile, cleanupDb } from './helpers.js';

// Import the server without starting its network listener / poll loop.
process.env.NO_LISTEN = '1';
const DB = tempDbFile();
const { server } = await import('../server.js');

let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});
after(() => { server.close(); cleanupDb(DB); });

const j = async (path, opts) => {
  const res = await fetch(base + path, opts);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, res };
};

test('security headers are set on every response', async () => {
  const { res } = await j('/api/health');
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('GET /api/health returns status shape', async () => {
  const { status, body } = await j('/api/health');
  assert.equal(status, 200);
  assert.ok('ok' in body && 'fetchedAt' in body);
});

test('GET /api/check validates and reports non-target', async () => {
  const bad = await j('/api/check?q=' + encodeURIComponent('not a host'));
  assert.equal(bad.body.ok, false);
  const ok = await j('/api/check?q=example.com');
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.type, 'domain');
  assert.equal(ok.body.targeted, false); // empty DB
});

test('POST /api/register: validation + duplicate + cookie', async () => {
  const badEmail = await j('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nope', password: 'longenough1' }) });
  assert.equal(badEmail.status, 400);

  const shortPw = await j('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'u@example.com', password: 'short' }) });
  assert.equal(shortPw.status, 400);

  const ok = await j('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'U@Example.com', password: 'longenough1' }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, 'u@example.com'); // normalised
  const cookie = ok.res.headers.get('set-cookie');
  assert.match(cookie, /sid=/);
  assert.match(cookie, /HttpOnly/);

  const dup = await j('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'u@example.com', password: 'longenough1' }) });
  assert.equal(dup.status, 409);
});

test('auth flow: register → me → protected asset add → check reflects it', async () => {
  const reg = await j('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'flow@example.com', password: 'longenough1' }) });
  const cookie = reg.res.headers.get('set-cookie').split(';')[0];

  // unauthenticated protected route
  const noAuth = await j('/api/assets');
  assert.equal(noAuth.status, 401);

  // authenticated
  const me = await j('/api/me', { headers: { cookie } });
  assert.equal(me.body.user.email, 'flow@example.com');

  const add = await j('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ value: 'mytarget.com' }) });
  assert.equal(add.status, 200);
  assert.ok(add.body.assets.some((a) => a.value === 'mytarget.com'));
});

test('POST /api/settings rejects SSRF webhook URLs', async () => {
  const reg = await j('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'set@example.com', password: 'longenough1' }) });
  const cookie = reg.res.headers.get('set-cookie').split(';')[0];
  const bad = await j('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ webhook_url: 'http://169.254.169.254/latest/meta-data/' }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /private|reserved|internal/i);
});

test('unknown API route → 404', async () => {
  const { status } = await j('/api/does-not-exist');
  assert.equal(status, 404);
});

test('oversized request body is rejected', async () => {
  const huge = 'x'.repeat(100 * 1024); // exceeds 64KB readBody limit
  const { status } = await j('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.com', password: huge }) });
  assert.equal(status, 400);
});

// Keep this LAST: it exhausts the per-IP public-read budget for the window.
test('public read endpoints are rate limited', async () => {
  let got429 = false;
  for (let i = 0; i < 260; i++) {
    const { status } = await j('/api/targets');
    if (status === 429) { got429 = true; break; }
  }
  assert.ok(got429, 'expected a 429 after exceeding the public-read rate limit');
});
