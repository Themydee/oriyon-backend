import { Router, Request, Response } from "express";
import crypto from "crypto";
import axios from "axios";
import { eq, and, sql, desc, or, lt, gt } from "drizzle-orm";
import { db } from "../index";
import {
  payments,
  workshopPayments,
  workshopRegistrations,
  workshops,
  workshopWebhookEvents,
  cooperativePayments,
  cooperativeMembers,
} from "../db/schema";
import { sendRegistrationConfirmationEmail } from "../services/workshopEmails";
import { publishEvent } from "../rabbitmq";

const router = Router();
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const SHOP_SERVICE_URL = process.env.SHOP_SERVICE_URL || "http://localhost:3006";

// ─────────────────────────────────────────────
// 1. CENTRAL PAYSTACK WEBHOOK HANDLER
// Single canonical webhook receiver for ALL platform payments:
// Workshops, Cooperative Registrations, Cooperative Dues, and Shop Orders.
// ─────────────────────────────────────────────
export async function handleCentralPaystackWebhook(req: Request, res: Response) {
  const signature = req.headers["x-paystack-signature"] as string;
  if (!signature) {
    console.warn("[Central Webhook] Request rejected: Missing x-paystack-signature header.");
    return res.status(401).json({ error: "Missing Paystack signature header." });
  }

  if (!PAYSTACK_SECRET_KEY) {
    console.error("[Central Webhook Error] PAYSTACK_SECRET_KEY is not configured in environment.");
    return res.status(500).json({ error: "Payment gateway secret key not configured." });
  }

  // Exact raw body verification
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");

  if (
    signature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  ) {
    console.warn("[Central Webhook] Invalid HMAC-SHA512 signature. Rejecting request.");
    return res.status(401).json({ error: "Invalid webhook signature." });
  }

  const event = req.body;
  const eventId = String(
    event.id || `paystack-${event.event}-${event.data?.reference || event.data?.id || Date.now()}`
  );

  try {
    // Webhook Deduplication Check
    const [existingEvent] = await db
      .select()
      .from(workshopWebhookEvents)
      .where(eq(workshopWebhookEvents.eventId, eventId))
      .limit(1);

    if (existingEvent) {
      console.log(`[Central Webhook] Event ${eventId} already processed. Deduplicating with 200 OK.`);
      return res.status(200).json({ received: true, deduplicated: true });
    }

    // Persist event in audit ledger
    await db.insert(workshopWebhookEvents).values({
      eventId,
      eventType: event.event || "unknown",
      reference: event.data?.reference || null,
      status: "processed",
      payload: event,
    });

    if (event.event === "charge.success") {
      const data = event.data;
      const reference = data.reference;
      const amountKobo = Number(data.amount);
      const currency = String(data.currency || "NGN").toUpperCase();
      const customerEmail = data.customer?.email || "";
      const paystackTxnId = String(data.id || "");
      const paidAt = new Date(data.paid_at || Date.now());

      console.log(`[Central Webhook] Processing charge.success for ref: ${reference}, amount: ${amountKobo} kobo`);

      // ─────────────────────────────────────────────
      // FLOW A: WORKSHOP PAYMENTS (WS-PAY-*)
      // ─────────────────────────────────────────────
      if (reference && reference.startsWith("WS-PAY-")) {
        const [payment] = await db
          .select()
          .from(workshopPayments)
          .where(eq(workshopPayments.reference, reference))
          .limit(1);

        if (payment) {
          if (payment.status === "success") {
            console.log(`[Central Webhook] Workshop payment ${reference} already confirmed.`);
            return res.status(200).json({ received: true, alreadyConfirmed: true });
          }

          // Validate amount & currency integrity
          if (amountKobo !== payment.amount || currency !== payment.currency.toUpperCase()) {
            console.error(
              `[SECURITY ALERT] Workshop payment mismatch for ref ${reference}: Expected ${payment.amount} ${payment.currency}, got ${amountKobo} ${currency}`
            );
            return res.status(400).json({ error: "Webhook amount or currency mismatch." });
          }

          const [reg] = await db
            .select()
            .from(workshopRegistrations)
            .where(eq(workshopRegistrations.id, payment.registrationId))
            .limit(1);

          // Duplicate successful payment detection
          if (reg && reg.status === "paid") {
            console.warn(
              `[DUPLICATE PAYMENT ALERT] Registration ${reg.id} already marked paid! Second payment ${reference} succeeded at Paystack.`
            );
            await db
              .update(workshopPayments)
              .set({
                status: "success",
                paystackTransactionId: paystackTxnId,
                metadata: { ...data, duplicateChargeDetected: true, originalRegistrationId: reg.id },
                verifiedAt: new Date(),
                paidAt,
                updatedAt: new Date(),
              })
              .where(eq(workshopPayments.id, payment.id));

            await db
              .insert(payments)
              .values({
                reference,
                category: "workshop",
                businessEntityId: reg.id,
                amountKobo,
                currency,
                customerEmail: reg.email,
                status: "duplicate_paid_review",
                provider: "paystack",
                paystackTransactionId: paystackTxnId,
                metadata: { ...data, duplicateChargeDetected: true },
                verifiedAt: new Date(),
                paidAt,
              })
              .onConflictDoUpdate({
                target: payments.reference,
                set: {
                  status: "duplicate_paid_review",
                  paystackTransactionId: paystackTxnId,
                  verifiedAt: new Date(),
                  paidAt,
                  metadata: { ...data, duplicateChargeDetected: true },
                  updatedAt: new Date(),
                },
              });

            return res.status(200).json({ received: true, duplicateDetected: true });
          }

          // Normal Workshop Fulfilment
          await db
            .update(workshopPayments)
            .set({
              status: "success",
              paystackTransactionId: paystackTxnId,
              verifiedAt: new Date(),
              paidAt,
              metadata: data,
              updatedAt: new Date(),
            })
            .where(eq(workshopPayments.id, payment.id));

          if (reg) {
            await db
              .update(workshopRegistrations)
              .set({
                status: "paid",
                paymentStatus: "success",
                updatedAt: new Date(),
              })
              .where(eq(workshopRegistrations.id, reg.id));

            // Sync with Unified Payments Table
            await db
              .insert(payments)
              .values({
                reference,
                category: "workshop",
                businessEntityId: reg.id,
                amountKobo,
                currency,
                customerEmail: reg.email,
                status: "success",
                provider: "paystack",
                paystackTransactionId: paystackTxnId,
                metadata: data,
                verifiedAt: new Date(),
                paidAt,
              })
              .onConflictDoUpdate({
                target: payments.reference,
                set: {
                  status: "success",
                  paystackTransactionId: paystackTxnId,
                  verifiedAt: new Date(),
                  paidAt,
                  metadata: data,
                  updatedAt: new Date(),
                },
              });

            // Dispatch Confirmation Email
            const [ws] = await db
              .select()
              .from(workshops)
              .where(eq(workshops.id, reg.workshopId))
              .limit(1);

            sendRegistrationConfirmationEmail({
              to: reg.email,
              participantName: reg.participantName,
              workshopTitle: ws?.title || "Oriyon Workshop Training",
              registrationReference: `REG-${reg.id.slice(0, 8).toUpperCase()}`,
              paystackReference: payment.reference,
              amountKobo: payment.amount,
              currency: payment.currency,
              paidAt,
            }).catch((err: any) => console.error("[Central Webhook] Workshop confirmation email error:", err));
          }
        }
      }

      // ─────────────────────────────────────────────
      // FLOW B: COOPERATIVE REGISTRATION FEE (COOP-PAY-*)
      // ─────────────────────────────────────────────
      else if (reference && reference.startsWith("COOP-PAY-")) {
        const [payment] = await db
          .select()
          .from(cooperativePayments)
          .where(eq(cooperativePayments.reference, reference))
          .limit(1);

        if (payment) {
          if (payment.status === "success") {
            console.log(`[Central Webhook] Cooperative payment ${reference} already confirmed.`);
            return res.status(200).json({ received: true, alreadyConfirmed: true });
          }

          // Validate amount and currency
          if (amountKobo !== payment.amount || currency !== payment.currency.toUpperCase()) {
            console.error(
              `[SECURITY ALERT] Cooperative payment mismatch for ref ${reference}: Expected ${payment.amount} ${payment.currency}, got ${amountKobo} ${currency}`
            );
            return res.status(400).json({ error: "Webhook amount or currency mismatch." });
          }

          const [member] = await db
            .select()
            .from(cooperativeMembers)
            .where(eq(cooperativeMembers.id, payment.memberId))
            .limit(1);

          // Duplicate successful payment detection
          if (member && member.registrationFeePaid === "YES") {
            console.warn(
              `[DUPLICATE PAYMENT ALERT] Member ${member.id} already paid registration fee! Second payment ${reference} succeeded.`
            );
            await db
              .update(cooperativePayments)
              .set({
                status: "success",
                metadata: { ...data, duplicateChargeDetected: true },
                updatedAt: new Date(),
              })
              .where(eq(cooperativePayments.id, payment.id));

            await db
              .insert(payments)
              .values({
                reference,
                category: "cooperative_registration_fee",
                businessEntityId: member.id,
                amountKobo,
                currency,
                customerEmail: member.email || customerEmail,
                status: "duplicate_paid_review",
                provider: "paystack",
                paystackTransactionId: paystackTxnId,
                metadata: { ...data, duplicateChargeDetected: true },
                verifiedAt: new Date(),
                paidAt,
              })
              .onConflictDoUpdate({
                target: payments.reference,
                set: {
                  status: "duplicate_paid_review",
                  paystackTransactionId: paystackTxnId,
                  verifiedAt: new Date(),
                  paidAt,
                  metadata: { ...data, duplicateChargeDetected: true },
                  updatedAt: new Date(),
                },
              });

            return res.status(200).json({ received: true, duplicateDetected: true });
          }

          // Cooperative Fulfilment
          await db
            .update(cooperativePayments)
            .set({
              status: "success",
              metadata: data,
              updatedAt: new Date(),
            })
            .where(eq(cooperativePayments.id, payment.id));

          if (member) {
            await db
              .update(cooperativeMembers)
              .set({
                registrationFeePaid: "YES",
                updatedAt: new Date(),
              })
              .where(eq(cooperativeMembers.id, member.id));

            // Publish auto-provision event
            await publishEvent("cooperative.payment_verified", {
              memberId: member.id,
              email: member.email,
              firstName: member.firstName,
              lastName: member.lastName,
              phone: member.phone,
              lga: member.lga,
            });

            // Master payment ledger update
            await db
              .insert(payments)
              .values({
                reference,
                category: "cooperative_registration_fee",
                businessEntityId: member.id,
                amountKobo,
                currency,
                customerEmail: member.email || customerEmail,
                status: "success",
                provider: "paystack",
                paystackTransactionId: paystackTxnId,
                metadata: data,
                verifiedAt: new Date(),
                paidAt,
              })
              .onConflictDoUpdate({
                target: payments.reference,
                set: {
                  status: "success",
                  paystackTransactionId: paystackTxnId,
                  verifiedAt: new Date(),
                  paidAt,
                  metadata: data,
                  updatedAt: new Date(),
                },
              });
          }
        }
      }

      // ─────────────────────────────────────────────
      // FLOW C: COOPERATIVE MONTHLY CONTRIBUTION (COOP-CONTRIB-*)
      // ─────────────────────────────────────────────
      else if (reference && reference.startsWith("COOP-CONTRIB-")) {
        const [payment] = await db
          .select()
          .from(cooperativePayments)
          .where(eq(cooperativePayments.reference, reference))
          .limit(1);

        if (payment) {
          await db
            .update(cooperativePayments)
            .set({
              status: "success",
              metadata: data,
              updatedAt: new Date(),
            })
            .where(eq(cooperativePayments.id, payment.id));

          await db
            .insert(payments)
            .values({
              reference,
              category: "cooperative_contribution",
              businessEntityId: payment.memberId,
              amountKobo,
              currency,
              customerEmail,
              status: "success",
              provider: "paystack",
              paystackTransactionId: paystackTxnId,
              metadata: data,
              verifiedAt: new Date(),
              paidAt,
            })
            .onConflictDoUpdate({
              target: payments.reference,
              set: {
                status: "success",
                paystackTransactionId: paystackTxnId,
                verifiedAt: new Date(),
                paidAt,
                metadata: data,
                updatedAt: new Date(),
              },
            });
        }
      }

      // ─────────────────────────────────────────────
      // FLOW D: SHOP / E-COMMERCE PURCHASE (OR-SHOP-*)
      // ─────────────────────────────────────────────
      else if (reference && (reference.startsWith("OR-SHOP-") || reference.startsWith("SHOP-"))) {
        console.log(`[Central Webhook] Processing shop order fulfilment for ref: ${reference}`);

        // 1. Record in master payments registry
        await db
          .insert(payments)
          .values({
            reference,
            category: "shop_order",
            businessEntityId: reference,
            amountKobo,
            currency,
            customerEmail,
            status: "success",
            provider: "paystack",
            paystackTransactionId: paystackTxnId,
            metadata: data,
            verifiedAt: new Date(),
            paidAt,
          })
          .onConflictDoUpdate({
            target: payments.reference,
            set: {
              status: "success",
              paystackTransactionId: paystackTxnId,
              verifiedAt: new Date(),
              paidAt,
              metadata: data,
              updatedAt: new Date(),
            },
          });

        // 2. Dispatch internal fulfilment call to shop-service
        try {
          await axios.post(
            `${SHOP_SERVICE_URL}/orders/${reference}/mark-paid`,
            {
              paystackTransactionId: paystackTxnId,
              amountKobo,
              currency,
              paidAt: paidAt.toISOString(),
            },
            { timeout: 8000 }
          );
          console.log(`[Central Webhook] Successfully notified shop-service for order ref ${reference}`);
        } catch (shopErr: any) {
          console.error(
            `[Central Webhook Warning] Direct shop-service notification failed for ref ${reference}:`,
            shopErr.message
          );
          // Publish asynchronous event via RabbitMQ as backup
          await publishEvent("shop.payment_confirmed", {
            reference,
            paystackTransactionId: paystackTxnId,
            amountKobo,
            currency,
            paidAt: paidAt.toISOString(),
          }).catch((mqErr) => console.error("[Central Webhook] RabbitMQ shop event error:", mqErr));
        }
      } else {
        console.warn(`[Central Webhook] Unrecognized transaction reference prefix: ${reference}`);
        await db
          .insert(payments)
          .values({
            reference: reference || `UNKNOWN-${Date.now()}`,
            category: "unmatched",
            businessEntityId: "unknown",
            amountKobo,
            currency,
            customerEmail,
            status: "unmatched",
            provider: "paystack",
            paystackTransactionId: paystackTxnId,
            metadata: data,
            verifiedAt: new Date(),
            paidAt,
          })
          .onConflictDoNothing();
      }
    }

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("[Central Webhook Error]:", err);
    return res.status(500).json({ error: "Webhook processing internal error" });
  }
}

