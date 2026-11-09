import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { connectRabbitMQ, consumeEvent, publishEvent } from "./rabbitmq";
import { userRouter, cohortRouter } from "./routes/users";
import adminRouter from "./routes/admin";
import idDocumentRouter from "./routes/id-document";
import { ticketsRouter } from "./routes/tickets";
import { chatRouter } from "./routes/chat";
import { users, cohortMembers, groupMembers } from "./db/schema";
import { eq } from "drizzle-orm";

const app = express();
const PORT = process.env.PORT || 3002;

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
const queryClient = postgres(process.env.DATABASE_URL!, {
  max: 30,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: {
    statement_timeout: 30000, // Max 30s per query in ms to prevent hung connections
    lock_timeout: 10000,      // Max 10s waiting for a lock in ms before failing safely
  },
});
export const db = drizzle(queryClient);

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "user-service" });
});

app.use("/users", idDocumentRouter);
app.use("/users", userRouter);
app.use("/cohorts", cohortRouter);
app.use("/admin", adminRouter);
app.use("/api/users", idDocumentRouter);
app.use("/api/users", userRouter);
app.use("/api/cohorts", cohortRouter);
app.use("/tickets", ticketsRouter);
app.use("/api/tickets", ticketsRouter);
app.use("/support-chat", chatRouter);
app.use("/api/support-chat", chatRouter);

// ─────────────────────────────────────────────
// RABBITMQ CONSUMERS
// ─────────────────────────────────────────────
async function setupConsumers() {

  // Application approved → create user profile or reactivate if existing → publish user.created
  // user.created is then picked up by:
  //   auth-service  → creates auth record + setup token
  //   notifications-service → sends setup email (via user.setup_requested)
  await consumeEvent(
    "application.approved",
    "user-service.application.approved",
    async (payload) => {
      const { userId, email, firstName, lastName, phone, cohortId, approvedRole, groupId, physicalSiteId, gender, age } = payload as any;

      // Idempotency guard — check if user already exists
      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing) {
        console.log(`[user-service] User ${email} already exists — reactivating`);
        
        const [reactivatedUser] = await db
          .update(users)
          .set({
            isActive: true,
            approvedRole,
            isCooperativeOnly: false,
            // Keep a site an admin already assigned; otherwise use the applicant's choice
            ...(existing.physicalSiteId ? {} : { physicalSiteId: physicalSiteId || null }),
            updatedAt: new Date(),
          })
          .where(eq(users.id, existing.id))
          .returning();

        if (cohortId) {
          try {
            await db.insert(cohortMembers).values({ cohortId, userId: reactivatedUser.id });
          } catch (e) {
            console.error(`[user-service] Failed to auto-enroll existing user in cohort ${cohortId}:`, e);
          }
        }
        if (groupId) {
          try {
            await db.insert(groupMembers).values({ groupId, userId: reactivatedUser.id });
          } catch (e) {
            console.error(`[user-service] Failed to auto-enroll existing user in group ${groupId}:`, e);
          }
        }

        // Publish user.created with existing userId so auth-service can reactivate it
        await publishEvent("user.created", {
          userId: reactivatedUser.id,
          email: reactivatedUser.email,
          firstName: reactivatedUser.firstName,
          lastName: reactivatedUser.lastName,
          role: reactivatedUser.role,
          isCooperativeOnly: false,
        });
        return;
      }

      // Create user profile in oriyon_user DB
      const [newUser] = await db
        .insert(users)
        .values({
          id: userId,
          email,
          firstName,
          lastName,
          phone,
          role: "trainee",
          approvedRole,
          gender: gender || null,
          age: (age && !isNaN(parseInt(age, 10))) ? parseInt(age, 10) : null,
          physicalSiteId: physicalSiteId || null,
          isActive: false,
        })
        .returning();

      if (cohortId) {
        try {
          await db.insert(cohortMembers).values({ cohortId, userId: newUser.id });
        } catch (e) {
          console.error(`[user-service] Failed to auto-enroll user in cohort ${cohortId}:`, e);
        }
      }
      if (groupId) {
        try {
          await db.insert(groupMembers).values({ groupId, userId: newUser.id });
        } catch (e) {
          console.error(`[user-service] Failed to auto-enroll user in group ${groupId}:`, e);
        }
      }

      console.log(`[user-service] Created user from approved application: ${email}`);

      // Publish user.created so auth-service can create
      // the auth record and generate the setup token
      await publishEvent("user.created", {
        userId: newUser.id,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        role: newUser.role,
      });
    }
  );

  // Application revoked (moved back to review) → deactivate user profile & memberships → publish user.deactivated
  await consumeEvent(
    "application.revoked",
    "user-service.application.revoked",
    async (payload) => {
      const { email, applicationId } = payload as any;
      if (!email) {
        console.error("[user-service][application.revoked] Missing email in payload");
        return;
      }

      // Find user by email
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (!user) {
        console.log(`[user-service] No user found for email ${email} — skipping deactivation`);
        return;
      }

      // Deactivate user profile
      await db
        .update(users)
        .set({
          isActive: false,
          approvedRole: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      // Remove any cohort and group memberships
      await db.delete(cohortMembers).where(eq(cohortMembers.userId, user.id));
      await db.delete(groupMembers).where(eq(groupMembers.userId, user.id));

      console.log(`[user-service] Deactivated user profile & memberships for ${email} (${user.id})`);

      // Publish user.deactivated event
      await publishEvent("user.deactivated", {
        userId: user.id,
        email: user.email,
      });
    }
  );

  // Cooperative payment verified → create user profile (if not exists) → publish user.created
  await consumeEvent(
    "cooperative.payment_verified",
    "user-service.cooperative.payment_verified",
    async (payload) => {
      const { email, firstName, lastName, phone, lga } = payload as any;
      if (!email) {
        console.error("[user-service][cooperative.payment_verified] Missing email");
        return;
      }

      // Check if user already exists
      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing) {
        console.log(`[user-service] User ${email} already exists — skipping cooperative provisioning`);
        return;
      }

      // Generate a new UUID
      const { randomUUID } = await import("crypto");
      const userId = randomUUID();

      // Create user profile in user DB
      const [newUser] = await db
        .insert(users)
        .values({
          id: userId,
          email,
          firstName: firstName || "Cooperative",
          lastName: lastName || "Member",
          phone: phone || null,
          role: "trainee",
          assignedLga: lga || null,
          isCooperativeOnly: true,
          isActive: false,
        })
        .returning();

      console.log(`[user-service] Created cooperative-only user: ${email}`);

      // Publish user.created
      await publishEvent("user.created", {
        userId: newUser.id,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        role: newUser.role,
        assignedLga: newUser.assignedLga,
        isCooperativeOnly: newUser.isCooperativeOnly,
      });
    }
  );

  // User activated (password setup complete) → update isActive to true in user profile
  await consumeEvent(
    "user.activated",
    "user-service.user.activated",
    async (payload) => {
      const { userId, isActive } = payload as any;
      if (!userId) {
        console.error("[user-service][user.activated] Missing userId");
        return;
      }

      await db
        .update(users)
        .set({
          isActive: isActive ?? true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      console.log(`[user-service] User ${userId} activated status synced: ${isActive}`);
    }
  );
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
async function bootstrap() {
  app.listen(PORT, () => {
    console.log(`[user-service] Running on port ${PORT}`);

    if (process.env.RABBITMQ_URL) {
      connectRabbitMQ(process.env.RABBITMQ_URL)
        .then(() => setupConsumers())
        .catch((err) => console.error("[user-service] RabbitMQ connection error:", err));
    }
  });
}

bootstrap().catch(console.error);