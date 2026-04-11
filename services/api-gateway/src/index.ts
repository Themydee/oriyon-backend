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

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3006",
];

app.use(helmet());
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id"],
  })
);

app.use(morgan("combined"));

const limiter       = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
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
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// PUBLIC AUTH ROUTES
// ─────────────────────────────────────────────
const authProxy = createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true });

app.post("/api/auth/login",           strictLimiter, authProxy);
app.post("/api/auth/refresh",         strictLimiter, authProxy);
app.post("/api/auth/logout",          strictLimiter, authProxy);
app.post("/api/auth/set-password",    strictLimiter, authProxy);
app.post("/api/auth/resend-setup",    strictLimiter, authProxy);
app.post("/api/auth/forgot-password", strictLimiter, authProxy);
app.post("/api/auth/reset-password",  strictLimiter, authProxy);
app.get("/api/auth/verify",           strictLimiter, authProxy);
app.patch("/api/auth/change-password", strictLimiter, authenticate, authProxy);

app.use(
  "/api/auth/change-password",
  strictLimiter,
  authenticate,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true })
);

// ─────────────────────────────────────────────
// PUBLIC APPLICATIONS ROUTE
// ─────────────────────────────────────────────
const applicationsProxy = createProxyMiddleware({ target: APPLICATIONS_SERVICE_URL, changeOrigin: true });

app.post(
  "/api/applications",
  strictLimiter,
  applicationsProxy
);

// ─────────────────────────────────────────────
// PROTECTED APPLICATIONS ROUTES
// ─────────────────────────────────────────────
app.use(
  "/api/applications",
  strictLimiter,
  applicationsProxy,
  authenticate,
  requireRole("admin"),
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
// PROTECTED ROUTES
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