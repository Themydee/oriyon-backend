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
import { users, cohorts, cohortMembers, groupMembers } from "./db/schema";
import { eq, and, sql } from "drizzle-orm";

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

      // Resolve cohort: ensure Cohort 1 is permanently closed to new enrolments.
      // If cohortId is Cohort 1, closed, or missing, divert to open Cohort 2.
      let targetCohortId = cohortId;
      let targetCohort = null;
      if (targetCohortId) {
        const [c] = await db.select().from(cohorts).where(eq(cohorts.id, targetCohortId)).limit(1);
        targetCohort = c;
      }

      if (!targetCohort || targetCohort.status === "closed" || targetCohort.name.toLowerCase().includes("cohort 1") || !targetCohort.isActive) {
        const openCohorts = await db
          .select()
          .from(cohorts)
          .where(and(eq(cohorts.status, "open"), eq(cohorts.isActive, true)));

        const c2 = openCohorts.find((c) => c.name.toLowerCase().includes("cohort 2")) || openCohorts[0];
        if (c2) {
          targetCohortId = c2.id;
          targetCohort = c2;
          console.log(`[user-service] Diverted approved applicant ${email} from closed cohort to ${c2.name} (${c2.id})`);
        }
      }

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

        if (targetCohortId) {
          try {
            const [alreadyEnrolled] = await db
              .select()
              .from(cohortMembers)
              .where(and(eq(cohortMembers.userId, reactivatedUser.id), eq(cohortMembers.cohortId, targetCohortId)))
              .limit(1);

            if (!alreadyEnrolled) {
              await db.insert(cohortMembers).values({ cohortId: targetCohortId, userId: reactivatedUser.id });
              await publishEvent("user.enrolled", {
                userId: reactivatedUser.id,
                cohortId: targetCohortId,
                enrolledAt: new Date().toISOString(),
              });
            }
          } catch (e) {
            console.error(`[user-service] Failed to auto-enroll existing user in cohort ${targetCohortId}:`, e);
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

      if (targetCohortId) {
        try {
          const [alreadyEnrolled] = await db
            .select()
            .from(cohortMembers)
            .where(and(eq(cohortMembers.userId, newUser.id), eq(cohortMembers.cohortId, targetCohortId)))
            .limit(1);

          if (!alreadyEnrolled) {
            await db.insert(cohortMembers).values({ cohortId: targetCohortId, userId: newUser.id });
            await publishEvent("user.enrolled", {
              userId: newUser.id,
              cohortId: targetCohortId,
              enrolledAt: new Date().toISOString(),
            });
          }
        } catch (e) {
          console.error(`[user-service] Failed to auto-enroll user in cohort ${targetCohortId}:`, e);
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
  try {
    await queryClient`ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'open' NOT NULL;`;
    await queryClient`UPDATE cohorts SET status = 'closed', is_active = false WHERE LOWER(name) LIKE '%cohort 1%' AND status != 'closed';`;
    await queryClient`CREATE UNIQUE INDEX IF NOT EXISTS idx_cohort_members_user_cohort ON cohort_members (user_id, cohort_id);`;

    const [c2Exists] = await db
      .select({ id: cohorts.id })
      .from(cohorts)
      .where(sql`LOWER(${cohorts.name}) LIKE '%cohort 2%'`)
      .limit(1);

    if (!c2Exists) {
      await db.insert(cohorts).values({
        name: "Cohort 2",
        description: "EEWYLA Cohort 2 Training Programme",
        state: "Oyo",
        status: "open",
        isActive: true,
      });
      console.log("[user-service] Seeded active Cohort 2.");
    }

    console.log("[user-service] Auto-migration and schema guards applied successfully.");
  } catch (migErr) {
    console.error("[user-service] Auto-migration error (non-fatal):", migErr);
  }

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