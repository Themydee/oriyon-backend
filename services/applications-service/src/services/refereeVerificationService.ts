import crypto from "crypto";
import { eq, and, sql, or, desc, lte } from "drizzle-orm";
import { db } from "../index";
import {
  applications,
  applicationReferees,
  refereeVerificationAuditLogs,
  refereeScheduledJobs,
} from "../db/schema";
import {
  normalizeNigerianPhone,
  arePhoneNumbersEqual,
  isValidNigerianPhone,
  maskPhoneNumber,
} from "../utils/phone";
import {
  getMessagingProvider,
  templates,
  RELATIONSHIP_OPTIONS_MAP,
  InboundMessage,
  DeliveryReceipt,
} from "../messaging";

export interface CreateRefereeInput {
  fullName: string;
  phone: string;
  email?: string;
  relationship?: string;
}

export interface MicroFormSubmission {
  refereeName?: string;
  fullName?: string;
  relationship?: string;
  duration?: string;
  durationOfRelationship?: string;
  vouchCommitment?: boolean;
  vouchesCommitment?: boolean;
  applicantInterest?: string;
  farmingInterestDescription?: string;
}

export class RefereeVerificationService {
  private frontendUrl: string;

  constructor() {
    this.frontendUrl = process.env.FRONTEND_URL || "https://oriyoninternational.com";
  }

  // ─────────────────────────────────────────────
  // 1. FRAUD-DETERRENT GATES
  // ─────────────────────────────────────────────

  /**
   * Evaluates Gate 1 and Gate 2 against candidate phone numbers
   */
  async validateFraudGates(
    applicantPhone: string,
    referee1Phone: string,
    referee2Phone: string,
    cohortId?: string | null
  ): Promise<{ valid: boolean; error?: string; code?: string }> {
    // ── GATE 1: Phone number format & applicant-referee match ──
    const normApplicant = normalizeNigerianPhone(applicantPhone);
    const normRef1 = normalizeNigerianPhone(referee1Phone);
    const normRef2 = normalizeNigerianPhone(referee2Phone);

    if (!normApplicant) {
      return { valid: false, error: "Applicant phone number is invalid.", code: "GATE1_INVALID_APPLICANT_PHONE" };
    }
    if (!normRef1) {
      return { valid: false, error: "Referee 1 phone number is invalid. Please provide a valid Nigerian mobile number.", code: "GATE1_INVALID_REF1_PHONE" };
    }
    if (!normRef2) {
      return { valid: false, error: "Referee 2 phone number is invalid. Please provide a valid Nigerian mobile number.", code: "GATE1_INVALID_REF2_PHONE" };
    }

    if (arePhoneNumbersEqual(normApplicant, normRef1)) {
      return {
        valid: false,
        error: "Fraud Gate 1 Violation: Referee 1's phone number cannot match the applicant's phone number.",
        code: "GATE1_APPLICANT_MATCH_REF1",
      };
    }

    if (arePhoneNumbersEqual(normApplicant, normRef2)) {
      return {
        valid: false,
        error: "Fraud Gate 1 Violation: Referee 2's phone number cannot match the applicant's phone number.",
        code: "GATE1_APPLICANT_MATCH_REF2",
      };
    }

    if (arePhoneNumbersEqual(normRef1, normRef2)) {
      return {
        valid: false,
        error: "Referees must be two distinct individuals. Referee 1 and Referee 2 cannot share the same phone number.",
        code: "GATE1_DUPLICATE_REFEREES",
      };
    }

    // ── GATE 2: Duplicate referee number within the cohort ──
    // Count use of normalised referee number across applications in this cohort intake.
    // If count >= 2, adding another will exceed the maximum threshold of 2.
    const checkDuplicateInCohort = async (refPhone: string, label: string) => {
      const conditions = [
        eq(applicationReferees.normalizedPhone, refPhone),
        // Exclude declined or replaced referees if applicable
      ];

      if (cohortId) {
        conditions.push(eq(applications.cohortId, cohortId));
      } else {
        conditions.push(sql`${applications.cohortId} IS NULL`);
      }

      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(applicationReferees)
        .innerJoin(applications, eq(applicationReferees.applicationId, applications.id))
        .where(and(...conditions));

      const existingCount = Number(rows[0]?.count || 0);
      if (existingCount >= 2) {
        return {
          valid: false,
          error: `Fraud Gate 2 Violation: ${label}'s phone number (${maskPhoneNumber(refPhone)}) has reached the maximum permitted nominations (2) in this cohort intake. Please provide an alternative referee.`,
          code: "GATE2_COHORT_LIMIT_EXCEEDED",
        };
      }
      return { valid: true };
    };

    const g2Ref1 = await checkDuplicateInCohort(normRef1, "Referee 1");
    if (!g2Ref1.valid) return g2Ref1;

    const g2Ref2 = await checkDuplicateInCohort(normRef2, "Referee 2");
    if (!g2Ref2.valid) return g2Ref2;

    return { valid: true };
  }

  // ─────────────────────────────────────────────
  // 2. INITIATE VERIFICATION WORKFLOW
  // ─────────────────────────────────────────────

