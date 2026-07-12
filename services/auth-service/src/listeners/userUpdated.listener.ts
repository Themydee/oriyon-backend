import { db } from "../index";
import { authUsers } from "../db/schema";

export async function handleUserUpdated(payload: Record<string, unknown>) {
  const { userId, role, assignedState, assignedLga, assignedZone, isActive } =
    payload as unknown as {
      userId: string;
      role?: string;
      assignedState?: string | null;
      assignedLga?: string | null;
      assignedZone?: string | null;
      isActive?: boolean;
    };

  if (!userId) {
    console.error("[auth-service][handleUserUpdated] Missing userId in payload:", payload);
    return;
  }

  try {
    const { eq } = await import("drizzle-orm");

    const updateData: any = { updatedAt: new Date() };
    if (role !== undefined) updateData.role = role as any;
    if (assignedState !== undefined) updateData.assignedState = assignedState;
    if (assignedLga !== undefined) updateData.assignedLga = assignedLga;
    if (assignedZone !== undefined) updateData.assignedZone = assignedZone;
    if (isActive !== undefined) updateData.isActive = isActive;

    await db.update(authUsers).set(updateData).where(eq(authUsers.id, userId));
    console.log(`[auth-service][handleUserUpdated] Synced auth record for ${userId}`);
  } catch (err) {
    console.error("[auth-service][handleUserUpdated] Error:", err);
    throw err;
  }
}
