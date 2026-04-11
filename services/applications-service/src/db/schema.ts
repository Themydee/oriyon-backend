import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";

export const applicationStatusEnum = pgEnum("application_status", [
  "pending",
  "shortlisted",
  "approved",
  "rejected",
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
  devices: text("devices"),               // stored as JSON string array
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
  biggestChallenge: text("biggest_challenge"),  // stored as JSON string array
  whyJoin: text("why_join"),
  hopesToAchieve: text("hopes_to_achieve"),
  willingTraceability: varchar("willing_traceability", { length: 10 }),
  hasAccess: text("has_access"),               // stored as JSON string array
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
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});