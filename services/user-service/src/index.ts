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
import { users, cohortMembers, groupMembers } from "./db/schema";
import { eq } from "drizzle-orm";

const app = express();
const PORT = process.env.PORT || 3002;

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
const queryClient = postgres(process.env.DATABASE_URL!);
export const db = drizzle(queryClient);

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));

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
      const { userId, email, firstName, lastName, phone, cohortId, approvedRole } = payload as any;

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
            updatedAt: new Date(),
          })
          .where(eq(users.id, existing.id))
          .returning();

        // Publish user.created with existing userId so auth-service can reactivate it
        await publishEvent("user.created", {
          userId: reactivatedUser.id,
          email: reactivatedUser.email,
          firstName: reactivatedUser.firstName,
          lastName: reactivatedUser.lastName,
          role: reactivatedUser.role,
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
        })
        .returning();

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
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
async function bootstrap() {
  await connectRabbitMQ(process.env.RABBITMQ_URL!);
  await setupConsumers();
  app.listen(PORT, () => {
    console.log(`[user-service] Running on port ${PORT}`);
  });
}

bootstrap().catch(console.error);