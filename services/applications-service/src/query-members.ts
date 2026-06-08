import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cooperativeMembers, cooperatives } from "./db/schema";

async function query() {
  const client = postgres(process.env.DATABASE_URL!);
  const db = drizzle(client);

  console.log("Querying cooperatives...");
  const coops = await db.select().from(cooperatives);
  console.log("Cooperatives in DB:", coops);

  console.log("Querying cooperative members...");
  const members = await db
    .select({
      id: cooperativeMembers.id,
      firstName: cooperativeMembers.firstName,
      lastName: cooperativeMembers.lastName,
      email: cooperativeMembers.email,
      cooperativeId: cooperativeMembers.cooperativeId,
    })
    .from(cooperativeMembers);
  console.log("Members in DB:", members);

  await client.end();
}

query().catch(console.error);
