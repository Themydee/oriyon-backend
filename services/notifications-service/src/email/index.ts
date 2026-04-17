import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY!);
const FROM = process.env.EMAIL_FROM || "no-reply@oriyoninternational.com";
const BASE_URL = process.env.FRONTEND_URL || "http://localhost:3000";

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
// BASE LAYOUT
// Wraps every email in a consistent shell.
// LOGO: replace LOGO_URL with your hosted CDN
// image URL when ready for production.
// ─────────────────────────────────────────────

const LOGO_URL = "https://res.cloudinary.com/dpbba8033/image/upload/v1775955555/logo_tre5jx.svg";

function base(content: string, preheader = "") {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Oriyon International</title>
  <!--[if mso]>
  <noscript>
    <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  </noscript>
  <![endif]-->
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background-color: #f4f4f0; font-family: Georgia, 'Times New Roman', serif; -webkit-font-smoothing: antialiased; }
    .preheader { display: none; max-height: 0; overflow: hidden; mso-hide: all; }
    a { color: inherit; }
    @media only screen and (max-width: 600px) {
      .email-card { border-radius: 0 !important; border-left: none !important; border-right: none !important; }
      .email-body { padding: 28px 24px !important; }
      .email-header { padding: 20px 24px !important; }
      .email-footer { padding: 20px 24px 28px !important; }
    }
  </style>
</head>
<body style="background-color:#f4f4f0; margin:0; padding:0;">

  ${preheader ? `<div class="preheader" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>` : ""}

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f0; padding:40px 16px;">
    <tr>
      <td align="center">
        <table class="email-card" width="100%" cellpadding="0" cellspacing="0" border="0"
          style="max-width:580px; background-color:#ffffff; border-radius:8px; overflow:hidden; border:1px solid #e2e0d8;">

          <!-- Header -->
          <tr>
            <td class="email-header" style="background-color:#0d1f0f; padding:28px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <img src="${LOGO_URL}" alt="Oriyon International" height="30"
                      style="display:block; height:30px; max-width:160px;" />
                  </td>
                  <td align="right">
                    <p style="color:#7a9e7e; font-size:10px; letter-spacing:2px; text-transform:uppercase; font-family:Arial,sans-serif; margin:0;">
                      EEWYLA Programme
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td class="email-body" style="padding:40px 40px 32px;">
              ${content}
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 40px;">
              <hr style="border:none; border-top:1px solid #e2e0d8;" />
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td class="email-footer" style="padding:24px 40px 32px;">
              <p style="font-family:Arial,sans-serif; font-size:11px; color:#9e9c94; line-height:1.8; margin:0;">
                Oriyon International &middot; EEWYLA Training Programme<br/>
                Oyo State, Nigeria &middot;
                <a href="mailto:training@oriyon.ng" style="color:#9e9c94; text-decoration:underline;">training@oriyon.ng</a>
                <br/><br/>
                You are receiving this email because you are registered with the EEWYLA Training Programme.<br/>
                <a href="${BASE_URL}" style="color:#5a7a5e; text-decoration:none;">www.oriyoninternational.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`.trim();
}

// ─────────────────────────────────────────────
// COMPONENT HELPERS
// ─────────────────────────────────────────────

function heading(text: string) {
  return `
    <h1 style="font-family:Georgia,'Times New Roman',serif; font-size:26px; font-weight:normal; color:#0d1f0f; line-height:1.35; margin:0 0 20px;">
      ${text}
    </h1>`;
}

function para(text: string) {
  return `
    <p style="font-family:Arial,sans-serif; font-size:15px; color:#3d3d3a; line-height:1.75; margin:0 0 16px;">
      ${text}
    </p>`;
}

function ctaButton(label: string, href: string) {
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
      <tr>
        <td style="background-color:#0d1f0f; border-radius:4px;">
          <a href="${href}" target="_blank"
            style="display:inline-block; padding:14px 28px; font-family:Arial,sans-serif; font-size:14px; font-weight:bold; letter-spacing:0.5px; color:#ffffff; text-decoration:none;">
            ${label} &rarr;
          </a>
        </td>
      </tr>
    </table>`;
}

