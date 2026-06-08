import { Router, Request, Response } from "express";
import { eq, count, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { cooperativeMembers, applications, cooperatives } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

// ─────────────────────────────────────────────
// GET /cooperative
// Public — list all cooperatives (or dynamic list)
// ─────────────────────────────────────────────
router.get("/", async (_req: Request, res: Response) => {
  try {
    const list = await db
      .select()
      .from(cooperatives)
      .orderBy(cooperatives.name);
    return res.json(list);
  } catch (err) {
    console.error("[cooperative] fetch cooperatives error:", err);
    return res.status(500).json({ error: "Failed to fetch cooperatives list" });
  }
});

// ─────────────────────────────────────────────
// POST /cooperative
// Admin only — create a new cooperative
// ─────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1, "Name is required"),
    state: z.string().min(1, "State is required"),
    description: z.string().optional().nullable(),
    isActive: z.boolean().optional().default(true),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const [newCoop] = await db
      .insert(cooperatives)
      .values(parsed.data)
      .returning();

    return res.status(201).json(newCoop);
  } catch (err: any) {
    console.error("[cooperative] create error:", err);
    if (err.code === "23505") { // unique violation code in PG
      return res.status(409).json({ error: "A cooperative with this name already exists" });
    }
    return res.status(500).json({ error: "Failed to create cooperative" });
  }
});

// ─────────────────────────────────────────────
// DELETE /cooperative/:id
// Admin only — delete a cooperative
// ─────────────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    // Check if there are members assigned to it first
    const [memberCount] = await db
      .select({ count: count() })
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.cooperativeId, req.params.id));

    if (Number(memberCount.count) > 0) {
      return res.status(400).json({
        error: "Cannot delete this cooperative because it has registered members associated with it.",
      });
    }

    const [deleted] = await db
      .delete(cooperatives)
      .where(eq(cooperatives.id, req.params.id))
      .returning();

    if (!deleted) {
      return res.status(404).json({ error: "Cooperative not found" });
    }

    return res.json({ message: "Cooperative deleted successfully", deleted });
  } catch (err) {
    console.error("[cooperative] delete error:", err);
    return res.status(500).json({ error: "Failed to delete cooperative" });
  }
});

