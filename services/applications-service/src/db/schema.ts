  import {
    pgTable,
    uuid,
    varchar,
    text,
    timestamp,
    boolean,
    pgEnum,
  } from "drizzle-orm/pg-core";

  export const applicationStatusEnum = pgEnum("application_status", [
    "pending",
    "shortlisted",
    "approved",
    "rejection_review",
    "rejected",
    "archived",
  ]);

  export const applications = pgTable("applications", {
    id: uuid("id").primaryKey().defaultRandom(),

    // ── PERSONAL INFORMATION ──
    firstName: varchar("first_name", { length: 100 }).notNull(),
    lastName: varchar("last_name", { length: 100 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 20 }).notNull(),
    age: varchar("age", { length: 10 }),
    gender: varchar("gender", { length: 20 }),
    address: text("address"),
    hasID: varchar("has_id", { length: 10 }),
    businessName: varchar("business_name", { length: 150 }),
    isCoop: varchar("is_coop", { length: 10 }),
    isCommunityMember: varchar("is_community_member", { length: 10 }),
    joinCoop: varchar("join_coop", { length: 10 }),

    // ── EDUCATION ──
    educationLevel: varchar("education_level", { length: 50 }),
    fieldOfStudy: varchar("field_of_study", { length: 100 }),
    graduationYear: varchar("graduation_year", { length: 20 }),
    institution: varchar("institution", { length: 150 }),

    // ── EXPERIENCE ──
    hasGoatExperience: varchar("has_goat_experience", { length: 10 }),
    goatExperienceRating: varchar("goat_experience_rating", { length: 5 }),
    ownsGoatFarm: varchar("owns_goat_farm", { length: 10 }),
    yearsOperated: varchar("years_operated", { length: 20 }),
    highestAnimals: varchar("highest_animals", { length: 20 }),

    // ── DIGITAL LITERACY ──
    isDigitallyLiterate: varchar("is_digitally_literate", { length: 10 }),
    digitalLiteracyRating: varchar("digital_literacy_rating", { length: 5 }),
    internetUsage: text("internet_usage"),
  devices: text("devices"), // stors JSON string array
    onlineTraining: varchar("online_training", { length: 10 }),
    platformExperience: text("platform_experience"),
    toolConfidence: text("tool_confidence"),

    // ── HOUSEHOLD & FINANCIAL ──
    isBreadwinner: varchar("is_breadwinner", { length: 10 }),
    hasDependants: varchar("has_dependants", { length: 10 }),
    dependantsDetail: text("dependants_detail"),
    dependantsSchoolAge: varchar("dependants_school_age", { length: 10 }),
    hasDisabledInHousehold: varchar("has_disabled_in_household", { length: 10 }),
    disabledDetail: text("disabled_detail"),

    // ── MOTIVATION & COMMITMENT ──
    benefitedBefore: varchar("benefited_before", { length: 10 }),
    benefitedDetail: text("benefited_detail"),
    biggestChallenge: text("biggest_challenge"), // stored as JSON string array
    whyJoin: text("why_join"),
    hopesToAchieve: text("hopes_to_achieve"),
    willingTraceability: varchar("willing_traceability", { length: 10 }),
    hasAccess: text("has_access"), // stored as JSON string array
    willingChampion: varchar("willing_champion", { length: 10 }),
    willingDonate: varchar("willing_donate", { length: 10 }),
    committedFullTraining: varchar("committed_full_training", { length: 10 }),

    // ── REFERENCES & DECLARATION ──
    reference1: text("reference1"),
    reference2: text("reference2"),
    understandsCredit: boolean("understands_credit").default(false),
    declarationConfirmed: boolean("declaration_confirmed").default(false),

    // ── ADMIN ──
    status: applicationStatusEnum("status").notNull().default("pending"),

    cohortId: uuid("cohort_id"),

    reviewedBy: uuid("reviewed_by"),

    reviewNotes: text("review_notes"),

    rejectionReason: text("rejection_reason"),

    rejectedAt: timestamp("rejected_at"),

    archivedAt: timestamp("archived_at"),

    isDeleted: boolean("is_deleted").notNull().default(false),

    deletedAt: timestamp("deleted_at"),

    submittedAt: timestamp("submitted_at").notNull().defaultNow(),

    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  });


  export const cooperatives = pgTable("cooperatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  state: varchar("state", { length: 100 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const cooperativeStatusEnum = pgEnum("cooperative_status", [
  "active",
  "inactive",
]);

export const cooperativeMembers = pgTable("cooperative_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").references(() => applications.id),
  cooperativeId: uuid("cooperative_id").references(() => cooperatives.id),

  // Pre-filled from application — no re-entry needed (optional to support direct entries)
  firstName: varchar("first_name", { length: 100 }),
  lastName: varchar("last_name", { length: 100 }),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 20 }).notNull(),
  address: text("address"),

  // Cooperative-specific and spreadsheet fields
  memberId: varchar("member_id", { length: 50 }),
  fullName: varchar("full_name", { length: 255 }),
  gender: varchar("gender", { length: 20 }),
  dateOfBirth: varchar("date_of_birth", { length: 50 }),
  lga: varchar("lga", { length: 100 }),
  zoneCluster: varchar("zone_cluster", { length: 150 }),
  occupation: varchar("occupation", { length: 150 }),
  livestockType: text("livestock_type"), // goats, cattle, poultry etc.
  yearsOfExperience: varchar("years_of_experience", { length: 50 }),
  idType: varchar("id_type", { length: 100 }),
  idNumber: varchar("id_number", { length: 100 }),
  nextOfKinName: varchar("next_of_kin_name", { length: 150 }),
  nextOfKinPhone: varchar("next_of_kin_phone", { length: 50 }),
  registrationFeePaid: varchar("registration_fee_paid", { length: 10 }), // "YES" / "NO"
  monthlyContributionAmount: varchar("monthly_contribution_amount", { length: 50 }),
  attendanceCommitment: varchar("attendance_commitment", { length: 10 }), // "YES" / "NO"
  qualifiedForTraining: varchar("qualified_for_training", { length: 10 }), // "YES" / "NO"
  whatsappNumber: varchar("whatsapp_number", { length: 50 }),
  signature: text("signature"),
  remarks: text("remarks"),

  // Constitution agreement (Section 3 & 5)
  agreesToConstitution: boolean("agrees_to_constitution").notNull().default(false),
  willingToContribute: boolean("willing_to_contribute").notNull().default(false),

  status: cooperativeStatusEnum("status").notNull().default("active"),
  joinedAt: timestamp("joined_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});