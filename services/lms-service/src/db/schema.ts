import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";

export const lessonTypeEnum = pgEnum("lesson_type", ["video", "document", "quiz"]);
export const sessionTypeEnum = pgEnum("session_type", ["online", "physical"]);

export const weeks = pgTable("weeks", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  weekNumber: integer("week_number").notNull(),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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
  durationMinutes: integer("duration_minutes"),
  order: integer("order").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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