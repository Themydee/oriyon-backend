import { pgTable, uuid, varchar, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const applicationStatusEnum = pgEnum("application_status", [
  "pending",
  "shortlisted",
  "approved",
  "rejected",
]);

export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 20 }).notNull(),
  state: varchar("state", { length: 100 }),
  gender: varchar("gender", { length: 20 }),
  ageRange: varchar("age_range", { length: 20 }),
  occupation: varchar("occupation", { length: 100 }),
  livestockExperience: text("livestock_experience"),
  motivation: text("motivation"),
  status: applicationStatusEnum("status").notNull().default("pending"),
  cohortId: uuid("cohort_id"),          // set when approved
  reviewedBy: uuid("reviewed_by"),      // admin userId
  reviewNotes: text("review_notes"),
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
