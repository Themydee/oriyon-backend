import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["trainee", "trainer", "coordinator", "lead_trainer", "admin", "sub_admin", "cooperative", "corper"]);

export const users = pgTable("users", {
  id:        uuid("id").primaryKey(), 
  email:     varchar("email", { length: 255 }).notNull().unique(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName:  varchar("last_name", { length: 100 }).notNull(),
  phone:     varchar("phone", { length: 20 }),
  address:   text("address"),
  role:      varchar("role", { length: 50 }).notNull().default("trainee"),
  assignedState: varchar("assigned_state", { length: 100 }),
  assignedLga: varchar("assigned_lga", { length: 100 }),
  assignedZone: varchar("assigned_zone", { length: 150 }),
  physicalSiteId: varchar("physical_site_id", { length: 100 }),
  isCooperativeOnly: boolean("is_cooperative_only").notNull().default(false),
  isActive:  boolean("is_active").notNull().default(true),
  blacklistReason: text("blacklist_reason"),
  approvedRole: varchar("approved_role", { length: 255 }),
  specialization: text("specialization"),

  
  idType:       varchar("id_type", { length: 60 }),       
  idDocument:   text("id_document"),                        
  idFilename:   varchar("id_filename", { length: 255 }),    
  idMimeType:   varchar("id_mime_type", { length: 60 }),    
  idUploadedAt: timestamp("id_uploaded_at"),
  kycStatus:    varchar("kyc_status", { length: 30 }),
  kycRejectionReason: text("kyc_rejection_reason"),

  passportPicture: text("passport_picture"),
  passportUrl:     text("passport_url"),
  avatarUrl:       text("avatar_url"),
  photo:           text("photo"),

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
  practicalDay: varchar("practical_day", { length: 255 }),

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

export const groupTrainers = pgTable("group_trainers", {
  id: uuid("id").primaryKey().defaultRandom(),

  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),

  trainerId: uuid("trainer_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  assignedDay: varchar("assigned_day", { length: 100 }),

  assignedAt: timestamp("assigned_at").notNull().defaultNow(),
});
// ─────────────────────────────────────────────
// TRAINER SUPPORT TICKETS
// A trainee (or any LMS user) raises a ticket about a trainer; admins and
// sub-admins triage it. Every reply, internal note and status change is a row
// in trainer_ticket_messages, so the ticket keeps a full audit trail.
// The trainer named in a ticket never sees it.
// ─────────────────────────────────────────────
export const trainerTickets = pgTable("trainer_tickets", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(), // e.g. TKT-7Q4M2X

  reporterId: uuid("reporter_id").notNull(),
  reporterName: varchar("reporter_name", { length: 255 }).notNull(),
  reporterEmail: varchar("reporter_email", { length: 255 }).notNull(),
  reporterPhone: varchar("reporter_phone", { length: 30 }),
  cohortId: uuid("cohort_id"),
  groupId: uuid("group_id"),
  groupName: varchar("group_name", { length: 255 }),
  physicalSiteId: varchar("physical_site_id", { length: 100 }),

  trainerId: uuid("trainer_id"), // null when the trainer is not in the trainee's groups
  trainerName: varchar("trainer_name", { length: 255 }).notNull(),

  category: varchar("category", { length: 50 }).notNull(),
  priority: varchar("priority", { length: 20 }).notNull().default("medium"), // low | medium | high | urgent
  subject: varchar("subject", { length: 200 }).notNull(),
  description: text("description").notNull(),
  incidentDate: varchar("incident_date", { length: 20 }),
  attachmentUrl: text("attachment_url"),
  attachmentName: varchar("attachment_name", { length: 255 }),

  // open | in_progress | awaiting_reporter | resolved | closed
  status: varchar("status", { length: 30 }).notNull().default("open"),
  assignedToId: uuid("assigned_to_id"),
  assignedToName: varchar("assigned_to_name", { length: 255 }),

  firstResponseAt: timestamp("first_response_at"),
  resolvedAt: timestamp("resolved_at"),
  closedAt: timestamp("closed_at"),
  satisfactionRating: integer("satisfaction_rating"), // 1–5, given by the reporter after resolution
  satisfactionComment: text("satisfaction_comment"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const trainerTicketMessages = pgTable("trainer_ticket_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => trainerTickets.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull(),
  authorName: varchar("author_name", { length: 255 }).notNull(),
  authorRole: varchar("author_role", { length: 50 }).notNull(),
  // reply (visible to reporter) | internal_note (staff only) | event (status/assignment change)
  kind: varchar("kind", { length: 20 }).notNull().default("reply"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