// Mount webhook listener
router.post("/webhook", handleCentralPaystackWebhook);

// ─────────────────────────────────────────────
// 2. RECONCILIATION ENGINE
// Periodically audits and resolves stuck "pending" transactions against Paystack API
// ─────────────────────────────────────────────
export async function reconcilePendingPayments(): Promise<{
  scanned: number;
  reconciledSuccess: number;
  reconciledFailed: number;
  stillPending: number;
  errors: number;
}> {
  const result = {
    scanned: 0,
    reconciledSuccess: 0,
    reconciledFailed: 0,
    stillPending: 0,
    errors: 0,
  };

  if (!PAYSTACK_SECRET_KEY || PAYSTACK_SECRET_KEY.includes("mockkey")) {
    console.log("[Reconciliation] Skipped: Paystack secret key not configured or in mock mode.");
    return result;
  }

  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // Scan pending payments created between 15 minutes and 48 hours ago
    const pendingList = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.status, "pending"),
          lt(payments.initializedAt, fifteenMinutesAgo),
          gt(payments.initializedAt, fortyEightHoursAgo)
        )
      )
      .limit(50);

    result.scanned = pendingList.length;

    for (const item of pendingList) {
      try {
        const verifyRes = await axios.get(
          `https://api.paystack.co/transaction/verify/${item.reference}`,
          {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
            timeout: 5000,
          }
        );

        const data = verifyRes.data?.data;
        if (data?.status === "success") {
          console.log(`[Reconciliation] Recovered successful payment: ${item.reference}`);
          await db
            .update(payments)
            .set({
              status: "success",
              paystackTransactionId: String(data.id),
              verifiedAt: new Date(),
              paidAt: new Date(data.paid_at || Date.now()),
              reconciledAt: new Date(),
              reconciliationNotes: "Recovered via automated reconciliation worker",
              metadata: data,
              updatedAt: new Date(),
            })
            .where(eq(payments.id, item.id));

          // Fulfil underlying obligation
          if (item.category === "workshop") {
            await db
              .update(workshopPayments)
              .set({ status: "success", paystackTransactionId: String(data.id), updatedAt: new Date() })
              .where(eq(workshopPayments.reference, item.reference));

            await db
              .update(workshopRegistrations)
              .set({ status: "paid", paymentStatus: "success", updatedAt: new Date() })
              .where(eq(workshopRegistrations.id, item.businessEntityId));
          } else if (item.category === "cooperative_registration_fee") {
            await db
              .update(cooperativePayments)
              .set({ status: "success", updatedAt: new Date() })
              .where(eq(cooperativePayments.reference, item.reference));

            await db
              .update(cooperativeMembers)
              .set({ registrationFeePaid: "YES", updatedAt: new Date() })
              .where(eq(cooperativeMembers.id, item.businessEntityId));
          }

          result.reconciledSuccess++;
        } else if (data?.status === "failed" || data?.status === "abandoned") {
          await db
            .update(payments)
            .set({
              status: data.status,
              reconciledAt: new Date(),
              reconciliationNotes: `Reconciled as ${data.status} by provider query`,
              updatedAt: new Date(),
            })
            .where(eq(payments.id, item.id));
          result.reconciledFailed++;
        } else {
          result.stillPending++;
        }
      } catch (itemErr) {
        result.errors++;
      }
    }
  } catch (scanErr) {
    console.error("[Reconciliation Engine Error]:", scanErr);
  }

  return result;
}

