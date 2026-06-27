import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { createProxyMiddleware } from "http-proxy-middleware";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger";
import { authenticate, requireRole } from "./middleware/auth";

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

const {
  AUTH_SERVICE_URL,
  USER_SERVICE_URL,
  LMS_SERVICE_URL,
  APPLICATIONS_SERVICE_URL,
  NOTIFICATIONS_SERVICE_URL,
} = process.env;

const fetchFn: any = (globalThis as any).fetch;

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3006",
  "https://www.oriyoninternational.com",
  "https://oriyoninternational.com",
];

// Configure helmet with CSP disabled to allow Swagger UI's inline scripts/styles to render successfully
app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin))
        return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id"],
  }),
);
app.use(morgan("combined"));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const strictLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use(limiter);

function keepPath(req: Request, _res: Response, next: NextFunction) {
  req.url = req.originalUrl;
  next();
}

// ─────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "api-gateway",
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// SWAGGER API DOCUMENTATION (QA testing endpoints)
// ─────────────────────────────────────────────
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/api-docs.json", (_req, res) => {
  res.json(swaggerSpec);
});

// ─────────────────────────────────────────────
// AUTH — public
// ─────────────────────────────────────────────
app.post(
  "/api/auth/login",
  strictLimiter,
  keepPath,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/auth/refresh",
  limiter,
  keepPath,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/auth/logout",
  strictLimiter,
  keepPath,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/auth/set-password",
  strictLimiter,
  keepPath,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/auth/resend-setup",
  strictLimiter,
  keepPath,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/auth/forgot-password",
  strictLimiter,
  keepPath,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/auth/reset-password",
  strictLimiter,
  keepPath,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/auth/verify",
  strictLimiter,
  keepPath,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/auth/admin/setup-token/:email",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }),
);

// AUTH — protected
app.patch(
  "/api/auth/change-password",
  strictLimiter,
  authenticate,
  keepPath,
  createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }),
);

