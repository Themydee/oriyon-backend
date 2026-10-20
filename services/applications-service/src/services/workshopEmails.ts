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
  registrationReference: string;
  paystackReference: string;
  amountKobo: number;
  currency: string;
  paidAt: string | Date;
}

export async function sendRegistrationConfirmationEmail(payload: WorkshopConfirmationPayload): Promise<void> {
  const {
    to,
    participantName,
    workshopTitle,
    registrationReference,
    paystackReference,
    amountKobo,
    currency,
    paidAt,
  } = payload;

  const displayAmount = (amountKobo / 100).toLocaleString("en-NG", {
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

  const subject = `Confirmed: Registration for ${workshopTitle}`;
  const html = baseLayout(`
    <h2 style="margin-top:0; color:#1E3F20;">Registration & Payment Confirmed</h2>
    <p>Dear <strong>${escapeHtml(participantName)}</strong>,</p>
    <p>Congratulations! Your payment for the <strong>${escapeHtml(workshopTitle)}</strong> has been verified successfully. Your seat is confirmed.</p>
    
    <div style="background:#fbfbee; border:1px solid #d4e0ce; border-radius:8px; padding:20px; margin:24px 0;">
      <h3 style="margin-top:0; color:#2D5A27;">Registration Receipt</h3>
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
          <td class="label">Workshop</td>
          <td class="value">${escapeHtml(workshopTitle)}</td>
        </tr>
        <tr>
          <td class="label">Registration Ref</td>
          <td class="value"><strong>${escapeHtml(registrationReference)}</strong></td>
        </tr>
        <tr>
          <td class="label">Payment Reference</td>
          <td class="value">${escapeHtml(paystackReference)}</td>
        </tr>
        <tr>
          <td class="label">Amount Paid</td>
          <td class="value" style="color:#2D5A27; font-size:16px;"><strong>${displayAmount}</strong></td>
        </tr>
        <tr>
          <td class="label">Confirmation Date</td>
          <td class="value">${formattedDate}</td>
        </tr>
      </table>
    </div>

    <h3 style="color:#1E3F20;">Next Steps</h3>
    <ul style="padding-left:20px;">
      <li>Keep your registration reference (<strong>${escapeHtml(registrationReference)}</strong>) safe for check-in at the venue.</li>
      <li>Our training team will contact you with specific timetable and venue directions ahead of the workshop commencement.</li>
      <li>Practical field training gear recommendations and curriculum briefs will be sent via email.</li>
    </ul>

    <p style="margin-top:24px;">We look forward to welcoming you to the workshop!</p>
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
