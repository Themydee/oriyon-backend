import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["trainee", "trainer", "admin"]);

export const users = pgTable("users", {
  id:        uuid("id").primaryKey(), // same ID as auth_users (synced via event)
  email:     varchar("email", { length: 255 }).notNull().unique(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName:  varchar("last_name", { length: 100 }).notNull(),
  phone:     varchar("phone", { length: 20 }),
  role:      roleEnum("role").notNull().default("trainee"),
  isActive:  boolean("is_active").notNull().default(true),

  // ── ID Document ──────────────────────────────────────────
  // Stored as base64 data URI: "data:image/jpeg;base64,..."
  // Admin can download via GET /users/:id/id-document
  idType:       varchar("id_type", { length: 60 }),        // e.g. "National ID (NIN)"
  idDocument:   text("id_document"),                        // full base64 data URI
  idFilename:   varchar("id_filename", { length: 255 }),    // original file name
  idMimeType:   varchar("id_mime_type", { length: 60 }),    // image/jpeg | image/png | application/pdf
  idUploadedAt: timestamp("id_uploaded_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const cohorts = pgTable("cohorts", {
  id:          uuid("id").primaryKey().defaultRandom(),
  name:        varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  state:       varchar("state", { length: 100 }),
  startDate:   timestamp("start_date"),
  endDate:     timestamp("end_date"),
  isActive:    boolean("is_active").notNull().default(true),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
});

export const cohortMembers = pgTable("cohort_members", {
  id:         uuid("id").primaryKey().defaultRandom(),
  userId:     uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  cohortId:   uuid("cohort_id").notNull().references(() => cohorts.id, { onDelete: "cascade" }),
  enrolledAt: timestamp("enrolled_at").notNull().defaultNow(),
});

export const groups = pgTable("groups", {
  id: uuid("id").primaryKey().defaultRandom(),

  cohortId: uuid("cohort_id")
    .notNull()
    .references(() => cohorts.id, { onDelete: "cascade" }),

  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),

  isActive: boolean("is_active").notNull().default(true),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const groupMembers = pgTable("group_members", {
  id: uuid("id").primaryKey().defaultRandom(),

  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),

  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  joinedAt: timestamp("joined_at").notNull().defaultNow(),
});