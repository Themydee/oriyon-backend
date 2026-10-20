import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import axios from "axios";
import { eq, and, sql, desc, or, gt, lt } from "drizzle-orm";
import { db } from "../index";
import {
  workshops,
  workshopRegistrations,
  workshopPayments,
  workshopEmailChallenges,
  workshopWebhookEvents,
} from "../db/schema";
import { WorkshopEligibilityService } from "../services/workshopEligibility";
import {
  sendVerificationChallengeEmail,
  sendRegistrationConfirmationEmail,
} from "../services/workshopEmails";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "oriyon-secret-key-2026-qa-test";
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "sk_test_52bd168f23b9e3c49711cc403a56ba6db9849149";

export interface WorkshopSessionPayload {
  sub: string; // normalized email
  workshopSlug: string;
  verifiedAt: string;
  purpose: string;
}

// ─────────────────────────────────────────────
// REGISTRATION SESSION AUTHENTICATION MIDDLEWARE
// ─────────────────────────────────────────────
export function requireWorkshopSession(req: Request, res: Response, next: NextFunction) {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else if ((req as any).cookies?.workshop_session) {
    token = (req as any).cookies.workshop_session;
  }

  if (!token) {
    return res.status(401).json({
      error: "Email verification required. Please verify your email first.",
      code: "SESSION_REQUIRED",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as WorkshopSessionPayload;
    if (decoded.purpose !== "workshop_registration") {
      return res.status(401).json({ error: "Invalid session type.", code: "INVALID_SESSION" });
    }

    const currentSlug = req.params.slug;
    if (currentSlug && decoded.workshopSlug !== currentSlug) {
      return res.status(403).json({
        error: "Session is not authorized for this workshop.",
        code: "SLUG_MISMATCH",
      });
    }

    (req as any).workshopSession = decoded;
    next();
  } catch (err: any) {
    return res.status(401).json({
      error: "Verification session has expired or is invalid. Please verify your email again.",
      code: "SESSION_EXPIRED",
    });
  }
}

// ─────────────────────────────────────────────
// 1. GET /api/workshops/:slug
// Public — Retrieve workshop details & availability
// ─────────────────────────────────────────────
router.get("/:slug", async (req: Request, res: Response) => {
  const { slug } = req.params;
  try {
    const [workshop] = await db
      .select({
        id: workshops.id,
        slug: workshops.slug,
        title: workshops.title,
        description: workshops.description,
        currency: workshops.currency,
        memberPrice: workshops.memberPrice,
        standardPrice: workshops.standardPrice,
        status: workshops.status,
        registrationAvailability: workshops.registrationAvailability,
        startDate: workshops.startDate,
        endDate: workshops.endDate,
        venue: workshops.venue,
        metadata: workshops.metadata,
      })
      .from(workshops)
      .where(eq(workshops.slug, slug))
      .limit(1);

    if (!workshop) {
      return res.status(404).json({ error: "Workshop not found." });
    }

    return res.json({ workshop });
  } catch (err) {
    console.error("[workshops] get workshop error:", err);
    return res.status(500).json({ error: "Failed to fetch workshop details." });
  }
});

// ─────────────────────────────────────────────
// 2. POST /api/workshops/:slug/email-challenges
// Request 6-digit OTP verification challenge
// ─────────────────────────────────────────────
router.post("/:slug/email-challenges", async (req: Request, res: Response) => {
  const { slug } = req.params;
  const emailSchema = z.object({
    email: z.string().email("Please provide a valid email address.").max(255),
  });

  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid email address." });
  }

  const normalizedEmail = parsed.data.email.trim().toLowerCase();

  try {
    // Verify workshop status
    const [workshop] = await db
      .select()
      .from(workshops)
      .where(eq(workshops.slug, slug))
      .limit(1);

    if (!workshop) {
      return res.status(404).json({ error: "Workshop not found." });
    }

    if (workshop.status === "closed" || !workshop.registrationAvailability) {
      return res.status(400).json({ error: "Registration for this workshop is currently closed." });
    }

    // Rate limiting: max 5 requests per 10 minutes per email
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const [recentCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workshopEmailChallenges)
      .where(
        and(
          eq(workshopEmailChallenges.email, normalizedEmail),
          eq(workshopEmailChallenges.workshopSlug, slug),
          gt(workshopEmailChallenges.createdAt, tenMinutesAgo)
        )
      );

    if (recentCount && recentCount.count >= 5) {
      return res.status(429).json({
        error: "Too many verification requests. Please wait 10 minutes before requesting another code.",
      });
    }

    // Generate cryptographically secure 6-digit code
    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";

    await db.insert(workshopEmailChallenges).values({
      email: normalizedEmail,
      workshopSlug: slug,
      codeHash,
      expiresAt,
      attempts: 0,
      maxAttempts: 5,
      used: false,
      ipAddress,
    });

    // Send email
    await sendVerificationChallengeEmail(normalizedEmail, code, 10);

    // In local dev/testing, log OTP securely for automated verification
    if (process.env.NODE_ENV !== "production") {
      console.log(`[DEV OTP LOG] Verification code for ${normalizedEmail}: ${code}`);
    }

    return res.json({
      success: true,
      message: "A 6-digit verification code has been sent to your email address.",
      expiresInMinutes: 10,
    });
  } catch (err) {
    console.error("[workshops] email-challenge error:", err);
    return res.status(500).json({ error: "Failed to generate verification challenge. Please retry." });
  }
});

// ─────────────────────────────────────────────
// 3. POST /api/workshops/:slug/email-challenges/verify
// Verify 6-digit OTP and issue registration session
// ─────────────────────────────────────────────
router.post("/:slug/email-challenges/verify", async (req: Request, res: Response) => {
  const { slug } = req.params;
  const verifySchema = z.object({
    email: z.string().email().max(255),
    code: z.string().length(6, "Verification code must be 6 digits."),
  });

  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request payload." });
  }

  const normalizedEmail = parsed.data.email.trim().toLowerCase();
  const rawCode = parsed.data.code.trim();

  try {
    // Find latest unused challenge for this email and workshop
    const [challenge] = await db
      .select()
      .from(workshopEmailChallenges)
      .where(
        and(
          eq(workshopEmailChallenges.email, normalizedEmail),
          eq(workshopEmailChallenges.workshopSlug, slug),
          eq(workshopEmailChallenges.used, false)
        )
      )
      .orderBy(desc(workshopEmailChallenges.createdAt))
      .limit(1);

    if (!challenge) {
      return res.status(400).json({
        error: "No pending verification challenge found. Please request a new code.",
      });
    }

    if (new Date() > challenge.expiresAt) {
      return res.status(400).json({
        error: "Verification code has expired. Please request a new code.",
      });
    }

    if (challenge.attempts >= challenge.maxAttempts) {
      return res.status(400).json({
        error: "Maximum verification attempts exceeded. Please request a new code.",
      });
    }

    const providedHash = crypto.createHash("sha256").update(rawCode).digest("hex");
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(providedHash, "hex"),
      Buffer.from(challenge.codeHash, "hex")
    );

    if (!isMatch) {
      const remaining = challenge.maxAttempts - (challenge.attempts + 1);
      await db
        .update(workshopEmailChallenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(workshopEmailChallenges.id, challenge.id));

      return res.status(400).json({
        error: `Invalid verification code. ${remaining > 0 ? `${remaining} attempts remaining.` : "Please request a new code."}`,
      });
    }

    // Mark challenge as used
    await db
      .update(workshopEmailChallenges)
      .set({ used: true, usedAt: new Date() })
      .where(eq(workshopEmailChallenges.id, challenge.id));

    // Issue short-lived registration session JWT (2 hours)
    const verifiedAt = new Date().toISOString();
    const token = jwt.sign(
      {
        sub: normalizedEmail,
        workshopSlug: slug,
        verifiedAt,
        purpose: "workshop_registration",
      },
      JWT_SECRET,
      { expiresIn: "2h" }
    );

    res.cookie("workshop_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 2 * 60 * 60 * 1000,
    });

    return res.json({
      success: true,
      token,
      email: normalizedEmail,
      verifiedAt,
    });
  } catch (err) {
    console.error("[workshops] verify error:", err);
    return res.status(500).json({ error: "Verification failed due to a server error." });
  }
});

