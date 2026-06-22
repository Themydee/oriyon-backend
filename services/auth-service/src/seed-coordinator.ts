import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

const AUTH_DB_URL = process.env.DATABASE_URL!;
const USER_DB_URL = process.env.USER_DATABASE_URL || process.env.DATABASE_URL!;

const COORD_ID = uuidv4();
const COORD_EMAIL = "temicord@oriyon.ng";
const COORD_PASSWORD = "Coordinator@Oriyon2026";
const COORD_FIRST_NAME = "Temi";
const COORD_LAST_NAME = "Coordinator";

async function seedCoordinator() {
  console.log("Seeding coordinator account...");
  console.log(`Email:    ${COORD_EMAIL}`);
  console.log(`Password: ${COORD_PASSWORD}`);
  console.log(`ID:       ${COORD_ID}`);

  const passwordHash = await bcrypt.hash(COORD_PASSWORD, 12);

  // ── 1. Create auth record ──────────────────
  const authClient = postgres(AUTH_DB_URL);
  const authDb = drizzle(authClient);

  await authDb.execute(
    sql`INSERT INTO auth_users (id, email, password_hash, role, assigned_state, assigned_lga, is_active)
        VALUES (${COORD_ID}, ${COORD_EMAIL}, ${passwordHash}, 'coordinator', 'Oyo State', 'Ibadan North', true)
        ON CONFLICT (email) DO UPDATE SET password_hash = ${passwordHash}, role = 'coordinator', assigned_state = 'Oyo State', assigned_lga = 'Ibadan North', is_active = true`
  );

  console.log("[auth-service] Coordinator auth record created/updated");
  await authClient.end();

  // ── 2. Create user profile ─────────────────
  const userClient = postgres(USER_DB_URL);
  const userDb = drizzle(userClient);

  await userDb.execute(
    sql`INSERT INTO users (id, email, first_name, last_name, role, assigned_state, assigned_lga, is_active)
        VALUES (${COORD_ID}, ${COORD_EMAIL}, ${COORD_FIRST_NAME}, ${COORD_LAST_NAME}, 'coordinator', 'Oyo State', 'Ibadan North', true)
        ON CONFLICT (email) DO UPDATE SET role = 'coordinator', assigned_state = 'Oyo State', assigned_lga = 'Ibadan North', is_active = true`
  );

  console.log("[user-service] Coordinator user profile created/updated");
  await userClient.end();

  console.log("\nDone. LGA Coordinator can now log in with:");
  console.log(`  Email:    ${COORD_EMAIL}`);
  console.log(`  Password: ${COORD_PASSWORD}`);
}

seedCoordinator().catch((err) => {
  console.error("Coordinator Seed failed:", err);
  process.exit(1);
});
