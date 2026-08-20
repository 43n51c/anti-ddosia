// anti-DDoSia — OAuth sign-in (dependency-free)
//
// Supports Google and GitHub. Each provider is enabled only when its
// client id + secret are set in the environment:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
// Register the redirect URI  <APP_URL>/auth/<provider>/callback  in the
// provider's console (e.g. http://localhost:3000/auth/google/callback).

import { randomBytes } from 'node:crypto';

const PROVIDERS = {
  google: {
    label: 'Google',
    id: () => process.env.GOOGLE_CLIENT_ID,
    secret: () => process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email',
    extra: { access_type: 'online', prompt: 'select_account' },
    async fetchEmail(token) {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (j.email && (j.email_verified === undefined || j.email_verified)) return j.email;
      return null;
    },
  },
  github: {
    label: 'GitHub',
    id: () => process.env.GITHUB_CLIENT_ID,
    secret: () => process.env.GITHUB_CLIENT_SECRET,
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'user:email',
    extra: {},
    async fetchEmail(token) {
      const r = await fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'anti-ddosia', Accept: 'application/vnd.github+json' } });
      const arr = await r.json();
      if (!Array.isArray(arr)) return null;
      const pick = arr.find((e) => e.primary && e.verified) || arr.find((e) => e.verified) || arr[0];
      return pick ? pick.email : null;
    },
  },
};

export function isEnabled(p) { const c = PROVIDERS[p]; return !!(c && c.id() && c.secret()); }
export function enabledProviders() { return Object.keys(PROVIDERS).filter(isEnabled).map((k) => ({ key: k, label: PROVIDERS[k].label })); }
export function redirectUri(p) { const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''); return `${base}/auth/${p}/callback`; }

export function authorizeUrl(p, state) {
  const c = PROVIDERS[p];
  const q = new URLSearchParams({ client_id: c.id(), redirect_uri: redirectUri(p), response_type: 'code', scope: c.scope, state, ...c.extra });
  return `${c.authUrl}?${q}`;
}
export async function exchangeCode(p, code) {
  const c = PROVIDERS[p];
  const body = new URLSearchParams({ client_id: c.id(), client_secret: c.secret(), code, redirect_uri: redirectUri(p), grant_type: 'authorization_code' });
  const r = await fetch(c.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || j.error || 'token exchange failed');
  return j.access_token;
}
export async function emailForToken(p, token) { return PROVIDERS[p].fetchEmail(token); }
export function newState() { return randomBytes(16).toString('hex'); }
