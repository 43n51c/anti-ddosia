import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as oauth from '../oauth.js';

test('isEnabled: false without client id/secret', () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.equal(oauth.isEnabled('google'), false);
  assert.equal(oauth.isEnabled('nonexistent'), false);
});

test('isEnabled/enabledProviders: true when both creds set', () => {
  process.env.GOOGLE_CLIENT_ID = 'gid';
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
  assert.equal(oauth.isEnabled('google'), true);
  const keys = oauth.enabledProviders().map((p) => p.key);
  assert.ok(keys.includes('google'));
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

test('redirectUri derives from APP_URL and strips trailing slash', () => {
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://guard.example.com/';
  assert.equal(oauth.redirectUri('google'), 'https://guard.example.com/auth/google/callback');
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;
});

test('authorizeUrl builds a proper OAuth request', () => {
  process.env.GOOGLE_CLIENT_ID = 'gid';
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
  const u = new URL(oauth.authorizeUrl('google', 'STATE123'));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), 'gid');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('state'), 'STATE123');
  assert.equal(u.searchParams.get('scope'), 'openid email');
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

test('newState returns unique high-entropy hex', () => {
  const a = oauth.newState();
  const b = oauth.newState();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});
