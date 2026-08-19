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

Under the hood:

- **Live polling** of the target feed (every 5 min, configurable) — server-side, since the feed sends no CORS headers.
- **GeoIP enrichment** — each target IP is resolved to country / city / ASN-org via [ip-api.com](https://ip-api.com) (cached to disk; only ~40 unique IPs).
- **History & first-seen tracking** — persisted to `data/state.json`, so the trend chart and NEW badges survive restarts.
- **Zero dependencies** — pure Node.js (`>=18`) + vanilla HTML/CSS/JS.

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

| Var             | Default                             | Meaning                          |
| --------------- | ----------------------------------- | -------------------------------- |
| `PORT`          | `3000`                              | HTTP port                        |
| `FEED_URL`      | `https://witha.name/data/last.json` | Source feed                      |
| `POLL_MINUTES`  | `5`                                 | Feed poll interval               |

```bash
PORT=8080 POLL_MINUTES=10 npm start
```

## API

| Endpoint        | Description                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| `GET /api/targets` | Current enriched target list + fetch metadata.                                 |
| `GET /api/hosts`   | Targets grouped by host: IPs, ports, paths, methods, per-type counts, vectors. |
| `GET /api/stats`   | Aggregations: totals, by type/country/port/method, top hosts, top paths, trend.|
| `GET /api/health`  | Poll status.                                                                   |

## Layout

```
server.js            # feed poller + GeoIP enrichment + JSON API + static server
backfill.js          # one-off: backfill daily history for a year from the archive
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
