import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
  jsonb,
  date,
} from "drizzle-orm/pg-core";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const lessonTypeEnum = pgEnum("lesson_type", ["video", "document"]);
export const sessionTypeEnum = pgEnum("session_type", ["online", "physical"]);

// ─── Weeks ────────────────────────────────────────────────────────────────────

export const weeks = pgTable("weeks", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  weekNumber: integer("week_number").notNull(),
  requiresQuizPass: boolean("requires_quiz_pass").notNull().default(true),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Lessons ──────────────────────────────────────────────────────────────────

export const lessons = pgTable("lessons", {
  id: uuid("id").primaryKey().defaultRandom(),
  weekId: uuid("week_id")
    .notNull()
    .references(() => weeks.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  type: lessonTypeEnum("type").notNull().default("video"),
  videoUrl: text("video_url"),
  documentUrl: text("document_url"),
  body: text("body"),
  durationMinutes: integer("duration_minutes"),
  order: integer("order").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Progress ─────────────────────────────────────────────────────────────────

export const progress = pgTable("progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  lessonId: uuid("lesson_id")
    .notNull()
    .references(() => lessons.id, { onDelete: "cascade" }),
  weekId: uuid("week_id")
    .notNull()
    .references(() => weeks.id, { onDelete: "cascade" }),
  cohortId: uuid("cohort_id").notNull(),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Quizzes ──────────────────────────────────────────────────────────────────

export const quizzes = pgTable("quizzes", {
  id: uuid("id").primaryKey().defaultRandom(),
  weekId: uuid("week_id")
    .notNull()
    .references(() => weeks.id, { onDelete: "cascade" }),
  cohortId: uuid("cohort_id").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  // questions stored as JSON array:
  // [{ id, question, options: [string], correctIndex: number }]
  questions: jsonb("questions").notNull().default([]),
  passingScore: integer("passing_score").notNull().default(70),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Quiz Attempts ────────────────────────────────────────────────────────────

export const quizAttempts = pgTable("quiz_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  quizId: uuid("quiz_id")
    .notNull()
    .references(() => quizzes.id, { onDelete: "cascade" }),
  weekId: uuid("week_id")
    .notNull()
    .references(() => weeks.id, { onDelete: "cascade" }),
  cohortId: uuid("cohort_id").notNull(),
  // answers stored as JSON: { [questionId]: selectedIndex }
  answers: jsonb("answers").notNull().default({}),
  score: integer("score").notNull().default(0),
  passed: boolean("passed").notNull().default(false),
  attemptedAt: timestamp("attempted_at").notNull().defaultNow(),
});

// ─── Week 12 Codes ────────────────────────────────────────────────────────────

export const week12Codes = pgTable("week12_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").notNull(),
  day: integer("day").notNull(), // 1 = Monday, 2 = Tuesday ... 5 = Friday
  code: varchar("code", { length: 20 }).notNull().unique(),
  validDate: date("valid_date").notNull(),
  createdBy: uuid("created_by").notNull(), // admin userId
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Week 12 Check-ins ────────────────────────────────────────────────────────

export const week12Checkins = pgTable("week12_checkins", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  cohortId: uuid("cohort_id").notNull(),
  codeId: uuid("code_id")
    .notNull()
    .references(() => week12Codes.id, { onDelete: "cascade" }),
  day: integer("day").notNull(), // 1–5
  checkedInAt: timestamp("checked_in_at").notNull().defaultNow(),
});

// ─── Physical Sessions ────────────────────────────────────────────────────────

export const physicalSessions = pgTable("physical_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").notNull(),
  weekId: uuid("week_id").references(() => weeks.id, { onDelete: "set null" }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  type: sessionTypeEnum("type").notNull().default("physical"),
  location: text("location"),
  scheduledAt: timestamp("scheduled_at"),
  durationMinutes: integer("duration_minutes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessionGroups = pgTable("session_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => physicalSessions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  assignedAt: timestamp("assigned_at").notNull().defaultNow(),
});