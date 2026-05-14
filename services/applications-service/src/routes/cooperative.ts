import { Router, Request, Response } from "express";
import { eq, count } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { cooperativeMembers, applications } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

// ─────────────────────────────────────────────
// POST /cooperative/join
// Called automatically after EEWYLA application is submitted.
// Public — no auth required.
// Body: { applicationId }
// ─────────────────────────────────────────────
router.post("/join", async (req: Request, res: Response) => {
  const schema = z.object({
    applicationId: z.string().uuid(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { applicationId } = parsed.data;

  try {
    // Fetch the linked application
    const [application] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);

    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    // Check if already a member (idempotent)
    const [existing] = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.email, application.email))
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
      .values({
        applicationId,
        firstName: application.firstName,
        lastName: application.lastName,
        email: application.email,
        phone: application.phone,
        address: application.address ?? undefined,
        agreesToConstitution: true,
        willingToContribute: true,
        status: "active",
      })
      .returning();

    // Publish event so notifications-service sends the welcome email
    await publishEvent("cooperative.member_joined", {
      memberId: member.id,
      applicationId,
      email: member.email,
      firstName: member.firstName,
      lastName: member.lastName,
      joinedAt: member.joinedAt.toISOString(),
    });

    return res.status(201).json({
      message: "Successfully joined the EEWYLA Cooperative",
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
      .select()
      .from(cooperativeMembers)
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