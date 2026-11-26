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
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const lessonTypeEnum = pgEnum("lesson_type", ["video", "document"]);
export const sessionTypeEnum = pgEnum("session_type", ["online", "physical"]);
export const reportStatusEnum = pgEnum("report_status", ["draft", "submitted"]);
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
  curriculumRevisionId: uuid("curriculum_revision_id"),
  moduleId: uuid("module_id"),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  weekNumber: integer("week_number").notNull(),
  requiresQuizPass: boolean("requires_quiz_pass").notNull().default(true),
  isPublished: boolean("is_published").notNull().default(false),
  isArchived: boolean("is_archived").notNull().default(false),
  objectives: jsonb("objectives").$type<string[]>().notNull().default([]),
  unlockDate: timestamp("unlock_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Lessons ──────────────────────────────────────────────────────────────────

export const lessons = pgTable("lessons", {
  id: uuid("id").primaryKey().defaultRandom(),
  weekId: uuid("week_id")
    .notNull()
    .references(() => weeks.id, { onDelete: "cascade" }),
  curriculumRevisionId: uuid("curriculum_revision_id"),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  type: lessonTypeEnum("type").notNull().default("video"),
  videoUrl: text("video_url"),
  audioUrl: text("audio_url"),
  documentUrl: text("document_url"),
  body: text("body"),
  durationMinutes: integer("duration_minutes"),
  order: integer("order").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(false),
  isArchived: boolean("is_archived").notNull().default(false),
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
  curriculumRevisionId: uuid("curriculum_revision_id"),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  userLessonUnique: uniqueIndex("idx_progress_user_lesson").on(table.userId, table.lessonId),
}));

// ─── Quizzes ──────────────────────────────────────────────────────────────────

export const quizzes = pgTable("quizzes", {
  id: uuid("id").primaryKey().defaultRandom(),
  weekId: uuid("week_id")
    .notNull()
    .references(() => weeks.id, { onDelete: "cascade" }),
  cohortId: uuid("cohort_id").notNull(),
  curriculumRevisionId: uuid("curriculum_revision_id"),
  title: varchar("title", { length: 255 }).notNull(),
  // questions stored as JSON array:
  // [{ id, question, options: [string], correctIndex: number }]
  questions: jsonb("questions").notNull().default([]),
  passingScore: integer("passing_score").notNull().default(70),
  isPublished: boolean("is_published").notNull().default(false),
  isArchived: boolean("is_archived").notNull().default(false),
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
  curriculumRevisionId: uuid("curriculum_revision_id"),
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
  groupId: varchar("group_id", { length: 128 }),
  codeId: uuid("code_id")
    .references(() => week12Codes.id, { onDelete: "cascade" }),
  day: integer("day").notNull(), // 1–5
  verifiedBy: uuid("verified_by"),
  checkedInAt: timestamp("checked_in_at").notNull().defaultNow(),
}, (table) => ({
  cohortUserDayUnique: uniqueIndex("idx_week12_checkins_cohort_user_day").on(table.cohortId, table.userId, table.day),
}));

// ─── Practical Check-ins ──────────────────────────────────────────────────────

export const practicalCheckins = pgTable("practical_checkins", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  cohortId: uuid("cohort_id").notNull(),
  groupId: varchar("group_id", { length: 128 }),
  weekNumber: integer("week_number").notNull(),
  codeSubmitted: varchar("code_submitted", { length: 128 }).notNull(),
  verifiedBy: uuid("verified_by"),
  checkedInAt: timestamp("checked_in_at").notNull().defaultNow(),
});

// ─── Practical Codes ──────────────────────────────────────────────────────────

