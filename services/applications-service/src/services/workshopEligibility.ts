import { eq, and, sql, or } from "drizzle-orm";
import { db } from "../index";
import {
  workshops,
  applications,
  cooperativeMembers,
  cooperatives,
} from "../db/schema";

export type MemberCategory = "VERIFIED_MEMBER" | "UNVERIFIED_MEMBER" | "NON_MEMBER";

export interface EligibilityFee {
  currency: string;
  amountKobo: number;
  display: string;
}

export interface EligibilityDecision {
  eligible: boolean;
  memberStatus: MemberCategory;
  eligibilitySource: "APPROVED_TRAINEE" | "ACTIVE_COOPERATIVE_MEMBER" | "UNVERIFIED_COOPERATIVE_MEMBER" | "BOTH" | "NONE";
  eligibilityRecordId: string | null;
  amountKobo: number;
  currency: string;
  displayFee: string;
  cooperativeDetails?: {
    cooperativeName?: string;
    lga?: string;
    registrationFeePaid?: string;
    status?: string;
  };
  adminContactMessage?: string;
  suggestedName?: string;
  checkedAt: Date;
  workshop: {
    id: string;
    slug: string;
    title: string;
    memberPrice: number;
    standardPrice: number;
    status: string;
    registrationAvailability: boolean;
  };
}

export class WorkshopEligibilityService {
  /**
   * Determine eligibility authoritatively from existing Oriyon applications and cooperative records.
   *
   * Business Rules:
   * 1. VERIFIED_MEMBER:
   *    - The participant has an active and verified EEWYLA cooperative membership record (status = 'active' AND registration_fee_paid = 'YES')
   *      OR has an approved trainee application (status = 'approved' AND is_deleted = false).
   *    - Fee: FREE (0 kobo / ₦0). Free Pass granted directly.
   *
   * 2. UNVERIFIED_MEMBER:
   *    - The participant is registered in cooperative_members, but registration_fee_paid != 'YES' (paid manually / offline or pending).
   *    - Free pass is NOT issued. Acknowledged as a cooperative member and instructed to contact the administrator
   *      (eewyla@oriyoninternational.com) to verify their status.
   *
   * 3. NON_MEMBER:
   *    - The participant is not found in the cooperative database or approved applications.
   *    - Fee: Standard workshop fee (₦35,000 / 3,500,000 kobo).
   */
  static async determineEligibility(
    email: string,
    workshopSlug = "eewyla-goat-training"
  ): Promise<EligibilityDecision> {
    const normalizedEmail = String(email ?? "").trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      throw new Error("A valid email address is required for eligibility check.");
    }

    // 1. Fetch workshop configuration
    const [workshop] = await db
      .select()
      .from(workshops)
      .where(eq(workshops.slug, workshopSlug))
      .limit(1);

    if (!workshop) {
      throw new Error(`Workshop with slug "${workshopSlug}" was not found.`);
    }

    const checkedAt = new Date();

    // 2. Query Authoritative Trainee Applications
    // Condition 1: Approved trainee (status = 'approved', isDeleted = false)
    const approvedApps = await db
      .select({
        id: applications.id,
        firstName: applications.firstName,
        lastName: applications.lastName,
        status: applications.status,
      })
      .from(applications)
      .where(
        and(
          sql`LOWER(TRIM(${applications.email})) = ${normalizedEmail}`,
          eq(applications.status, "approved"),
          eq(applications.isDeleted, false)
        )
      )
      .limit(1);

    const isApprovedTrainee = approvedApps.length > 0;
    const traineeRecord = approvedApps[0];

    // 3. Query Authoritative Cooperative Members (with joined cooperative info)
    const coopMemberRecords = await db
      .select({
        id: cooperativeMembers.id,
        fullName: cooperativeMembers.fullName,
        firstName: cooperativeMembers.firstName,
        lastName: cooperativeMembers.lastName,
        status: cooperativeMembers.status,
        registrationFeePaid: cooperativeMembers.registrationFeePaid,
        lga: cooperativeMembers.lga,
        cooperativeId: cooperativeMembers.cooperativeId,
        cooperativeName: cooperatives.name,
      })
      .from(cooperativeMembers)
      .leftJoin(cooperatives, eq(cooperativeMembers.cooperativeId, cooperatives.id))
      .where(sql`LOWER(TRIM(${cooperativeMembers.email})) = ${normalizedEmail}`)
      .limit(1);

    const coopRecord = coopMemberRecords[0];
    const hasCoopRecord = Boolean(coopRecord);
    const isCoopFeePaid = coopRecord && String(coopRecord.registrationFeePaid || "").trim().toUpperCase() === "YES";
    const isActiveCoopMember = coopRecord && coopRecord.status === "active" && isCoopFeePaid;

