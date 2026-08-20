# anti-DDoSia

A defensive threat-intelligence dashboard that tracks **DDoSia Project / NoName057(16)** DDoS targets from the public feed at [`witha.name/data/last.json`](https://witha.name/data/last.json), similar to [ddosia.rfeed.it](https://ddosia.rfeed.it/).

It **visualizes a publicly published target list** so potential victims and defenders can see who is being targeted and prepare. It does **not** perform, facilitate, or coordinate any attack.

## Features

The dashboard has three views plus a per-host detail drawer, built around what a defender actually needs: *is my host targeted, and how exactly?*

- **Overview** — stat cards (targets, hosts, IPs, countries, attacked paths, new hosts 24h), a targets-over-time trend, and breakdowns by attack type, country, port, and method. Includes **Top attacked paths** (WAF-relevant) and clickable **Most-targeted hosts**.
- **Hosts** (the primary view) — one card per host showing its full attack surface: vector count, per-type breakdown, unique IPs, ports, paths, and SSL. Sortable by targets / name / newest / attack surface.
- **Host detail drawer** — click any host to see all its attack vectors in a table, plus **copy-ready IOCs**: all IPs and all targeted paths, individually or in bulk, for pasting into WAF/firewall rules.
- **Targets** — the raw flat table (host, IP, country, type, method, port, SSL, path) with sortable columns, for power users.
- **Global toolbar** — live search, filters by type / country / port, "new 24h" toggle, and **export** the current filtered set as CSV or JSON, or copy all IPs / paths. Hotkeys: `/` focuses search, `Esc` closes the drawer.

### Accounts & asset monitoring

- **Register / sign in** — email + password (scrypt-hashed, cookie sessions), or **social sign-in with Google / GitHub** (OAuth 2.0, enabled per-provider via env). To enable a provider, create an OAuth app and register the redirect URI `<APP_URL>/auth/<provider>/callback` (e.g. `http://localhost:3000/auth/google/callback`), then set its client id/secret env vars.
- **My Assets** — add domains or IPv4s you own; each shows live status (targeted now / clear).
- **Alerts** — when a monitored asset (or any of its **subdomains**, or an exact IP) appears on the target list, an alert is raised and delivered through the channels you enable:
  - **In-app** — notification bell + Alerts view (always on).
  - **Webhook** — POST JSON to a URL you set (Slack / Telegram / custom).
  - **Email** — optional, via SMTP (see env below); disabled cleanly if not configured.

Under the hood:

- **Live polling** of the target feed (every 5 min, configurable) — server-side, since the feed sends no CORS headers.
- **GeoIP enrichment** — each target IP is resolved to country / city / ASN-org via [ip-api.com](https://ip-api.com) (cached; only ~40 unique IPs).
- **SQLite storage** — a single `data/ddosia.db` (via Node's built-in `node:sqlite`, no external deps) holds GeoIP cache, daily history, first-seen dates, and the users / assets / alerts tables. Existing `data/*.json` from earlier versions is migrated in automatically on first run.
- **Zero dependencies** — pure Node.js (`>=22`, for `node:sqlite`) + vanilla HTML/CSS/JS.

## Backfill history (optional but recommended)

By default the trend chart starts empty and fills as the monitor runs. To populate it with **real history from the start of 2026**, run the backfill — it downloads one archived snapshot per day from witha.name, computes daily target counts, and records each host's true first-seen date:

```bash
node backfill.js          # backfill 2026 (the default)
node backfill.js 2025     # or any other year present in the archive
node backfill.js all      # the entire archive (2023-06 → today)
```

It merges into `data/state.json` (safe to re-run): ~20s for a single year, ~1 min for the whole archive (~1140 days, one snapshot per day). After it finishes, start/restart the app and the "Targets Over Time" chart shows the whole year. To run it against a running container instead:

```bash
docker compose exec anti-ddosia node backfill.js
```

## Run with Docker (recommended)

```bash
docker compose up -d --build
```

Then open <http://localhost:3000>. State (GeoIP cache + history) is persisted in `./data` (bind-mounted), so a host-side `node backfill.js` is picked up by the container.

```bash
docker compose logs -f      # follow logs
docker compose down         # stop
```

To change the port or poll interval, copy `.env.example` to `.env` and edit it.

## Run without Docker

Requires Node.js `>=18` (no dependencies to install).

```bash
npm start
```

Then open <http://localhost:3000>.

### Configuration (env vars)

| Var             | Default                             | Meaning                                    |
| --------------- | ----------------------------------- | ------------------------------------------ |
| `PORT`          | `3000`                              | HTTP port                                  |
| `FEED_URL`      | `https://witha.name/data/last.json` | Source feed                                |
| `POLL_MINUTES`  | `5`                                 | Feed poll interval                         |
| `APP_URL`       | `http://localhost:3000`             | Public URL, used in alert messages         |
| `SMTP_HOST`     | *(empty)*                           | SMTP server for email alerts (empty = off) |
| `SMTP_PORT`     | `587`                               | SMTP port (`465` with `SMTP_SECURE=true`)  |
| `SMTP_USER` / `SMTP_PASS` | *(empty)*                 | SMTP auth credentials                      |
| `SMTP_FROM`     | `SMTP_USER`                         | From address for alert emails              |
| `SMTP_SECURE`   | *(empty)*                           | `true` for implicit TLS (port 465)         |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(empty)*               | Enable Google sign-in                      |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | *(empty)*               | Enable GitHub sign-in                      |

> Sessions are keyed to the deployment; put the app behind HTTPS in production so the session cookie is sent with the `Secure` flag.

```bash
PORT=8080 POLL_MINUTES=10 npm start
```

## API

Public data:

| Endpoint        | Description                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| `GET /api/targets` | Current enriched target list + fetch metadata.                                 |
| `GET /api/hosts`   | Targets grouped by host: IPs, ports, paths, methods, per-type counts, vectors. |
| `GET /api/stats`   | Aggregations: totals, by type/country/port/method, top hosts, top paths, trend.|
| `GET /api/health`  | Poll status.                                                                   |

Accounts (cookie session):

| Endpoint        | Description                                                          |
| --------------- | ------------------------------------------------------------------- |
| `POST /api/register` · `POST /api/login` · `POST /api/logout` | Auth.  |
| `GET /api/me`      | Current user, settings, unseen-alert count.                      |
| `GET/POST /api/assets` · `DELETE /api/assets/:id` | Manage monitored assets. |
| `GET /api/alerts` · `POST /api/alerts/seen` | List alerts / mark all read.   |
| `POST /api/settings` | Update webhook URL and alert-channel toggles.                 |

## Layout

```
server.js            # feed poller + matching engine + JSON API + static server
db.js                # SQLite data layer (schema, queries, JSON migration)
auth.js              # password hashing (scrypt) + cookie sessions
notify.js            # alert delivery: webhook + minimal SMTP email client
backfill.js          # one-off: backfill daily history from the archive
public/
  index.html         # dashboard shell
  styles.css         # dark theme
  app.js             # data loading, charts, filterable/sortable table
data/                # runtime cache (gitignored): geoip-cache.json, state.json
Dockerfile           # non-root Node 24-alpine image with healthcheck
docker-compose.yml   # service + persistent volume for data/
.env.example         # configurable env vars for compose
```

## Notes

- GeoIP uses the free ip-api.com endpoint (HTTP, rate-limited). Results are cached, so lookups only happen for new IPs.
- History is capped at the most recent ~4000 poll points (~2 weeks at 5-min intervals).
- Data reflects whatever the upstream feed publishes; accuracy and availability depend on that source.