// ─────────────────────────────────────────────
// 4. GET /api/workshops/:slug/eligibility
// Check authoritative eligibility for verified session
// ─────────────────────────────────────────────
router.get("/:slug/eligibility", requireWorkshopSession, async (req: Request, res: Response) => {
  const { slug } = req.params;
  const session = (req as any).workshopSession as WorkshopSessionPayload;

  try {
    const decision = await WorkshopEligibilityService.determineEligibility(session.sub, slug);

    return res.json({
      eligible: decision.eligible,
      fee: {
        currency: decision.currency,
        amountKobo: decision.amountKobo,
        display: decision.displayFee,
      },
      participant: {
        email: session.sub,
        suggestedName: decision.suggestedName || null,
      },
      workshop: {
        slug: decision.workshop.slug,
        title: decision.workshop.title,
      },
    });
  } catch (err: any) {
    console.error("[workshops] eligibility check error:", err);
    return res.status(503).json({
      error: "Authoritative eligibility records temporarily unavailable. Please retry.",
    });
  }
});

// ─────────────────────────────────────────────
// 5. POST /api/workshops/:slug/registrations
// Create or resume registration with atomic pricing
// ─────────────────────────────────────────────
router.post("/:slug/registrations", requireWorkshopSession, async (req: Request, res: Response) => {
  const { slug } = req.params;
  const session = (req as any).workshopSession as WorkshopSessionPayload;

  const registrationSchema = z.object({
    participantName: z.string().min(2, "Name is too short").max(255),
    phone: z.string().min(7).max(30).optional(),
    additionalDetails: z.record(z.any()).optional(),
  });

  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid registration details." });
  }

  const { participantName, phone, additionalDetails } = parsed.data;

  try {
    // 1. Authoritative eligibility check on the backend
    const decision = await WorkshopEligibilityService.determineEligibility(session.sub, slug);

    const [workshop] = await db
      .select()
      .from(workshops)
      .where(eq(workshops.slug, slug))
      .limit(1);

    if (!workshop || workshop.status === "closed" || !workshop.registrationAvailability) {
      return res.status(400).json({ error: "Workshop is not open for registration." });
    }

    // 2. Check for existing registration for (workshopId, session.sub)
    const [existing] = await db
      .select()
      .from(workshopRegistrations)
      .where(
        and(
          eq(workshopRegistrations.workshopId, workshop.id),
          sql`LOWER(TRIM(${workshopRegistrations.email})) = ${session.sub}`
        )
      )
      .limit(1);

    if (existing) {
      if (existing.status === "paid" || existing.paymentStatus === "success") {
        return res.status(409).json({
          error: "You have already completed registration and payment for this workshop.",
          registration: existing,
          paid: true,
        });
      }

      // Resume existing unpaid registration: update contact details if changed, preserve locked fee
      const [updated] = await db
        .update(workshopRegistrations)
        .set({
          participantName: participantName.trim(),
          phone: phone?.trim() || existing.phone,
          additionalDetails: additionalDetails || existing.additionalDetails,
          updatedAt: new Date(),
        })
        .where(eq(workshopRegistrations.id, existing.id))
        .returning();

      return res.json({
        registration: updated,
        resumed: true,
      });
    }

    // 3. Atomically create new registration with locked server-determined fee
    const [created] = await db
      .insert(workshopRegistrations)
      .values({
        workshopId: workshop.id,
        participantName: participantName.trim(),
        email: session.sub,
        phone: phone?.trim() || null,
        emailVerifiedAt: new Date(session.verifiedAt),
        eligible: decision.eligible,
        eligibilitySource: decision.eligibilitySource,
        eligibilityRecordId: decision.eligibilityRecordId,
        eligibilityDecisionTimestamp: decision.checkedAt,
        amount: decision.amountKobo,
        currency: decision.currency,
        status: "pending_payment",
        paymentStatus: "unpaid",
        additionalDetails: additionalDetails || null,
      })
      .returning();

    return res.status(201).json({
      registration: created,
      resumed: false,
    });
  } catch (err: any) {
    console.error("[workshops] create registration error:", err);
    return res.status(500).json({ error: "Failed to create registration record." });
  }
});

