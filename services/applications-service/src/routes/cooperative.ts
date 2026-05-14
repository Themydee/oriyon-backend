import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { cooperativeMembers, applications } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

// ─────────────────────────────────────────────
// POST /cooperative/join
// Public — called immediately after EEWYLA submission
// ─────────────────────────────────────────────
const joinSchema = z.object({
  applicationId: z.string().uuid(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(7),
  address: z.string().optional(),
  livestockType: z.string().optional(),
  agreesToConstitution: z.literal(true, {
    errorMap: () => ({
      message:
        "You must agree to the EEWYLA Livestock Producers Cooperative Society Constitution",
    }),
  }),
  willingToContribute: z.literal(true, {
    errorMap: () => ({
      message:
        "You must agree to pay registration fees and regular contributions as required by Section 5",
    }),
  }),
});

router.post("/join", async (req: Request, res: Response) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  const { applicationId, ...data } = parsed.data;

  try {
    // Verify application exists
    const [application] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);

    if (!application)
      return res.status(404).json({ error: "Application not found" });

    // Prevent duplicate membership per application
    const [existing] = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.applicationId, applicationId))
      .limit(1);

    if (existing)
      return res.status(409).json({
        message: "Already registered as a cooperative member",
        member: existing,
      });

    const [member] = await db
      .insert(cooperativeMembers)
      .values({ ...data, applicationId })
      .returning();

    await publishEvent("cooperative.member_joined", {
      memberId: member.id,
      applicationId,
      email: member.email,
      firstName: member.firstName,
      lastName: member.lastName,
      joinedAt: member.joinedAt.toISOString(),
    });

    return res.status(201).json({
      message: "Successfully registered as a cooperative member",
      member,
    });
  } catch (err) {
    console.error("[POST /cooperative/join]", err);
    return res.status(500).json({ error: "Failed to register cooperative member" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members — admin
// All cooperative members, ordered by join date
// ─────────────────────────────────────────────
router.get("/members", async (_req: Request, res: Response) => {
  try {
    const all = await db
      .select()
      .from(cooperativeMembers)
      .orderBy(cooperativeMembers.joinedAt);
    return res.json(all);
  } catch (err) {
    console.error("[GET /cooperative/members]", err);
    return res.status(500).json({ error: "Failed to fetch cooperative members" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members/status/:status — admin
// Filter by active / inactive
// ⚠️ MUST be before GET /members/:id
// ─────────────────────────────────────────────
router.get("/members/status/:status", async (req: Request, res: Response) => {
  const validStatuses = ["active", "inactive"];
  if (!validStatuses.includes(req.params.status)) {
    return res.status(400).json({ error: "Invalid status. Must be 'active' or 'inactive'" });
  }

  try {
    const all = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.status, req.params.status as "active" | "inactive"))
      .orderBy(cooperativeMembers.joinedAt);
    return res.json(all);
  } catch (err) {
    console.error("[GET /cooperative/members/status/:status]", err);
    return res.status(500).json({ error: "Failed to fetch members by status" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members/:id — admin
// Single member by ID
// ⚠️ Wildcard — must be AFTER /members/status/:status
// ─────────────────────────────────────────────
router.get("/members/:id", async (req: Request, res: Response) => {
  try {
    const [member] = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.id, req.params.id))
      .limit(1);

    if (!member)
      return res.status(404).json({ error: "Member not found" });

    return res.json(member);
  } catch (err) {
    console.error("[GET /cooperative/members/:id]", err);
    return res.status(500).json({ error: "Failed to fetch member" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/by-application/:applicationId
// Look up cooperative membership by application ID
// ─────────────────────────────────────────────
router.get("/by-application/:applicationId", async (req: Request, res: Response) => {
  try {
    const [member] = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.applicationId, req.params.applicationId))
      .limit(1);

    if (!member)
      return res.status(404).json({ error: "No cooperative membership found for this application" });

    return res.json(member);
  } catch (err) {
    console.error("[GET /cooperative/by-application/:applicationId]", err);
    return res.status(500).json({ error: "Failed to fetch membership" });
  }
});

// ─────────────────────────────────────────────
// PATCH /cooperative/members/:id
// Admin toggles active / inactive
// ─────────────────────────────────────────────
router.patch("/members/:id", async (req: Request, res: Response) => {
  const schema = z.object({
    status: z.enum(["active", "inactive"]),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [updated] = await db
      .update(cooperativeMembers)
      .set({ status: parsed.data.status, updatedAt: new Date() })
      .where(eq(cooperativeMembers.id, req.params.id))
      .returning();

    if (!updated)
      return res.status(404).json({ error: "Member not found" });

    return res.json(updated);
  } catch (err) {
    console.error("[PATCH /cooperative/members/:id]", err);
    return res.status(500).json({ error: "Failed to update member status" });
  }
});

export default router;