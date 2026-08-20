import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbFile } from './helpers.js';

// auth.js transitively imports db.js (opens a DB on load) — isolate it first.
tempDbFile();
const { hashPassword, verifyPassword, validEmail, validPassword, parseCookies, sessionCookie, clearCookie } = await import('../auth.js');

test('hashPassword/verifyPassword round-trip', () => {
  const stored = hashPassword('correct horse battery');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(verifyPassword('correct horse battery', stored), true);
  assert.equal(verifyPassword('wrong password', stored), false);
});

test('hashPassword salts: same password → different hashes', () => {
  assert.notEqual(hashPassword('samepass1'), hashPassword('samepass1'));
});

test('verifyPassword tolerates malformed stored values', () => {
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
  assert.equal(verifyPassword('x', 'bcrypt$aa$bb'), false); // wrong scheme
  assert.equal(verifyPassword('x', null), false);
});

test('validEmail', () => {
  assert.equal(validEmail('a@b.co'), true);
  assert.equal(validEmail('user.name+tag@sub.example.com'), true);
  assert.equal(validEmail('no-at-sign'), false);
  assert.equal(validEmail('a@b'), false); // no dot in domain
  assert.equal(validEmail('a b@c.com'), false); // space
  assert.equal(validEmail('a@b.com\r\nBcc: x@y.com'), false); // header injection
  assert.equal(validEmail('a@' + 'b'.repeat(300) + '.com'), false); // too long
  assert.equal(validEmail(123), false);
});

test('validPassword length bounds', () => {
  assert.equal(validPassword('1234567'), false); // 7
  assert.equal(validPassword('12345678'), true); // 8
  assert.equal(validPassword('x'.repeat(200)), true);
  assert.equal(validPassword('x'.repeat(201)), false);
  assert.equal(validPassword(12345678), false);
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies({ headers: {} }), {});
  assert.deepEqual(parseCookies({ headers: { cookie: 'sid=abc; theme=dark' } }), { sid: 'abc', theme: 'dark' });
  assert.deepEqual(parseCookies({ headers: { cookie: 'x=a%20b' } }), { x: 'a b' });
});

test('sessionCookie flags', () => {
  const exp = new Date('2030-01-01T00:00:00Z');
  const c = sessionCookie('tok', exp, false);
  assert.match(c, /^sid=tok;/);
  assert.ok(c.includes('HttpOnly'));
  assert.ok(c.includes('SameSite=Lax'));
  assert.ok(!c.includes('Secure'));
  assert.ok(sessionCookie('tok', exp, true).includes('Secure'));
});

test('clearCookie expires immediately', () => {
  assert.ok(clearCookie().includes('Max-Age=0'));
  assert.ok(clearCookie().includes('HttpOnly'));
});