    // 4. Resolve 3-Tier Eligibility & Audit Sources
    let eligible = false;
    let memberStatus: MemberCategory = "NON_MEMBER";
    let eligibilitySource: "APPROVED_TRAINEE" | "ACTIVE_COOPERATIVE_MEMBER" | "UNVERIFIED_COOPERATIVE_MEMBER" | "BOTH" | "NONE" = "NONE";
    let eligibilityRecordId: string | null = null;
    let suggestedName: string | undefined;
    let cooperativeDetails: EligibilityDecision["cooperativeDetails"] = undefined;
    let adminContactMessage: string | undefined = undefined;

    if (hasCoopRecord && !isCoopFeePaid) {
      // 1. Cooperative member whose membership fee or status has NOT been verified yet.
      // MUST NOT be given a free pass under any circumstances until verified by an administrator!
      eligible = false;
      memberStatus = "UNVERIFIED_MEMBER";
      eligibilitySource = "UNVERIFIED_COOPERATIVE_MEMBER";
      eligibilityRecordId = `coop:${coopRecord.id}`;
      suggestedName = coopRecord.fullName || `${coopRecord.firstName ?? ""} ${coopRecord.lastName ?? ""}`.trim() || undefined;
      cooperativeDetails = {
        cooperativeName: coopRecord.cooperativeName || coopRecord.lga || "EEWYLA Cooperative",
        lga: coopRecord.lga || undefined,
        registrationFeePaid: coopRecord.registrationFeePaid || "NO",
        status: coopRecord.status,
      };
      const benefitLabel = workshop.memberPrice === 0 ? "unlock your Free Pass" : `unlock your subsidized member fee (₦${(workshop.memberPrice / 100).toLocaleString()})`;
      adminContactMessage = `You are registered as a member of ${cooperativeDetails.cooperativeName}, but your membership status has not yet been verified by the administrator. Please contact your administrator or coordinator at eewyla@oriyoninternational.com to verify your status to ${benefitLabel}.`;
    } else if (isActiveCoopMember) {
      // 2. Active, verified cooperative member
      eligible = true;
      memberStatus = "VERIFIED_MEMBER";
      eligibilitySource = isApprovedTrainee ? "BOTH" : "ACTIVE_COOPERATIVE_MEMBER";
      eligibilityRecordId = isApprovedTrainee ? `app:${traineeRecord.id};coop:${coopRecord.id}` : `coop:${coopRecord.id}`;
      suggestedName = coopRecord.fullName || `${coopRecord.firstName ?? ""} ${coopRecord.lastName ?? ""}`.trim() || (isApprovedTrainee ? `${traineeRecord.firstName} ${traineeRecord.lastName}`.trim() : undefined);
      cooperativeDetails = {
        cooperativeName: coopRecord.cooperativeName || coopRecord.lga || "EEWYLA Cooperative",
        lga: coopRecord.lga || undefined,
        registrationFeePaid: coopRecord.registrationFeePaid || "YES",
        status: coopRecord.status,
      };
    } else if (isApprovedTrainee) {
      // 3. Approved trainee application
      eligible = true;
      memberStatus = "VERIFIED_MEMBER";
      eligibilitySource = "APPROVED_TRAINEE";
      eligibilityRecordId = `app:${traineeRecord.id}`;
      suggestedName = `${traineeRecord.firstName} ${traineeRecord.lastName}`.trim();
    } else {
      eligible = false;
      memberStatus = "NON_MEMBER";
      eligibilitySource = "NONE";
      eligibilityRecordId = null;

      // Check if they have an unapproved trainee application to populate suggested name
      const [anyApp] = await db
        .select({ firstName: applications.firstName, lastName: applications.lastName })
        .from(applications)
        .where(
          and(
            sql`LOWER(TRIM(${applications.email})) = ${normalizedEmail}`,
            eq(applications.isDeleted, false)
          )
        )
        .limit(1);

      if (anyApp) {
        suggestedName = `${anyApp.firstName} ${anyApp.lastName}`.trim();
      }
    }

    const amountKobo = eligible ? workshop.memberPrice : workshop.standardPrice;
    const displayFee = amountKobo === 0 ? "FREE" : `₦${(amountKobo / 100).toLocaleString()}`;

    return {
      eligible,
      memberStatus,
      eligibilitySource,
      eligibilityRecordId,
      amountKobo,
      currency: workshop.currency,
      displayFee,
      cooperativeDetails,
      adminContactMessage,
      suggestedName,
      checkedAt,
      workshop: {
        id: workshop.id,
        slug: workshop.slug,
        title: workshop.title,
        memberPrice: workshop.memberPrice,
        standardPrice: workshop.standardPrice,
        status: workshop.status,
        registrationAvailability: workshop.registrationAvailability,
      },
    };
  }
}