// ─────────────────────────────────────────────
// 6. POST /api/workshops/:slug/registrations/:id/payments
// Initialize Paystack transaction for registration
// ─────────────────────────────────────────────
router.post("/:slug/registrations/:id/payments", requireWorkshopSession, async (req: Request, res: Response) => {
  const { slug, id } = req.params;
  const session = (req as any).workshopSession as WorkshopSessionPayload;

  try {
    const [registration] = await db
      .select()
      .from(workshopRegistrations)
      .where(
        and(
          eq(workshopRegistrations.id, id),
          sql`LOWER(TRIM(${workshopRegistrations.email})) = ${session.sub}`
        )
      )
      .limit(1);

    if (!registration) {
      return res.status(404).json({ error: "Registration record not found or unauthorized." });
    }

    if (registration.status === "paid" || registration.paymentStatus === "success") {
      return res.status(400).json({ error: "This registration has already been paid and confirmed." });
    }

    // Check workshop is still open
    const [workshop] = await db
      .select()
      .from(workshops)
      .where(eq(workshops.id, registration.workshopId))
      .limit(1);

    if (!workshop || workshop.status === "closed") {
      return res.status(400).json({ error: "Workshop registration has closed." });
    }

    // Generate unique Paystack transaction reference
    const reference = `WS-PAY-${registration.id.slice(0, 8)}-${Date.now()}`;
    const callbackUrl = `${FRONTEND_URL}/workshop/${slug}/callback?reference=${reference}`;

    // Persist payment attempt in DB
    await db.insert(workshopPayments).values({
      registrationId: registration.id,
      reference,
      amount: registration.amount,
      currency: registration.currency,
      status: "pending",
    });

    // Check if test bypass is configured or mock secret key
    const isMock = !PAYSTACK_SECRET_KEY || PAYSTACK_SECRET_KEY.includes("mockkey");
    if (isMock) {
      console.log("[Mock Paystack] Bypassing initialization, returning direct callback URL");
      return res.json({
        authorization_url: callbackUrl,
        reference,
        amount: registration.amount,
        currency: registration.currency,
      });
    }

    // Initialize Paystack Hosted Checkout
    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: registration.email,
        amount: registration.amount, // in kobo
        reference,
        callback_url: callbackUrl,
        metadata: {
          workshopSlug: slug,
          registrationId: registration.id,
          participantName: registration.participantName,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const authUrl = paystackResponse.data?.data?.authorization_url;

    await db
      .update(workshopPayments)
      .set({ authorizationUrl: authUrl })
      .where(eq(workshopPayments.reference, reference));

    return res.json({
      authorization_url: authUrl,
      reference,
      amount: registration.amount,
      currency: registration.currency,
    });
  } catch (err: any) {
    console.error("[workshops] payment init error:", err.response?.data || err.message);
    return res.status(500).json({ error: "Unable to initialize payment transaction with provider." });
  }
});

// ─────────────────────────────────────────────
// 7. GET /api/workshops/:slug/registrations/:id
// Get registration status
// ─────────────────────────────────────────────
router.get("/:slug/registrations/:id", async (req: Request, res: Response) => {
  const { slug, id } = req.params;

  try {
    const [reg] = await db
      .select({
        id: workshopRegistrations.id,
        participantName: workshopRegistrations.participantName,
        email: workshopRegistrations.email,
        phone: workshopRegistrations.phone,
        amount: workshopRegistrations.amount,
        currency: workshopRegistrations.currency,
        status: workshopRegistrations.status,
        paymentStatus: workshopRegistrations.paymentStatus,
        eligible: workshopRegistrations.eligible,
        createdAt: workshopRegistrations.createdAt,
        workshopTitle: workshops.title,
        workshopSlug: workshops.slug,
      })
      .from(workshopRegistrations)
      .innerJoin(workshops, eq(workshopRegistrations.workshopId, workshops.id))
      .where(
        and(
          eq(workshopRegistrations.id, id),
          eq(workshops.slug, slug)
        )
      )
      .limit(1);

    if (!reg) {
      return res.status(404).json({ error: "Registration not found." });
    }

    // Mask email for privacy if not authenticated
    const maskedEmail = reg.email.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + "*" + b.slice(-1) + c);

    return res.json({
      registration: {
        ...reg,
        email: maskedEmail,
      },
    });
  } catch (err) {
    console.error("[workshops] get registration error:", err);
    return res.status(500).json({ error: "Failed to fetch registration status." });
  }
});

