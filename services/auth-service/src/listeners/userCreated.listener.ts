import crypto from "crypto";
import { db } from "../index";
import { authUsers, setupTokens } from "../db/schema";
import { publishEvent } from "../rabbitmq";
import { EVENTS } from "../types";

// ─────────────────────────────────────────────
// handleUserCreated
//
// Triggered by: user.created  (published by user-service)
//
// What it does:
//   1. Creates an auth record for the new user
//      (no password yet — isActive = false)
//   2. Generates a one-time setup token (24hr expiry)
//   3. Publishes user.setup_requested so
//      notifications-service sends the welcome
//      email with the set-password link
//
// Idempotency:
//   - Checks by BOTH userId AND email to prevent duplicate key crashes
//     (RabbitMQ can redeliver messages on reconnect)
//   - If user exists but has no password: resend the setup email
//   - If user exists and has a password: skip silently (already active)
// ─────────────────────────────────────────────

interface UserCreatedPayload {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  assignedState?: string | null;
  assignedLga?: string | null;
  assignedZone?: string | null;
  isCooperativeOnly?: boolean;
}

export async function handleUserCreated(payload: Record<string, unknown>) {
  const { userId, email, firstName, lastName, role, assignedState, assignedLga, assignedZone, isCooperativeOnly } =
    payload as unknown as UserCreatedPayload;

  if (!userId || !email) {
    console.error("[auth-service][handleUserCreated] Missing required fields:", payload);
    return;
  }

  try {
    const { eq, or } = await import("drizzle-orm");

    // ── 1. Idempotency check — look up by both userId AND email ──────────────
    const [existing] = await db
      .select()
      .from(authUsers)
      .where(or(eq(authUsers.id, userId), eq(authUsers.email, email)))
      .limit(1);

    if (existing) {
      if (existing.passwordHash) {
        // Account is fully active — nothing to do
        console.log(`[auth-service][handleUserCreated] User ${email} already active — skipping`);
        return;
      }

      // Auth record exists but no password set → resend the setup email
      console.log(`[auth-service][handleUserCreated] User ${email} exists without password — resending setup email`);

      // Reuse a still-valid setup token, or create a fresh one
      const [existingToken] = await db
        .select()
        .from(setupTokens)
        .where(eq(setupTokens.userId, existing.id))
        .limit(1);

      let token: string;
      let expiresAt: Date;

      if (existingToken && existingToken.expiresAt > new Date()) {
        token = existingToken.token;
        expiresAt = existingToken.expiresAt;
        console.log(`[auth-service][handleUserCreated] Reusing valid setup token for ${email}`);
      } else {
        // Expired or missing — rotate to a fresh token
        token = crypto.randomBytes(32).toString("hex");
        expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await db.delete(setupTokens).where(eq(setupTokens.userId, existing.id));
        await db.insert(setupTokens).values({ userId: existing.id, token, expiresAt });
        console.log(`[auth-service][handleUserCreated] Rotated setup token for ${email}`);
      }

      await publishEvent(EVENTS.USER_SETUP_REQUESTED, {
        userId: existing.id,
        email: existing.email,
        firstName,
        lastName,
        token,
        expiresAt: expiresAt.toISOString(),
        setupLink: `${process.env.FRONTEND_URL}/auth/setup?token=${token}`,
      });

      console.log(`[auth-service][handleUserCreated] Setup email re-queued for ${email}`);
      return;
    }

    // ── 2. New user — create auth record ─────────────────────────────────────
    await db.insert(authUsers).values({
      id: userId,          // same UUID as user-service — critical
      email,
      passwordHash: null,
      role: role as any,
      assignedState: assignedState || null,
      assignedLga: assignedLga || null,
      assignedZone: assignedZone || null,
      isCooperativeOnly: isCooperativeOnly ?? false,
      isActive: false,
    });

    // ── 3. Generate one-time setup token ─────────────────────────────────────
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await db.insert(setupTokens).values({ userId, token, expiresAt });

    // ── 4. Publish — notifications-service sends the welcome email ────────────
    await publishEvent(EVENTS.USER_SETUP_REQUESTED, {
      userId,
      email,
      firstName,
      lastName,
      token,
      expiresAt: expiresAt.toISOString(),
      setupLink: `${process.env.FRONTEND_URL}/auth/setup?token=${token}`,
    });

    console.log(`[auth-service][handleUserCreated] Auth record + setup token created for ${email}`);
  } catch (err) {
    console.error("[auth-service][handleUserCreated] Error:", err);
    throw err; // rethrow so rabbitmq.ts nacks the message
  }
}