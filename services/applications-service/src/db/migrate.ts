import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "path";

async function runMigrations() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);

  console.log("[applications-service] Running migrations...");

  await migrate(db, {
    migrationsFolder: path.join(__dirname, "migrations"),
  });

  console.log("[applications-service] Migrations complete.");
  await client.end();
  process.exit(0);
}

runMigrations().catch((err) => {
  console.error("[applications-service] Migration failed:", err);
  process.exit(1);
});
