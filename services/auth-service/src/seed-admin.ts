import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

// ─────────────────────────────────────────────
// SEED ADMIN
// Run once to create the first admin account.
//
// Usage (inside container):
//   npx ts-node --transpile-only src/seed-admin.ts
// ─────────────────────────────────────────────

const AUTH_DB_URL = process.env.DATABASE_URL!;
const USER_DB_URL = process.env.USER_DATABASE_URL || process.env.DATABASE_URL!;

const ADMIN_ID = uuidv4();
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@oriyon.ng";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@Oriyon2025";
const ADMIN_FIRST_NAME = "Oriyon";
const ADMIN_LAST_NAME = "Admin";

async function seedAdmin() {
  console.log("Seeding admin account...");
  console.log(`Email:    ${ADMIN_EMAIL}`);
  console.log(`Password: ${ADMIN_PASSWORD}`);
  console.log(`ID:       ${ADMIN_ID}`);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  // ── 1. Create auth record ──────────────────
  const authClient = postgres(AUTH_DB_URL);
  const authDb = drizzle(authClient);

  await authDb.execute(
    sql`INSERT INTO auth_users (id, email, password_hash, role, is_active)
        VALUES (${ADMIN_ID}, ${ADMIN_EMAIL}, ${passwordHash}, 'admin', true)
        ON CONFLICT (email) DO NOTHING`
  );

  console.log("[auth-service] Admin auth record created");
  await authClient.end();

  // ── 2. Create user profile ─────────────────
  // USER_DATABASE_URL must point to oriyon_user DB
  // Add to your .env if not already there:
  //   USER_DATABASE_URL=postgresql://user:pass@oriyon-postgres-user:5432/oriyon_user
  const userClient = postgres(USER_DB_URL);
  const userDb = drizzle(userClient);

  await userDb.execute(
    sql`INSERT INTO users (id, email, first_name, last_name, role, is_active)
        VALUES (${ADMIN_ID}, ${ADMIN_EMAIL}, ${ADMIN_FIRST_NAME}, ${ADMIN_LAST_NAME}, 'admin', true)
        ON CONFLICT (email) DO NOTHING`
  );

  console.log("[user-service] Admin user profile created");
  await userClient.end();

  console.log("\nDone. You can now log in with:");
  console.log(`  Email:    ${ADMIN_EMAIL}`);
  console.log(`  Password: ${ADMIN_PASSWORD}`);
}

seedAdmin().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});