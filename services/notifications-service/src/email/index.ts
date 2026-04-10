import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY!);
const FROM = process.env.EMAIL_FROM || "no-reply@oriyoninternational.com";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail({ to, subject, html }: SendEmailOptions) {
  try {
    const result = await resend.emails.send({ from: FROM, to, subject, html });
    console.log(`[notifications] Email sent to ${to} — subject: "${subject}"`);
    return result;
  } catch (err) {
    console.error(`[notifications] Failed to send email to ${to}:`, err);
    throw err;
  }
}

// ─────────────────────────────────────────────
// EMAIL TEMPLATES
// ─────────────────────────────────────────────

export const templates = {

  // ── Applications ────────────────────────────

  applicationConfirmation: (firstName: string) => ({
    subject: "We received your EEWYLA application",
    html: `
      <h2>Hi ${firstName},</h2>
      <p>Thank you for applying to the <strong>EEWYLA Training Programme</strong> by Oriyon International.</p>
      <p>Your application is under review. We will be in touch within 5–7 working days.</p>
      <p>If you have questions, contact us at <a href="mailto:training@oriyon.ng">training@oriyon.ng</a>.</p>
      <br/>
      <p>— The Oriyon Team</p>
    `,
  }),

  applicationApproved: (firstName: string) => ({
    subject: "Congratulations! Your EEWYLA application has been approved",
    html: `
      <h2>Hi ${firstName}, welcome to EEWYLA!</h2>
      <p>Your application has been <strong>approved</strong>. You're now part of the Oriyon International training programme.</p>
      <p>You will receive a separate email shortly with instructions and a link to set up your account password.</p>
      <p>If you don't receive the setup email within a few minutes, please contact us.</p>
      <br/>
      <p>— The Oriyon Team</p>
    `,
  }),

  applicationRejected: (firstName: string) => ({
    subject: "Update on your EEWYLA application",
    html: `
      <h2>Hi ${firstName},</h2>
      <p>Thank you for your interest in the EEWYLA Training Programme.</p>
      <p>After careful review, we are unable to offer you a place in the current cohort.</p>
      <p>We encourage you to apply again in a future cohort.</p>
      <br/>
      <p>— The Oriyon Team</p>
    `,
  }),

  // ── Account Setup ────────────────────────────

  // Sent when admin creates a user manually
  accountSetup: (firstName: string, setupLink: string) => ({
    subject: "Set up your Oriyon International account",
    html: `
      <h2>Hi ${firstName}, you've been added to Oriyon International!</h2>
      <p>An account has been created for you on the Oriyon platform.</p>
      <p>Click the button below to set your password and activate your account:</p>
      <p style="margin: 24px 0;">
        <a href="${setupLink}" style="background:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;">
          Set Up My Account →
        </a>
      </p>
      <p><strong>This link expires in 24 hours.</strong></p>
      <p>If you were not expecting this email, please ignore it.</p>
      <br/>
      <p>— The Oriyon Team</p>
    `,
  }),

  // ── Password Reset ───────────────────────────

  passwordReset: (firstName: string, resetLink: string) => ({
    subject: "Reset your Oriyon International password",
    html: `
      <h2>Hi ${firstName},</h2>
      <p>We received a request to reset your password.</p>
      <p>Click the button below to choose a new password:</p>
      <p style="margin: 24px 0;">
        <a href="${resetLink}" style="background:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;">
          Reset My Password →
        </a>
      </p>
      <p><strong>This link expires in 1 hour.</strong></p>
      <p>If you did not request a password reset, you can safely ignore this email.</p>
      <br/>
      <p>— The Oriyon Team</p>
    `,
  }),

  // ── LMS ─────────────────────────────────────

  lessonCompleted: (firstName: string, lessonTitle: string) => ({
    subject: `Great work! You completed "${lessonTitle}"`,
    html: `
      <h2>Well done, ${firstName}! 🎉</h2>
      <p>You have completed the lesson: <strong>${lessonTitle}</strong>.</p>
      <p>Keep going — you're making great progress on your livestock training journey.</p>
      <p><a href="https://www.oriyoninternational.com/learn/lms">Continue learning →</a></p>
      <br/>
      <p>— The Oriyon Team</p>
    `,
  }),

  weekCompleted: (firstName: string, weekTitle: string) => ({
    subject: `You completed a full training week — "${weekTitle}"`,
    html: `
      <h2>Outstanding, ${firstName}! 🏆</h2>
      <p>You have completed all lessons in: <strong>${weekTitle}</strong>.</p>
      <p>You're one step closer to completing the full EEWYLA programme.</p>
      <p><a href="https://www.oriyoninternational.com/learn/lms">Continue to next week →</a></p>
      <br/>
      <p>— The Oriyon Team</p>
    `,
  }),

  welcomeOnboard: (firstName: string) => ({
    subject: "Welcome to Oriyon International",
    html: `
      <h2>Welcome, ${firstName}!</h2>
      <p>Your account has been created on the Oriyon platform.</p>
      <p>You can now access training resources, track your progress, and connect with your cohort.</p>
      <p><a href="https://www.oriyoninternational.com/learn/lms">Get started →</a></p>
      <br/>
      <p>— The Oriyon Team</p>
    `,
  }),

  // ── Contact ──────────────────────────────────

  contactReceived: (firstName: string) => ({
    subject: "We received your message",
    html: `
      <h2>Hi ${firstName},</h2>
      <p>Thank you for reaching out to Oriyon International. We have received your message and will get back to you within 2 business days.</p>
      <br/>
      <p>— The Oriyon Team</p>
    `,
  }),
};