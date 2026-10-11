import express, { Request, Response, NextFunction, Router } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";

// ─────────────────────────────────────────────
// MONITORING
// Lightweight in-process metrics for the daily site report:
//   • per-route traffic, status codes and latency (hourly buckets, 7 days)
//   • recent 5xx and slow request samples
//   • browser errors reported by the frontend
//   • service health + login activity (fetched from auth-service on demand)
// State is flushed to MONITORING_DATA_FILE so it survives PM2 restarts.
// ─────────────────────────────────────────────

const RETENTION_HOURS = 24 * 7;
const SLOW_REQUEST_MS = Number(process.env.MONITORING_SLOW_MS) || 3000;
const MAX_DURATION_SAMPLES = 200;
const MAX_SAMPLES = 200;
const MAX_CLIENT_ERRORS = 500;
const DATA_FILE =
  process.env.MONITORING_DATA_FILE || path.join(process.cwd(), "monitoring-data.json");

interface RouteStats {
  count: number;
  status: Record<string, number>;
  durations: number[]; // capped reservoir sample
  totalMs: number;
}

interface RequestSample {
  at: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  role: string | null;
}

interface ClientError {
  fingerprint: string;
  kind: string;
  message: string;
  stack: string | null;
  pages: string[];
  count: number;
  firstSeen: string;
  lastSeen: string;
  userAgents: string[];
}

interface MonitoringState {
  startedAt: string;
  // hourKey ("2026-10-02T14") -> "METHOD /route" -> stats
  buckets: Record<string, Record<string, RouteStats>>;
  errorSamples: RequestSample[];
  slowSamples: RequestSample[];
  clientErrors: Record<string, ClientError>;
}

const state: MonitoringState = loadState();

function loadState(): MonitoringState {
  const empty: MonitoringState = {
    startedAt: new Date().toISOString(),
    buckets: {},
    errorSamples: [],
    slowSamples: [],
    clientErrors: {},
  };
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return { ...empty, ...saved, startedAt: empty.startedAt };
    }
  } catch (err) {
    console.warn("[monitoring] Could not load saved state, starting fresh:", err);
  }
  return empty;
}

function saveState() {
  try {
    pruneOldBuckets();
    fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  } catch (err) {
    console.warn("[monitoring] Could not save state:", err);
  }
}

setInterval(saveState, 60 * 1000).unref();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    saveState();
    process.exit(0);
  });
}

function hourKey(d: Date) {
  return d.toISOString().slice(0, 13);
}

function pruneOldBuckets() {
  const cutoff = hourKey(new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000));
  for (const key of Object.keys(state.buckets)) {
    if (key < cutoff) delete state.buckets[key];
  }
}

function pushCapped<T>(arr: T[], item: T, max: number) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

// Collapse ids/tokens so "/api/lms/weeks/3f2a..." groups as "/api/lms/weeks/:id"
export function normalizeRoute(url: string) {
  const pathname = url.split("?")[0] || "/";
  return pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
      if (/^\d+$/.test(seg)) return ":n";
      if (seg.includes("@")) return ":email";
      if (seg.length >= 20 && /^[A-Za-z0-9._~%-]+$/.test(seg) && /\d/.test(seg)) return ":token";
      return seg;
    })
    .join("/");
}

function roleFromRequest(req: Request): string | null {
  if (req.user?.role) return req.user.role;
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const decoded = jwt.decode(auth.split(" ")[1]) as { role?: string } | null;
  return decoded?.role || null;
}

// ─────────────────────────────────────────────
// Request metrics middleware — register before routes
// ─────────────────────────────────────────────
export function requestMetrics(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  const originalUrl = req.originalUrl;

  res.on("finish", () => {
    if (originalUrl.startsWith("/api/monitoring") || originalUrl === "/health") return;

    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const now = new Date();
    const route = `${req.method} ${normalizeRoute(originalUrl)}`;
    const bucket = (state.buckets[hourKey(now)] ||= {});
    const stats = (bucket[route] ||= { count: 0, status: {}, durations: [], totalMs: 0 });

    stats.count++;
    stats.totalMs += durationMs;
    stats.status[res.statusCode] = (stats.status[res.statusCode] || 0) + 1;
    if (stats.durations.length < MAX_DURATION_SAMPLES) {
      stats.durations.push(Math.round(durationMs));
    } else {
      const i = Math.floor(Math.random() * stats.count);
      if (i < MAX_DURATION_SAMPLES) stats.durations[i] = Math.round(durationMs);
    }

    const sample: RequestSample = {
      at: now.toISOString(),
      method: req.method,
      route: normalizeRoute(originalUrl),
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      role: roleFromRequest(req),
    };
    if (res.statusCode >= 500) pushCapped(state.errorSamples, sample, MAX_SAMPLES);
    if (durationMs >= SLOW_REQUEST_MS) pushCapped(state.slowSamples, sample, MAX_SAMPLES);
  });

  next();
}