// ─────────────────────────────────────────────
// POST /cooperative/join
// Called automatically after EEWYLA application is submitted.
// Public — no auth required.
// Body: { applicationId }
// ─────────────────────────────────────────────
router.post("/join", async (req: Request, res: Response) => {
  const schema = z.object({
    applicationId: z.string().uuid().optional().nullable(),
    cooperativeId: z.string().uuid().optional().nullable(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    livestockType: z.string().optional().nullable(),
    agreesToConstitution: z.boolean(),
    willingToContribute: z.boolean(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const {
    applicationId,
    cooperativeId,
    firstName,
    lastName,
    email,
    phone,
    address,
    livestockType,
    agreesToConstitution,
    willingToContribute,
  } = parsed.data;

  try {
    // Resolve cooperative ID, default to EEWYLA Oyo if none specified (safeguard)
    let finalCooperativeId = cooperativeId;
    if (!finalCooperativeId) {
      const [defaultCoop] = await db
        .select()
        .from(cooperatives)
        .where(eq(cooperatives.name, "EEWYLA Livestock Producers Cooperative Society Ltd"))
        .limit(1);
      if (defaultCoop) {
        finalCooperativeId = defaultCoop.id;
      }
    }

    let memberData: any = {
      cooperativeId: finalCooperativeId ?? undefined,
      agreesToConstitution,
      willingToContribute,
      status: "active",
      livestockType: livestockType ?? undefined,
    };

    if (applicationId) {
      // Fetch the linked application
      const [application] = await db
        .select()
        .from(applications)
        .where(eq(applications.id, applicationId))
        .limit(1);

      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      memberData = {
        ...memberData,
        applicationId,
        firstName: application.firstName,
        lastName: application.lastName,
        email: application.email,
        phone: application.phone,
        address: application.address ?? undefined,
      };
    } else {
      if (!firstName || !lastName || !email || !phone) {
        return res.status(400).json({ error: "Missing required contact fields for direct registration" });
      }
      memberData = {
        ...memberData,
        firstName,
        lastName,
        email,
        phone,
        address: address ?? undefined,
      };
    }

    // Check if already a member of this cooperative (idempotent)
    const [existing] = await db
      .select()
      .from(cooperativeMembers)
      .where(
        and(
          eq(cooperativeMembers.email, memberData.email),
          finalCooperativeId 
            ? eq(cooperativeMembers.cooperativeId, finalCooperativeId)
            : eq(cooperativeMembers.agreesToConstitution, true) // fallback
        )
      )
      .limit(1);

    if (existing) {
      return res.json({
        message: "Already a cooperative member",
        member: existing,
      });
    }

    // Create the cooperative member record
    const [member] = await db
      .insert(cooperativeMembers)
      .values(memberData)
      .returning();

    // Fetch cooperative name for notification
    let cooperativeName = "EEWYLA Cooperative";
    if (member.cooperativeId) {
      const [coop] = await db
        .select()
        .from(cooperatives)
        .where(eq(cooperatives.id, member.cooperativeId))
        .limit(1);
      if (coop) {
        cooperativeName = coop.name;
      }
    }

    // Publish event so notifications-service sends the welcome email
    await publishEvent("cooperative.member_joined", {
      memberId: member.id,
      applicationId,
      email: member.email,
      firstName: member.firstName,
      lastName: member.lastName,
      cooperativeName,
      joinedAt: member.joinedAt.toISOString(),
    });

    return res.status(201).json({
      message: `Successfully joined ${cooperativeName}`,
      member,
    });
  } catch (err) {
    console.error("[cooperative] join error:", err);
    return res.status(500).json({ error: "Failed to join cooperative" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members
// Admin only — list all cooperative members
// ─────────────────────────────────────────────
router.get("/members", async (_req: Request, res: Response) => {
  try {
    const members = await db
      .select({
        id: cooperativeMembers.id,
        applicationId: cooperativeMembers.applicationId,
        cooperativeId: cooperativeMembers.cooperativeId,
        cooperativeName: cooperatives.name,
        firstName: cooperativeMembers.firstName,
        lastName: cooperativeMembers.lastName,
        email: cooperativeMembers.email,
        phone: cooperativeMembers.phone,
        address: cooperativeMembers.address,
        livestockType: cooperativeMembers.livestockType,
        agreesToConstitution: cooperativeMembers.agreesToConstitution,
        willingToContribute: cooperativeMembers.willingToContribute,
        status: cooperativeMembers.status,
        joinedAt: cooperativeMembers.joinedAt,
        updatedAt: cooperativeMembers.updatedAt,
      })
      .from(cooperativeMembers)
      .leftJoin(cooperatives, eq(cooperativeMembers.cooperativeId, cooperatives.id))
      .orderBy(cooperativeMembers.joinedAt);

    return res.json(members);
  } catch {
    return res.status(500).json({ error: "Failed to fetch cooperative members" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members/:id
// Admin only — get a single cooperative member
// ─────────────────────────────────────────────
router.get("/members/:id", async (req: Request, res: Response) => {
  try {
    const [member] = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.id, req.params.id))
      .limit(1);

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    return res.json(member);
  } catch {
    return res.status(500).json({ error: "Failed to fetch member" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members/by-application/:applicationId
// Get cooperative member record by application ID
// NOTE: must be defined before /members/:id so Express
// doesn't match "by-application" as an :id param
// ─────────────────────────────────────────────
router.get(
  "/members/by-application/:applicationId",
  async (req: Request, res: Response) => {
    try {
      const [member] = await db
        .select()
        .from(cooperativeMembers)
        .where(eq(cooperativeMembers.applicationId, req.params.applicationId))
        .limit(1);

      if (!member) {
        return res
          .status(404)
          .json({ error: "No cooperative record found for this application" });
      }

      return res.json(member);
    } catch {
      return res.status(500).json({ error: "Failed to fetch member" });
    }
  }
);

// ─────────────────────────────────────────────
// PATCH /cooperative/members/:id
// Admin only — activate or deactivate a member
// ─────────────────────────────────────────────
router.patch("/members/:id", async (req: Request, res: Response) => {
  const schema = z.object({
    status: z.enum(["active", "inactive"]).optional(),
    livestockType: z.string().optional(),
    willingToContribute: z.boolean().optional(),
    agreesToConstitution: z.boolean().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const [updated] = await db
      .update(cooperativeMembers)
      .set({
        ...parsed.data,
        updatedAt: new Date(),
      })
      .where(eq(cooperativeMembers.id, req.params.id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Member not found" });
    }

    return res.json(updated);
  } catch (err) {
    console.error("[cooperative] patch error:", err);
    return res.status(500).json({ error: "Failed to update member" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/stats
// Admin only — quick stats for the dashboard
// ─────────────────────────────────────────────
router.get("/stats", async (_req: Request, res: Response) => {
  try {
    const [total] = await db
      .select({ count: count() })
      .from(cooperativeMembers);

    const [active] = await db
      .select({ count: count() })
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.status, "active"));

    const [inactive] = await db
      .select({ count: count() })
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.status, "inactive"));

    return res.json({
      total: Number(total.count),
      active: Number(active.count),
      inactive: Number(inactive.count),
    });
  } catch {
    return res.status(500).json({ error: "Failed to fetch cooperative stats" });
  }
});

export default router;