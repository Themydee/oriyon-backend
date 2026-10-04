import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { eq, and, sql, ilike, gte, desc, isNull } from "drizzle-orm";
import { db } from "../index";
import { authUsers, refreshTokens, setupTokens, loginEvents, loginAttemptCounters } from "../db/schema";
import { publishEvent } from "../rabbitmq";
import { EVENTS } from "../types";
import { getClientFrontendUrl } from "../utils/urlHelper";

const router = Router();

// ─────────────────────────────────────────────
// SCHEMAS
// ─────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const setPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function generateAccessToken(user: { id: string; email: string; role: string; assignedState?: string | null; assignedLga?: string | null; assignedZone?: string | null; isCooperativeOnly?: boolean }) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      assignedState: user.assignedState || null,
      assignedLga: user.assignedLga || null,
      assignedZone: user.assignedZone || null,
      isCooperativeOnly: user.isCooperativeOnly ?? false,
    },
    process.env.JWT_SECRET!,
    { expiresIn: (process.env.JWT_EXPIRES_IN || "15m") as any }
  );
}

function generateRefreshToken(userId: string) {
  return jwt.sign(
    // jti keeps tokens unique when the same user logs in twice within one second
    { userId, jti: crypto.randomUUID() },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || "7d") as any }
  );
}

async function saveRefreshToken(userId: string, token: string) {
  try {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await db.insert(refreshTokens).values({ userId, token, expiresAt });
  } catch (err) {
    console.warn("[auth] saveRefreshToken warning:", err);
  }
}

// Records a login / set-password / reset-password attempt for the
// monitoring report. Never throws — monitoring must not break auth.
async function recordLoginEvent(
  req: Request,
  event: "login" | "set_password" | "reset_password",
  success: boolean,
  reason: string,
  user?: { id?: string | null; email?: string | null; role?: string | null },
) {
  try {
    const forwarded = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
    await db.insert(loginEvents).values({
      event,
      success,
      reason,
      email: user?.email?.trim().toLowerCase().slice(0, 255) || null,
      userId: user?.id || null,
      role: user?.role || null,
      ip: (forwarded || req.ip || "").slice(0, 64) || null,
      userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 500) || null,
    });
  } catch (err) {
    console.warn("[auth] recordLoginEvent warning:", err);
  }
}

// ─────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────
// Per-account brute-force guard: at most this many login attempts per email
// in a fixed window. Each attempt is counted with one atomic upsert before the
// password is checked, so concurrent guesses cannot all read a stale count.
// A successful login clears the counter. The gateway's per-IP limit is
// deliberately generous because trainees at a training site share one IP.
const MAX_LOGIN_ATTEMPTS_PER_EMAIL = 10;
const LOGIN_ATTEMPT_WINDOW_MINUTES = 15;

async function reserveLoginAttempt(email: string): Promise<boolean> {
  const rows = await db.execute(sql`
    INSERT INTO login_attempt_counters (email, attempts, window_start)
    VALUES (${email}, 1, now())
    ON CONFLICT (email) DO UPDATE SET
      attempts = CASE
        WHEN login_attempt_counters.window_start < now() - make_interval(mins => ${LOGIN_ATTEMPT_WINDOW_MINUTES}) THEN 1
        ELSE login_attempt_counters.attempts + 1
      END,
      window_start = CASE
        WHEN login_attempt_counters.window_start < now() - make_interval(mins => ${LOGIN_ATTEMPT_WINDOW_MINUTES}) THEN now()
        ELSE login_attempt_counters.window_start
      END
    RETURNING attempts
  `);
  const row = ((rows as any).rows ?? rows)[0];
  return Number(row?.attempts ?? 0) <= MAX_LOGIN_ATTEMPTS_PER_EMAIL;
}

async function clearLoginAttempts(email: string) {
  try {
    await db.delete(loginAttemptCounters).where(eq(loginAttemptCounters.email, email));
  } catch (err) {
    console.warn("[auth] clearLoginAttempts warning:", err);
  }
}