// ─────────────────────────────────────────────
// Report helpers
// ─────────────────────────────────────────────
function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarizeTraffic(hours: number) {
  const cutoff = hourKey(new Date(Date.now() - hours * 60 * 60 * 1000));
  const merged: Record<string, RouteStats> = {};
  const byHour: Array<{ hour: string; requests: number; errors5xx: number; errors4xx: number }> = [];

  for (const [hour, routes] of Object.entries(state.buckets).sort(([a], [b]) => a.localeCompare(b))) {
    if (hour < cutoff) continue;
    let requests = 0, e5 = 0, e4 = 0;
    for (const [route, s] of Object.entries(routes)) {
      const m = (merged[route] ||= { count: 0, status: {}, durations: [], totalMs: 0 });
      m.count += s.count;
      m.totalMs += s.totalMs;
      m.durations.push(...s.durations);
      for (const [code, n] of Object.entries(s.status)) {
        m.status[code] = (m.status[code] || 0) + n;
        if (Number(code) >= 500) e5 += n;
        else if (Number(code) >= 400) e4 += n;
      }
      requests += s.count;
    }
    byHour.push({ hour: `${hour}:00`, requests, errors5xx: e5, errors4xx: e4 });
  }

  const routes = Object.entries(merged).map(([route, s]) => {
    const count5xx = Object.entries(s.status).filter(([c]) => Number(c) >= 500).reduce((a, [, n]) => a + n, 0);
    const count4xx = Object.entries(s.status).filter(([c]) => Number(c) >= 400 && Number(c) < 500).reduce((a, [, n]) => a + n, 0);
    return {
      route,
      requests: s.count,
      status: s.status,
      errors5xx: count5xx,
      errors4xx: count4xx,
      errorRate5xx: s.count ? +(count5xx / s.count).toFixed(4) : 0,
      avgMs: s.count ? Math.round(s.totalMs / s.count) : 0,
      p95Ms: percentile(s.durations, 95),
    };
  });

  const total = routes.reduce((a, r) => a + r.requests, 0);
  const total5xx = routes.reduce((a, r) => a + r.errors5xx, 0);
  const total4xx = routes.reduce((a, r) => a + r.errors4xx, 0);
  const statusOf = (code: string) => routes.reduce((a, r) => a + (r.status[code] || 0), 0);

  return {
    totals: {
      requests: total,
      errors5xx: total5xx,
      errors4xx: total4xx,
      unauthorized401: statusOf("401"),
      forbidden403: statusOf("403"),
      notFound404: statusOf("404"),
      rateLimited429: statusOf("429"),
    },
    byHour,
    busiestRoutes: [...routes].sort((a, b) => b.requests - a.requests).slice(0, 15),
    failingRoutes: routes.filter((r) => r.errors5xx > 0).sort((a, b) => b.errors5xx - a.errors5xx).slice(0, 20),
    clientErrorRoutes: routes
      .filter((r) => r.errors4xx > 0)
      .sort((a, b) => b.errors4xx - a.errors4xx)
      .slice(0, 20),
    // 404s on unknown routes usually mean the frontend calls an endpoint the gateway does not expose
    unknownRoutes: routes
      .filter((r) => r.status["404"] && r.status["404"] === r.requests)
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 20)
      .map((r) => ({ route: r.route, requests: r.requests })),
    slowestRoutes: routes
      .filter((r) => r.requests >= 5)
      .sort((a, b) => b.p95Ms - a.p95Ms)
      .slice(0, 15),
  };
}

