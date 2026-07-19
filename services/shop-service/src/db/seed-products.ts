import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { products } from "./schema";

const DB_URL = process.env.DATABASE_URL!;

const SEED_PRODUCTS: any[] = [];

async function seed() {
  console.log("Seeding products database...");
  if (!DB_URL) {
    console.error("DATABASE_URL is missing in environment!");
    process.exit(1);
  }

  const client = postgres(DB_URL);
  const db = drizzle(client);

  try {
    const existing = await db.select().from(products).limit(1);
    if (existing.length === 0) {
      for (const p of SEED_PRODUCTS) {
        await db.insert(products).values(p);
        console.log(`Seeded product: ${p.name}`);
      }
      console.log("Product seeding completed successfully.");
    } else {
      console.log("Products table already has data. Skipping seed.");
    }
  } catch (error) {
    console.error("Seeding failed:", error);
  } finally {
    await client.end();
  }
}

seed();
