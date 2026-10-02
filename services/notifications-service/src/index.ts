import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { connectRabbitMQ, consumeEvent } from "./rabbitmq";
import { contactRouter, newsletterRouter } from "./routes/notifications";
import { blogRouter } from "./routes/blog";
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
app.use("/blog", blogRouter);
app.use("/api/contact", contactRouter); // add this
app.use("/api/newsletter", newsletterRouter); // add this
app.use("/api/blog", blogRouter);

// ─────────────────────────────────────────────
// RABBITMQ CONSUMERS
// ─────────────────────────────────────────────
async function setupConsumers() {
  // ── Applications ──────────────────────────────

  // Application custom email requested → send branded custom email
  await consumeEvent(
    "application.custom_email_requested",
    "notifications.application.custom_email",
    async (payload) => {
      const { email, firstName, subject, body } = payload as any;
      const tpl = templates.customDirectEmail(firstName, subject, body);
      await sendEmail({ to: email, ...tpl });
    },
  );

  // Application submitted → confirmation email to applicant
  await consumeEvent(
    "application.submitted",
    "notifications.application.submitted",
    async (payload) => {
      const { email, firstName } = payload as any;
      const tpl = templates.applicationConfirmation(firstName);
      await sendEmail({ to: email, ...tpl });
    },
  );

  // Application shortlisted → notify applicant
  await consumeEvent(
    "application.shortlisted",
    "notifications.application.shortlisted",
    async (payload) => {
      const { email, firstName, rescued } = payload as any;
      const tpl = rescued
        ? templates.applicationRescued(firstName)
        : templates.applicationShortlisted(firstName);
      await sendEmail({ to: email, ...tpl });
    },
  );

  // Application in rejection review → notify applicant
  await consumeEvent(
    "application.rejection_review",
    "notifications.application.rejection_review",
    async (payload) => {
      const { email, firstName } = payload as any;
      const tpl = templates.applicationRejectionReview(firstName);
      await sendEmail({ to: email, ...tpl });
    },
  );

  // Application approved → send approval confirmation email
  await consumeEvent(
    "application.approved",
    "notifications.application.approved",
    async (payload) => {
      const { email, firstName, approvedRole } = payload as any;
      const tpl = templates.applicationApproved(firstName, approvedRole);
      await sendEmail({ to: email, ...tpl });
    },
  );

  // Application rejected → rejection email
  await consumeEvent(
    "application.rejected",
    "notifications.application.rejected",
    async (payload) => {
      const { email, firstName } = payload as any;
      const tpl = templates.applicationRejected(firstName);
      await sendEmail({ to: email, ...tpl });
    },
  );

  // ── Account Setup ─────────────────────────────

  // New user created by admin → send set-password link
  // Triggered by auth-service after it creates the auth record + setup token
  await consumeEvent(
    "user.setup_requested",
    "notifications.user.setup_requested",
    async (payload) => {
      const { email, firstName, setupLink, token, baseUrl: payloadBaseUrl } = payload as any;
      const frontendUrl = (payloadBaseUrl || process.env.FRONTEND_URL || "https://oriyon.themydee.com").replace(/\/$/, "");

      // If token is provided instead of setupLink, build the link
      const effectiveLink =
        setupLink ||
        `${frontendUrl}/auth/setup?token=${token}`;

      const tpl = templates.accountSetup(firstName || "there", effectiveLink, frontendUrl);
      await sendEmail({ to: email, ...tpl });
    },
  );

  // ── Password Reset ────────────────────────────

  // User requested a password reset → send reset link
  await consumeEvent(
    "auth.password_reset_requested",
    "notifications.auth.password_reset_requested",
    async (payload) => {
      const { email, firstName, token, resetLink: payloadResetLink, baseUrl: payloadBaseUrl } = payload as any;
      const frontendUrl = (payloadBaseUrl || process.env.FRONTEND_URL || "https://oriyon.themydee.com").replace(/\/$/, "");
      const resetLink = payloadResetLink || `${frontendUrl}/auth/reset-password?token=${token}`;
      const tpl = templates.passwordReset(firstName || "there", resetLink, frontendUrl);
      await sendEmail({ to: email, ...tpl });
    },
  );

  // ── LMS ───────────────────────────────────────

  // Lesson completed → milestone email
  // NOTE: lms-service must include email + firstName in the event payload
  await consumeEvent(
    "lesson.completed",
    "notifications.lesson.completed",
    async (payload) => {
      const { email, firstName, lessonTitle, baseUrl } = payload as any;
      if (!email || !firstName) {
        console.warn(
          "[notifications] lesson.completed missing email/firstName — skipping",
        );
        return;
      }
      const tpl = templates.lessonCompleted(firstName, lessonTitle, baseUrl);
      await sendEmail({ to: email, ...tpl });
    },
  );

  // Week completed → congratulations email
  await consumeEvent(
    "week.completed",
    "notifications.week.completed",
    async (payload) => {
      const { email, firstName, weekTitle, baseUrl } = payload as any;
      if (!email || !firstName) {
        console.warn(
          "[notifications] week.completed missing email/firstName — skipping",
        );
        return;
      }
      const tpl = templates.weekCompleted(firstName, weekTitle, baseUrl);
      await sendEmail({ to: email, ...tpl });
    },
  );

  // Exam submitted → exam score and status email
  await consumeEvent(
    "exam.submitted",
    "notifications.exam.submitted",
    async (payload) => {
      const { email, firstName, mcqScore, hasPending, timedOut, sessionId, baseUrl } =
        payload as any;
      if (!email || !firstName) {
        console.warn(
          "[notifications] exam.submitted missing email/firstName — skipping",
        );
        return;
      }
      const tpl = templates.examSubmitted(
        firstName,
        Number(mcqScore ?? 0),
        Boolean(hasPending),
        Boolean(timedOut),
        sessionId ?? "",
        baseUrl,
      );
      await sendEmail({ to: email, ...tpl });
    },
  );

  // Cohort group & physical training notification
  await consumeEvent(
    "cohort.group_notification_requested",
    "notifications.cohort.group_notification",
    async (payload) => {
      const { email, firstName, cohortName, groupName, location, timeRange, practicalDay, baseUrl } = payload as any;
      if (!email || !firstName) {
        console.warn("[notifications] cohort.group_notification_requested missing email/firstName — skipping");
        return;
      }
      const tpl = templates.cohortGroupNotification(
        firstName,
        cohortName || "Cohort 1",
        groupName || "Group Unassigned",
        location || "LAUTECH Ogbomoso",
        timeRange || "9:00 AM – 5:00 PM",
        practicalDay,
        baseUrl
      );
      await sendEmail({ to: email, ...tpl });
    },
  );

  // ── Trainer support tickets ───────────────────

  await consumeEvent("ticket.created", "notifications.ticket.created", async (payload) => {
    const p = payload as any;
    if (p.reporterEmail) {
      const tpl = templates.ticketCreated(p.firstName || p.reporterName || "there", p.code, p.subject, p.trainerName);
      await sendEmail({ to: p.reporterEmail, ...tpl });
    }
    // Optional: alert the programme team (comma-separated addresses)
    const alertTo = (process.env.TICKETS_ALERT_EMAIL || "").split(",").map((e) => e.trim()).filter(Boolean);
    for (const to of alertTo) {
      const tpl = templates.ticketStaffAlert(p.code, p.subject, p.category, p.priority, p.trainerName, p.reporterName);
      await sendEmail({ to, ...tpl });
    }
  });

  await consumeEvent("ticket.replied", "notifications.ticket.replied", async (payload) => {
    const p = payload as any;
    if (!p.reporterEmail) return;
    const firstName = String(p.reporterName || "").split(" ")[0] || "there";
    const tpl = templates.ticketReplied(firstName, p.code, p.subject, p.message, p.status);
    await sendEmail({ to: p.reporterEmail, ...tpl });
  });

  await consumeEvent("ticket.status_changed", "notifications.ticket.status_changed", async (payload) => {
    const p = payload as any;
    if (!p.reporterEmail) return;
    const firstName = String(p.reporterName || "").split(" ")[0] || "there";
    const tpl = templates.ticketStatusChanged(firstName, p.code, p.subject, p.status);
    await sendEmail({ to: p.reporterEmail, ...tpl });
  });
}

async function bootstrap() {
  await connectRabbitMQ(process.env.RABBITMQ_URL!);
  await setupConsumers();
  app.listen(PORT, () => {
    console.log(`[notifications-service] Running on port ${PORT}`);
  });
}

bootstrap().catch(console.error);