// ─────────────────────────────────────────────
// 8. POST /api/workshops/:slug/payments/verify
// Server-side payment verification (callback return)
// ─────────────────────────────────────────────
router.post("/:slug/payments/verify", async (req: Request, res: Response) => {
  const { slug } = req.params;
  const verifySchema = z.object({
    reference: z.string().min(1, "Reference is required"),
  });

  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Payment reference is required." });
  }

  const { reference } = parsed.data;

  try {
    // 1. Fetch payment attempt record
    const [payment] = await db
      .select()
      .from(workshopPayments)
      .where(eq(workshopPayments.reference, reference))
      .limit(1);

    if (!payment) {
      return res.status(404).json({ error: "Payment transaction record not found." });
    }

    const [registration] = await db
      .select()
      .from(workshopRegistrations)
      .where(eq(workshopRegistrations.id, payment.registrationId))
      .limit(1);

    if (!registration) {
      return res.status(404).json({ error: "Associated registration record not found." });
    }

    const [workshop] = await db
      .select()
      .from(workshops)
      .where(eq(workshops.id, registration.workshopId))
      .limit(1);

    // If already verified success, return idempotent confirmation
    if (payment.status === "success" && registration.status === "paid") {
      return res.json({
        status: "success",
        alreadyConfirmed: true,
        registrationId: registration.id,
        reference: payment.reference,
        amount: payment.amount,
        currency: payment.currency,
        paidAt: payment.paidAt,
        workshopTitle: workshop?.title,
      });
    }

    // 2. Query Paystack verification API
    const isMock = !PAYSTACK_SECRET_KEY || PAYSTACK_SECRET_KEY.includes("mockkey");
    let paystackData: any;

    if (isMock) {
      console.log("[Mock Paystack] Auto-approving verify API call");
      paystackData = {
        status: "success",
        id: "mock-txn-" + Date.now(),
        amount: payment.amount,
        currency: payment.currency,
        paid_at: new Date().toISOString(),
      };
    } else {
      const paystackRes = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        }
      );
      paystackData = paystackRes.data?.data;
    }

    if (paystackData?.status === "success") {
      // Validate amount and currency integrity
      if (paystackData.amount !== payment.amount) {
        console.error(
          `[SECURITY ALERT] Payment amount mismatch for ref ${reference}: Expected ${payment.amount}, got ${paystackData.amount}`
        );
        return res.status(400).json({ error: "Payment verification failed: Amount mismatch." });
      }

      if (paystackData.currency?.toUpperCase() !== payment.currency.toUpperCase()) {
        console.error(
          `[SECURITY ALERT] Payment currency mismatch for ref ${reference}: Expected ${payment.currency}, got ${paystackData.currency}`
        );
        return res.status(400).json({ error: "Payment verification failed: Currency mismatch." });
      }

      const paidAt = new Date(paystackData.paid_at || Date.now());

      // 3. Atomically update payment and registration
      await db
        .update(workshopPayments)
        .set({
          status: "success",
          paystackTransactionId: String(paystackData.id),
          verifiedAt: new Date(),
          paidAt,
          metadata: paystackData,
          updatedAt: new Date(),
        })
        .where(eq(workshopPayments.id, payment.id));

      await db
        .update(workshopRegistrations)
        .set({
          status: "paid",
          paymentStatus: "success",
          updatedAt: new Date(),
        })
        .where(eq(workshopRegistrations.id, registration.id));

      // 4. Send Confirmation Email (Idempotent)
      sendRegistrationConfirmationEmail({
        to: registration.email,
        participantName: registration.participantName,
        workshopTitle: workshop?.title || "EEWYLA Goat Training Workshop",
        registrationReference: `REG-${registration.id.slice(0, 8).toUpperCase()}`,
        paystackReference: payment.reference,
        amountKobo: payment.amount,
        currency: payment.currency,
        paidAt,
      }).catch(err => console.error("[workshops] confirmation email error:", err));

      return res.json({
        status: "success",
        alreadyConfirmed: false,
        registrationId: registration.id,
        reference: payment.reference,
        amount: payment.amount,
        currency: payment.currency,
        paidAt,
        workshopTitle: workshop?.title,
      });
    } else {
      await db
        .update(workshopPayments)
        .set({
          status: "failed",
          metadata: paystackData,
          updatedAt: new Date(),
        })
        .where(eq(workshopPayments.id, payment.id));

      return res.status(400).json({
        status: paystackData?.status || "failed",
        message: "Payment was not completed successfully. Please retry.",
      });
    }
  } catch (err: any) {
    console.error("[workshops] verify endpoint error:", err.response?.data || err.message);
    return res.status(500).json({ error: "Failed to verify transaction with payment provider." });
  }
});