export const practicalCodes = pgTable("practical_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: varchar("user_id", { length: 128 }).notNull(),
  cohortId: varchar("cohort_id", { length: 128 }).notNull(),
  groupId: varchar("group_id", { length: 128 }),
  weekNumber: integer("week_number").notNull(),
  code: varchar("code", { length: 128 }).notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
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

// ─── Platform Video Tutorials ───────────────────────────────────────────────
export const platformTutorials = pgTable("platform_tutorials", {
  id: varchar("id", { length: 128 }).primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  category: varchar("category", { length: 64 }).notNull().default("Getting Started"),
  videoUrl: text("video_url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  duration: varchar("duration", { length: 32 }).default("3 min"),
  targetAudience: varchar("target_audience", { length: 64 }).notNull().default("All"),
  notes: jsonb("notes").$type<string[]>(),
  isFeatured: boolean("is_featured").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── LMS Community Q&A & Live Chat ──────────────────────────────────────────

export const communityQuestions = pgTable("community_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  authorId: uuid("author_id").notNull(),
  authorName: varchar("author_name", { length: 255 }).notNull(),
  authorRole: varchar("author_role", { length: 50 }).notNull().default("trainee"),
  authorAvatar: text("author_avatar"),
  channelId: varchar("channel_id", { length: 100 }).notNull().default("general"),
  channelName: varchar("channel_name", { length: 255 }).notNull().default("General Discussion"),
  tags: jsonb("tags").$type<string[]>().default([]),
  upvotes: integer("upvotes").notNull().default(0),
  upvotedBy: jsonb("upvoted_by").$type<string[]>().default([]),
  isSolved: boolean("is_solved").notNull().default(false),
  solvedAnswerId: uuid("solved_answer_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const communityAnswers = pgTable("community_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  questionId: uuid("question_id")
    .notNull()
    .references(() => communityQuestions.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  authorId: uuid("author_id").notNull(),
  authorName: varchar("author_name", { length: 255 }).notNull(),
  authorRole: varchar("author_role", { length: 50 }).notNull().default("trainee"),
  authorAvatar: text("author_avatar"),
  isVerified: boolean("is_verified").notNull().default(false),
  upvotes: integer("upvotes").notNull().default(0),
  upvotedBy: jsonb("upvoted_by").$type<string[]>().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const communityReplies = pgTable("community_replies", {
  id: uuid("id").primaryKey().defaultRandom(),
  answerId: uuid("answer_id")
    .notNull()
    .references(() => communityAnswers.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  authorId: uuid("author_id").notNull(),
  authorName: varchar("author_name", { length: 255 }).notNull(),
  authorRole: varchar("author_role", { length: 50 }).notNull().default("trainee"),
  authorAvatar: text("author_avatar"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const communityChatMessages = pgTable("community_chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: varchar("channel_id", { length: 100 }).notNull().default("general"),
  text: text("text").notNull(),
  authorId: uuid("author_id").notNull(),
  authorName: varchar("author_name", { length: 255 }).notNull(),
  authorRole: varchar("author_role", { length: 50 }).notNull().default("trainee"),
  authorAvatar: text("author_avatar"),
  isPinned: boolean("is_pinned").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Appeals ──────────────────────────────────────────────────────────────────
export const appeals = pgTable("appeals", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  userName: varchar("user_name", { length: 255 }).notNull(),
  userEmail: varchar("user_email", { length: 255 }).notNull(),
  cohortId: uuid("cohort_id"),
  appealType: varchar("appeal_type", { length: 64 }).notNull(), // 'week12_attendance' | 'exam_score'
  sessionId: uuid("session_id"),
  score: integer("score"),
  daysAttended: integer("days_attended"),
  reason: text("reason").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
  adminNotes: text("admin_notes"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Recommended Readings ───────────────────────────────────────────────────
export const readings = pgTable("readings", {
  id: varchar("id", { length: 128 }).primaryKey(),
  recommendedWeek: integer("recommended_week").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  subtitle: text("subtitle"),
  category: varchar("category", { length: 100 }).notNull().default("Livestock Management"),
  author: varchar("author", { length: 255 }).notNull(),
  readTime: varchar("read_time", { length: 50 }).notNull().default("10 min read"),
  type: varchar("type", { length: 50 }).notNull().default("Article"),
  chapterReference: text("chapter_reference"),
  coverImage: text("cover_image"),
  summary: text("summary").notNull(),
  content: text("content").notNull(),
  downloadUrl: text("download_url"),
  externalUrl: text("external_url"),
  featured: boolean("featured").default(false),
  publishedAt: timestamp("published_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Trainer Lesson Reports (Official 7-Section EEWYLA Template) ─────────────
export const trainerLessonReports = pgTable("trainer_lesson_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  trainerId: uuid("trainer_id").notNull(),
  trainerName: varchar("trainer_name", { length: 255 }),
  trainerEmail: varchar("trainer_email", { length: 255 }),
  cohortId: uuid("cohort_id").notNull(),
  cohortName: varchar("cohort_name", { length: 255 }),
  groupId: varchar("group_id", { length: 128 }),
  groupName: varchar("group_name", { length: 255 }),
  sessionId: uuid("session_id"),
  lessonId: uuid("lesson_id"),
  weekNumber: integer("week_number"),

  // Section 1: Session details
  sessionTitle: varchar("session_title", { length: 255 }).notNull(),
  sessionType: varchar("session_type", { length: 64 }).notNull().default("practical"), // physical | practical | online | hybrid
  dateConducted: timestamp("date_conducted").notNull(),
  sessionStartTime: varchar("session_start_time", { length: 32 }),
  sessionEndTime: varchar("session_end_time", { length: 32 }),
  location: varchar("location", { length: 255 }),

  // Section 2: Attendance
  expectedTrainees: integer("expected_trainees").notNull().default(0),
  traineesPresent: integer("trainees_present").notNull().default(0),
  absentTrainees: integer("absent_trainees").notNull().default(0),
  attendanceNotes: text("attendance_notes"),
  attendanceEvidenceRef: text("attendance_evidence_ref"),

  // Section 3: Objectives and outcomes
  objectives: text("objectives"),
  topicsCovered: text("topics_covered").notNull(),
  activities: text("activities").notNull(),
  learningOutcomes: text("learning_outcomes").notNull(),

  // Section 4: Issues raised
  challenges: text("challenges"),

  // Section 5: Incidents
  incidentsOccurred: boolean("incidents_occurred").notNull().default(false),
  incidentDetails: text("incident_details"),

  // Section 6: Looking ahead
  lookingAhead: text("looking_ahead"),

  // Section 7: Sign-off
  comments: text("comments"),
  trainerSignOffName: varchar("trainer_sign_off_name", { length: 255 }),
  trainerSignedAt: timestamp("trainer_signed_at"),

  // Legacy single-attachment columns kept for backwards compatibility
  attachmentUrl: text("attachment_url"),
  attachmentName: varchar("attachment_name", { length: 255 }),

  // Workflow, 24h Deadline, Delivery Gate & EPA Confirmation
  status: reportStatusEnum("status").notNull().default("draft"),
  submissionDeadline: timestamp("submission_deadline"),
  isLate: boolean("is_late").notNull().default(false),
  isDelivered: boolean("is_delivered").notNull().default(false),
  deliveredAt: timestamp("delivered_at"),
  submittedAt: timestamp("submitted_at"),
  epaConfirmed: boolean("epa_confirmed").notNull().default(false),
  epaConfirmedBy: uuid("epa_confirmed_by"),
  epaConfirmedByName: varchar("epa_confirmed_by_name", { length: 255 }),
  epaConfirmedAt: timestamp("epa_confirmed_at"),
  epaNotes: text("epa_notes"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  idxTrainerReportsTrainer: index("idx_trainer_reports_trainer").on(table.trainerId),
  idxTrainerReportsCohort: index("idx_trainer_reports_cohort").on(table.cohortId),
  idxTrainerReportsGroup: index("idx_trainer_reports_group").on(table.groupId),
  idxTrainerReportsStatus: index("idx_trainer_reports_status").on(table.status),
  idxTrainerReportsSession: index("idx_trainer_reports_session").on(table.sessionId),
}));

// ─── Trainer Report Supporting Document Attachments (Cloudinary Metadata) ─────
export const trainerReportAttachments = pgTable("trainer_report_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  reportId: uuid("report_id")
    .notNull()
    .references(() => trainerLessonReports.id, { onDelete: "cascade" }),
  trainerId: uuid("trainer_id").notNull(),
  cloudinaryPublicId: varchar("cloudinary_public_id", { length: 512 }).notNull(),
  resourceType: varchar("resource_type", { length: 32 }).notNull().default("image"), // image | raw | video
  deliveryType: varchar("delivery_type", { length: 32 }).notNull().default("authenticated"), // authenticated | private | upload
  originalFilename: varchar("original_filename", { length: 255 }).notNull(),
  fileFormat: varchar("file_format", { length: 50 }),
  fileSize: integer("file_size").notNull().default(0),
  attachmentCategory: varchar("attachment_category", { length: 64 }).notNull().default("other"), // attendance | photo | farm_evidence | other
  uploadedBy: uuid("uploaded_by").notNull(),
  uploadNonce: varchar("upload_nonce", { length: 128 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  idxReportAttachReport: index("idx_report_attach_report").on(table.reportId),
  idxReportAttachTrainer: index("idx_report_attach_trainer").on(table.trainerId),
  uqReportAttachPublicId: uniqueIndex("uq_report_attach_public_id").on(table.reportId, table.cloudinaryPublicId),
}));

// ─── Trainer Report Audit Trail ───────────────────────────────────────────────
export const trainerReportAuditLogs = pgTable("trainer_report_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  reportId: uuid("report_id")
    .notNull()
    .references(() => trainerLessonReports.id, { onDelete: "cascade" }),
  action: varchar("action", { length: 64 }).notNull(), // created | draft_saved | submitted | amended | attachment_added | attachment_removed | epa_confirmed | marked_delivered
  actorId: uuid("actor_id").notNull(),
  actorName: varchar("actor_name", { length: 255 }),
  actorRole: varchar("actor_role", { length: 64 }),
  details: jsonb("details").$type<Record<string, any>>().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  idxReportAuditReport: index("idx_report_audit_report").on(table.reportId),
}));

// ─── Audited Manual Exam Eligibility Overrides ────────────────────────────────
export const examEligibilityOverrides = pgTable("exam_eligibility_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  traineeId: uuid("trainee_id").notNull(),
  cohortId: uuid("cohort_id"),
  examId: uuid("exam_id"),
  grantedBy: uuid("granted_by").notNull(),
  grantedByName: varchar("granted_by_name", { length: 255 }),
  reason: text("reason").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  expiresAt: timestamp("expires_at"),
  revokedBy: uuid("revoked_by"),
  revokedAt: timestamp("revoked_at"),
  revokeReason: text("revoke_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  idxExamEligOverrideTrainee: index("idx_exam_elig_override_trainee").on(table.traineeId),
  idxExamEligOverrideActive: index("idx_exam_elig_override_active").on(table.traineeId, table.isActive),
}));

// ─── Master Curriculum Architecture (Phase 1 Additive Schema) ────────────────

export const masterCurricula = pgTable("master_curricula", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const curriculumRevisions = pgTable("curriculum_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  curriculumId: uuid("curriculum_id")
    .notNull()
    .references(() => masterCurricula.id, { onDelete: "restrict" }),
  versionLabel: varchar("version_label", { length: 32 }).notNull(),
  versionNumber: integer("version_number").notNull(),
  changeClassification: varchar("change_classification", { length: 32 }).notNull().default("initial"), // initial | non_breaking | structural | controlled
  status: varchar("status", { length: 32 }).notNull().default("draft"), // draft | in_review | published | archived
  summary: text("summary"),
  effectiveFrom: timestamp("effective_from"),
  publishedBy: uuid("published_by"),
  publishedAt: timestamp("published_at"),
  parentRevisionId: uuid("parent_revision_id"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  uqCurriculumVersion: uniqueIndex("uq_curriculum_revision_version").on(table.curriculumId, table.versionNumber),
  idxCurriculumRevisionStatus: index("idx_curriculum_revision_status").on(table.status),
}));

export const curriculumModules = pgTable("curriculum_modules", {
  id: uuid("id").primaryKey().defaultRandom(),
  revisionId: uuid("revision_id")
    .notNull()
    .references(() => curriculumRevisions.id, { onDelete: "restrict" }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  idxCurriculumModulesRev: index("idx_curriculum_modules_rev").on(table.revisionId),
}));

export const cohortCurriculumBindings = pgTable("cohort_curriculum_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").notNull(),
  cohortName: varchar("cohort_name", { length: 255 }),
  revisionId: uuid("revision_id")
    .notNull()
    .references(() => curriculumRevisions.id, { onDelete: "restrict" }),
  isPinned: boolean("is_pinned").notNull().default(true),
  boundBy: uuid("bound_by"),
  boundAt: timestamp("bound_at").notNull().defaultNow(),
  previousRevisionId: uuid("previous_revision_id"),
  upgradeReason: text("upgrade_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  uqCohortBinding: uniqueIndex("uq_cohort_curriculum_binding").on(table.cohortId),
  idxCohortBindingRev: index("idx_cohort_binding_rev").on(table.revisionId),
}));

export const cohortWeekSchedules = pgTable("cohort_week_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").notNull(),
  weekNumber: integer("week_number").notNull(),
  masterWeekId: uuid("master_week_id"),
  unlockDate: timestamp("unlock_date"),
  practicalRequired: boolean("practical_required").notNull().default(true),
  quizRequired: boolean("quiz_required").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  uqCohortWeekSchedule: uniqueIndex("uq_cohort_week_schedule").on(table.cohortId, table.weekNumber),
  idxCohortWeekScheduleCohort: index("idx_cohort_week_schedule_cohort").on(table.cohortId),
}));

export const curriculumAuditLogs = pgTable("curriculum_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  curriculumId: uuid("curriculum_id"),
  revisionId: uuid("revision_id"),
  cohortId: uuid("cohort_id"),
  action: varchar("action", { length: 64 }).notNull(), // revision_created | content_updated | revision_published | cohort_bound | cohort_upgraded | backfill_promoted | rollback
  changeClassification: varchar("change_classification", { length: 32 }),
  actorId: uuid("actor_id"),
  actorRole: varchar("actor_role", { length: 64 }),
  reason: text("reason"),
  details: jsonb("details").$type<Record<string, any>>().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  idxCurriculumAuditRev: index("idx_curriculum_audit_rev").on(table.revisionId),
  idxCurriculumAuditCohort: index("idx_curriculum_audit_cohort").on(table.cohortId),
}));

