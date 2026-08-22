// anti-DDoSia — authentication helpers (zero-dependency)
//
// Password hashing with scrypt (salted, constant-time compare) and
// opaque random session tokens stored in the DB, delivered as an
// HttpOnly cookie.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import * as store from './db.js';

const SESSION_DAYS = 30;
const COOKIE = 'sid';

// ---------- password hashing ----------
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
// a real hash to verify against when there is no user / no stored password, so
// login timing doesn't reveal whether an account exists (user enumeration)
export const DUMMY_HASH = hashPassword('anti-ddosia-timing-equalizer');
export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

// ---------- validation ----------
export function validEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254; }
export function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }

// ---------- sessions ----------
export function startSession(userId) {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400 * 1000);
  store.createSession(token, userId, now.toISOString(), exp.toISOString());
  return { token, exp };
}
export function endSession(token) { if (token) store.deleteSession(token); }

// cookie helpers
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function sessionCookie(token, exp, secure) {
  const attrs = [`${COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Expires=${exp.toUTCString()}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
export function clearCookie() { return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`; }

// resolve the current user from the request cookie (or null)
export function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = store.getSession(token);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) { store.deleteSession(token); return null; }
  return { id: s.user_id, email: s.email, token };
}
