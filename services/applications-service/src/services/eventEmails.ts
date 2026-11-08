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

function baseLayout(content: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Oriyon International - EEWYLA Week 12 Guest Seminars</title>
  <style>
    body { background-color: #f4f4f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 12px; border: 1px solid #e0dfd5; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .header { background-color: #1E3F20; padding: 28px; text-align: center; }
    .logo { height: 44px; }
    .body-content { padding: 36px 32px; color: #1c1c1c; line-height: 1.6; }
    .code-box { background: #fbfbee; border: 2px dashed #2D5A27; border-radius: 8px; padding: 18px; text-align: center; margin: 24px 0; }
    .code { font-family: 'Courier New', monospace; font-size: 26px; font-weight: bold; letter-spacing: 3px; color: #1E3F20; }
    .receipt-table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; }
    .receipt-table td { padding: 10px 12px; border-bottom: 1px solid #eeeeee; }
    .receipt-table td.label { color: #666666; font-weight: 600; width: 38%; }
    .receipt-table td.value { color: #111111; font-weight: 500; }
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
      <p>For inquiries, please email <a href="mailto:eewyla@oriyoninternational.com" style="color:#2D5A27; text-decoration:none;">eewyla@oriyoninternational.com</a></p>
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
        {
          from: FROM,
          to,
          subject,
          html,
        },
        {
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 5000,
        }
      );
      return true;
    } catch (err: any) {
      console.warn(`[Event Email] Direct Resend delivery failed for ${to}:`, err.response?.data || err.message);
      return false;
    }
  } else {
    console.log(`[Event Email: Mock] Email to ${to} with subject "${subject}" acknowledged.`);
    return true;
  }
}

export interface EventRegistrationEmailPayload {
  to: string;
  fullName: string;
  registrationReference: string;
  eventTitle: string;
  venue: string;
  schedule: string;
}

export async function sendEventRegistrationEmail(payload: EventRegistrationEmailPayload): Promise<void> {
  const { to, fullName, registrationReference, eventTitle, venue, schedule } = payload;
  const subject = `Registration Confirmed: ${eventTitle} (Ref: ${registrationReference})`;

  const html = baseLayout(`
    <h2 style="margin-top:0; color:#1E3F20;">Registration Confirmed!</h2>
    <p>Dear <strong>${escapeHtml(fullName)}</strong>,</p>
    <p>Thank you for registering for the <strong>${escapeHtml(eventTitle)}</strong> under the Oriyon International EEWYLA Agricultural Program.</p>
    <p>Your seat has been reserved. Please keep your registration reference handy for arrival:</p>

    <div class="code-box">
      <div style="font-size:12px; color:#555555; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; font-weight:bold;">Your Registration Reference</div>
      <div class="code">${escapeHtml(registrationReference)}</div>
    </div>

    <table class="receipt-table">
      <tr>
        <td class="label">Event</td>
        <td class="value"><strong>${escapeHtml(eventTitle)}</strong></td>
      </tr>
      <tr>
        <td class="label">Commencement</td>
        <td class="value">${escapeHtml(schedule)}</td>
      </tr>
      <tr>
        <td class="label">Venue</td>
        <td class="value">${escapeHtml(venue)}</td>
      </tr>
      <tr>
        <td class="label">Admission Fee</td>
        <td class="value" style="color:#2D5A27; font-weight:bold;">FREE (Complimentary Seat)</td>
      </tr>
      <tr>
        <td class="label">Attendee</td>
        <td class="value">${escapeHtml(fullName)}</td>
      </tr>
      <tr>
        <td class="label">Registered Email</td>
        <td class="value">${escapeHtml(to)}</td>
      </tr>
    </table>

    <h3 style="color:#1E3F20; margin-top:24px;">Important Information</h3>
    <ul style="padding-left:20px; line-height:1.7;">
      <li>This seminar series is open to everyone, including students, farmers, agribusiness professionals, entrepreneurs, and the general public.</li>
      <li>Seating will be available on a first-come, first-served basis. We encourage arriving 15 minutes prior to the start time (10:45 AM).</li>
      <li>No prior student ID, matriculation number, or institutional verification is required for admission.</li>
    </ul>

    <p style="margin-top:28px;">We look forward to welcoming you at LAUTECH, Ogbomoso!</p>
  `);

  try {
    await publishEvent("event.registration_confirmed", {
      email: to,
      fullName,
      registrationReference,
      eventTitle,
      venue,
      schedule,
      subject,
      html,
    });
  } catch (err: any) {
    console.warn(`[Event Email] RabbitMQ publish failed, falling back to direct send:`, err.message);
    await sendEmailDirect(to, subject, html);
  }
}

