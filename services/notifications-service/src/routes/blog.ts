import { Router, Request, Response } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { blogPosts } from "../db/schema";

export const blogRouter = Router();

// Seed Default Blog Posts Helper
const defaultSeedPosts = [
  {
    slug: "building-a-traceable-livestock-value-chain-in-nigeria-why-it-matters",
    title: "Building a Traceable Livestock Value Chain in Nigeria: Why It Matters",
    category: "News",
    readTime: "5 min read",
    author: "Reece James",
    authorTitle: "Head of Traceability Operations",
    authorImg: "/learn/blog/Avatar.png",
    image: "/learn/blog/singleHero.png",
    heroImage: "/learn/blog/singleHero.png",
    featured: true,
    isPublished: true,
    excerpt: "Discover how digital EAR TAG identification and blockchain-inspired audit trails are revolutionizing livestock commercialization across Nigeria.",
    keyTakeaways: [
      "Digital EAR TAGs provide unique identity numbers for individual cattle and small ruminants.",
      "Traceability eliminates flat-rate buyer pricing by proving animal health, age, and vaccination history.",
      "Institutional buyers pay a 15-25% premium for verified, disease-free livestock with digital records."
    ],
    content: [
      "The traditional livestock trade in Nigeria has long been defined by fragmented supply chains and a lack of transparent pricing. For decades, pastoral farmers and commercial rearers have relied on informal physical markets, long-distance cattle trekking, and multiple intermediaries that erode farmgate profits.",
      "Digital marketplaces and EAR TAG identity systems are set to disrupt this status quo by creating a direct, verifiable link between the farm gate, cooperative processing hubs, and industrial meat buyers.",
      "Beyond simple commercial sales, these platforms introduce a layer of data-driven trust. Verified seller profiles, ear-tag RFID codes, and digital health certificates allow buyers to purchase with complete confidence, knowing the exact provenance and vaccination history of every animal.",
      "As we look toward the future, the integration of cold-chain logistics, regional abattoir tracking, and escrow payments will drastically reduce livestock theft, interstate transit mortality, and payment disputes across West Africa."
    ],
    tags: ["Traceability", "Livestock", "EAR TAG", "Nigeria Agribusiness"]
  },
  {
    slug: "how-cooperative-based-training-strengthens-rural-communities",
    title: "How Cooperative-Based Training Strengthens Rural Communities",
    category: "Oriyon International",
    readTime: "6 min read",
    author: "Dr. Amina Bello",
    authorTitle: "EEWYLA Lead Coordinator",
    authorImg: "/learn/blog/Avatar.png",
    image: "/learn/blog/single.png",
    heroImage: "/learn/blog/single.png",
    featured: false,
    isPublished: true,
    excerpt: "EEWYLA's cooperative model empowers women and youth with practical goat farming skills, group savings, and direct off-taker access.",
    keyTakeaways: [
      "Group pooling enables smallholder farmers to access bulk feeds and veterinary services at 30% lower cost.",
      "Women and youth gain direct ownership of income-generating livestock assets.",
      "Cooperative registration unlocks formal credit lines, micro-loans, and government agricultural grants."
    ],
    content: [
      "In rural livestock farming, individual micro-producers often struggle to compete with large commercial feedlots due to limited capital, lack of bargaining power, and expensive veterinary inputs.",
      "The EEWYLA (Economic Empowerment of Women and Youth in Livestock Agriculture) programme addresses this systemic barrier by anchoring technical training within grassroots cooperative clusters across Oyo, Kwara, and surrounding states.",
      "When women and young livestock rearers form registered cooperative societies, they gain collective bargaining power. They purchase high-quality feed concentrates in bulk, share vaccination kits, and negotiate fair off-taker contracts with major urban meat processors.",
      "Through structured 12-week practical curriculum sessions at sites like LAUTECH Ogbomoso, cooperative members build lasting networks, gain financial literacy, and transform subsistence goat rearing into scalable, profitable agribusinesses."
    ],
    tags: ["EEWYLA", "Cooperatives", "Women In Agribusiness", "Ogbomoso"]
  },
  {
    slug: "using-data-to-reduce-losses-and-improve-livestock-quality",
    title: "Using Data to Reduce Losses and Improve Livestock Quality",
    category: "Business",
    readTime: "4 min read",
    author: "Reece James",
    authorTitle: "Agribusiness Analyst",
    authorImg: "/learn/blog/Avatar.png",
    image: "/learn/blog/single2.jpg",
    heroImage: "/learn/blog/single2.jpg",
    featured: false,
    isPublished: true,
    excerpt: "How data tracking, weight monitoring, and biosecurity checklists protect herd investments and boost profit margins.",
    keyTakeaways: [
      "Regular weight measurement ensures optimal feed-to-meat conversion rates.",
      "Digital health logs enable early disease detection before herd-wide outbreaks occur.",
      "Data-driven farm management increases average kid survival rates to over 92%."
    ],
    content: [
      "Trust and quantitative measurement are the most valuable currencies in modern livestock management. Historically, farmers estimated animal weight by sight, leading to underpricing during sale and inaccurate feed rationing.",
      "By adopting digital weigh scales, growth tracking apps, and routine health logs, small ruminant farmers can precisely monitor Average Daily Gain (ADG) and optimize feed formulas for maximum muscle growth.",
      "Biosecurity checklists—such as isolation protocols for newly acquired goats, routine deworming schedules, and tick control—significantly reduce mortality rates, particularly during rainy season disease surges.",
      "Ultimately, data transforms livestock farming from a high-risk gamble into a predictable, bankable enterprise that attracts commercial investment and bank credit."
    ],
    tags: ["Livestock Data", "Farm Management", "Goat Production", "Biosecurity"]
  }
];

