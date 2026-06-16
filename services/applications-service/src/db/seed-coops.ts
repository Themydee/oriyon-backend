import { db } from "../index";
import { cooperatives } from "./schema";
import { eq } from "drizzle-orm";

export async function seedCooperatives() {
  console.log("[applications-service] Seeding cooperatives...");
  try {
    const defaultCoops = [
      { name: "Ibadan North", state: "Oyo State", description: "Cooperative for livestock farmers in Ibadan North LGA, Oyo State.", isActive: true },
      { name: "Ibadan North-East", state: "Oyo State", description: "Cooperative for livestock farmers in Ibadan North-East LGA, Oyo State.", isActive: true },
      { name: "Ibadan North-West", state: "Oyo State", description: "Cooperative for livestock farmers in Ibadan North-West LGA, Oyo State.", isActive: true },
      { name: "Ibadan South-East", state: "Oyo State", description: "Cooperative for livestock farmers in Ibadan South-East LGA, Oyo State.", isActive: true },
      { name: "Ibadan South-West", state: "Oyo State", description: "Cooperative for livestock farmers in Ibadan South-West LGA, Oyo State.", isActive: true },
      { name: "Akinyele", state: "Oyo State", description: "Cooperative for livestock farmers in Akinyele LGA, Oyo State.", isActive: true },
      { name: "Oyo East", state: "Oyo State", description: "Cooperative for livestock farmers in Oyo East LGA, Oyo State.", isActive: true },
      { name: "Oyo West", state: "Oyo State", description: "Cooperative for livestock farmers in Oyo West LGA, Oyo State.", isActive: true },
      { name: "Atiba", state: "Oyo State", description: "Cooperative for livestock farmers in Atiba LGA, Oyo State.", isActive: true },
      { name: "Afijio", state: "Oyo State", description: "Cooperative for livestock farmers in Afijio LGA, Oyo State.", isActive: true },
      { name: "Ogbomosho North", state: "Oyo State", description: "Cooperative for livestock farmers in Ogbomosho North LGA, Oyo State.", isActive: true },
      { name: "Ogbomosho South", state: "Oyo State", description: "Cooperative for livestock farmers in Ogbomosho South LGA, Oyo State.", isActive: true },
      { name: "Ori Ire", state: "Oyo State", description: "Cooperative for livestock farmers in Ori Ire LGA, Oyo State.", isActive: true },
      { name: "Ogo Oluwa", state: "Oyo State", description: "Cooperative for livestock farmers in Ogo Oluwa LGA, Oyo State.", isActive: true },
      { name: "Iseyin", state: "Oyo State", description: "Cooperative for livestock farmers in Iseyin LGA, Oyo State.", isActive: true },
      { name: "Itesiwaju", state: "Oyo State", description: "Cooperative for livestock farmers in Itesiwaju LGA, Oyo State.", isActive: true },
      { name: "Kajola", state: "Oyo State", description: "Cooperative for livestock farmers in Kajola LGA, Oyo State.", isActive: true },
      { name: "Irepo", state: "Oyo State", description: "Cooperative for livestock farmers in Irepo LGA, Oyo State.", isActive: true },
      { name: "Olorunsogo", state: "Oyo State", description: "Cooperative for livestock farmers in Olorunsogo LGA, Oyo State.", isActive: true },
      { name: "Orelope", state: "Oyo State", description: "Cooperative for livestock farmers in Orelope LGA, Oyo State.", isActive: true },
      { name: "Saki East", state: "Oyo State", description: "Cooperative for livestock farmers in Saki East LGA, Oyo State.", isActive: true },
      { name: "Saki West", state: "Oyo State", description: "Cooperative for livestock farmers in Saki West LGA, Oyo State.", isActive: true },
      { name: "Ibarapa East", state: "Oyo State", description: "Cooperative for livestock farmers in Ibarapa East LGA, Oyo State.", isActive: true },
      { name: "Ibarapa Central", state: "Oyo State", description: "Cooperative for livestock farmers in Ibarapa Central LGA, Oyo State.", isActive: true },
      { name: "Ibarapa North", state: "Oyo State", description: "Cooperative for livestock farmers in Ibarapa North LGA, Oyo State.", isActive: true },
      { name: "Atisbo", state: "Oyo State", description: "Cooperative for livestock farmers in Atisbo LGA, Oyo State.", isActive: true },
      { name: "Iwajowa", state: "Oyo State", description: "Cooperative for livestock farmers in Iwajowa LGA, Oyo State.", isActive: true },
      { name: "Ido", state: "Oyo State", description: "Cooperative for livestock farmers in Ido LGA, Oyo State.", isActive: true },
      { name: "Egbeda", state: "Oyo State", description: "Cooperative for livestock farmers in Egbeda LGA, Oyo State.", isActive: true },
      { name: "Oluyole", state: "Oyo State", description: "Cooperative for livestock farmers in Oluyole LGA, Oyo State.", isActive: true },
      { name: "Ona-Ara", state: "Oyo State", description: "Cooperative for livestock farmers in Ona-Ara LGA, Oyo State.", isActive: true },
      { name: "Lagelu", state: "Oyo State", description: "Cooperative for livestock farmers in Lagelu LGA, Oyo State.", isActive: true },
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
