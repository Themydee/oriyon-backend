import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
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
  role: varchar("role", { length: 20 }).notNull().default("trainee"), // trainee | trainer | admin
  isActive: boolean("is_active").notNull().default(false),      // false until set-password completes
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