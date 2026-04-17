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
// ─── Enums (add to existing enums section) ───────────────────────────────────
export const questionTypeEnum = pgEnum("question_type", ["mcq", "short_answer","essay",]);

export const examSessionStatusEnum = pgEnum("exam_session_status", ["in_progress",
  "submitted",
  "auto_submitted",
  "timed_out",
]);

export const violationTypeEnum = pgEnum("violation_type", [
  "tab_switch",
  "fullscreen_exit",
  "devtools",
  "copy_paste",
]);

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


// ─── Exams ────────────────────────────────────────────────────────────────────
export const exams = pgTable("exams", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").notNull(),
  weekId: uuid("week_id").references(() => weeks.id, { onDelete: "set null" }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  totalMarks: integer("total_marks").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Exam Questions ───────────────────────────────────────────────────────────
export const examQuestions = pgTable("exam_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  examId: uuid("exam_id")
    .notNull()
    .references(() => exams.id, { onDelete: "cascade" }),
  type: questionTypeEnum("type").notNull(),
  questionText: text("question_text").notNull(),
  // For MCQ only: ["Option A", "Option B", "Option C", "Option D"]
  options: jsonb("options").$type<string[]>(),
  // For MCQ only: index of correct option (0-based)
  correctOptionIndex: integer("correct_option_index"),
  marks: integer("marks").notNull().default(1),
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Exam Sessions ────────────────────────────────────────────────────────────
export const examSessions = pgTable("exam_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  examId: uuid("exam_id")
    .notNull()
    .references(() => exams.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  // Set at session creation: startedAt + durationMinutes
  deadlineAt: timestamp("deadline_at").notNull(),
  submittedAt: timestamp("submitted_at"),
  status: examSessionStatusEnum("status").notNull().default("in_progress"),
  violationCount: integer("violation_count").notNull().default(0),
  // Auto-calculated on submit from MCQ answers only
  mcqScore: integer("mcq_score"),
  // Final score — null until all short/essay answers are marked
  score: integer("score"),
  isFullyMarked: boolean("is_fully_marked").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Exam Answers ─────────────────────────────────────────────────────────────
export const examAnswers = pgTable("exam_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => examSessions.id, { onDelete: "cascade" }),
  questionId: uuid("question_id")
    .notNull()
    .references(() => examQuestions.id, { onDelete: "cascade" }),
  // For MCQ: the selected option index as a string e.g. "2"
  // For short/essay: the typed answer text
  answerText: text("answer_text"),
  // MCQ only — set on submit, null for short/essay until marked
  isCorrect: boolean("is_correct"),
  // Set immediately for MCQ on submit, null for short/essay until admin marks
  marksAwarded: integer("marks_awarded"),
  markedBy: uuid("marked_by"),
  markedAt: timestamp("marked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Exam Violations ──────────────────────────────────────────────────────────
export const examViolations = pgTable("exam_violations", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => examSessions.id, { onDelete: "cascade" }),
  type: violationTypeEnum("type").notNull(),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
});