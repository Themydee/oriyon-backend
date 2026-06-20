import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

// ─────────────────────────────────────────────
// SEED TRAINER
// Run once to create the first trainer account.
//
// Usage:
//   npx ts-node --transpile-only src/seed-trainer.ts
// ─────────────────────────────────────────────

const AUTH_DB_URL = process.env.DATABASE_URL!;
const USER_DB_URL = process.env.USER_DATABASE_URL || process.env.DATABASE_URL!;

const TRAINER_ID = uuidv4();
const TRAINER_EMAIL = process.env.TRAINER_EMAIL || "trainer@oriyon.ng";
const TRAINER_PASSWORD = process.env.TRAINER_PASSWORD || "Trainer@Oriyon2025";
const TRAINER_FIRST_NAME = "Oriyon";
const TRAINER_LAST_NAME = "Trainer";

async function seedTrainer() {
  console.log("Seeding trainer account...");
  console.log(`Email:    ${TRAINER_EMAIL}`);
  console.log(`Password: ${TRAINER_PASSWORD}`);
  console.log(`ID:       ${TRAINER_ID}`);

  const passwordHash = await bcrypt.hash(TRAINER_PASSWORD, 12);

  // ── 1. Create auth record ──────────────────
  const authClient = postgres(AUTH_DB_URL);
  const authDb = drizzle(authClient);

  await authDb.execute(
    sql`INSERT INTO auth_users (id, email, password_hash, role, is_active)
        VALUES (${TRAINER_ID}, ${TRAINER_EMAIL}, ${passwordHash}, 'trainer', true)
        ON CONFLICT (email) DO NOTHING`
  );

  console.log("[auth-service] Trainer auth record created");
  await authClient.end();

  // ── 2. Create user profile ─────────────────
  const userClient = postgres(USER_DB_URL);
  const userDb = drizzle(userClient);

  await userDb.execute(
    sql`INSERT INTO users (id, email, first_name, last_name, role, is_active)
        VALUES (${TRAINER_ID}, ${TRAINER_EMAIL}, ${TRAINER_FIRST_NAME}, ${TRAINER_LAST_NAME}, 'trainer', true)
        ON CONFLICT (email) DO NOTHING`
  );

  console.log("[user-service] Trainer user profile created");
  await userClient.end();

  console.log("\nDone. You can now log in with:");
  console.log(`  Email:    ${TRAINER_EMAIL}`);
  console.log(`  Password: ${TRAINER_PASSWORD}`);
}

seedTrainer().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