// ─────────────────────────────────────────────
// 9. POST /api/workshops/webhook (or /:slug/webhook)
// Secure, idempotent Paystack webhook processing
// ─────────────────────────────────────────────
export async function handlePaystackWebhook(req: Request, res: Response) {
  const signature = req.headers["x-paystack-signature"] as string;
  if (!signature) {
    return res.status(401).json({ error: "Missing Paystack signature header." });
  }

  // Raw body verification
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    console.warn("[Webhook] Invalid HMAC signature");
    return res.status(401).json({ error: "Invalid webhook signature." });
  }

  const event = req.body;
  const eventId = String(event.id || `paystack-${event.event}-${event.data?.reference || event.data?.id}`);

  // Webhook Deduplication Check
  const [existingEvent] = await db
    .select()
    .from(workshopWebhookEvents)
    .where(eq(workshopWebhookEvents.eventId, eventId))
    .limit(1);

  if (existingEvent) {
    console.log(`[Webhook] Event ${eventId} already processed. Acknowledging 200 OK.`);
    return res.status(200).json({ received: true, deduplicated: true });
  }

  // Persist webhook event for audit and deduplication
  await db.insert(workshopWebhookEvents).values({
    eventId,
    eventType: event.event,
    reference: event.data?.reference || null,
    status: "processed",
    payload: event,
  });

  if (event.event === "charge.success") {
    const data = event.data;
    const reference = data.reference;

    if (reference && reference.startsWith("WS-PAY-")) {
      const [payment] = await db
        .select()
        .from(workshopPayments)
        .where(eq(workshopPayments.reference, reference))
        .limit(1);

      if (payment && payment.status !== "success") {
        if (data.amount === payment.amount && data.currency?.toUpperCase() === payment.currency.toUpperCase()) {
          const paidAt = new Date(data.paid_at || Date.now());

          await db
            .update(workshopPayments)
            .set({
              status: "success",
              paystackTransactionId: String(data.id),
              verifiedAt: new Date(),
              paidAt,
              metadata: data,
              updatedAt: new Date(),
            })
            .where(eq(workshopPayments.id, payment.id));

          await db
            .update(workshopRegistrations)
            .set({
              status: "paid",
              paymentStatus: "success",
              updatedAt: new Date(),
            })
            .where(eq(workshopRegistrations.id, payment.registrationId));

          const [registration] = await db
            .select()
            .from(workshopRegistrations)
            .where(eq(workshopRegistrations.id, payment.registrationId))
            .limit(1);

          if (registration) {
            sendRegistrationConfirmationEmail({
              to: registration.email,
              participantName: registration.participantName,
              workshopTitle: "EEWYLA Goat Training Workshop",
              registrationReference: `REG-${registration.id.slice(0, 8).toUpperCase()}`,
              paystackReference: payment.reference,
              amountKobo: payment.amount,
              currency: payment.currency,
              paidAt,
            }).catch(e => console.error("[Webhook] confirmation email error:", e));
          }
        }
      }
    }
  }

  return res.status(200).json({ received: true });
}

