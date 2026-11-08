import axios from "axios";
import { publishEvent } from "../rabbitmq";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM || "no-reply@oriyoninternational.com";
const LOGO_URL = "https://res.cloudinary.com/dpbba8033/image/upload/v1775955555/logo_tre5jx.svg";

function escapeHtml(value: string) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function baseLayout(content: string, preheader = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Oriyon International - EEWYLA Workshop</title>
  <style>
    body { background-color: #f4f4f0; font-family: Georgia, 'Times New Roman', serif; -webkit-font-smoothing: antialiased; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 8px; border: 1px solid #e0dfd5; overflow: hidden; }
    .header { background-color: #1E3F20; padding: 28px; text-align: center; }
    .logo { height: 48px; }
    .body-content { padding: 36px 32px; color: #1c1c1c; line-height: 1.6; }
    .code-box { background: #fbfbee; border: 2px dashed #2D5A27; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0; }
    .code { font-family: 'Courier New', monospace; font-size: 34px; font-weight: bold; letter-spacing: 6px; color: #2D5A27; }
    .receipt-table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; }
    .receipt-table td { padding: 10px 12px; border-bottom: 1px solid #eeeeee; }
    .receipt-table td.label { color: #666666; font-weight: bold; width: 40%; }
    .receipt-table td.value { color: #111111; font-weight: 500; }
    .button { display: inline-block; background-color: #2D5A27; color: #ffffff !important; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 15px; margin-top: 15px; }
    .footer { background-color: #f8f8f6; padding: 24px; text-align: center; color: #777777; font-size: 12px; border-top: 1px solid #ebebea; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="${LOGO_URL}" alt="Oriyon International" class="logo" />
    </div>
    <div class="body-content">
      ${content}
    </div>
    <div class="footer">
      <p>Oriyon International • Economic Empowerment of Women and Youth in Livestock Agriculture (EEWYLA)</p>
      <p>For inquiries or assistance, reach us at <a href="mailto:eewyla@oriyoninternational.com" style="color:#2D5A27;">eewyla@oriyoninternational.com</a></p>
      <p>© ${new Date().getFullYear()} Oriyon International. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;
}

export async function sendEmailDirect(to: string, subject: string, html: string): Promise<boolean> {
  if (RESEND_API_KEY && RESEND_API_KEY !== "mock" && !RESEND_API_KEY.includes("placeholder")) {
    try {
      await axios.post(
        "https://api.resend.com/emails",
        { from: FROM, to, subject, html },
        { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" } }
      );
      console.log(`[Workshop Email] Resend sent successfully to ${to} (Subject: ${subject})`);
      return true;
    } catch (err: any) {
      console.warn(`[Workshop Email] Direct Resend API failed: ${err.response?.data?.message || err.message}`);
    }
  }
  return false;
}

export async function sendVerificationChallengeEmail(to: string, code: string, expiresMinutes = 10, workshopTitle = "EEWYLA Practical Workshop"): Promise<void> {
  const subject = "Your EEWYLA Goat Training Workshop Verification Code";
  const html = baseLayout(`
    <h2 style="margin-top:0; color:#1E3F20;">Workshop Registration Verification</h2>
    <p>Dear Participant,</p>
    <p>Please use the following 6-digit one-time verification code to confirm your email and proceed with your registration for the <strong>EEWYLA Goat Training Workshop</strong>:</p>
    <div class="code-box">
      <div class="code">${code}</div>
      <p style="margin: 8px 0 0; color:#555555; font-size:13px;">Expires in ${expiresMinutes} minutes</p>
    </div>
    <p><strong>Security notice:</strong> Never share this verification code with anyone. Oriyon International staff will never ask for your code.</p>
    <p>If you did not initiate this registration request, please disregard this email.</p>
  `);

  // 1. Publish to RabbitMQ for notifications-service processing
  try {
    await publishEvent("workshop.email_verification_requested", {
      email: to,
      code,
      expiresMinutes,
      workshopTitle,
      subject,
      html,
    });
    console.log(`[Workshop Email] Event published to RabbitMQ for ${to}`);
  } catch (err: any) {
    console.warn(`[Workshop Email] RabbitMQ publish failed, falling back to direct Resend send:`, err.message);
    await sendEmailDirect(to, subject, html);
  }
}

export interface WorkshopConfirmationPayload {
  to: string;
  participantName: string;
  workshopTitle: string;
  workshopSlug?: string;
  workshopType?: "physical" | "online" | string;
  venue?: string | null;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  metadata?: any;
  registrationReference: string;
  paystackReference: string;
  amountKobo: number;
  currency: string;
  paidAt: string | Date;
  isFreePass?: boolean;
}

export async function sendRegistrationConfirmationEmail(payload: WorkshopConfirmationPayload): Promise<void> {
  const {
    to,
    participantName,
    workshopTitle,
    workshopSlug,
    workshopType,
    venue,
    startDate,
    metadata,
    registrationReference,
    paystackReference,
    amountKobo,
    currency,
    paidAt,
    isFreePass,
  } = payload;

  const isFree = isFreePass || amountKobo === 0;
  const isOnline =
    workshopType === "online" ||
    workshopSlug === "online-goat-training" ||
    metadata?.type === "online" ||
    (workshopTitle && workshopTitle.toLowerCase().includes("online"));

  const displayAmount = isFree
    ? "FREE (Verified Member Pass)"
    : (amountKobo / 100).toLocaleString("en-NG", {
        style: "currency",
        currency: currency || "NGN",
      });

  const formattedDate = new Date(paidAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const sessionDateStr =
    (metadata?.date as string) ||
    (startDate ? new Date(startDate).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : null);

  const sessionTimeStr = (metadata?.time as string) || null;

  const subject = isFree
    ? `Confirmed: Free Member Pass for ${workshopTitle}`
    : `Confirmed: Registration & Payment for ${workshopTitle}`;

  const greetingHeader = isFree
    ? "Registration & Seat Confirmed (Free Member Pass)"
    : "Registration & Payment Confirmed";

  const greetingIntro = isFree
    ? `Congratulations! Your cooperative member free pass for the <strong>${escapeHtml(workshopTitle)}</strong> has been verified. Your seat is confirmed.`
    : `Congratulations! Your payment for the <strong>${escapeHtml(workshopTitle)}</strong> has been verified successfully. Your seat is confirmed.`;

  const formatRow = isOnline
    ? `<tr><td class="label">Course Modality</td><td class="value">💻 Live Interactive Webinar (Online)</td></tr>`
    : `<tr><td class="label">Course Modality</td><td class="value">📍 In-Person Field Practical</td></tr>`;

  const venueOrSessionRow = isOnline
    ? `<tr><td class="label">Session Schedule</td><td class="value">${escapeHtml(sessionDateStr || "Scheduled Session")}${sessionTimeStr ? ` • ${escapeHtml(sessionTimeStr)}` : ""}</td></tr>`
    : `<tr><td class="label">Practical Venue</td><td class="value">${escapeHtml(venue || "Touring Select LGAs across Oyo State")}</td></tr>`;

  const nextStepsHtml = isOnline
    ? `
      <h3 style="color:#1E3F20;">Online Master Class Next Steps</h3>
      <ul style="padding-left:20px; line-height:1.7;">
        <li>Keep your registration reference (<strong>${escapeHtml(registrationReference)}</strong>) for your records.</li>
        <li><strong>Webinar Broadcast Access:</strong> Your secure Zoom/webinar broadcast link and calendar invitation will be delivered directly to this email address (<strong>${escapeHtml(to)}</strong>) prior to the scheduled live session.</li>
        <li><strong>Digital Certification:</strong> A verifiable Certificate of Participation will be issued to you upon successful completion of the live master class.</li>
        <li><strong>Session Replays & Materials:</strong> The full session recording, slide decks, and derivative goat products handbook will be made available to all confirmed attendees.</li>
      </ul>
    `
    : `
      <h3 style="color:#1E3F20;">Physical Field Practical Next Steps</h3>
      <ul style="padding-left:20px; line-height:1.7;">
        <li>Keep your registration reference (<strong>${escapeHtml(registrationReference)}</strong>) handy for check-in on the field.</li>
        <li><strong>Venue & Itinerary:</strong> Our field training coordinators will contact you via phone/WhatsApp with specific LGA assembly points and directions ahead of the practical tour.</li>
        <li><strong>Field Preparation:</strong> Practical field training gear recommendations (boots, comfortable outdoor farm clothing) and live demonstration schedules will be communicated via email.</li>
      </ul>
    `;

  const html = baseLayout(`
    <h2 style="margin-top:0; color:#1E3F20;">${greetingHeader}</h2>
    <p>Dear <strong>${escapeHtml(participantName)}</strong>,</p>
    <p>${greetingIntro}</p>
    
    <div style="background:#fbfbee; border:1px solid #d4e0ce; border-radius:8px; padding:20px; margin:24px 0;">
      <h3 style="margin-top:0; color:#2D5A27;">Registration Summary</h3>
      <table class="receipt-table">
        <tr>
          <td class="label">Participant Name</td>
          <td class="value">${escapeHtml(participantName)}</td>
        </tr>
        <tr>
          <td class="label">Registered Email</td>
          <td class="value">${escapeHtml(to)}</td>
        </tr>
        <tr>
          <td class="label">Course / Workshop</td>
          <td class="value">${escapeHtml(workshopTitle)}</td>
        </tr>
        ${formatRow}
        ${venueOrSessionRow}
        <tr>
          <td class="label">Registration Ref</td>
          <td class="value"><strong>${escapeHtml(registrationReference)}</strong></td>
        </tr>
        <tr>
          <td class="label">Payment Reference</td>
          <td class="value">${escapeHtml(paystackReference)}</td>
        </tr>
        <tr>
          <td class="label">Amount</td>
          <td class="value" style="color:#2D5A27; font-size:16px;"><strong>${displayAmount}</strong></td>
        </tr>
        <tr>
          <td class="label">Confirmation Date</td>
          <td class="value">${formattedDate}</td>
        </tr>
      </table>
    </div>

    ${nextStepsHtml}

    <p style="margin-top:24px;">We look forward to welcoming you to the training program!</p>
  `);

  // 1. Publish to RabbitMQ for notifications-service processing
  try {
    await publishEvent("workshop.registration_confirmed", {
      email: to,
      participantName,
      workshopTitle,
      registrationReference,
      paystackReference,
      amountKobo,
      currency,
      paidAt,
      subject,
      html,
    });
    console.log(`[Workshop Email] Registration confirmed event published to RabbitMQ for ${to}`);
  } catch (err: any) {
    console.warn(`[Workshop Email] RabbitMQ publish failed, falling back to direct Resend send:`, err.message);
    await sendEmailDirect(to, subject, html);
  }
}

export interface WaitlistConfirmationPayload {
  to: string;
  fullName: string;
  courseTitle: string;
  courseSlug?: string;
}

export async function sendWaitlistConfirmationEmail(
  payload: WaitlistConfirmationPayload
): Promise<void> {
  const { to, fullName, courseTitle } = payload;
  const participantName = fullName;
  const subject = `You are on the Priority Waitlist: ${courseTitle}`;
  const html = baseLayout(`
    <h2 style="margin-top:0; color:#1E3F20;">Priority Waitlist Confirmed</h2>
    <p>Dear <strong>${escapeHtml(participantName)}</strong>,</p>
    <p>Thank you for expressing interest in the upcoming <strong>${escapeHtml(courseTitle)}</strong> under the Oriyon International EEWYLA Agricultural Program.</p>
    
    <div style="background:#fbfbee; border:1px solid #d4e0ce; border-radius:8px; padding:20px; margin:24px 0;">
      <h3 style="margin-top:0; color:#2D5A27;">Waitlist Details</h3>
      <table class="receipt-table">
        <tr>
          <td class="label">Course Title</td>
          <td class="value"><strong>${escapeHtml(courseTitle)}</strong></td>
        </tr>
        <tr>
          <td class="label">Applicant Name</td>
          <td class="value">${escapeHtml(participantName)}</td>
        </tr>
        <tr>
          <td class="label">Registered Email</td>
          <td class="value">${escapeHtml(to)}</td>
        </tr>
        <tr>
          <td class="label">Status</td>
          <td class="value" style="color:#2D5A27; font-weight:bold;">Priority Waitlist Reserved</td>
        </tr>
      </table>
    </div>

    <h3 style="color:#1E3F20;">What Happens Next?</h3>
    <ul style="padding-left:20px; line-height:1.7;">
      <li>Admissions for the upcoming cohort of <strong>${escapeHtml(courseTitle)}</strong> are currently finalizing dates and curriculum updates.</li>
      <li>As a priority waitlist member, you will receive first notification and priority registration before general public admission opens.</li>
      <li>Subsidized tuition opportunities for verified cooperative members and early registrants will be communicated directly to your email.</li>
    </ul>

    <p style="margin-top:24px;">Thank you for your dedication to agricultural innovation and excellence!</p>
  `);

  try {
    await publishEvent("workshop.waitlist_confirmed", {
      email: to,
      participantName,
      courseTitle,
      subject,
      html,
    });
  } catch (err: any) {
    console.warn(`[Workshop Waitlist Email] RabbitMQ publish failed, falling back to direct Resend send:`, err.message);
    await sendEmailDirect(to, subject, html);
  }
}
