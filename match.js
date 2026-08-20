// anti-DDoSia — pure asset-matching helpers (no I/O, no deps).
// Extracted so they can be unit-tested in isolation from the HTTP server.

// Normalise a user-supplied asset string into { type, value } or null.
// Accepts an IPv4 literal or a domain (optionally with scheme/port/path/trailing dot).
export function parseAsset(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((o) => Number(o) <= 255)) return { type: 'ip', value: v };
  const host = v.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/\.$/, '');
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && host.length <= 253) return { type: 'domain', value: host };
  return null;
}

// Does a targeted host (with its resolved IPs) match a monitored asset?
// IP assets match by resolved address; domain assets match the exact host or any subdomain.
export function hostMatchesAsset(host, hostIps, asset) {
  const v = asset.value;
  if (asset.type === 'ip') return hostIps.includes(v);
  return host === v || host.endsWith('.' + v);
}