async function seedBlogPostsIfEmpty() {
  try {
    const existing = await db.select({ id: blogPosts.id }).from(blogPosts).limit(1);
    if (existing.length === 0) {
      console.log("[notifications-service] Seeding default blog posts into PostgreSQL...");
      for (const p of defaultSeedPosts) {
        await db.insert(blogPosts).values(p as any).onConflictDoNothing();
      }
    }
  } catch (err) {
    console.warn("[notifications-service] Seed blog posts check skipped/warn:", err);
  }
}

// GET /api/blog — List All Blog Posts
blogRouter.get("/", async (req: Request, res: Response) => {
  try {
    await seedBlogPostsIfEmpty();

    const { category, search, isPublished, featured } = req.query;

    let query = db.select().from(blogPosts);

    const posts = await query.orderBy(desc(blogPosts.createdAt));

    let filtered = posts;

    if (isPublished === "true") {
      filtered = filtered.filter((p) => p.isPublished === true);
    } else if (isPublished === "false") {
      filtered = filtered.filter((p) => p.isPublished === false);
    }

    if (category && category !== "All") {
      filtered = filtered.filter(
        (p) => p.category.toLowerCase() === String(category).toLowerCase()
      );
    }

    if (featured === "true") {
      filtered = filtered.filter((p) => p.featured === true);
    }

    if (search) {
      const q = String(search).toLowerCase().trim();
      filtered = filtered.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.excerpt.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q)
      );
    }

    return res.json(filtered);
  } catch (err) {
    console.error("[blogRouter GET /] Error:", err);
    return res.status(500).json({ error: "Failed to fetch blog posts" });
  }
});

// GET /api/blog/:slug — Fetch single post by slug
blogRouter.get("/:slug", async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const [post] = await db
      .select()
      .from(blogPosts)
      .where(eq(sql`LOWER(${blogPosts.slug})`, slug.toLowerCase()))
      .limit(1);

    if (!post) {
      return res.status(404).json({ error: "Blog post not found" });
    }

    return res.json(post);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch blog post" });
  }
});

// POST /api/blog — Create new blog post (Admin / Sub-Admin)
blogRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    title: z.string().min(3),
    category: z.string().default("News"),
    readTime: z.string().optional().default("5 min read"),
    author: z.string().optional().default("Admin"),
    authorTitle: z.string().optional(),
    authorImg: z.string().optional().default("/learn/blog/Avatar.png"),
    image: z.string().optional().default("/learn/blog/singleHero.png"),
    heroImage: z.string().optional(),
    featured: z.boolean().optional().default(false),
    isPublished: z.boolean().optional().default(true),
    excerpt: z.string().min(5),
    keyTakeaways: z.array(z.string()).optional().default([]),
    content: z.array(z.string()).optional().default([]),
    tags: z.array(z.string()).optional().default([]),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const slug = parsed.data.title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  try {
    if (parsed.data.featured) {
      await db.update(blogPosts).set({ featured: false });
    }

    const [newPost] = await db
      .insert(blogPosts)
      .values({
        ...parsed.data,
        slug,
        heroImage: parsed.data.heroImage || parsed.data.image,
      })
      .returning();

    return res.status(201).json(newPost);
  } catch (err: any) {
    console.error("[blogRouter POST /] Error:", err);
    if (err?.code === "23505") {
      return res.status(409).json({ error: "A blog post with this title/slug already exists." });
    }
    return res.status(500).json({ error: "Failed to create blog post" });
  }
});

// PATCH /api/blog/:id — Update existing blog post
blogRouter.patch("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const updateData: Record<string, any> = { ...req.body, updatedAt: new Date() };

    if (updateData.title) {
      updateData.slug = updateData.title
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/[\s_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    if (updateData.featured) {
      await db.update(blogPosts).set({ featured: false });
    }

    const [updated] = await db
      .update(blogPosts)
      .set(updateData)
      .where(eq(blogPosts.id, id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Blog post not found" });
    }

    return res.json(updated);
  } catch (err) {
    console.error("[blogRouter PATCH /:id] Error:", err);
    return res.status(500).json({ error: "Failed to update blog post" });
  }
});

// DELETE /api/blog/:id — Delete blog post
blogRouter.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const [deleted] = await db
      .delete(blogPosts)
      .where(eq(blogPosts.id, id))
      .returning();

    if (!deleted) {
      return res.status(404).json({ error: "Blog post not found" });
    }

    return res.json({ message: "Blog post deleted successfully", deletedId: id });
  } catch (err) {
    console.error("[blogRouter DELETE /:id] Error:", err);
    return res.status(500).json({ error: "Failed to delete blog post" });
  }
});
