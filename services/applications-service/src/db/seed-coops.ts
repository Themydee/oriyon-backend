import { db } from "../index";
import { cooperatives } from "./schema";
import { eq } from "drizzle-orm";

export async function seedCooperatives() {
  console.log("[applications-service] Seeding cooperatives...");
  try {
    const defaultCoops = [
      {
        name: "EEWYLA Livestock Producers Cooperative Society Ltd",
        state: "Oyo State, Nigeria",
        description: "Focuses on female and youth livestock farmers, providing credit access and training.",
        isActive: true,
      },
      {
        name: "Oriyon Farmers Alliance Cooperative Society",
        state: "Oyo State, Nigeria",
        description: "A wider network for smallholder ruminant and poultry producers offering marketing linkages.",
        isActive: true,
      },
      {
        name: "Fashola Livestock Producers Cooperative",
        state: "Oyo State, Nigeria",
        description: "Based around Fashola Farms, specializing in improved breeding, grazing management, and dairy.",
        isActive: true,
      },
    ];

    for (const coop of defaultCoops) {
      // Check if already exists
      const [existing] = await db
        .select()
        .from(cooperatives)
        .where(eq(cooperatives.name, coop.name))
        .limit(1);

      if (!existing) {
        await db.insert(cooperatives).values(coop);
        console.log(`✔ Seeded cooperative: ${coop.name}`);
      }
    }
    console.log("[applications-service] Cooperatives seeding complete.");
  } catch (err) {
    console.error("[applications-service] Cooperatives seeding failed:", err);
  }
}
