import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { connectRabbitMQ, consumeEvent } from "./rabbitmq";
import { contactRouter, newsletterRouter } from "./routes/notifications";
import { sendEmail, templates } from "./email";

const app = express();
const PORT = process.env.PORT || 3005;

const queryClient = postgres(process.env.DATABASE_URL!);
export const db = drizzle(queryClient);

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "notifications-service" });
});

app.use("/contact", contactRouter);
app.use("/newsletter", newsletterRouter);
app.use("/api/contact", contactRouter);    // add this
app.use("/api/newsletter", newsletterRouter); // add this

// ─────────────────────────────────────────────
// RABBITMQ CONSUMERS
// ─────────────────────────────────────────────
async function setupConsumers() {

  // ── Applications ──────────────────────────────

  // Application submitted → confirmation email to applicant
  await consumeEvent(
    "application.submitted",
    "notifications.application.submitted",
    async (payload) => {
      const { email, firstName } = payload as any;
      const tpl = templates.applicationConfirmation(firstName);
      await sendEmail({ to: email, ...tpl });
    }
  );

  // Application approved → send approval confirmation email
  await consumeEvent(
    "application.approved",
    "notifications.application.approved",
    async (payload) => {
      const { email, firstName } = payload as any;
      const tpl = templates.applicationApproved(firstName);
      await sendEmail({ to: email, ...tpl });
    }
  );

  // Application rejected → rejection email
  await consumeEvent(
    "application.rejected",
    "notifications.application.rejected",
    async (payload) => {
      const { email, firstName } = payload as any;
      const tpl = templates.applicationRejected(firstName);
      await sendEmail({ to: email, ...tpl });
    }
  );

  // ── Account Setup ─────────────────────────────

  // New user created by admin → send set-password link
  // New user created by admin → send set-password link
  // Triggered by auth-service after it creates the auth record + setup token
  await consumeEvent(
    "user.setup_requested",
    "notifications.user.setup_requested",
    async (payload) => {
      const { email, firstName, setupLink, token } = payload as any;

      // If token is provided instead of setupLink, build the link
      const effectiveLink = setupLink || `${process.env.FRONTEND_URL}/setup-password?token=${token}`;

      const tpl = templates.accountSetup(firstName || "there", effectiveLink);
      await sendEmail({ to: email, ...tpl });
    }
  );

  // ── Password Reset ────────────────────────────

  // User requested a password reset → send reset link
  await consumeEvent(
    "auth.password_reset_requested",
    "notifications.auth.password_reset_requested",
    async (payload) => {
      const { email, firstName, token } = payload as any;
      const resetLink = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;
      const tpl = templates.passwordReset(firstName || "there", resetLink);
      await sendEmail({ to: email, ...tpl });
    }
  );

  // ── LMS ───────────────────────────────────────

  // Lesson completed → milestone email
  // NOTE: lms-service must include email + firstName in the event payload
  await consumeEvent(
    "lesson.completed",
    "notifications.lesson.completed",
    async (payload) => {
      const { email, firstName, lessonTitle } = payload as any;
      if (!email || !firstName) {
        console.warn("[notifications] lesson.completed missing email/firstName — skipping");
        return;
      }
      const tpl = templates.lessonCompleted(firstName, lessonTitle);
      await sendEmail({ to: email, ...tpl });
    }
  );

  // Week completed → congratulations email
  await consumeEvent(
    "week.completed",
    "notifications.week.completed",
    async (payload) => {
      const { email, firstName, weekTitle } = payload as any;
      if (!email || !firstName) {
        console.warn("[notifications] week.completed missing email/firstName — skipping");
        return;
      }
      const tpl = templates.weekCompleted(firstName, weekTitle);
      await sendEmail({ to: email, ...tpl });
    }
  );
}

async function bootstrap() {
  await connectRabbitMQ(process.env.RABBITMQ_URL!);
  await setupConsumers();
  app.listen(PORT, () => {
    console.log(`[notifications-service] Running on port ${PORT}`);
  });
}

bootstrap().catch(console.error);