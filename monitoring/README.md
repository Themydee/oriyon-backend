# Site Monitoring & Daily Report

A team of Claude agents checks oriyoninternational.com every morning. It records logins, what is
breaking and what is slow, works out the cause from the code, and posts a report as a GitHub issue
labelled `site-report`.

```
Browser ──JS errors──▶ POST /api/monitoring/client-error ─┐
All API traffic ─────▶ gateway requestMetrics middleware ─┤  (services/api-gateway/src/monitoring.ts)
Login attempts ──────▶ auth-service login_events table ───┤
                                                          ▼
                         GET /api/monitoring/report  (x-monitoring-key or admin JWT)
                                                          │
            monitoring/collect.mjs  (+ public page probes of every key page)
                                                          │
             Claude coordinator ── Agent A: reliability (what's breaking)
             (AGENT_PROMPT.md)   ── Agent B: logins & security
                                 ── Agent C: code & UX audit (improvements)
                                                          │
                                  GitHub issue "Daily site report — YYYY-MM-DD"
```

## What gets recorded

| Source | Data | Where it lives |
|---|---|---|
| API gateway | Requests per route (ids collapsed), status codes, p95 latency, 5xx and slow samples, 404s on unknown routes | In memory, flushed every minute to `MONITORING_DATA_FILE` (7 days) |
| Website | Uncaught JS errors and unhandled promise rejections, grouped by fingerprint (page path, message, stack, no user data) | Same as above |
| auth-service | Every login / set-password / reset-password attempt with outcome and reason | `login_events` table (pruned after `LOGIN_EVENTS_RETENTION_DAYS`, default 90) |
| collect.mjs | Status, latency and hosting errors for 14 key pages on each site origin | Snapshot only |

## Setup

1. **Gateway env**: add `MONITORING_API_KEY` (a long random string, e.g. `openssl rand -hex 32`).
   Optional: `MONITORING_DATA_FILE` (default `./monitoring-data.json` in the gateway's working
   directory) and `MONITORING_SLOW_MS` (default 3000).
2. **auth-service**: the `login_events` migration (`0006`) runs with the normal deploy.
3. **Frontend**: `components/layout/ErrorReporter.tsx` is mounted in `app/layout.tsx` (oriyon-backup).
4. **Agent environment**: set the same `MONITORING_API_KEY` as an environment variable in
   the Claude Code cloud environment that runs the daily routine. Without it, the report still
   includes page probes and API health, but no traffic, error or login data.

## Run it manually

```bash
MONITORING_API_KEY=... node monitoring/collect.mjs --hours 24 --out snapshot.json
```

Then ask Claude: *"Follow monitoring/AGENT_PROMPT.md"*.

An admin can also read the raw report directly:
`GET /api/monitoring/report?hours=24` with an admin `Authorization: Bearer` token.