  async initiateRefereeVerification(
    applicationId: string,
    applicantName: string,
    referee1: CreateRefereeInput,
    referee2: CreateRefereeInput
  ): Promise<{ success: boolean; referees: any[] }> {
    const messaging = getMessagingProvider();

    // 1. Create Referee 1
    const normRef1 = normalizeNigerianPhone(referee1.phone)!;
    const token1 = crypto.randomBytes(24).toString("hex");
    const tokenHash1 = crypto.createHash("sha256").update(token1).digest("hex");
    const expiresAt1 = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    const [ref1Record] = await db
      .insert(applicationReferees)
      .values({
        applicationId,
        refereeIndex: 1,
        fullName: referee1.fullName.trim(),
        phone: referee1.phone.trim(),
        normalizedPhone: normRef1,
        email: referee1.email?.trim() || null,
        relationship: referee1.relationship?.trim() || null,
        status: "REF-PENDING",
        channel: "whatsapp",
        deliveryStatus: "pending",
        verificationToken: token1,
        tokenHash: tokenHash1,
        tokenExpiresAt: expiresAt1,
        initialMessageSentAt: new Date(),
      })
      .returning();

    // 2. Create Referee 2
    const normRef2 = normalizeNigerianPhone(referee2.phone)!;
    const token2 = crypto.randomBytes(24).toString("hex");
    const tokenHash2 = crypto.createHash("sha256").update(token2).digest("hex");
    const expiresAt2 = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    const [ref2Record] = await db
      .insert(applicationReferees)
      .values({
        applicationId,
        refereeIndex: 2,
        fullName: referee2.fullName.trim(),
        phone: referee2.phone.trim(),
        normalizedPhone: normRef2,
        email: referee2.email?.trim() || null,
        relationship: referee2.relationship?.trim() || null,
        status: "REF-PENDING",
        channel: "whatsapp",
        deliveryStatus: "pending",
        verificationToken: token2,
        tokenHash: tokenHash2,
        tokenExpiresAt: expiresAt2,
        initialMessageSentAt: new Date(),
      })
      .returning();

    // 3. Log Audit Events
    await this.logAudit({
      applicationId,
      refereeId: ref1Record.id,
      eventType: "GATE_CHECK_PASSED",
      newStatus: "REF-PENDING",
      reason: "Gates 1 & 2 passed successfully.",
      actor: "system",
    });
    await this.logAudit({
      applicationId,
      refereeId: ref2Record.id,
      eventType: "GATE_CHECK_PASSED",
      newStatus: "REF-PENDING",
      reason: "Gates 1 & 2 passed successfully.",
      actor: "system",
    });

    // 4. Send MSG-01 to both referees simultaneously via WhatsApp
    const sendMsg01 = async (refRecord: typeof ref1Record) => {
      const msgText = templates.msg01(refRecord.fullName, applicantName);
      const res = await messaging.send({
        to: refRecord.normalizedPhone,
        message: msgText,
        templateId: "MSG-01",
        channel: "whatsapp",
        applicationId,
        refereeId: refRecord.id,
      });

      await this.logAudit({
        applicationId,
        refereeId: refRecord.id,
        eventType: "MSG_SENT",
        newStatus: "REF-PENDING",
        reason: `Initial ping (MSG-01) dispatched via WhatsApp (${res.success ? "success" : "provider error: " + res.error})`,
        metadata: { messageId: res.messageId, provider: res.provider, channel: "whatsapp" },
        actor: "system",
      });

      // Schedule 10-Minute WhatsApp -> SMS Fallback Check
      const fallbackTime = new Date(Date.now() + 10 * 60 * 1000);
      await db.insert(refereeScheduledJobs).values({
        applicationId,
        refereeId: refRecord.id,
        jobType: "WHATSAPP_SMS_FALLBACK_CHECK",
        scheduledFor: fallbackTime,
        payload: { applicantName, messageId: res.messageId },
      });

      // Schedule 48-Hour Micro-Form Escalation Check
      const escalateTime = new Date(Date.now() + 48 * 60 * 60 * 1000);
      await db.insert(refereeScheduledJobs).values({
        applicationId,
        refereeId: refRecord.id,
        jobType: "ESCALATE_MICRO_FORM",
        scheduledFor: escalateTime,
        payload: { applicantName },
      });
    };

    await Promise.allSettled([sendMsg01(ref1Record), sendMsg01(ref2Record)]);

    // Update application referee status
    await db
      .update(applications)
      .set({
        refereeVerificationStatus: "in_progress",
        updatedAt: new Date(),
      })
      .where(eq(applications.id, applicationId));

    return { success: true, referees: [ref1Record, ref2Record] };
  }

  // ─────────────────────────────────────────────
  // 3. INBOUND MESSAGE PROCESSING
  // ─────────────────────────────────────────────