router.post("/login", async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    await recordLoginEvent(req, "login", false, "invalid_input", {
      email: typeof req.body?.email === "string" ? req.body.email : null,
    });
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }

  try {
    const { email, password } = parsed.data;
    const cleanEmail = email.trim().toLowerCase();

    if (!(await reserveLoginAttempt(cleanEmail))) {
      await recordLoginEvent(req, "login", false, "locked_out", { email: cleanEmail });
      return res.status(429).json({
        error: `Too many sign-in attempts for this account. Please wait ${LOGIN_ATTEMPT_WINDOW_MINUTES} minutes or reset your password.`,
      });
    }

    const [user] = await db
      .select()
      .from(authUsers)
      .where(sql`LOWER(TRIM(${authUsers.email})) = ${cleanEmail}`)
      .limit(1);

    if (!user) {
      await recordLoginEvent(req, "login", false, "unknown_email", { email: cleanEmail });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!user.isActive) {
      if (user.passwordHash) {
        await recordLoginEvent(req, "login", false, "account_restricted", user);
        return res.status(403).json({ error: "Your application is undergoing a revisit. Access is restricted at this time." });
      }
      await recordLoginEvent(req, "login", false, "setup_incomplete", user);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Guard: user exists but has never set a password yet
    if (!user.passwordHash) {
      await recordLoginEvent(req, "login", false, "setup_incomplete", user);
      return res.status(403).json({ error: "Account setup not complete. Please check your email for a setup link." });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await recordLoginEvent(req, "login", false, "wrong_password", user);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user.id);
    await saveRefreshToken(user.id, refreshToken);

    try {
      await db
        .update(authUsers)
        .set({ lastLoginAt: new Date() })
        .where(eq(authUsers.id, user.id));
    } catch (updateErr) {
      console.warn("[auth] Failed to update lastLoginAt:", updateErr);
    }

    try {
      await publishEvent(EVENTS.USER_LOGGED_IN, {
        userId: user.id,
        email: user.email,
        timestamp: new Date().toISOString(),
      });
    } catch (rabbitmqErr) {
      console.error("[auth] Failed to publish user.logged_in event to RabbitMQ, continuing login:", rabbitmqErr);
    }

    await clearLoginAttempts(cleanEmail);
    await recordLoginEvent(req, "login", true, "ok", user);
    return res.json({ accessToken, refreshToken, role: user.role });
  } catch (err: any) {
    console.error("[auth] login error:", err);
    await recordLoginEvent(req, "login", false, "server_error", { email: parsed.data.email });
    return res.status(500).json({ error: "Internal server error", message: err?.message || String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /auth/refresh
// ─────────────────────────────────────────────
router.post("/refresh", async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: "Refresh token required" });

  try {
    const payload = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET!
    ) as { userId: string };

    const [stored] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.token, refreshToken))
      .limit(1);

    if (!stored || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    const [user] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, payload.userId))
      .limit(1);

    if (!user || !user.isActive) {
      return res.status(401).json({ error: "User not found or inactive" });
    }

    const accessToken = generateAccessToken(user);
    return res.json({ accessToken });
  } catch {
    return res.status(401).json({ error: "Invalid refresh token" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/logout
// ─────────────────────────────────────────────
router.post("/logout", async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await db.delete(refreshTokens).where(eq(refreshTokens.token, refreshToken));
  }
  return res.json({ message: "Logged out" });
});

// ─────────────────────────────────────────────
// GET /auth/verify  — called internally by api-gateway
// ─────────────────────────────────────────────
router.get("/verify", (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ valid: false });
  }
  try {
    const token = authHeader.split(" ")[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET!);
    return res.json({ valid: true, payload });
  } catch {
    return res.status(401).json({ valid: false });
  }
});

