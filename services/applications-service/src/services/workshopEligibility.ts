import { eq, and, sql, or } from "drizzle-orm";
import { db } from "../index";
import {
  workshops,
  applications,
  cooperativeMembers,
} from "../db/schema";

export interface EligibilityFee {
  currency: string;
  amountKobo: number;
  display: string;
}

export interface EligibilityDecision {
  eligible: boolean;
  eligibilitySource: "APPROVED_TRAINEE" | "ACTIVE_COOPERATIVE_MEMBER" | "BOTH" | "NONE";
  eligibilityRecordId: string | null;
  amountKobo: number;
  currency: string;
  displayFee: string;
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
   * A participant qualifies for the ₦5,000 fee if either condition is satisfied:
   * 1. The participant has a trainee application in the existing database whose status represents an explicitly approved or accepted application (status = 'approved' AND is_deleted = false).
   * 2. The participant has an active and verified EEWYLA cooperative membership record in the existing database (status = 'active' AND registration_fee_paid = 'YES').
   *
   * Otherwise, the participant pays the standard workshop fee of ₦70,000.
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

    // 3. Query Authoritative Cooperative Members
    // Condition 2: Active & Verified Cooperative Member (status = 'active', registrationFeePaid = 'YES')
    const verifiedCoopMembers = await db
      .select({
        id: cooperativeMembers.id,
        fullName: cooperativeMembers.fullName,
        firstName: cooperativeMembers.firstName,
        lastName: cooperativeMembers.lastName,
        status: cooperativeMembers.status,
        registrationFeePaid: cooperativeMembers.registrationFeePaid,
      })
      .from(cooperativeMembers)
      .where(
        and(
          sql`LOWER(TRIM(${cooperativeMembers.email})) = ${normalizedEmail}`,
          eq(cooperativeMembers.status, "active"),
          sql`UPPER(TRIM(${cooperativeMembers.registrationFeePaid})) = 'YES'`
        )
      )
      .limit(1);

    const isActiveVerifiedCoopMember = verifiedCoopMembers.length > 0;
    const coopRecord = verifiedCoopMembers[0];

    // 4. Resolve Eligibility & Audit Sources
    let eligible = false;
    let eligibilitySource: "APPROVED_TRAINEE" | "ACTIVE_COOPERATIVE_MEMBER" | "BOTH" | "NONE" = "NONE";
    let eligibilityRecordId: string | null = null;
    let suggestedName: string | undefined;

    if (isApprovedTrainee && isActiveVerifiedCoopMember) {
      eligible = true;
      eligibilitySource = "BOTH";
      eligibilityRecordId = `app:${traineeRecord.id};coop:${coopRecord.id}`;
      suggestedName = `${traineeRecord.firstName} ${traineeRecord.lastName}`.trim() || coopRecord.fullName || undefined;
    } else if (isApprovedTrainee) {
      eligible = true;
      eligibilitySource = "APPROVED_TRAINEE";
      eligibilityRecordId = `app:${traineeRecord.id}`;
      suggestedName = `${traineeRecord.firstName} ${traineeRecord.lastName}`.trim();
    } else if (isActiveVerifiedCoopMember) {
      eligible = true;
      eligibilitySource = "ACTIVE_COOPERATIVE_MEMBER";
      eligibilityRecordId = `coop:${coopRecord.id}`;
      suggestedName = coopRecord.fullName || `${coopRecord.firstName ?? ""} ${coopRecord.lastName ?? ""}`.trim() || undefined;
    } else {
      eligible = false;
      eligibilitySource = "NONE";
      eligibilityRecordId = null;

      // Check if they have an unapproved trainee application or unpaid coop membership to populate suggested name
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
    const displayFee = eligible ? "₦5,000" : "₦70,000";

    return {
      eligible,
      eligibilitySource,
      eligibilityRecordId,
      amountKobo,
      currency: workshop.currency,
      displayFee,
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