// ─────────────────────────────────────────────
// APPLICATIONS
// ─────────────────────────────────────────────
app.post(
  "/api/applications",
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/applications",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/applications/status/:status",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/applications/:id",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);

// ADMIN — applications analytics
app.get(
  "/api/applications/admin/analytics",
  strictLimiter,
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({ target: APPLICATIONS_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/applications/:id/rescue",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.post(
  "/api/applications/:id/email",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.patch(
  "/api/applications/:id",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.delete(
  "/api/applications/:id",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);

// ─────────────────────────────────────────────
// COOPERATIVE
// ─────────────────────────────────────────────
app.get(
  "/api/cooperative",
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.post(
  "/api/cooperative",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.delete(
  "/api/cooperative/:id",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.post(
  "/api/cooperative/join",
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/cooperative/members",
  authenticate,
  requireRole("admin", "coordinator"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/cooperative/members/status/:status",
  authenticate,
  requireRole("admin", "coordinator"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/cooperative/members/me",
  authenticate,
  requireRole("admin", "coordinator", "trainer", "lead_trainer", "trainee"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/cooperative/members/me/payments",
  authenticate,
  requireRole("admin", "coordinator", "trainer", "lead_trainer", "trainee"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/cooperative/members/:id",
  authenticate,
  requireRole("admin", "coordinator"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/cooperative/by-application/:applicationId",
  authenticate,
  requireRole("admin", "coordinator"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.patch(
  "/api/cooperative/members/:id",
  authenticate,
  requireRole("admin", "coordinator"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/cooperative/stats",
  authenticate,
  requireRole("admin", "coordinator"),
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);

app.post(
  "/api/cooperative/payment/initialize",
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.post(
  "/api/cooperative/payment/verify",
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);


// ─────────────────────────────────────────────
// COMPLAINTS
// ─────────────────────────────────────────────
app.post(
  "/api/complaints",
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/complaints/:trackingCode",
  keepPath,
  createProxyMiddleware({
    target: APPLICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);

// ─────────────────────────────────────────────
// CONTACT & NEWSLETTER
// ─────────────────────────────────────────────
app.post(
  "/api/contact",
  strictLimiter,
  keepPath,
  createProxyMiddleware({
    target: NOTIFICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.post(
  "/api/newsletter/subscribe",
  strictLimiter,
  keepPath,
  createProxyMiddleware({
    target: NOTIFICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.delete(
  "/api/newsletter/unsubscribe",
  strictLimiter,
  keepPath,
  createProxyMiddleware({
    target: NOTIFICATIONS_SERVICE_URL,
    changeOrigin: true,
  }),
);

// ─────────────────────────────────────────────
// USERS
// IMPORTANT: sub-path routes (/id-document/meta,
// /id-document) must come BEFORE /:id so Express
// does not swallow "id-document" as a user ID.
// ─────────────────────────────────────────────
app.get(
  "/api/users",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/users",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/users/bulk-email",
  authenticate,
  requireRole("admin", "trainer", "lead_trainer"),
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);

// ADMIN — aggregated results for quizzes and exams
app.get(
  "/api/admin/results",
  authenticate,
  requireRole("admin", "trainer", "lead_trainer"),
  async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization ?? "";

      const [quizResp, examResp, usersResp] = await Promise.all([
        fetchFn(`${LMS_SERVICE_URL}/api/lms/quizzes/admin/attempts`, { headers: { Authorization: authHeader } }),
        fetchFn(`${LMS_SERVICE_URL}/api/lms/exams/admin/sessions`, { headers: { Authorization: authHeader } }),
        fetchFn(`${USER_SERVICE_URL}/api/users`, { headers: { Authorization: authHeader } }),
      ]);

      const quizAttempts = quizResp && quizResp.ok ? await quizResp.json() : [];
      const examSessions = examResp && examResp.ok ? await examResp.json() : [];
      const users = usersResp && usersResp.ok ? await usersResp.json() : [];

      const userMap = new Map((users || []).map((u: any) => [u.id, u]));

      const combined: any[] = [];

      for (const a of quizAttempts || []) {
        const u: any = userMap.get(a.userId) || {};
        combined.push({
          kind: "quiz",
          title: a.quizTitle,
          userId: a.userId,
          fullName: u.firstName ? `${u.firstName} ${u.lastName}` : null,
          email: u.email ?? null,
          score: a.score,
          passed: a.passed,
          date: a.attemptedAt,
        });
      }

      for (const s of examSessions || []) {
        const u: any = userMap.get(s.userId) || {};
        combined.push({
          kind: "exam",
          title: s.examTitle,
          userId: s.userId,
          fullName: u.firstName ? `${u.firstName} ${u.lastName}` : null,
          email: u.email ?? null,
          score: s.score ?? null,
          mcqScore: s.mcqScore ?? null,
          status: s.status,
          date: s.submittedAt ?? s.startedAt,
          isFullyMarked: s.isFullyMarked,
        });
      }

      return res.json({ results: combined });
    } catch (err) {
      console.error("[api-gateway] admin results error:", err);
      return res.status(500).json({ error: "Failed to fetch admin results" });
    }
  },
);


app.patch(
  "/api/users/:id/id-document",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/users/:id/id-document/meta",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/users/:id/id-document",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/users/:id/kyc-verify",
  authenticate,
  requireRole("admin"),
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);

// Generic user CRUD — after sub-paths
app.get(
  "/api/users/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/users/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.delete(
  "/api/users/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);

// ─────────────────────────────────────────────
// COHORTS
// ─────────────────────────────────────────────
app.get(
  "/api/cohorts",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/cohorts",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/cohorts/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/cohorts/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/cohorts/:id/enrol",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/cohorts/:id/groups",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: USER_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/cohorts/:id/groups",
  authenticate,
  keepPath,
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/groups/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.post(
  "/api/cohorts/:cohortId/groups/:groupId/members",
  authenticate,
  keepPath,
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.patch(
  "/api/cohorts/:cohortId/groups/:groupId",
  authenticate,
  keepPath,
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.delete(
  "/api/cohorts/:cohortId/groups/:groupId",
  authenticate,
  keepPath,
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.delete(
  "/api/cohorts/:cohortId/groups/:groupId/members/:userId",
  authenticate,
  keepPath,
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
  }),
);
app.get(
  "/api/groups/:id/members",
  authenticate,
  keepPath,
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
  }),
);
// ─────────────────────────────────────────────
// LMS — weeks
// ─────────────────────────────────────────────
app.get(
  "/api/lms/weeks",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/weeks",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/weeks/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/lms/weeks/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);

// ─────────────────────────────────────────────
// LMS — lessons
// ─────────────────────────────────────────────
app.get(
  "/api/lms/lessons/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/lessons",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/lms/lessons/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);

// ─────────────────────────────────────────────
// LMS — progress
// NOTE: /cohort/:cohortId must come BEFORE /:userId
// ─────────────────────────────────────────────
app.post(
  "/api/lms/progress",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/progress/cohort/:cohortId",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/progress/:userId",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);

// ─────────────────────────────────────────────
// LMS — sessions
// ─────────────────────────────────────────────
app.get(
  "/api/lms/sessions",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/sessions",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/lms/sessions/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/sessions/:id/assign",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);

// ─────────────────────────────────────────────
// LMS — stats
// ─────────────────────────────────────────────
app.get(
  "/api/lms/stats/summary",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);

// ─────────────────────────────────────────────
// LMS — quizzes
// ─────────────────────────────────────────────
app.get(
  "/api/lms/quizzes/admin/attempts",
  authenticate,
  requireRole("admin", "trainer", "lead_trainer"),
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/quizzes/week/:weekId",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/quizzes/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/quizzes",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/lms/quizzes/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/quizzes/:id/attempt",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/quizzes/:id/attempts/:userId",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);

// ─────────────────────────────────────────────
// LMS — exams
// IMPORTANT: specific sub-paths (sessions, questions,
// answers) must come BEFORE /:id routes
// ─────────────────────────────────────────────
app.get(
  "/api/lms/exams",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/exams",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/exams/sessions/:sessionId/result",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/exams/sessions/:sessionId/answers",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/lms/exams/sessions/:sessionId/autosave",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/exams/sessions/:sessionId/submit",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/exams/sessions/:sessionId/violations",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/lms/exams/questions/:questionId",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.delete(
  "/api/lms/exams/questions/:questionId",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/lms/exams/answers/:answerId/mark",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/exams/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.patch(
  "/api/lms/exams/:id",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/exams/:id/questions",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/exams/:id/questions",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/exams/:id/sessions/start",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/exams/:id/sessions",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);

// ─────────────────────────────────────────────
// LMS — week 12 attendance
// ─────────────────────────────────────────────
app.post(
  "/api/lms/week12/codes",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/week12/codes/:cohortId",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.post(
  "/api/lms/week12/checkin",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/week12/checkins/:cohortId",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);
app.get(
  "/api/lms/week12/checkins/:cohortId/:userId",
  authenticate,
  keepPath,
  createProxyMiddleware({ target: LMS_SERVICE_URL, changeOrigin: true }),
);

// ─────────────────────────────────────────────
// 404
// ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.listen(PORT, () => {
  console.log(`[api-gateway] Running on port ${PORT}`);
});
