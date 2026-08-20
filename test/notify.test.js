import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webhookUrlIssue, emailConfigured } from '../notify.js';

test('webhookUrlIssue: accepts public https/http URLs', () => {
  assert.equal(webhookUrlIssue('https://hooks.example.com/abc'), null);
  assert.equal(webhookUrlIssue('http://93.184.216.34/hook'), null); // public IP
});

test('webhookUrlIssue: rejects non-http schemes', () => {
  assert.match(webhookUrlIssue('ftp://example.com'), /http\(s\)/);
  assert.match(webhookUrlIssue('file:///etc/passwd'), /http\(s\)/);
  assert.match(webhookUrlIssue('gopher://x'), /http\(s\)/);
});

test('webhookUrlIssue: rejects malformed URLs', () => {
  assert.match(webhookUrlIssue('not a url'), /valid URL/);
  assert.match(webhookUrlIssue(''), /valid URL/);
});

test('webhookUrlIssue: blocks internal hostnames', () => {
  assert.match(webhookUrlIssue('http://localhost/x'), /internal/);
  assert.match(webhookUrlIssue('http://foo.localhost/x'), /internal/);
  assert.match(webhookUrlIssue('http://printer.local/x'), /internal/);
  assert.match(webhookUrlIssue('http://db.internal/x'), /internal/);
});

test('webhookUrlIssue: blocks private/reserved IPv4', () => {
  for (const h of ['10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.1.1', '172.16.0.1', '172.31.255.1', '192.168.1.1', '224.0.0.1', '255.255.255.255']) {
    assert.match(webhookUrlIssue(`http://${h}/x`), /private|reserved|invalid/, `${h} should be blocked`);
  }
});

test('webhookUrlIssue: allows public IPv4 near reserved ranges', () => {
  assert.equal(webhookUrlIssue('http://11.0.0.1/x'), null);
  assert.equal(webhookUrlIssue('http://172.15.0.1/x'), null); // just below 172.16
  assert.equal(webhookUrlIssue('http://172.32.0.1/x'), null); // just above 172.31
  assert.equal(webhookUrlIssue('http://8.8.8.8/x'), null);
});

test('webhookUrlIssue: blocks private/loopback IPv6', () => {
  assert.match(webhookUrlIssue('http://[::1]/x'), /IPv6/);
  assert.match(webhookUrlIssue('http://[fc00::1]/x'), /IPv6/);
  assert.match(webhookUrlIssue('http://[fd12::1]/x'), /IPv6/);
  assert.match(webhookUrlIssue('http://[fe80::1]/x'), /IPv6/);
});

test('emailConfigured reflects SMTP_HOST env (unset in tests)', () => {
  assert.equal(emailConfigured(), !!process.env.SMTP_HOST);
});