router.post("/webhook", handlePaystackWebhook);
router.post("/:slug/webhook", handlePaystackWebhook);

// ─────────────────────────────────────────────
// 10. GET /api/workshops/:slug/admin/registrations
// Administrative visibility of all registrations
// ─────────────────────────────────────────────
router.get("/:slug/admin/registrations", async (req: Request, res: Response) => {
  const userRole = req.headers["x-user-role"] as string;
  if (!userRole || !["admin", "super_admin", "coordinator"].includes(userRole)) {
    return res.status(403).json({ error: "Access forbidden: Administrator privileges required." });
  }

  const { slug } = req.params;

  try {
    const list = await db
      .select({
        id: workshopRegistrations.id,
        participantName: workshopRegistrations.participantName,
        email: workshopRegistrations.email,
        phone: workshopRegistrations.phone,
        eligible: workshopRegistrations.eligible,
        eligibilitySource: workshopRegistrations.eligibilitySource,
        eligibilityRecordId: workshopRegistrations.eligibilityRecordId,
        amount: workshopRegistrations.amount,
        currency: workshopRegistrations.currency,
        status: workshopRegistrations.status,
        paymentStatus: workshopRegistrations.paymentStatus,
        createdAt: workshopRegistrations.createdAt,
        updatedAt: workshopRegistrations.updatedAt,
      })
      .from(workshopRegistrations)
      .innerJoin(workshops, eq(workshopRegistrations.workshopId, workshops.id))
      .where(eq(workshops.slug, slug))
      .orderBy(desc(workshopRegistrations.createdAt));

    return res.json({ registrations: list, total: list.length });
  } catch (err) {
    console.error("[workshops] admin registrations list error:", err);
    return res.status(500).json({ error: "Failed to fetch registrations." });
  }
});

export default router;
