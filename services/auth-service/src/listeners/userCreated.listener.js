import crypto from "crypto";
import { db } from "../index";
import { authUsers, setupTokens } from "../db/schema";
import { publishEvent } from "../rabbitmq";
import { EVENTS } from "../types";
export async function handleUserCreated(payload) {
    const { userId, email, firstName, lastName, role } = payload;
    if (!userId || !email) {
        console.error("[auth-service][handleUserCreated] Missing required fields:", payload);
        return;
    }
    try {
        // 1. Check if auth record already exists (idempotency guard)
        const { eq } = await import("drizzle-orm");
        const [existing] = await db
            .select()
            .from(authUsers)
            .where(eq(authUsers.id, userId))
            .limit(1);
        if (existing) {
            console.warn(`[auth-service][handleUserCreated] Auth record already exists for ${userId}`);
            return;
        }
        // 2. Create auth record — inactive until set-password completes
        await db.insert(authUsers).values({
            id: userId, // same UUID as user-service — critical
            email,
            passwordHash: null,
            role: role,
            isActive: false,
        });
        // 3. Generate one-time setup token
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        await db.insert(setupTokens).values({ userId, token, expiresAt });
        // 4. Publish event — notifications-service sends the welcome email
        await publishEvent(EVENTS.USER_SETUP_REQUESTED, {
            userId,
            email,
            firstName,
            lastName,
            token,
            expiresAt: expiresAt.toISOString(),
            setupLink: `${process.env.FRONTEND_URL}/set-password?token=${token}`,
        });
        console.log(`[auth-service][handleUserCreated] Auth record + setup token created for ${email}`);
    }
    catch (err) {
        console.error("[auth-service][handleUserCreated] Error:", err);
        throw err; // rethrow so rabbitmq.ts nacks the message
    }
}