function infoBox(rows: { label: string; value: string }[]) {
  const rowsHtml = rows.map(({ label, value }) => `
    <tr>
      <td style="font-family:Arial,sans-serif; font-size:13px; color:#9e9c94; padding:7px 16px 7px 0; white-space:nowrap; vertical-align:top;">
        ${label}
      </td>
      <td style="font-family:Arial,sans-serif; font-size:13px; color:#0d1f0f; padding:7px 0; font-weight:bold; vertical-align:top;">
        ${value}
      </td>
    </tr>`).join("");
  return `
    <table cellpadding="0" cellspacing="0" border="0"
      style="background-color:#f8f7f2; border:1px solid #e2e0d8; border-radius:4px; padding:4px 20px; margin:20px 0; width:100%;">
      <tr><td><table cellpadding="0" cellspacing="0" border="0" width="100%">${rowsHtml}</table></td></tr>
    </table>`;
}

function notice(text: string, type: "info" | "warning" = "info") {
  const border = type === "warning" ? "#c9a84c" : "#5a7a5e";
  const bg     = type === "warning" ? "#fdf8ee" : "#f2f7f2";
  return `
    <table cellpadding="0" cellspacing="0" border="0"
      style="border-left:3px solid ${border}; background-color:${bg}; margin:20px 0; width:100%;">
      <tr>
        <td style="padding:12px 16px; font-family:Arial,sans-serif; font-size:13px; color:#3d3d3a; line-height:1.65;">
          ${text}
        </td>
      </tr>
    </table>`;
}

function signature() {
  return `
    <p style="font-family:Georgia,'Times New Roman',serif; font-size:15px; color:#0d1f0f; margin:28px 0 0; font-style:italic;">
      The Oriyon Team
    </p>`;
}

// ─────────────────────────────────────────────
// EMAIL TEMPLATES
// ─────────────────────────────────────────────

