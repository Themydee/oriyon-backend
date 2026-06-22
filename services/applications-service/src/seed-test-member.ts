import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { cooperativeMembers, cooperatives } from "./db/schema";

async function seedTestMember() {
  const client = postgres(process.env.DATABASE_URL!);
  const db = drizzle(client);

  console.log("Seeding test member for Ibadan North...");

  // 1. Find the Ibadan North cooperative
  const [coop] = await db
    .select()
    .from(cooperatives)
    .where(eq(cooperatives.name, "Ibadan North"))
    .limit(1);

  if (!coop) {
    console.error("Cooperative 'Ibadan North' not found in database.");
    await client.end();
    return;
  }

  console.log(`Found cooperative 'Ibadan North' with ID: ${coop.id}`);

  // 2. Insert or update the test member
  const memberData = {
    firstName: "Deji",
    lastName: "IbadanNorthMember",
    email: "deji.ibnorth@example.com",
    phone: "+2348011223344",
    lga: "Ibadan North",
    cooperativeId: coop.id,
    registrationFeePaid: "YES",
    remarks: "Not Joined",
    agreesToConstitution: true,
    willingToContribute: true,
    status: "active" as const,
  };

  // Check if member already exists
  const [existing] = await db
    .select()
    .from(cooperativeMembers)
    .where(eq(cooperativeMembers.email, memberData.email))
    .limit(1);

  if (existing) {
    await db
      .update(cooperativeMembers)
      .set(memberData)
      .where(eq(cooperativeMembers.email, memberData.email));
    console.log(`Updated existing member: ${memberData.email}`);
  } else {
    await db.insert(cooperativeMembers).values(memberData);
    console.log(`Inserted new test member: ${memberData.email}`);
  }

  await client.end();
  console.log("Seeding test member completed successfully!");
}

seedTestMember().catch(console.error);