// ─────────────────────────────────────────────
// 3. ADMIN ENDPOINTS FOR PAYMENT REGISTRY & AUDIT
// ─────────────────────────────────────────────

const requireAdmin = (req: Request, res: Response, next: any) => {
  const role = req.headers["x-user-role"] as string;
  if (role !== "admin" && role !== "sub_admin") {
    return res.status(403).json({ error: "Forbidden — Administrator access required" });
  }
  next();
};

// GET /api/payments/admin/registry — Paginated master payment ledger
router.get("/admin/registry", requireAdmin, async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  const offset = (page - 1) * limit;
  const category = req.query.category as string;
  const status = req.query.status as string;
  const search = req.query.search as string;

  try {
    const conditions: any[] = [];

    if (category && category !== "all") {
      conditions.push(eq(payments.category, category));
    }
    if (status && status !== "all") {
      conditions.push(eq(payments.status, status));
    }
    if (search) {
      conditions.push(
        or(
          sql`LOWER(${payments.reference}) LIKE ${"%" + search.toLowerCase() + "%"}`,
          sql`LOWER(${payments.customerEmail}) LIKE ${"%" + search.toLowerCase() + "%"}`,
          sql`LOWER(${payments.businessEntityId}) LIKE ${"%" + search.toLowerCase() + "%"}`
        )
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalCountRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(payments)
      .where(whereClause);

    const total = Number(totalCountRow?.count || 0);

    const items = await db
      .select()
      .from(payments)
      .where(whereClause)
      .orderBy(desc(payments.initializedAt))
      .limit(limit)
      .offset(offset);

    return res.json({
      data: items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    console.error("[Payments Admin Registry Error]:", err);
    return res.status(500).json({ error: "Failed to fetch payments registry" });
  }
});

// GET /api/payments/admin/alerts — Items flagged for duplicate charges or refund review
router.get("/admin/alerts", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const alerts = await db
      .select()
      .from(payments)
      .where(
        or(
          eq(payments.status, "duplicate_paid_review"),
          sql`${payments.metadata}->>'duplicateChargeDetected' = 'true'`
        )
      )
      .orderBy(desc(payments.updatedAt))
      .limit(50);

    return res.json({ alerts, count: alerts.length });
  } catch (err: any) {
    console.error("[Payments Admin Alerts Error]:", err);
    return res.status(500).json({ error: "Failed to fetch payment alerts" });
  }
});

// POST /api/payments/admin/reconcile — On-demand reconciliation trigger
router.post("/admin/reconcile", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await reconcilePendingPayments();
    return res.json({
      message: "Reconciliation cycle completed successfully",
      stats: result,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Payments Admin Reconcile Error]:", err);
    return res.status(500).json({ error: "Failed to execute reconciliation batch" });
  }
});

export default router;
