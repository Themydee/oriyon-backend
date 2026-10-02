import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────
// auth_users
// Core credentials table.
// passwordHash is nullable — new users have no
// password until they complete set-password flow.
// ─────────────────────────────────────────────
export const authUsers = pgTable("auth_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash"),                          // nullable until set-password
  role: varchar("role", { length: 20 }).notNull().default("trainee"), // trainee | trainer | lead_trainer | coordinator | admin
  assignedState: varchar("assigned_state", { length: 100 }),
  assignedLga: varchar("assigned_lga", { length: 100 }),
  assignedZone: varchar("assigned_zone", { length: 150 }),
  isCooperativeOnly: boolean("is_cooperative_only").notNull().default(false),
  isActive: boolean("is_active").notNull().default(false),      // false until set-password completes
  blacklistReason: text("blacklist_reason"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─────────────────────────────────────────────
// refresh_tokens
// Stores active refresh tokens per user.
// Deleted on logout, password change, or reset.
// ─────────────────────────────────────────────
export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─────────────────────────────────────────────
// setup_tokens
// Dual-purpose table:
//   1. First-time password setup   (triggered by user.created event)
//   2. Forgot-password reset links (triggered by POST /auth/forgot-password)
//
// A token is single-use and expires.
// The `used` flag prevents replay attacks.
// ─────────────────────────────────────────────
export const setupTokens = pgTable("setup_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─────────────────────────────────────────────
// login_events
// One row per login / set-password / reset-password
// attempt, successful or not. Read by the monitoring
// report (GET /auth/admin/login-activity).
// Rows older than LOGIN_EVENTS_RETENTION_DAYS are pruned.
// ─────────────────────────────────────────────
export const loginEvents = pgTable(
  "login_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    event: varchar("event", { length: 30 }).notNull(),           // login | set_password | reset_password
    success: boolean("success").notNull(),
    reason: varchar("reason", { length: 50 }).notNull(),          // ok | unknown_email | wrong_password | ...
    email: varchar("email", { length: 255 }),
    userId: uuid("user_id"),
    role: varchar("role", { length: 50 }),
    ip: varchar("ip", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    createdAtIdx: index("login_events_created_at_idx").on(table.createdAt),
  }),
);
