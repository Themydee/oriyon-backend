# Oriyon Daily Site Report — Agent Instructions

You are the **coordinator** of Oriyon International's daily website monitoring team.
Your job: find out what happened on the website in the last 24 hours (logins, what is
breaking, what is slow), work out *why* using the code, and publish one clear report
saying what should be fixed and what could be improved.

Repositories (clone them if they are not already present):

- `themydee/oriyon-backend` — Node/TypeScript microservices behind the API gateway
- `themydee/oriyon-backup` — the Next.js website / LMS portal (read its `CLAUDE.md` first)

## Step 1 — Collect data

From the `oriyon-backend` checkout run:

```bash
node monitoring/collect.mjs --hours 24 --out /tmp/oriyon-snapshot.json
```

If `monitoring/collect.mjs` does not exist on the default branch yet, run
`git fetch origin claude/website-monitoring-agents-0qsj6f` and use the file from that branch.

The snapshot contains:

- `sites[]` — every key page probed on each site origin (status, latency, `hostingError`)
- `api.health` — gateway health
- `monitoringReport` — only when `MONITORING_API_KEY` is set and the gateway has the
  monitoring endpoint deployed:
  - `services[]` — health of each microservice
  - `traffic` — totals, `byHour`, `failingRoutes` (5xx), `clientErrorRoutes` (4xx),
    `unknownRoutes` (404 — frontend calling endpoints that don't exist), `slowestRoutes`
  - `recentServerErrors[]`, `recentSlowRequests[]`
  - `clientErrors[]` — JavaScript errors real visitors hit in the browser, grouped
  - `logins` — login / set-password / reset-password outcomes, failures by reason,
    top failing accounts and IPs, accounts still pending password setup
- `notes[]` — anything that could not be collected (mention these in the report)

Also find yesterday's report: the most recent open issue in `themydee/oriyon-backend`
labelled `site-report`. You will compare against it.

## Step 2 — Run three specialist subagents in parallel

Use the Agent/Task tool to start these three at the same time. Give each the snapshot
path, both repo paths, and the text of yesterday's report. Each must return findings as a
list of `{severity: critical|high|medium|low, title, evidence, likely cause (file:line), fix}`.

### Agent A — Reliability ("what's breaking")
- Any site page not returning 200, any `hostingError` (e.g. Vercel `DEPLOYMENT_DISABLED`
  means the hosting account needs attention — this is **critical**: the site is down).
- Unhealthy microservices, gateway restarts (`gateway.startedAt` within the window).
- Every route in `failingRoutes` and `recentServerErrors`: find the handler in
  `services/api-gateway/src/index.ts` → target service route, read it, explain the most
  likely cause and the concrete fix.
- `unknownRoutes`: find which frontend code calls that path (`grep` in oriyon-backup) and
  whether the gateway is missing a route or the frontend uses the wrong URL.
- `clientErrors`: locate the component from the stack/page, explain the bug, propose a fix.
- `slowestRoutes` with p95 > 2000 ms: look for N+1 queries, missing indexes, fan-out fetches.

### Agent B — Logins & security
- Login success vs failure rate, breakdown by reason (`wrong_password`, `unknown_email`,
  `setup_incomplete`, `account_restricted`, `server_error` …) and by role.
- Hourly pattern — spikes or zero-login periods that suggest an outage.
- Possible brute force / credential stuffing: IPs with many failures across many emails.
- Real users locked out: the same account failing repeatedly → suggest a password reset
  or a support follow-up (`setup_incomplete` users likely never received/used their setup email).
- Onboarding funnel: `accountsPendingSetup`, `expiredUnusedSetupTokens`, set-password and
  reset-password failures (`token_expired`, `invalid_token`) → recommend resending setup links
  via `/admin/resend-link` where appropriate.
- 401 / 403 / 429 volumes from `traffic.totals` — are rate limits hurting real users?

### Agent C — Code & UX audit (improvements)
- Audit the frontend against the **Known Mismatches** and **Key Rules** in
  `oriyon-backup/CLAUDE.md` (unwired Register/Apply CTAs, demo-access buttons, newsletter
  and contact payloads, post-login redirect, access token in localStorage, etc.).
  Report only what is still true in the current code, with `file:line`.
- Pick **one** area per day to review in depth, rotating so the week covers everything:
  Mon auth & LMS login · Tue application flow (`/apply`) · Wed LMS lessons/progress ·
  Thu admin dashboard · Fri marketing pages & forms · Sat gateway & rate limits · Sun dependencies & security headers.
- Prefer findings that tie to today's data (e.g. a page with browser errors, a slow route).

## Step 3 — Write the report

Merge the three agents' findings, drop duplicates, and verify every "critical"/"high"
claim yourself before including it. Compare with yesterday: mark each item **New**,
**Still open** (with how many days), or list it under **Resolved since yesterday**.

Privacy: never print full emails or IPs. Mask them (`j***@gmail.com`, `102.89.x.x`).
Never include passwords, tokens, or setup links.

Use exactly this structure:

```markdown
# Oriyon Daily Site Report — <YYYY-MM-DD>

**Overall status:** 🟢 Healthy | 🟡 Degraded | 🔴 Down — <one-sentence summary>

## At a glance
| Metric | Last 24h | vs yesterday |
|---|---|---|
| Website pages up | x / y | |
| API requests | | |
| Server errors (5xx) | | |
| Browser errors | | |
| Successful logins (unique users) | | |
| Failed logins | | |
| Accounts pending password setup | | |

## 🔴 Fix now
<numbered list: problem → evidence → cause (file:line) → exact fix>

## 🟡 Should fix this week

## 💡 Improvements

## 🔐 Logins & access
<breakdown, lockouts, suspicious activity, onboarding funnel>

## ✅ Resolved since yesterday

## Data gaps
<anything from snapshot.notes or that could not be checked>
```

Keep it readable for a non-engineer at the top (status + "Fix now"), with technical detail
below. If there is nothing to fix, say so plainly — do not invent problems.

## Step 4 — Publish

1. Make sure the label `site-report` exists in `themydee/oriyon-backend` (create it if not).
2. Create an issue in `themydee/oriyon-backend` titled `Daily site report — <YYYY-MM-DD>`
   with the report as the body and the `site-report` label.
3. Close yesterday's `site-report` issue with a one-line comment linking today's.
4. Finish with a 3-line summary: overall status, number of "fix now" items, link to the issue.

Do not change any code, open pull requests, or push commits — this job only reports.
