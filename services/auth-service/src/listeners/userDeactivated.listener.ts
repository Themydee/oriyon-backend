import { db } from "../index";
import { authUsers, refreshTokens } from "../db/schema";

export async function handleUserDeactivated(payload: Record<string, unknown>) {
  const { userId, email } = payload as any;

  if (!userId) {
    console.error("[auth-service][handleUserDeactivated] Missing userId in payload:", payload);
    return;
  }

  try {
    const { eq } = await import("drizzle-orm");

    // Deactivate auth record
    await db
      .update(authUsers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(authUsers.id, userId));

    // Revoke all refresh tokens
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));

    console.log(`[auth-service][handleUserDeactivated] Deactivated auth record & revoked refresh tokens for user ${userId} (${email || "no email"})`);
  } catch (err) {
    console.error("[auth-service][handleUserDeactivated] Error handling user deactivation:", err);
    throw err;
  }
}
