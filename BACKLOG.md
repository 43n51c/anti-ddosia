# Backlog — next iteration

## Security hardening (residual risks from the audit)

Non-critical for a single-instance / trusted deployment; address before
untrusted multi-tenant or public production use.

- [ ] **Email verification on password registration.** Without it, OAuth
  auto-linking by email allows theoretical account pre-hijacking (an
  attacker pre-registers a victim's email + password, victim later signs
  in via Google and lands on the attacker-seeded account). Fix: verify
  email on registration, or require a password reset when an OAuth login
  first lands on a password-created account.
- [ ] **SSRF: defeat DNS-rebinding.** The current webhook check runs at
  save time and blocks literal private IPs / internal hostnames, but a
  hostname can resolve to a public IP at save and a private one at send.
  Fix for hostile use: resolve + pin the IP at send time and re-check it,
  or run outbound webhooks through an egress allowlist / proxy.
- [ ] **Hash session tokens at rest.** Tokens are stored in `sessions`
  in plaintext; a leaked DB file lets them be replayed. Store `sha256(token)`
  and look up by hash.
- [ ] **Rate-limit trust + scope.** The limiter keys on `X-Forwarded-For`
  (spoofable unless behind a trusted proxy that sets it) and is in-memory
  (per instance). For multi-instance, use a shared store and trust only
  the proxy's XFF.
- [ ] **Enforce HTTPS in production** so the session cookie ships with
  `Secure` (already wired via `isSecure`); add HSTS behind TLS.
- [ ] **Registration email enumeration (minor).** `/api/register` returns
  "email already registered" (409). Optional: return a generic success
  and email the address instead (ties into email verification above).

## Notes

- Login already returns a generic "wrong email or password" (no user
  enumeration there) — keep it that way.