async function checkServices() {
  const services: Record<string, string | undefined> = {
    "auth-service": process.env.AUTH_SERVICE_URL,
    "user-service": process.env.USER_SERVICE_URL,
    "lms-service": process.env.LMS_SERVICE_URL,
    "applications-service": process.env.APPLICATIONS_SERVICE_URL,
    "notifications-service": process.env.NOTIFICATIONS_SERVICE_URL,
    "shop-service": process.env.SHOP_SERVICE_URL || "http://localhost:3006",
  };
  return Promise.all(
    Object.entries(services).map(async ([name, base]) => {
      if (!base) return { name, ok: false, error: "URL not configured" };
      const start = Date.now();
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
        return { name, ok: r.ok, status: r.status, latencyMs: Date.now() - start };
      } catch (err: any) {
        return { name, ok: false, error: err?.message || String(err), latencyMs: Date.now() - start };
      }
    }),
  );
}

async function fetchLoginActivity(hours: number) {
  const base = process.env.AUTH_SERVICE_URL;
  if (!base) return { error: "AUTH_SERVICE_URL not configured" };
  try {
    const r = await fetch(`${base}/api/auth/admin/login-activity?hours=${hours}`, {
      headers: { "x-user-role": "admin" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return { error: `auth-service responded ${r.status}` };
    return await r.json();
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}

// Monitoring key (for the scheduled report agent) or an admin JWT
function requireMonitoringAccess(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.MONITORING_API_KEY;
  const provided = req.headers["x-monitoring-key"];
  if (expected && typeof provided === "string") {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    return res.status(401).json({ error: "Invalid monitoring key" });
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }
  try {
    const payload = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET!) as { role?: string };
    if (payload.role !== "admin") return res.status(403).json({ error: "Forbidden — admin only" });
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─────────────────────────────────────────────
// Routes: /api/monitoring/*
// ─────────────────────────────────────────────
const clientErrorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many error reports" },
});

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export const monitoringRouter = Router();

// Public: the frontend reports uncaught browser errors here
monitoringRouter.post(
  "/client-error",
  clientErrorLimiter,
  express.json({ limit: "16kb" }),
  (req: Request, res: Response) => {
    const message = clip(req.body?.message, 500);
    if (!message) return res.status(400).json({ error: "message is required" });

    const kind = clip(req.body?.kind, 40) || "error";
    const stack = clip(req.body?.stack, 4000) || null;
    // Keep the page path only; query strings can carry setup/reset tokens
    const page = clip(req.body?.page, 300).split("?")[0] || "unknown";
    const userAgent = clip(req.headers["user-agent"], 200);
    const firstFrame = stack?.split("\n").find((l) => l.includes("at ") || l.includes("@")) || "";
    const fingerprint = crypto
      .createHash("sha1")
      .update(`${kind}|${message}|${firstFrame.replace(/:\d+:\d+/g, "")}`)
      .digest("hex")
      .slice(0, 12);
    const now = new Date().toISOString();

    const existing = state.clientErrors[fingerprint];
    if (existing) {
      existing.count++;
      existing.lastSeen = now;
      if (!existing.pages.includes(page) && existing.pages.length < 10) existing.pages.push(page);
      if (userAgent && !existing.userAgents.includes(userAgent) && existing.userAgents.length < 5) {
        existing.userAgents.push(userAgent);
      }
    } else {
      const keys = Object.keys(state.clientErrors);
      if (keys.length >= MAX_CLIENT_ERRORS) {
        const oldest = keys.sort((a, b) =>
          state.clientErrors[a].lastSeen.localeCompare(state.clientErrors[b].lastSeen),
        )[0];
        delete state.clientErrors[oldest];
      }
      state.clientErrors[fingerprint] = {
        fingerprint,
        kind,
        message,
        stack,
        pages: [page],
        count: 1,
        firstSeen: now,
        lastSeen: now,
        userAgents: userAgent ? [userAgent] : [],
      };
    }
    return res.status(204).end();
  },
);

// Protected: full report consumed by the daily monitoring agent
monitoringRouter.get("/report", requireMonitoringAccess, async (req: Request, res: Response) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), RETENTION_HOURS);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const [services, logins] = await Promise.all([checkServices(), fetchLoginActivity(hours)]);

  res.json({
    generatedAt: new Date().toISOString(),
    windowHours: hours,
    gateway: {
      startedAt: state.startedAt,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    services,
    traffic: summarizeTraffic(hours),
    recentServerErrors: state.errorSamples.filter((s) => s.at >= since).slice(-50),
    recentSlowRequests: state.slowSamples.filter((s) => s.at >= since).slice(-50),
    clientErrors: Object.values(state.clientErrors)
      .filter((e) => e.lastSeen >= since)
      .sort((a, b) => b.count - a.count)
      .slice(0, 50),
    logins,
  });
});