  async handleInboundMessage(inbound: InboundMessage): Promise<{ handled: boolean; action?: string; error?: string }> {
    const senderPhone = inbound.from || (inbound as any).fromPhone || "";
    const normFrom = normalizeNigerianPhone(senderPhone);
    if (!normFrom) {
      return { handled: false, error: "Unrecognized sender phone number format" };
    }

    // Locate active referee record
    const [referee] = await db
      .select()
      .from(applicationReferees)
      .where(
        and(
          eq(applicationReferees.normalizedPhone, normFrom),
          or(
            eq(applicationReferees.status, "REF-PENDING"),
            eq(applicationReferees.status, "REF-FLAGGED"),
            sql`${applicationReferees.relationshipCategory} IS NULL`
          )
        )
      )
      .orderBy(desc(applicationReferees.createdAt))
      .limit(1);

    if (!referee) {
      console.warn(`[RefereeVerification] Inbound message from ${maskPhoneNumber(normFrom)} with no active referee record.`);
      return { handled: false, action: "NO_ACTIVE_REFEREE_FOUND" };
    }

    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, referee.applicationId))
      .limit(1);

    const applicantName = app ? `${app.firstName} ${app.lastName}` : "the applicant";
    const rawText = (inbound.text || (inbound as any).messageText || "").trim();
    const cleanUpper = rawText.toUpperCase();
    const messaging = getMessagingProvider();

    // ── CASE A: STOP / OPT-OUT ──
    if (cleanUpper === "STOP" || cleanUpper === "OPT OUT" || cleanUpper === "UNSUBSCRIBE") {
      await db
        .update(applicationReferees)
        .set({
          isOptedOut: true,
          optedOutAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(applicationReferees.id, referee.id));

      await this.logAudit({
        applicationId: referee.applicationId,
        refereeId: referee.id,
        eventType: "STOP_OPT_OUT",
        reason: "Referee opted out via STOP command. Prohibited from sending further messages.",
        actor: "referee",
      });

      return { handled: true, action: "OPT_OUT_RECORDED" };
    }

    if (referee.isOptedOut) {
      console.warn(`[RefereeVerification] Message ignored from opted-out referee ${maskPhoneNumber(normFrom)}`);
      return { handled: true, action: "IGNORED_OPTED_OUT" };
    }

    // ── CASE B: Rapid-Response Reconfirmation (MSG-07 reply) ──
    if (referee.reconfirmationStatus === "sent") {
      if (cleanUpper === "YES" || cleanUpper === "Y" || cleanUpper.startsWith("YES")) {
        await db
          .update(applicationReferees)
          .set({
            status: "REF-VERIFIED",
            rapidResponseFlagged: false,
            reconfirmationStatus: "confirmed",
            updatedAt: new Date(),
          })
          .where(eq(applicationReferees.id, referee.id));

        await this.logAudit({
          applicationId: referee.applicationId,
          refereeId: referee.id,
          eventType: "RECONFIRMATION_YES",
          previousStatus: "REF-FLAGGED",
          newStatus: "REF-VERIFIED",
          reason: "Referee confirmed endorsement via MSG-07. Rapid-response flag cleared.",
          actor: "referee",
        });

        await this.evaluateApplicationEligibility(referee.applicationId);
        return { handled: true, action: "RECONFIRMATION_CONFIRMED" };
      } else if (cleanUpper === "NO" || cleanUpper === "N" || cleanUpper.startsWith("NO")) {
        const replacementDeadline = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
        await db
          .update(applicationReferees)
          .set({
            status: "REF-DECLINED",
            reconfirmationStatus: "withdrawn",
            replacementWindowExpiresAt: replacementDeadline,
            updatedAt: new Date(),
          })
          .where(eq(applicationReferees.id, referee.id));

        await this.logAudit({
          applicationId: referee.applicationId,
          refereeId: referee.id,
          eventType: "RECONFIRMATION_NO",
          previousStatus: "REF-FLAGGED",
          newStatus: "REF-DECLINED",
          reason: "Referee withdrew endorsement upon MSG-07 reconfirmation.",
          actor: "referee",
        });

        // Notify applicant (MSG-05)
        await this.notifyApplicantRefereeDeclined(referee, applicantName);
        return { handled: true, action: "RECONFIRMATION_WITHDRAWN" };
      }
    }

    // ── CASE C: Relationship Category Reply (MSG-02 reply: 1 - 5) ──
    const digitMatch = rawText.match(/^[1-5]$/);
    if (digitMatch) {
      const selectedOption = digitMatch[0];
      const categoryName = RELATIONSHIP_OPTIONS_MAP[selectedOption] || "Other";

      const newStatus = referee.rapidResponseFlagged ? "REF-FLAGGED" : "REF-VERIFIED";

      await db
        .update(applicationReferees)
        .set({
          status: newStatus,
          relationshipCategory: categoryName,
          relationshipRespondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(applicationReferees.id, referee.id));

      await this.logAudit({
        applicationId: referee.applicationId,
        refereeId: referee.id,
        eventType: "STATUS_CHANGED",
        previousStatus: referee.status,
        newStatus,
        reason: `Referee selected relationship category: ${categoryName} (${selectedOption})`,
        metadata: { category: categoryName, option: selectedOption },
        actor: "referee",
      });

      if (newStatus === "REF-VERIFIED") {
        await this.evaluateApplicationEligibility(referee.applicationId);
      }

      return { handled: true, action: "RELATIONSHIP_CATEGORY_SAVED" };
    }

    // ── CASE D: Initial Ping Reply (MSG-01 reply: YES or NO) ──
    if (cleanUpper === "YES" || cleanUpper === "Y" || cleanUpper.startsWith("YES")) {
      const now = inbound.timestamp ? new Date(inbound.timestamp) : ((inbound as any).receivedAt ? new Date((inbound as any).receivedAt) : new Date());
      const firstResponseAt = now;

      // Gate 3: Check Rapid-Response Anomaly (< 90 seconds)
      const baseTime = referee.deliveryTimestamp || referee.initialMessageSentAt || now;
      const durationSeconds = Math.max(0, Math.floor((now.getTime() - baseTime.getTime()) / 1000));
      const isRapid = durationSeconds < 90;

      const initialStatus = isRapid ? "REF-FLAGGED" : "REF-PENDING";

      await db
        .update(applicationReferees)
        .set({
          status: initialStatus,
          firstResponseAt,
          responseDurationSeconds: durationSeconds,
          rapidResponseFlagged: isRapid,
          reconfirmationStatus: isRapid ? "pending" : null,
          updatedAt: new Date(),
        })
        .where(eq(applicationReferees.id, referee.id));

      await this.logAudit({
        applicationId: referee.applicationId,
        refereeId: referee.id,
        eventType: isRapid ? "RAPID_RESPONSE_FLAGGED" : "INBOUND_REPLY",
        previousStatus: "REF-PENDING",
        newStatus: initialStatus,
        reason: isRapid
          ? `Affirmative YES received within ${durationSeconds}s (< 90s). Flagged for 24h reconfirmation.`
          : `Affirmative YES received in ${durationSeconds}s.`,
        metadata: { durationSeconds, isRapid },
        actor: "referee",
      });

      // If rapid-response flagged: schedule MSG-07 Reconfirmation for 24 hours later
      if (isRapid) {
        const reconfirmTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await db.insert(refereeScheduledJobs).values({
          applicationId: referee.applicationId,
          refereeId: referee.id,
          jobType: "RAPID_RESPONSE_RECONFIRMATION",
          scheduledFor: reconfirmTime,
          payload: { applicantName },
        });
      }

      // Send MSG-02 (Relationship category)
      const msg02Text = templates.msg02(applicantName);
      await messaging.send({
        to: referee.normalizedPhone,
        message: msg02Text,
        templateId: "MSG-02",
        channel: (referee.channel as any) || "whatsapp",
        applicationId: referee.applicationId,
        refereeId: referee.id,
      });

      // Schedule 24h relationship timeout: if no category reply in 24h, mark verified with "Not Provided"
      const timeoutTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.insert(refereeScheduledJobs).values({
        applicationId: referee.applicationId,
        refereeId: referee.id,
        jobType: "RELATIONSHIP_TIMEOUT",
        scheduledFor: timeoutTime,
        payload: { applicantName },
      });

      return { handled: true, action: "AFFIRMATIVE_RESPONSE_PROCESSED" };
    }

    if (cleanUpper === "NO" || cleanUpper === "N" || cleanUpper.startsWith("NO")) {
      const replacementDeadline = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      await db
        .update(applicationReferees)
        .set({
          status: "REF-DECLINED",
          replacementWindowExpiresAt: replacementDeadline,
          updatedAt: new Date(),
        })
        .where(eq(applicationReferees.id, referee.id));

      await this.logAudit({
        applicationId: referee.applicationId,
        refereeId: referee.id,
        eventType: "INBOUND_REPLY",
        previousStatus: referee.status,
        newStatus: "REF-DECLINED",
        reason: "Referee replied NO (declined to vouch).",
        actor: "referee",
      });

      // Notify applicant (MSG-05)
      await this.notifyApplicantRefereeDeclined(referee, applicantName);
      return { handled: true, action: "DECLINE_RECORDED" };
    }

    // ── CASE E: Invalid/Unrecognized reply ──
    // If referee previously replied YES and hasn't selected relationship, send one-time clarification
    if (referee.firstResponseAt && !referee.relationshipCategory && !referee.clarificationSent) {
      const clarifyText = templates.msg02Clarification(applicantName);
      await messaging.send({
        to: referee.normalizedPhone,
        message: clarifyText,
        templateId: "CLARIFY",
        channel: (referee.channel as any) || "whatsapp",
        applicationId: referee.applicationId,
        refereeId: referee.id,
      });

      await db
        .update(applicationReferees)
        .set({ clarificationSent: true, updatedAt: new Date() })
        .where(eq(applicationReferees.id, referee.id));

      await this.logAudit({
        applicationId: referee.applicationId,
        refereeId: referee.id,
        eventType: "INBOUND_REPLY",
        reason: `Invalid numeric reply received ("${rawText.substring(0, 30)}"). One-time clarification dispatched.`,
        actor: "referee",
      });

      return { handled: true, action: "CLARIFICATION_DISPATCHED" };
    }

    return { handled: false, action: "UNRECOGNIZED_REPLY_IGNORED" };
  }

  // ─────────────────────────────────────────────
  // 4. DELIVERY STATUS CALLBACK
  // ─────────────────────────────────────────────

  async handleDeliveryReceipt(receipt: DeliveryReceipt): Promise<void> {
    const normTo = normalizeNigerianPhone(receipt.to);
    if (!normTo) return;

    const [referee] = await db
      .select()
      .from(applicationReferees)
      .where(eq(applicationReferees.normalizedPhone, normTo))
      .orderBy(desc(applicationReferees.createdAt))
      .limit(1);

    if (!referee) return;

    await db
      .update(applicationReferees)
      .set({
        deliveryStatus: receipt.status,
        deliveryTimestamp: receipt.status === "delivered" ? receipt.timestamp : referee.deliveryTimestamp,
        updatedAt: new Date(),
      })
      .where(eq(applicationReferees.id, referee.id));

    await this.logAudit({
      applicationId: referee.applicationId,
      refereeId: referee.id,
      eventType: receipt.status === "delivered" ? "MSG_DELIVERED" : "MSG_FAILED",
      reason: `Message delivery status updated to: ${receipt.status}`,
      metadata: { messageId: receipt.messageId, status: receipt.status },
      actor: "system",
    });

    // If WhatsApp delivery failed immediately, trigger instant SMS fallback
    if (receipt.status === "failed" && referee.channel === "whatsapp") {
      await this.triggerSmsFallback(referee.id);
    }
  }

  // ─────────────────────────────────────────────
  // 5. SMS FALLBACK
  // ─────────────────────────────────────────────

  async triggerSmsFallback(refereeId: string): Promise<boolean> {
    const [referee] = await db
      .select()
      .from(applicationReferees)
      .where(eq(applicationReferees.id, refereeId))
      .limit(1);

    if (!referee || referee.channel === "sms" || referee.status === "REF-VERIFIED" || referee.isOptedOut) {
      return false;
    }

    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, referee.applicationId))
      .limit(1);

    const applicantName = app ? `${app.firstName} ${app.lastName}` : "the applicant";
    const msgText = templates.msg01(referee.fullName, applicantName);
    const messaging = getMessagingProvider();

    const res = await messaging.send({
      to: referee.normalizedPhone,
      message: msgText,
      templateId: "MSG-01",
      channel: "sms",
      applicationId: referee.applicationId,
      refereeId: referee.id,
    });

    await db
      .update(applicationReferees)
      .set({
        channel: "sms",
        deliveryStatus: "pending",
        updatedAt: new Date(),
      })
      .where(eq(applicationReferees.id, referee.id));

    await this.logAudit({
      applicationId: referee.applicationId,
      refereeId: referee.id,
      eventType: "MSG_FALLBACK_SMS",
      reason: "WhatsApp delivery not verified within threshold. Initiated SMS fallback.",
      metadata: { messageId: res.messageId },
      actor: "system",
    });

    return true;
  }

  // ─────────────────────────────────────────────
  // 6. MICRO-FORM RETRIEVAL & SUBMISSION
  // ─────────────────────────────────────────────

  async getMicroForm(token: string): Promise<{ valid: boolean; data?: any; error?: string; status?: number }> {
    if (!token || token.length < 16) {
      return { valid: false, error: "Invalid verification token format.", status: 400 };
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const [referee] = await db
      .select()
      .from(applicationReferees)
      .where(or(eq(applicationReferees.verificationToken, token), eq(applicationReferees.tokenHash, tokenHash)))
      .limit(1);

    if (!referee) {
      return { valid: false, error: "Verification link not found or invalid.", status: 404 };
    }

    if (referee.tokenExpiresAt && referee.tokenExpiresAt < new Date()) {
      return { valid: false, error: "This referee verification link has expired (72-hour window elapsed).", status: 410 };
    }

    if (referee.formSubmittedAt || referee.status === "REF-VERIFIED" || referee.status === "REF-DECLINED") {
      return { valid: false, error: "This reference verification form has already been completed.", status: 410 };
    }

    const [app] = await db
      .select({ firstName: applications.firstName, lastName: applications.lastName })
      .from(applications)
      .where(eq(applications.id, referee.applicationId))
      .limit(1);

    const applicantFirst = app?.firstName || "Applicant";
    const applicantLastInitial = app?.lastName ? `${app.lastName.charAt(0)}.` : "";

    const microData = {
      refereeName: referee.fullName,
      applicantName: `${applicantFirst} ${applicantLastInitial}`.trim(),
      programme: "EEWYLA (Economic Empowerment of Women & Youth in Livestock Agribusiness)",
      expiresAt: referee.tokenExpiresAt,
    };
    return {
      valid: true,
      ...microData,
      data: microData,
    };
  }

  async submitMicroForm(token: string, payload: MicroFormSubmission): Promise<{ success: boolean; message: string; error?: string; status?: number; refereeStatus?: string }> {
    const formCheck = await this.getMicroForm(token);
    if (!formCheck.valid) {
      return { success: false, message: formCheck.error!, error: formCheck.error, status: formCheck.status };
    }

    // Validation
    const cleanName = (payload.fullName || payload.refereeName || "").trim();
    if (cleanName.length < 3) {
      return { success: false, message: "Referee's full name must be at least 3 characters.", status: 400 };
    }

    const cleanInterest = (payload.farmingInterestDescription || payload.applicantInterest || "").trim();
    if (cleanInterest.length < 20) {
      return {
        success: false,
        message: "Description of applicant's interest in farming or business must be at least 20 characters.",
        status: 400,
      };
    }

    const duration = payload.durationOfRelationship || payload.duration || "1–3 years";
    const relationship = payload.relationship || "Religious Leader";
    const vouched = payload.vouchesCommitment !== undefined ? Boolean(payload.vouchesCommitment) : Boolean(payload.vouchCommitment);
    const newStatus = vouched ? "REF-VERIFIED" : "REF-DECLINED";

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const [referee] = await db
      .select()
      .from(applicationReferees)
      .where(or(eq(applicationReferees.verificationToken, token), eq(applicationReferees.tokenHash, tokenHash)))
      .limit(1);

    if (!referee) {
      return { success: false, message: "Referee record not found.", status: 404 };
    }

    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, referee.applicationId))
      .limit(1);
    const applicantName = app ? `${app.firstName} ${app.lastName}` : "the applicant";

    await db
      .update(applicationReferees)
      .set({
        fullName: cleanName,
        status: newStatus,
        relationshipCategory: relationship,
        formRelationshipDuration: duration,
        formVouchCommitment: vouched,
        formApplicantInterest: cleanInterest,
        formSubmittedAt: new Date(),
        verificationToken: null, // invalidate token on submission
        tokenHash: null,
        updatedAt: new Date(),
      })
      .where(eq(applicationReferees.id, referee.id));

    await this.logAudit({
      applicationId: referee.applicationId,
      refereeId: referee.id,
      eventType: "MICROFORM_SUBMITTED",
      previousStatus: referee.status,
      newStatus,
      reason: vouched
        ? "Referee completed micro-form and confirmed commitment."
        : "Referee completed micro-form but declined commitment.",
      metadata: { relationship: payload.relationship, duration: payload.duration, vouched },
      actor: "referee",
    });

    if (vouched) {
      await this.evaluateApplicationEligibility(referee.applicationId);
      return {
        success: true,
        status: 200,
        refereeStatus: newStatus,
        message: "Thank you! Your reference verification has been successfully submitted and confirmed.",
      };
    } else {
      // Notify applicant (MSG-05)
      await this.notifyApplicantRefereeDeclined(referee, applicantName);
      return {
        success: true,
        status: 200,
        refereeStatus: newStatus,
        message: "Thank you for your response. Your feedback has been recorded.",
      };
    }
  }

  // ─────────────────────────────────────────────
  // 7. APPLICANT NOTIFICATIONS & REPLACEMENT
  // ─────────────────────────────────────────────

  async notifyApplicantRefereeDeclined(referee: typeof applicationReferees.$inferSelect, applicantName: string) {
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, referee.applicationId))
      .limit(1);

    if (!app) return;

    const updateUrl = `${this.frontendUrl}/applications/${app.id}/update-referee?ref=${referee.id}`;
    const msgText = templates.msg05(app.firstName, referee.fullName, updateUrl);
    const messaging = getMessagingProvider();

    await messaging.send({
      to: app.phone,
      message: msgText,
      templateId: "MSG-05",
      channel: "sms",
      applicationId: app.id,
    });

    await this.logAudit({
      applicationId: app.id,
      refereeId: referee.id,
      eventType: "APPLICANT_NOTIFIED",
      reason: "Applicant notified that referee declined endorsement (5-day replacement window initiated).",
      metadata: { templateId: "MSG-05" },
      actor: "system",
    });

    // Schedule 5-Day Applicant Replacement Deadline Check
    const deadlineTime = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await db.insert(refereeScheduledJobs).values({
      applicationId: app.id,
      refereeId: referee.id,
      jobType: "APPLICANT_REPLACEMENT_DEADLINE_CHECK",
      scheduledFor: deadlineTime,
      payload: { applicantName },
    });
  }

  async replaceReferee(
    applicationId: string,
    oldRefereeId: string,
    newReferee: CreateRefereeInput
  ): Promise<{ success: boolean; referee?: any; error?: string; status?: number }> {
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);

    if (!app) {
      return { success: false, error: "Application not found.", status: 404 };
    }

    const [oldReferee] = await db
      .select()
      .from(applicationReferees)
      .where(
        and(
          eq(applicationReferees.id, oldRefereeId),
          eq(applicationReferees.applicationId, applicationId)
        )
      )
      .limit(1);

    if (!oldReferee) {
      return { success: false, error: "Referee record not found.", status: 404 };
    }

    // Verify replacement window (5 days)
    if (oldReferee.replacementWindowExpiresAt && oldReferee.replacementWindowExpiresAt < new Date()) {
      return {
        success: false,
        error: "The 5-day window to update this referee has expired. Application is deferred.",
        status: 400,
      };
    }

    // Check sibling referee to enforce Gate 1
    const [siblingReferee] = await db
      .select()
      .from(applicationReferees)
      .where(
        and(
          eq(applicationReferees.applicationId, applicationId),
          sql`${applicationReferees.id} != ${oldReferee.id}`,
          sql`${applicationReferees.status} != 'REF-DEFERRED'`
        )
      )
      .limit(1);

    const normNew = normalizeNigerianPhone(newReferee.phone);
    if (!normNew) {
      return { success: false, error: "Please provide a valid Nigerian phone number for the replacement referee.", status: 400 };
    }

    // Gate 1 check: new referee cannot match applicant or sibling referee
    if (arePhoneNumbersEqual(app.phone, normNew)) {
      return { success: false, error: "Fraud Gate 1: Replacement referee's phone cannot match applicant's phone.", status: 400 };
    }
    if (siblingReferee && arePhoneNumbersEqual(siblingReferee.normalizedPhone, normNew)) {
      return { success: false, error: "Fraud Gate 1: Replacement referee's phone cannot match your other listed referee.", status: 400 };
    }

    // Gate 2 check: cohort duplicates
    const gateCheck = await this.validateFraudGates(app.phone, normNew, siblingReferee?.normalizedPhone || "08000000000", app.cohortId);
    if (!gateCheck.valid && gateCheck.code?.startsWith("GATE2")) {
      return { success: false, error: gateCheck.error!, status: 400 };
    }

    // Insert new replacement referee
    const [newRecord] = await db
      .insert(applicationReferees)
      .values({
        applicationId,
        refereeIndex: oldReferee.refereeIndex,
        fullName: newReferee.fullName.trim(),
        phone: newReferee.phone.trim(),
        normalizedPhone: normNew,
        email: newReferee.email?.trim() || null,
        relationship: newReferee.relationship?.trim() || null,
        status: "REF-PENDING",
        channel: "whatsapp",
        deliveryStatus: "pending",
        initialMessageSentAt: new Date(),
      })
      .returning();

    // Mark old referee replaced
    await db
      .update(applicationReferees)
      .set({
        replacedByRefereeId: newRecord.id,
        updatedAt: new Date(),
      })
      .where(eq(applicationReferees.id, oldReferee.id));

    await this.logAudit({
      applicationId,
      refereeId: newRecord.id,
      eventType: "REFEREE_REPLACED",
      newStatus: "REF-PENDING",
      reason: `Referee ${oldReferee.fullName} replaced with ${newRecord.fullName}`,
      metadata: { oldRefereeId: oldReferee.id, newRefereeId: newRecord.id },
      actor: "applicant",
    });

    // Send MSG-01 to new referee
    const applicantFullName = `${app.firstName} ${app.lastName}`;
    const msgText = templates.msg01(newRecord.fullName, applicantFullName);
    const messaging = getMessagingProvider();

    await messaging.send({
      to: newRecord.normalizedPhone,
      message: msgText,
      templateId: "MSG-01",
      channel: "whatsapp",
      applicationId,
      refereeId: newRecord.id,
    });

    // Schedule 10m fallback and 48h escalation for new referee
    await db.insert(refereeScheduledJobs).values({
      applicationId,
      refereeId: newRecord.id,
      jobType: "WHATSAPP_SMS_FALLBACK_CHECK",
      scheduledFor: new Date(Date.now() + 10 * 60 * 1000),
      payload: { applicantName: applicantFullName },
    });
    await db.insert(refereeScheduledJobs).values({
      applicationId,
      refereeId: newRecord.id,
      jobType: "ESCALATE_MICRO_FORM",
      scheduledFor: new Date(Date.now() + 48 * 60 * 60 * 1000),
      payload: { applicantName: applicantFullName },
    });

    return { success: true, referee: newRecord };
  }

  // ─────────────────────────────────────────────
  // 8. ELIGIBILITY EVALUATION & APPLICATION COMPLETION
  // ─────────────────────────────────────────────

  /**
   * Section 7: "Only one successfully verified referee is required for the application to enter the review queue."
   * Trigger MSG-06 only once when first verified.
   */
  async evaluateApplicationEligibility(applicationId: string): Promise<boolean> {
    const referees = await db
      .select()
      .from(applicationReferees)
      .where(eq(applicationReferees.applicationId, applicationId));

    const hasVerified = referees.some((r) => r.status === "REF-VERIFIED");
    if (!hasVerified) return false;

    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);

    if (!app) return false;

    // If already marked eligible, no duplicate MSG-06
    if (app.isEligibleForReview && app.refereeVerificationStatus === "verified") {
      return true;
    }

    await db
      .update(applications)
      .set({
        refereeVerificationStatus: "REF-VERIFIED",
        refereeVerifiedAt: new Date(),
        isEligibleForReview: true,
        updatedAt: new Date(),
      })
      .where(eq(applications.id, applicationId));

    await this.logAudit({
      applicationId,
      eventType: "STATUS_CHANGED",
      previousStatus: app.refereeVerificationStatus,
      newStatus: "verified",
      reason: "Application has met referee verification requirement (at least 1 verified referee). Enters review queue.",
      actor: "system",
    });

    // Dispatch MSG-06: Verification complete to applicant
    const msg06Text = templates.msg06(app.firstName);
    const messaging = getMessagingProvider();

    await messaging.send({
      to: app.phone,
      message: msg06Text,
      templateId: "MSG-06",
      channel: "sms",
      applicationId,
    });

    await this.logAudit({
      applicationId,
      eventType: "APPLICANT_NOTIFIED",
      reason: "Applicant notified of successful referee verification (MSG-06).",
      metadata: { templateId: "MSG-06" },
      actor: "system",
    });

    return true;
  }

  // ─────────────────────────────────────────────
  // 9. SCHEDULED JOBS PROCESSOR (DURABLE ENGINE)
  // ─────────────────────────────────────────────

  async processScheduledJobs(): Promise<{ processed: number; errors: number }> {
    const now = new Date();
    const pendingJobs = await db
      .select()
      .from(refereeScheduledJobs)
      .where(
        and(
          eq(refereeScheduledJobs.status, "pending"),
          lte(refereeScheduledJobs.scheduledFor, now)
        )
      )
      .orderBy(refereeScheduledJobs.scheduledFor)
      .limit(50);

    let processed = 0;
    let errors = 0;

    for (const job of pendingJobs) {
      try {
        await db
          .update(refereeScheduledJobs)
          .set({ status: "processing", updatedAt: new Date() })
          .where(eq(refereeScheduledJobs.id, job.id));

        const [referee] = job.refereeId
          ? await db
              .select()
              .from(applicationReferees)
              .where(eq(applicationReferees.id, job.refereeId))
              .limit(1)
          : [null];

        const [app] = await db
          .select()
          .from(applications)
          .where(eq(applications.id, job.applicationId))
          .limit(1);

        const applicantName = app ? `${app.firstName} ${app.lastName}` : "the applicant";

        // 1. WhatsApp -> SMS Fallback
        if (job.jobType === "WHATSAPP_SMS_FALLBACK_CHECK") {
          if (referee && referee.channel === "whatsapp" && referee.deliveryStatus !== "delivered" && referee.status === "REF-PENDING") {
            await this.triggerSmsFallback(referee.id);
          }
        }

        // 2. Escalate Micro-Form (48h no response)
        else if (job.jobType === "ESCALATE_MICRO_FORM") {
          if (referee && referee.status === "REF-PENDING" && !referee.isOptedOut && !referee.firstResponseAt) {
            const token = crypto.randomBytes(24).toString("hex");
            const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
            const formUrl = `${this.frontendUrl}/referee-form/${token}`;
            const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

            await db
              .update(applicationReferees)
              .set({
                verificationToken: token,
                tokenHash,
                tokenExpiresAt: expiresAt,
                updatedAt: new Date(),
              })
              .where(eq(applicationReferees.id, referee.id));

            const msg03Text = templates.msg03(referee.fullName, applicantName, formUrl);
            const messaging = getMessagingProvider();

            await messaging.send({
              to: referee.normalizedPhone,
              message: msg03Text,
              templateId: "MSG-03",
              channel: (referee.channel as any) || "sms",
              applicationId: referee.applicationId,
              refereeId: referee.id,
            });

            await this.logAudit({
              applicationId: referee.applicationId,
              refereeId: referee.id,
              eventType: "MICROFORM_GENERATED",
              reason: "No response within 48h. Micro-form link generated and dispatched (MSG-03).",
              metadata: { expiresAt },
              actor: "system",
            });

            // Schedule Form Expiry Check (72 hours later)
            await db.insert(refereeScheduledJobs).values({
              applicationId: referee.applicationId,
              refereeId: referee.id,
              jobType: "FORM_EXPIRY_CHECK",
              scheduledFor: expiresAt,
              payload: { applicantName },
            });
          }
        }

        // 3. Relationship Timeout (24h no reply to 1-5)
        else if (job.jobType === "RELATIONSHIP_TIMEOUT") {
          if (referee && !referee.relationshipCategory && referee.firstResponseAt) {
            const newStatus = referee.rapidResponseFlagged ? "REF-FLAGGED" : "REF-VERIFIED";
            await db
              .update(applicationReferees)
              .set({
                relationshipCategory: "Not Provided",
                relationshipRespondedAt: new Date(),
                status: newStatus,
                updatedAt: new Date(),
              })
              .where(eq(applicationReferees.id, referee.id));

            await this.logAudit({
              applicationId: referee.applicationId,
              refereeId: referee.id,
              eventType: "STATUS_CHANGED",
              previousStatus: referee.status,
              newStatus,
              reason: "24h elapsed without relationship category. Auto-assigned 'Not Provided' and marked verified.",
              actor: "system",
            });

            if (newStatus === "REF-VERIFIED") {
              await this.evaluateApplicationEligibility(referee.applicationId);
            }
          }
        }

        // 4. Form Expiry Check (72h no submission)
        else if (job.jobType === "FORM_EXPIRY_CHECK") {
          if (referee && referee.status === "REF-PENDING" && !referee.formSubmittedAt) {
            const replacementDeadline = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
            await db
              .update(applicationReferees)
              .set({
                status: "REF-UNRESPONSIVE",
                verificationToken: null,
                replacementWindowExpiresAt: replacementDeadline,
                updatedAt: new Date(),
              })
              .where(eq(applicationReferees.id, referee.id));

            await this.logAudit({
              applicationId: referee.applicationId,
              refereeId: referee.id,
              eventType: "STATUS_CHANGED",
              previousStatus: "REF-PENDING",
              newStatus: "REF-UNRESPONSIVE",
              reason: "72h micro-form window expired without submission. Marked REF-UNRESPONSIVE.",
              actor: "system",
            });

            // Dispatch MSG-04 to applicant
            if (app) {
              const updateUrl = `${this.frontendUrl}/applications/${app.id}/update-referee?ref=${referee.id}`;
              const msg04Text = templates.msg04(app.firstName, referee.fullName, referee.phone, updateUrl);
              const messaging = getMessagingProvider();

              await messaging.send({
                to: app.phone,
                message: msg04Text,
                templateId: "MSG-04",
                channel: "sms",
                applicationId: app.id,
              });

              await this.logAudit({
                applicationId: app.id,
                refereeId: referee.id,
                eventType: "APPLICANT_NOTIFIED",
                reason: "Applicant notified of unresponsive referee (MSG-04 with 5-day replacement window).",
                metadata: { templateId: "MSG-04" },
                actor: "system",
              });

              // Schedule 5-day deadline check
              await db.insert(refereeScheduledJobs).values({
                applicationId: app.id,
                refereeId: referee.id,
                jobType: "APPLICANT_REPLACEMENT_DEADLINE_CHECK",
                scheduledFor: replacementDeadline,
                payload: { applicantName },
              });
            }
          }
        }

        // 5. Rapid Response Reconfirmation (24h later)
        else if (job.jobType === "RAPID_RESPONSE_RECONFIRMATION") {
          if (referee && referee.rapidResponseFlagged && referee.status === "REF-FLAGGED") {
            const msg07Text = templates.msg07(referee.fullName, applicantName);
            const messaging = getMessagingProvider();

            await messaging.send({
              to: referee.normalizedPhone,
              message: msg07Text,
              templateId: "MSG-07",
              channel: (referee.channel as any) || "whatsapp",
              applicationId: referee.applicationId,
              refereeId: referee.id,
            });

            await db
              .update(applicationReferees)
              .set({
                reconfirmationStatus: "sent",
                reconfirmationSentAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(applicationReferees.id, referee.id));

            await this.logAudit({
              applicationId: referee.applicationId,
              refereeId: referee.id,
              eventType: "RECONFIRMATION_SENT",
              reason: "24h rapid-response reconfirmation message dispatched (MSG-07).",
              actor: "system",
            });

            // Schedule 48h reconfirmation timeout
            const timeoutTime = new Date(Date.now() + 48 * 60 * 60 * 1000);
            await db.insert(refereeScheduledJobs).values({
              applicationId: referee.applicationId,
              refereeId: referee.id,
              jobType: "RECONFIRMATION_TIMEOUT_CHECK",
              scheduledFor: timeoutTime,
              payload: { applicantName },
            });
          }
        }

        // 6. Reconfirmation Timeout Check (48h after MSG-07)
        else if (job.jobType === "RECONFIRMATION_TIMEOUT_CHECK") {
          if (referee && referee.reconfirmationStatus === "sent") {
            // Retain soft flag without changing verified status
            await db
              .update(applicationReferees)
              .set({
                reconfirmationStatus: "timeout",
                updatedAt: new Date(),
              })
              .where(eq(applicationReferees.id, referee.id));

            await this.logAudit({
              applicationId: referee.applicationId,
              refereeId: referee.id,
              eventType: "STATUS_CHANGED",
              reason: "48h elapsed without MSG-07 reply. Soft flag retained; verified status unchanged per specification.",
              actor: "system",
            });
          }
        }

        // 7. Applicant Replacement Deadline Check (5 days)
        else if (job.jobType === "APPLICANT_REPLACEMENT_DEADLINE_CHECK") {
          if (referee && (referee.status === "REF-UNRESPONSIVE" || referee.status === "REF-DECLINED") && !referee.replacedByRefereeId) {
            // Check if other referee is verified
            const otherReferees = await db
              .select()
              .from(applicationReferees)
              .where(
                and(
                  eq(applicationReferees.applicationId, job.applicationId),
                  sql`${applicationReferees.id} != ${referee.id}`
                )
              );

            const hasOtherVerified = otherReferees.some((r) => r.status === "REF-VERIFIED");
            if (!hasOtherVerified) {
              await db
                .update(applications)
                .set({
                  refereeVerificationStatus: "deferred",
                  updatedAt: new Date(),
                })
                .where(eq(applications.id, job.applicationId));

              await this.logAudit({
                applicationId: job.applicationId,
                eventType: "STATUS_CHANGED",
                previousStatus: app?.refereeVerificationStatus || "in_progress",
                newStatus: "REF-DEFERRED",
                reason: "5-day replacement deadline expired without valid referee. Application moved to REF-DEFERRED.",
                actor: "system",
              });
            }
          }
        }

        await db
          .update(refereeScheduledJobs)
          .set({ status: "completed", processedAt: new Date(), updatedAt: new Date() })
          .where(eq(refereeScheduledJobs.id, job.id));

        processed++;
      } catch (jobErr: any) {
        console.error(`[RefereeJob Error] job ${job.id} (${job.jobType}):`, jobErr);
        await db
          .update(refereeScheduledJobs)
          .set({
            status: "failed",
            attempts: job.attempts + 1,
            lastError: jobErr?.message || "Job execution error",
            updatedAt: new Date(),
          })
          .where(eq(refereeScheduledJobs.id, job.id));
        errors++;
      }
    }

    return { processed, errors };
  }

  // ─────────────────────────────────────────────
  // 10. AUDIT LOGGING HELPER
  // ─────────────────────────────────────────────

  async logAudit(entry: {
    applicationId: string;
    refereeId?: string | null;
    eventType: string;
    previousStatus?: string | null;
    newStatus?: string | null;
    reason?: string | null;
    metadata?: Record<string, any>;
    actor?: string;
  }): Promise<void> {
    try {
      await db.insert(refereeVerificationAuditLogs).values({
        applicationId: entry.applicationId,
        refereeId: entry.refereeId || null,
        eventType: entry.eventType,
        previousStatus: entry.previousStatus || null,
        newStatus: entry.newStatus || null,
        reason: entry.reason || null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
        actor: entry.actor || "system",
      });
    } catch (err) {
      console.error("[RefereeAuditLog Error]:", err);
    }
  }

  // ─────────────────────────────────────────────
  // 11. DETAILS FOR ADMIN & APPLICANT
  // ─────────────────────────────────────────────

  async getApplicationRefereeDetails(applicationId: string) {
    const [app] = await db
      .select({
        id: applications.id,
        firstName: applications.firstName,
        lastName: applications.lastName,
        email: applications.email,
        phone: applications.phone,
        status: applications.status,
        refereeVerificationStatus: applications.refereeVerificationStatus,
        refereeVerifiedAt: applications.refereeVerifiedAt,
        isEligibleForReview: applications.isEligibleForReview,
        refereeDeclarationConfirmed: applications.refereeDeclarationConfirmed,
        refereeDeclarationTimestamp: applications.refereeDeclarationTimestamp,
      })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);

    if (!app) return null;

    const referees = await db
      .select()
      .from(applicationReferees)
      .where(eq(applicationReferees.applicationId, applicationId))
      .orderBy(applicationReferees.refereeIndex);

    const auditLogs = await db
      .select()
      .from(refereeVerificationAuditLogs)
      .where(eq(refereeVerificationAuditLogs.applicationId, applicationId))
      .orderBy(desc(refereeVerificationAuditLogs.timestamp));

    return {
      application: app,
      referees: referees.map((r) => ({
        ...r,
        phoneMasked: maskPhoneNumber(r.normalizedPhone),
        token: r.verificationToken,
      })),
      auditLogs,
    };
  }
}

export const refereeVerificationService = new RefereeVerificationService();