export const templates = {

  // ── Applications ──────────────────────────────────────────────

  applicationConfirmation: (firstName: string) => ({
    subject: "We received your EEWYLA application",
    html: base(`
      ${heading(`Hi ${firstName},`)}
      ${para("Thank you for applying to the <strong>EEWYLA Training Programme</strong> by Oriyon International.")}
      ${para("Your application has been received and is now under review. Our team carefully assesses every submission and we will get back to you within <strong>5–7 working days</strong>.")}
      ${notice(`Questions in the meantime? Reach us at <a href="mailto:training@oriyon.ng" style="color:#5a7a5e;">training@oriyon.ng</a>.`)}
      ${signature()}
    `, "Your EEWYLA application has been received — we'll be in touch within 5–7 working days."),
  }),

  applicationApproved: (firstName: string) => ({
    subject: "Congratulations — your EEWYLA application has been approved",
    html: base(`
      ${heading(`Congratulations, ${firstName}.`)}
      ${para("Your application to the <strong>EEWYLA Training Programme</strong> has been approved. You are now part of the Oriyon International family.")}
      ${para("You will receive a separate email shortly with a link to set up your account password and access the training portal. Please check your inbox — and your spam folder, just in case.")}
      ${notice("If you do not receive your account setup email within 15 minutes, contact us at <a href=\"mailto:training@oriyon.ng\" style=\"color:#5a7a5e;\">training@oriyon.ng</a> and we will resend it.")}
      ${para("We look forward to supporting your growth through the programme.")}
      ${signature()}
    `, "You've been accepted into the EEWYLA Training Programme — your account setup link is on its way."),
  }),

  applicationRejected: (firstName: string) => ({
    subject: "Update on your EEWYLA application",
    html: base(`
      ${heading(`Hi ${firstName},`)}
      ${para("Thank you for your interest in the EEWYLA Training Programme and for taking the time to apply.")}
      ${para("After a thorough review of all applications, we are unable to offer you a place in the current cohort. This was a competitive intake and we appreciate the effort you put into your application.")}
      ${para("We encourage you to apply again when the next cohort opens. We announce future intakes on our website and through our mailing list.")}
      ${notice(`For feedback on your application or to register interest in future cohorts, contact us at <a href="mailto:training@oriyon.ng" style="color:#5a7a5e;">training@oriyon.ng</a>.`)}
      ${signature()}
    `, "An update on your EEWYLA Training Programme application."),
  }),

  // ── Account Setup ──────────────────────────────────────────────

  accountSetup: (firstName: string, setupLink: string) => ({
    subject: "Set up your Oriyon International account",
    html: base(`
      ${heading(`Hi ${firstName}, your account is ready.`)}
      ${para("An account has been created for you on the Oriyon International platform. Click the button below to set your password and activate your access.")}
      ${ctaButton("Set Up My Account", setupLink)}
      ${notice("<strong>This link expires in 24 hours.</strong> If it expires before you use it, contact us at <a href=\"mailto:training@oriyon.ng\" style=\"color:#5a7a5e;\">training@oriyon.ng</a> and we will send a new one.", "warning")}
      ${para("Once active, your account gives you access to the EEWYLA training portal, your cohort schedule, and all programme resources.")}
      ${para("If you were not expecting this email, please ignore it — no action is required and your account will not be activated without the link.")}
      ${signature()}
    `, "Your Oriyon International account is ready — click to set your password and get started."),
  }),

  // ── Password Reset ─────────────────────────────────────────────

  passwordReset: (firstName: string, resetLink: string) => ({
    subject: "Reset your Oriyon International password",
    html: base(`
      ${heading(`Hi ${firstName},`)}
      ${para("We received a request to reset the password on your Oriyon International account. Click the button below to create a new password.")}
      ${ctaButton("Reset My Password", resetLink)}
      ${notice("<strong>This link expires in 1 hour.</strong> If it expires, you can request a new reset link from the login page.", "warning")}
      ${para("If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged and your account is secure.")}
      ${signature()}
    `, "A password reset was requested for your account — click to set a new password."),
  }),

  // ── LMS ───────────────────────────────────────────────────────

  lessonCompleted: (firstName: string, lessonTitle: string) => ({
    subject: `Lesson complete — "${lessonTitle}"`,
    html: base(`
      ${heading(`Well done, ${firstName}.`)}
      ${para("You have successfully completed the following lesson:")}
      ${infoBox([{ label: "Lesson completed", value: lessonTitle }])}
      ${para("Every lesson you complete builds your knowledge and brings you closer to full programme certification. Keep up the excellent work.")}
      ${ctaButton("Continue Learning", `${BASE_URL}/learn/lms/dashboard`)}
      ${signature()}
    `, `You've completed "${lessonTitle}" — keep going!`),
  }),

  weekCompleted: (firstName: string, weekTitle: string) => ({
    subject: `Week complete — "${weekTitle}"`,
    html: base(`
      ${heading(`Outstanding, ${firstName}.`)}
      ${para("You have completed all lessons for the following training week:")}
      ${infoBox([{ label: "Week completed", value: weekTitle }])}
      ${para("Completing a full training week is a significant milestone. You are demonstrating the commitment and discipline that EEWYLA is designed to develop.")}
      ${ctaButton("Continue to Next Week", `${BASE_URL}/learn/lms/dashboard`)}
      ${signature()}
    `, `You've completed all lessons in "${weekTitle}" — excellent progress.`),
  }),

  examSubmitted: (
    firstName: string,
    mcqScore: number,
    hasPending: boolean,
    timedOut: boolean,
    sessionId: string
  ) => ({
    subject: timedOut
      ? "Exam auto-submitted — review your result"
      : "Exam submitted — your score is ready",
    html: base(`
      ${heading(`Hi ${firstName},`)}
      ${para(timedOut
        ? "Your exam was submitted automatically because the allotted time expired."
        : "Your exam has been successfully submitted.")}
      ${infoBox([
        { label: "MCQ score", value: `${mcqScore}%` },
        { label: "Status", value: timedOut ? "Timed out" : "Submitted" },
        { label: "Review status", value: hasPending ? "Pending short/essay marking" : "Fully marked" },
      ])}
      ${hasPending
        ? para("Your multiple choice score is now available. Short answer and essay questions are still being marked by our team, and your final result will be updated once marking is complete.")
        : para("Your exam has been fully marked. The score shown above is your completed result.")}
      ${ctaButton("View exam result", `${BASE_URL}/learn/lms/exam/session/${sessionId}/result`)}
      ${signature()}
    `, timedOut
      ? "Your exam was auto-submitted because time expired. Your MCQ score is available and the remainder is pending review."
      : "Your exam has been submitted. Your MCQ score is available and final marking is in progress."),
  }),

  // ── Contact ───────────────────────────────────────────────────

  contactReceived: (firstName: string) => ({
    subject: "We received your message",
    html: base(`
      ${heading(`Hi ${firstName},`)}
      ${para("Thank you for reaching out to Oriyon International. We have received your message and a member of our team will respond within <strong>2 business days</strong>.")}
      ${notice(`For urgent matters, contact us directly at <a href="mailto:training@oriyon.ng" style="color:#5a7a5e;">training@oriyon.ng</a>.`)}
      ${signature()}
    `, "We've received your message and will respond within 2 business days."),
  }),
};