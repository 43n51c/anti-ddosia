import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAsset, hostMatchesAsset } from '../match.js';

test('parseAsset: valid IPv4', () => {
  assert.deepEqual(parseAsset('8.8.8.8'), { type: 'ip', value: '8.8.8.8' });
  assert.deepEqual(parseAsset(' 192.168.1.1 '), { type: 'ip', value: '192.168.1.1' });
  assert.deepEqual(parseAsset('255.255.255.255'), { type: 'ip', value: '255.255.255.255' });
});

test('parseAsset: rejects out-of-range octets', () => {
  assert.equal(parseAsset('256.1.1.1'), null);
  assert.equal(parseAsset('999.999.999.999'), null);
});

test('parseAsset: valid domains, normalised', () => {
  assert.deepEqual(parseAsset('Example.COM'), { type: 'domain', value: 'example.com' });
  assert.deepEqual(parseAsset('https://sub.example.com/path?q=1'), { type: 'domain', value: 'sub.example.com' });
  assert.deepEqual(parseAsset('http://example.com:8443/x'), { type: 'domain', value: 'example.com' });
  assert.deepEqual(parseAsset('example.com.'), { type: 'domain', value: 'example.com' });
});

test('parseAsset: rejects junk', () => {
  assert.equal(parseAsset(''), null);
  assert.equal(parseAsset('   '), null);
  assert.equal(parseAsset('not a domain'), null);
  assert.equal(parseAsset('localhost'), null); // no TLD
  assert.equal(parseAsset(null), null);
  assert.equal(parseAsset(undefined), null);
});

test('parseAsset: rejects over-length host', () => {
  const long = 'a'.repeat(250) + '.com';
  assert.equal(parseAsset(long), null);
});

test('hostMatchesAsset: IP asset matches only by resolved IP', () => {
  const asset = { type: 'ip', value: '1.2.3.4' };
  assert.equal(hostMatchesAsset('x.com', ['1.2.3.4'], asset), true);
  assert.equal(hostMatchesAsset('x.com', ['9.9.9.9'], asset), false);
  assert.equal(hostMatchesAsset('x.com', [], asset), false);
});

test('hostMatchesAsset: domain asset matches exact host and subdomains', () => {
  const asset = { type: 'domain', value: 'example.com' };
  assert.equal(hostMatchesAsset('example.com', [], asset), true);
  assert.equal(hostMatchesAsset('epaper.example.com', [], asset), true);
  assert.equal(hostMatchesAsset('a.b.example.com', [], asset), true);
});

test('hostMatchesAsset: domain asset does NOT match sibling/suffix tricks', () => {
  const asset = { type: 'domain', value: 'example.com' };
  assert.equal(hostMatchesAsset('notexample.com', [], asset), false); // suffix without dot boundary
  assert.equal(hostMatchesAsset('example.com.evil.com', [], asset), false);
  assert.equal(hostMatchesAsset('example.org', [], asset), false);
});
