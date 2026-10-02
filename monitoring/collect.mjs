#!/usr/bin/env node
// ─────────────────────────────────────────────
// Oriyon site monitoring — data collector
//
// Gathers everything the daily report agent needs into one JSON snapshot:
//   1. Public probes of key website pages (status, latency, hosting errors)
//   2. API gateway health
//   3. The gateway monitoring report (traffic, 5xx, slow routes, browser
//      errors, login activity) when MONITORING_API_KEY is set
//
// Usage:
//   MONITORING_API_KEY=... node monitoring/collect.mjs [--hours 24] [--out snapshot.json]
//
// Env:
//   SITE_URLS            comma-separated site origins (default: production + themydee mirror)
//   API_URL              gateway base incl. /api (default: https://api.oriyoninternational.com/api)
//   MONITORING_API_KEY   must match the gateway's MONITORING_API_KEY
// Zero dependencies — requires Node 18+.
// ─────────────────────────────────────────────

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const HOURS = Number(argValue("--hours", "24"));
const OUT = argValue("--out", null);
const SITE_URLS = (process.env.SITE_URLS || "https://www.oriyoninternational.com,https://oriyon.themydee.com")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);
const API_URL = (process.env.API_URL || "https://api.oriyoninternational.com/api").replace(/\/$/, "");
const API_ORIGIN = API_URL.replace(/\/api$/, "");
const KEY = process.env.MONITORING_API_KEY;

// Pages from the CLAUDE.md page map that real users depend on
const PAGES = [
  "/",
  "/about",
  "/model",
  "/eewyla",
  "/learn/training",
  "/learn/blog",
  "/contact",
  "/apply",
  "/learn/lms",
  "/auth/setup",
  "/auth/forgot-password",
  "/auth/reset-password",
  "/complaints",
  "/cooperative",
];

async function probe(url, { timeoutMs = 20000 } = {}) {
  const start = Date.now();
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    const title = body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || null;
    return {
      url,
      status: res.status,
      ok: res.ok,
      ms: Date.now() - start,
      bytes: body.length,
      finalUrl: res.url !== url ? res.url : undefined,
      title,
      server: res.headers.get("server") || undefined,
      // Hosting-level failures, e.g. Vercel DEPLOYMENT_DISABLED / DEPLOYMENT_NOT_FOUND
      hostingError: res.headers.get("x-vercel-error") || undefined,
      bodyPreview: res.ok ? undefined : body.slice(0, 300),
    };
  } catch (err) {
    return { url, ok: false, status: null, ms: Date.now() - start, error: err?.cause?.code || err?.message || String(err) };
  }
}

async function main() {
  const snapshot = {
    collectedAt: new Date().toISOString(),
    windowHours: HOURS,
    sites: [],
    api: {},
    monitoringReport: null,
    notes: [],
  };

  for (const origin of SITE_URLS) {
    const pages = [];
    for (const page of PAGES) pages.push(await probe(origin + page));
    snapshot.sites.push({
      origin,
      up: pages.filter((p) => p.ok).length,
      down: pages.filter((p) => !p.ok).length,
      pages,
    });
  }

  snapshot.api.health = await probe(`${API_ORIGIN}/health`, { timeoutMs: 10000 });

  if (!KEY) {
    snapshot.notes.push("MONITORING_API_KEY not set — traffic, error and login data were not collected.");
  } else {
    try {
      const res = await fetch(`${API_URL}/monitoring/report?hours=${HOURS}`, {
        headers: { "x-monitoring-key": KEY },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        snapshot.monitoringReport = await res.json();
      } else {
        snapshot.notes.push(
          `Monitoring report request failed with HTTP ${res.status}` +
            (res.status === 404 ? " — the gateway monitoring endpoint is probably not deployed yet." : "") +
            (res.status === 401 ? " — MONITORING_API_KEY does not match the gateway." : ""),
        );
      }
    } catch (err) {
      snapshot.notes.push(`Monitoring report request errored: ${err?.message || err}`);
    }
  }

  const json = JSON.stringify(snapshot, null, 2);
  if (OUT) {
    writeFileSync(OUT, json);
    console.error(`[collect] Snapshot written to ${OUT}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

main().catch((err) => {
  console.error("[collect] Failed:", err);
  process.exit(1);
});
