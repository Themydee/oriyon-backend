import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { createProxyMiddleware } from "http-proxy-middleware";
import { authenticate, requireRole } from "./middleware/auth";

const app = express();
const PORT = process.env.PORT || 3000;

const {
  AUTH_SERVICE_URL,
  USER_SERVICE_URL,
  LMS_SERVICE_URL,
  APPLICATIONS_SERVICE_URL,
  NOTIFICATIONS_SERVICE_URL,
} = process.env;

// ─────────────────────────────────────────────
// GLOBAL MIDDLEWARE
// ─────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*", credentials: true }));
app.use(morgan("combined"));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const strictLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use(limiter);

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "api-gateway", timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// PUBLIC AUTH ROUTES
// These routes do not require a JWT token:
//   POST /api/auth/login
//   POST /api/auth/refresh
//   POST /api/auth/logout
//   POST /api/auth/set-password      ← new: first time setup
//   POST /api/auth/forgot-password   ← new: request reset link
//   POST /api/auth/reset-password    ← new: submit new password via token
// ─────────────────────────────────────────────

app.use(
  [
    "/api/auth/login",
    "/api/auth/refresh",
    "/api/auth/logout",
    "/api/auth/set-password",
    "/api/auth/resend-setup",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/auth/verify",
  ],
  strictLimiter,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true })
);

// ─────────────────────────────────────────────
// PROTECTED AUTH ROUTES
// Requires valid JWT — x-user-id is injected by authenticate
//   PATCH /api/auth/change-password  ← new: logged-in user changes password
// ─────────────────────────────────────────────
app.use(
  "/api/auth/change-password",
  strictLimiter,
  authenticate,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true })
);

// ─────────────────────────────────────────────
// PUBLIC APPLICATIONS ROUTE
// POST /api/applications  — anyone can submit an application
// ─────────────────────────────────────────────
app.post(
  "/api/applications",
  createProxyMiddleware({ target: APPLICATIONS_SERVICE_URL, changeOrigin: true })
);

// ─────────────────────────────────────────────
// PROTECTED APPLICATIONS ROUTES
// GET/PATCH require admin role
//   GET  /api/applications       ← list all applications
//   GET  /api/applications/:id   ← get single application
//   PATCH /api/applications/:id  ← approve / reject
// ─────────────────────────────────────────────
app.use(
  "/api/applications",
  authenticate,
  requireRole("admin"),
  createProxyMiddleware({ target: APPLICATIONS_SERVICE_URL, changeOrigin: true })
);

// ─────────────────────────────────────────────
// PUBLIC CONTACT & NEWSLETTER
// ─────────────────────────────────────────────
app.use(
  "/api/contact",
  strictLimiter,
  createProxyMiddleware({ target: NOTIFICATIONS_SERVICE_URL, changeOrigin: true })
);
app.use(
  "/api/newsletter",
  strictLimiter,
  createProxyMiddleware({ target: NOTIFICATIONS_SERVICE_URL, changeOrigin: true })
);

// ─────────────────────────────────────────────
// PROTECTED ROUTES — JWT required for all
// ─────────────────────────────────────────────
app.use(
  "/api/users",
  authenticate,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true })
);
app.use(
  "/api/cohorts",
  authenticate,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true })
);
app.use(
  "/api/lms",
  authenticate,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true })
);

// ─────────────────────────────────────────────
// 404 FALLBACK
// ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.listen(PORT, () => {
  console.log(`[api-gateway] Running on port ${PORT}`);
});