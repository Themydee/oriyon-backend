import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["trainee", "trainer", "coordinator", "lead_trainer", "admin"]);

export const users = pgTable("users", {
  id:        uuid("id").primaryKey(), 
  email:     varchar("email", { length: 255 }).notNull().unique(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName:  varchar("last_name", { length: 100 }).notNull(),
  phone:     varchar("phone", { length: 20 }),
  role:      roleEnum("role").notNull().default("trainee"),
  assignedState: varchar("assigned_state", { length: 100 }),
  assignedLga: varchar("assigned_lga", { length: 100 }),
  assignedZone: varchar("assigned_zone", { length: 150 }),
  isCooperativeOnly: boolean("is_cooperative_only").notNull().default(false),
  isActive:  boolean("is_active").notNull().default(true),
  approvedRole: varchar("approved_role", { length: 255 }),

  
  idType:       varchar("id_type", { length: 60 }),       
  idDocument:   text("id_document"),                        
  idFilename:   varchar("id_filename", { length: 255 }),    
  idMimeType:   varchar("id_mime_type", { length: 60 }),    
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