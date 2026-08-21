# Backlog — next iteration

## Feature ideas (research)

- [ ] **Threat-intel news feed about the group.** Aggregate recent public
  reporting on NoName057(16) / the DDoSia Project into a panel (or a dedicated
  view), so a defender gets context alongside the target data.
  **Research before building:**
  - *Sources.* CERT/CISA/national-CERT advisories, vendor threat blogs
    (Netscout, Radware, Cloudflare, Kaspersky, Sekoia, etc.), and reputable
    news via RSS/Atom where available; consider a curated allowlist of feeds
    rather than open web search to keep signal high and avoid disinfo.
  - *Fetch model.* Server-side poller (like the target feed) on a slow cadence
    (hourly/daily), cache results in SQLite; never fetch from the browser.
    Respect each source's robots/ToS and rate limits; set a descriptive UA.
  - *Filtering/dedup.* Match on keywords (NoName057, DDoSia, "pro-Russian
    hacktivist DDoS"), dedupe by URL/title, store title/source/date/link/
    summary. Show source + timestamp; link out, don't rehost article bodies
    (copyright — store only title + short snippet + link).
  - *Trust/safety.* Treat fetched text as untrusted data (no acting on it);
    clearly label as third-party reporting; keep the tool's defensive framing.
  - *Optional enrichment.* Correlate a news spike with the trend chart (did a
    campaign announcement precede a target surge?).

- [ ] **Live reachability of currently-targeted hosts.** Show, next to each
  target on the current list, whether it is actually reachable right now — a
  rough "is the DDoS having visible impact?" signal for defenders.
  **Research before building:**
  - *Signal source.* Two paths: (a) active probe from our server — HTTP(S)
    `HEAD`/`GET` with a short timeout, record status/latency/up-down; (b) a
    third-party uptime/observability API (e.g. a status-check provider) so we
    don't originate the traffic ourselves.
  - *Ethics / legality / optics.* We only ever probe hosts that are **already
    on the public target list** (never user assets without consent), at a
    **low, fixed rate**, single lightweight request — never anything that
    resembles load generation. This must stay unambiguously a *read* to avoid
    contributing to the very attack we track. Document this in the probe code
    and the UI.
  - *Accuracy.* Down-from-here ≠ down-globally (geo/CDN/anycast, our egress IP
    could be blocked, WAF/anti-bot 403s). Present it as "reachable from our
    probe" with latency + last-checked, not an authoritative "offline".
    Consider multi-region probes or a provider to reduce false positives.
  - *Mechanics.* Cache results per host with a TTL (e.g. 60–120 s), reuse the
    existing rate-limiter/queue pattern (cf. GeoIP batching), set a tight
    timeout and `User-Agent`, and surface state in the host drawer + a column
    in the feed/hosts table (up / slow / unreachable / unknown).
  - *Config.* Off by default; gate behind an env flag (e.g. `PROBE_TARGETS=1`)
    so a deployer explicitly opts in to originating probe traffic.

## UI polish (next editing session)

- [ ] **FEED tab: no inner scroll — let the full list flow down the page.**
  The feed table (`#targetsTable`) sits in `.tbl-wrap.tall`, which caps height
  at `max-height: 74vh; overflow-y: auto` (styles.css). Drop the inner scroll
  for this view so the whole target list renders at page length and the page
  itself scrolls. Options: give the feed table its own wrapper class without
  the `.tall` cap (keep the sticky header working, keep `overflow-x: auto` for
  narrow screens), or scope a `#view-feed .tbl-wrap { max-height: none;
  overflow-y: visible; }` override. Note: the sticky `thead` currently pins to
  the scroll container — verify it still behaves (or make it stick to the page)
  once the cap is removed. Leave `#hostAllTbl` (HOSTS) as-is unless we want the
  same treatment there.

## Fixed in the second audit pass (with tests)

- [x] **Static path traversal to sibling dirs.** The old guard used
  `startsWith(PUBLIC_DIR)`, which also matched `/app/public-secret/…`.
  Now requires `PUBLIC_DIR` exactly or `PUBLIC_DIR + sep`.
- [x] **Oversized request bodies reset the socket** (`req.destroy()`),
  surfacing as a connection error instead of a clean 400. Now drains and
  returns 400.
- [x] **X-Forwarded-For trusted unconditionally** for rate-limit keying
  (spoofable → per-request IP rotation bypasses the limiter). Now trusted
  only when `TRUST_PROXY=1`; otherwise keys on the socket address.
- [x] **Public read endpoints were unthrottled.** `/api/targets|stats|check|
  host-sessions|hosts-all|session-detail` each run a scan/DB query with no
  auth; added a 240-req/min per-IP cap.
- Test suite added (`npm test`, zero-dep `node:test`): 46 cases across
  match / auth / notify (SSRF) / oauth / db / API integration.

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
- [ ] **Rate-limit scope (multi-instance).** XFF trust is now gated behind
  `TRUST_PROXY` (done), but the limiter is still in-memory / per-instance.
  For multi-instance, move to a shared store (Redis) so limits are global.
- [ ] **Enforce HTTPS in production** so the session cookie ships with
  `Secure` (already wired via `isSecure`); add HSTS behind TLS.
- [ ] **Registration email enumeration (minor).** `/api/register` returns
  "email already registered" (409). Optional: return a generic success
  and email the address instead (ties into email verification above).

## If it goes public (free, open registration)

Open registration flips several "nice-to-have" items into launch blockers,
because inputs (webhooks, emails, check queries) now come from untrusted
users at volume.

**Must-have before public launch**
- [ ] **Email verification on signup** (blocks the pre-hijacking above,
  stops throwaway/spam accounts). Ties to a real transactional email
  provider (SES / Postmark / Resend) with SPF+DKIM — the hand-rolled SMTP
  client is fine for a personal instance, not for deliverability at scale.
- [ ] **Bot/abuse protection on `/api/register`** (CAPTCHA / Turnstile) and
  tighter rate limits on `/api/check` and alert creation.
- [ ] **Webhook SSRF hardening for untrusted users** — at-send DNS pinning
  or an egress-proxy allowlist (the current save-time check is not enough
  when anyone can add a webhook). Consider gating webhooks behind a
  verified email.
- [ ] **HTTPS + HSTS** via a reverse proxy (Caddy), `APP_URL=https://…`,
  trust `X-Forwarded-Proto`/`-For` only from that proxy. Required for the
  `Secure` session cookie and for Google OAuth on a real domain.
- [ ] **Hash session tokens at rest**; add account deletion / data export
  (GDPR), a privacy policy and ToS (you store emails + send alerts = PII).
- [ ] **GeoIP at scale** — ip-api's free tier is 45 req/min; switch to a
  local MaxMind DB or a paid tier.

**Scaling path (only when load demands it)**
- [ ] **SQLite → Postgres.** SQLite (WAL) serializes writes; the 1-min
  poller writes history/sessions constantly and every user action writes
  too. It can carry a few thousand users on one box, but past that, or for
  HA / horizontal scale, move to Postgres.
- [ ] Then split containers: **web (N replicas)** + **worker (exactly one:
  poller + matching + alerts, to avoid duplicate work/alerts)** + Postgres,
  behind the reverse proxy. Keep the poller a singleton.
- [ ] Backups (SQLite file snapshot or Postgres dumps), structured logging,
  uptime/health monitoring.

## Notes

- Login already returns a generic "wrong email or password" (no user
  enumeration there) — keep it that way.
- Current single-container + SQLite design is correct for a personal /
  small deployment; none of the above is needed until you actually open
  registration to the public.