// ─────────────────────────────────────────────
// POST /auth/set-password
// First-time password setup via emailed token
// ─────────────────────────────────────────────
router.post("/set-password", async (req: Request, res: Response) => {
  const parsed = setPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { token, password } = parsed.data;

  try {
    const [setupToken] = await db
      .select()
      .from(setupTokens)
      .where(eq(setupTokens.token, token))
      .limit(1);

    if (!setupToken) {
      await recordLoginEvent(req, "set_password", false, "invalid_token");
      return res.status(400).json({ error: "Invalid token" });
    }
    if (setupToken.used) {
      await recordLoginEvent(req, "set_password", false, "token_used", { id: setupToken.userId });
      return res.status(400).json({ error: "Token has already been used" });
    }
    if (setupToken.expiresAt < new Date()) {
      await recordLoginEvent(req, "set_password", false, "token_expired", { id: setupToken.userId });
      return res.status(400).json({ error: "Token has expired. Please contact support." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Save password + activate account — never for a revoked account
    // (its application was moved back to review; it must be approved again).
    const activated = await db
      .update(authUsers)
      .set({ passwordHash, isActive: true, updatedAt: new Date() })
      .where(and(eq(authUsers.id, setupToken.userId), isNull(authUsers.revokedAt)))
      .returning({ id: authUsers.id });

    if (activated.length === 0) {
      await db.update(setupTokens).set({ used: true }).where(eq(setupTokens.id, setupToken.id));
      await recordLoginEvent(req, "set_password", false, "account_revoked", { id: setupToken.userId });
      return res.status(403).json({
        error: "This account is no longer active. Please contact eewyla@oriyoninternational.com.",
      });
    }

    // Publish user.activated to sync user-service profile
    try {
      await publishEvent("user.activated", {
        userId: setupToken.userId,
        isActive: true,
      });
    } catch (rabbitmqErr) {
      console.error("[auth] Failed to publish user.activated event to RabbitMQ, continuing set-password:", rabbitmqErr);
    }

    // Invalidate the token
    await db
      .update(setupTokens)
      .set({ used: true })
      .where(eq(setupTokens.id, setupToken.id));

    // Log them in immediately
    const [user] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, setupToken.userId))
      .limit(1);

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user.id);
    await saveRefreshToken(user.id, refreshToken);

    await db
      .update(authUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(authUsers.id, user.id));

    await recordLoginEvent(req, "set_password", true, "ok", user);
    return res.json({ accessToken, refreshToken, role: user.role });
  } catch (err) {
    console.error("[auth] set-password error:", err);
    await recordLoginEvent(req, "set_password", false, "server_error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/forgot-password
// User requests a password reset link
// ─────────────────────────────────────────────
router.post("/forgot-password", async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email } = parsed.data;

  // Always return 200 — never reveal whether the email exists
  const genericResponse = { message: "If that email is registered, a reset link has been sent." };

  try {
    const [user] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .limit(1);

    if (!user || !user.isActive) return res.json(genericResponse);

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.insert(setupTokens).values({ userId: user.id, token, expiresAt });

    const baseUrl = getClientFrontendUrl(req);
    await publishEvent(EVENTS.PASSWORD_RESET_REQUESTED, {
      userId: user.id,
      email: user.email,
      token,
      expiresAt: expiresAt.toISOString(),
      baseUrl,
      resetLink: `${baseUrl}/auth/reset-password?token=${token}`,
    });

    return res.json(genericResponse);
  } catch (err) {
    console.error("[auth] forgot-password error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Create a fresh 7-day setup token and publish the setup email event.
async function issueSetupLink(req: Request, user: { id: string; email: string }) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days (1 week) for setup

  await db.insert(setupTokens).values({ userId: user.id, token, expiresAt });

  const baseUrl = getClientFrontendUrl(req);
  await publishEvent(EVENTS.USER_SETUP_REQUESTED, {
    userId: user.id,
    email: user.email,
    token,
    expiresAt: expiresAt.toISOString(),
    baseUrl,
    setupLink: `${baseUrl}/auth/setup?token=${token}`,
  });
}

// Look up a user-service profile by exact email (used by the admin resend path
// when an approved user has a profile but no auth record yet).
async function findUserProfileByEmail(email: string, callerId: string, callerRole: string) {
  const base = process.env.USER_SERVICE_URL || "http://localhost:3002";
  const r = await fetch(`${base}/users?search=${encodeURIComponent(email)}&limit=20`, {
    headers: { "x-user-id": callerId, "x-user-role": callerRole },
  });
  if (!r.ok) throw new Error(`user-service responded ${r.status}`);
  const body: any = await r.json();
  const list: any[] = body?.data ?? body?.users ?? [];
  return list.find((u) => typeof u?.email === "string" && u.email.toLowerCase() === email.toLowerCase()) ?? null;
}

// ─────────────────────────────────────────────
// POST /auth/resend-setup
// Public: resend the first-time setup link to an existing account that has
// not set a password yet. Always returns the same reply so it cannot be used
// to discover or create accounts.
// ─────────────────────────────────────────────
router.post("/resend-setup", async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body); // reuse { email } schema
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email } = parsed.data;
  const genericResponse = {
    message: "If this email belongs to an approved account that still needs a password, a setup link has been sent.",
  };

  try {
    const [user] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .limit(1);

    if (user && !user.passwordHash && !user.revokedAt) {
      await issueSetupLink(req, user);
    }

    return res.json(genericResponse);
  } catch (err) {
    console.error("[auth] resend-setup error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Look up user-service profiles for many ids at once (chunks of 500).
async function lookupProfilesByIds(ids: string[], callerId: string, callerRole: string) {
  const base = process.env.USER_SERVICE_URL || "http://localhost:3002";
  const found = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 500) {
    const r = await fetch(`${base}/users/lookup-by-ids`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": callerId, "x-user-role": callerRole },
      body: JSON.stringify({ ids: ids.slice(i, i + 500) }),
    });
    if (!r.ok) throw new Error(`user-service responded ${r.status}`);
    const body: any = await r.json();
    for (const p of body?.data ?? []) found.set(p.id, p);
  }
  return found;
}

// ─────────────────────────────────────────────
// POST /auth/admin/resend-setup/bulk
// Admin / sub_admin: send setup links to every approved person who has not
// set a password yet. Only accounts with a user-service profile are included
// (orphan auth records, e.g. from the old public sign-up loophole, are skipped).
// Body: { dryRun?: boolean, skipActiveLinks?: boolean, limit?: number }
//   dryRun          — only return the counts, send nothing
//   skipActiveLinks — leave out people whose current link has not expired
//   limit           — send at most this many (oldest accounts first), so a
//                     large backlog can go out in batches within email quotas
// ─────────────────────────────────────────────
router.post("/admin/resend-setup/bulk", async (req: Request, res: Response) => {
  const callerRole = req.headers["x-user-role"] as string;
  const callerId = req.headers["x-user-id"] as string;
  if (callerRole !== "admin" && callerRole !== "sub_admin") {
    return res.status(403).json({ error: "Forbidden — admin only" });
  }

  const parsed = z
    .object({
      dryRun: z.boolean().optional().default(false),
      skipActiveLinks: z.boolean().optional().default(true),
      limit: z.number().int().min(1).max(1000).optional().default(100),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { dryRun, skipActiveLinks, limit } = parsed.data;

  try {
    const pendingAll = await db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        createdAt: authUsers.createdAt,
        revokedAt: authUsers.revokedAt,
      })
      .from(authUsers)
      .where(isNull(authUsers.passwordHash))
      .orderBy(authUsers.createdAt);
    const pending = pendingAll.filter((u) => !u.revokedAt);

    const profiles = await lookupProfilesByIds(pending.map((u) => u.id), callerId, callerRole);
    // Revoked before revoked_at existed: the profile's approval was cleared
    // (application.revoked sets approvedRole to null). Leave those out; an
    // admin can still send to a specific person from the single-send form.
    const looksRevoked = (p: any) =>
      p.role === "trainee" && !p.isCooperativeOnly && !p.approvedRole && p.isActive === false;
    const withProfile = pending.filter((u) => profiles.has(u.id) && !looksRevoked(profiles.get(u.id)));

    const activeRows = await db
      .select({ userId: setupTokens.userId })
      .from(setupTokens)
      .where(and(eq(setupTokens.used, false), gte(setupTokens.expiresAt, new Date())));
    const hasActiveLink = new Set(activeRows.map((r) => r.userId));

    const eligible = skipActiveLinks ? withProfile.filter((u) => !hasActiveLink.has(u.id)) : withProfile;
    const batch = eligible.slice(0, limit);

    const summary = {
      pendingAccounts: pendingAll.length,
      revoked: pendingAll.length - pending.length + pending.filter((u) => profiles.has(u.id) && looksRevoked(profiles.get(u.id))).length,
      withoutProfile: pending.filter((u) => !profiles.has(u.id)).length,
      withActiveLink: withProfile.filter((u) => hasActiveLink.has(u.id)).length,
      eligible: eligible.length,
      batchSize: batch.length,
    };

    if (dryRun) {
      return res.json({ dryRun: true, ...summary });
    }

    let sent = 0;
    const failed: string[] = [];
    for (const u of batch) {
      try {
        await issueSetupLink(req, u);
        sent++;
      } catch (err) {
        console.error(`[auth] bulk resend-setup failed for ${u.id}:`, err);
        failed.push(u.email);
      }
    }

    return res.json({
      dryRun: false,
      ...summary,
      sent,
      failed: failed.length,
      remaining: Math.max(0, eligible.length - sent),
    });
  } catch (err) {
    console.error("[auth] bulk resend-setup error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/admin/resend-setup
// Admin / sub_admin: send a setup link. If the person has a user-service
// profile but no auth record yet, the auth record is created with the
// profile's id and role. Unknown emails are refused.
// ─────────────────────────────────────────────
router.post("/admin/resend-setup", async (req: Request, res: Response) => {
  const callerRole = req.headers["x-user-role"] as string;
  const callerId = req.headers["x-user-id"] as string;
  if (callerRole !== "admin" && callerRole !== "sub_admin") {
    return res.status(403).json({ error: "Forbidden — admin only" });
  }

  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email } = parsed.data;

  try {
    let [user] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .limit(1);

    if (!user) {
      const profile = await findUserProfileByEmail(email, callerId, callerRole);
      if (!profile?.id) {
        return res.status(404).json({
          error: "No user profile with this email. Approve their application first.",
        });
      }

      [user] = await db
        .insert(authUsers)
        .values({
          id: profile.id,
          email,
          role: profile.role || "trainee",
          isActive: false,
        })
        .onConflictDoNothing()
        .returning();

      if (!user) {
        [user] = await db.select().from(authUsers).where(eq(authUsers.id, profile.id)).limit(1);
      }
      if (!user) {
        return res.status(409).json({ error: "Could not create the auth record for this user." });
      }
    }

    if (user.passwordHash) {
      return res.json({ message: "User has already set up their account password." });
    }

    if (user.revokedAt) {
      return res.status(409).json({
        error: "This person's application was revoked. Approve the application again to send a new setup link.",
      });
    }

    await issueSetupLink(req, user);
    return res.json({ message: `Account setup email successfully sent to ${email}.` });
  } catch (err) {
    console.error("[auth] admin resend-setup error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/reset-password
// Submit a new password using a reset token
// ─────────────────────────────────────────────
router.post("/reset-password", async (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { token, password } = parsed.data;

  try {
    const [setupToken] = await db
      .select()
      .from(setupTokens)
      .where(eq(setupTokens.token, token))
      .limit(1);

    if (!setupToken || setupToken.used || setupToken.expiresAt < new Date()) {
      await recordLoginEvent(req, "reset_password", false, "invalid_or_expired_token", setupToken ? { id: setupToken.userId } : undefined);
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await db
      .update(authUsers)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(authUsers.id, setupToken.userId));

    await db
      .update(setupTokens)
      .set({ used: true })
      .where(eq(setupTokens.id, setupToken.id));

    // Invalidate all existing sessions on all devices
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.userId, setupToken.userId));

    await recordLoginEvent(req, "reset_password", true, "ok", { id: setupToken.userId });
    return res.json({ message: "Password reset successfully. Please log in." });
  } catch (err) {
    console.error("[auth] reset-password error:", err);
    await recordLoginEvent(req, "reset_password", false, "server_error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────
// PATCH /auth/change-password
// Logged-in user changes their own password
// Requires: x-user-id header (injected by gateway)
// ─────────────────────────────────────────────
router.patch("/change-password", async (req: Request, res: Response) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { currentPassword, newPassword } = parsed.data;

  try {
    const [user] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .limit(1);

    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.passwordHash) {
      return res.status(400).json({ error: "No password set on this account" });
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "New password must be different from current password" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await db
      .update(authUsers)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(authUsers.id, userId));

    // Invalidate all refresh tokens — forces re-login on all other devices
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.userId, userId));

    return res.json({ message: "Password changed successfully. Please log in again." });
  } catch (err) {
    console.error("[auth] change-password error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────
// GET /auth/admin/setup-token/:email
// Admin only — fetch setup token for manual copying
// ─────────────────────────────────────────────
router.get("/admin/setup-token/:email", async (req: Request, res: Response) => {
  const callerRole = req.headers["x-user-role"] as string;
  if (callerRole !== "admin") {
    return res.status(403).json({ error: "Forbidden — admin only" });
  }

  const { email } = req.params;

  try {
    const [user] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .limit(1);

    if (!user) {
      return res.status(404).json({ error: "User not found in auth system" });
    }

    const [setupToken] = await db
      .select()
      .from(setupTokens)
      .where(
        and(
          eq(setupTokens.userId, user.id),
          eq(setupTokens.used, false)
        )
      )
      .orderBy(setupTokens.createdAt)
      .limit(1);

    if (!setupToken) {
      return res.status(404).json({ error: "No active setup token found" });
    }

    return res.json({ token: setupToken.token });
  } catch (err) {
    console.error("[auth] fetch setup token error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────
// GET /auth/admin/login-activity?hours=24
// Admin only (called by the gateway's monitoring report).
// Aggregated login / onboarding activity for the window.
// ─────────────────────────────────────────────
router.get("/admin/login-activity", async (req: Request, res: Response) => {
  const callerRole = req.headers["x-user-role"] as string;
  if (callerRole !== "admin") {
    return res.status(403).json({ error: "Forbidden — admin only" });
  }

  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  try {
    const byOutcome = await db
      .select({
        event: loginEvents.event,
        success: loginEvents.success,
        reason: loginEvents.reason,
        count: sql<number>`count(*)::int`,
      })
      .from(loginEvents)
      .where(gte(loginEvents.createdAt, since))
      .groupBy(loginEvents.event, loginEvents.success, loginEvents.reason);

    const successfulByRole = await db
      .select({
        role: loginEvents.role,
        logins: sql<number>`count(*)::int`,
        uniqueUsers: sql<number>`count(distinct ${loginEvents.userId})::int`,
      })
      .from(loginEvents)
      .where(and(gte(loginEvents.createdAt, since), eq(loginEvents.event, "login"), eq(loginEvents.success, true)))
      .groupBy(loginEvents.role);

    const byHour = await db
      .select({
        hour: sql<string>`to_char(date_trunc('hour', ${loginEvents.createdAt}), 'YYYY-MM-DD"T"HH24:00')`,
        success: sql<number>`count(*) filter (where ${loginEvents.success})::int`,
        failed: sql<number>`count(*) filter (where not ${loginEvents.success})::int`,
      })
      .from(loginEvents)
      .where(and(gte(loginEvents.createdAt, since), eq(loginEvents.event, "login")))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    // Accounts and IPs with repeated failures — possible lockouts or brute force
    const topFailingEmails = await db
      .select({
        email: loginEvents.email,
        failures: sql<number>`count(*)::int`,
        reasons: sql<string[]>`array_agg(distinct ${loginEvents.reason})`,
        lastAttempt: sql<string>`max(${loginEvents.createdAt})`,
      })
      .from(loginEvents)
      .where(and(gte(loginEvents.createdAt, since), eq(loginEvents.success, false), sql`${loginEvents.email} is not null`))
      .groupBy(loginEvents.email)
      .orderBy(desc(sql`count(*)`))
      .limit(15);

    const topFailingIps = await db
      .select({
        ip: loginEvents.ip,
        failures: sql<number>`count(*)::int`,
        distinctEmails: sql<number>`count(distinct ${loginEvents.email})::int`,
      })
      .from(loginEvents)
      .where(and(gte(loginEvents.createdAt, since), eq(loginEvents.success, false), sql`${loginEvents.ip} is not null`))
      .groupBy(loginEvents.ip)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    // Onboarding funnel: accounts created but password never set
    const [pendingSetup] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(authUsers)
      .where(sql`${authUsers.passwordHash} is null`);

    const [expiredUnusedSetupTokens] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(setupTokens)
      .where(and(eq(setupTokens.used, false), sql`${setupTokens.expiresAt} < now()`));

    return res.json({
      windowHours: hours,
      since: since.toISOString(),
      byOutcome,
      successfulByRole,
      byHour,
      topFailingEmails,
      topFailingIps,
      accountsPendingSetup: pendingSetup?.count ?? 0,
      expiredUnusedSetupTokens: expiredUnusedSetupTokens?.count ?? 0,
    });
  } catch (err) {
    console.error("[auth] login-activity error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
