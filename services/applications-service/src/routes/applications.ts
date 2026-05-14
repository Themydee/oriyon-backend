import { Router, Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { db } from "../index";
import { applications } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

// ─────────────────────────────────────────────
// SUBMIT APPLICATION — public
// ─────────────────────────────────────────────
const submitSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(7),
  age: z.string().optional(),
  gender: z.string().optional(),
  address: z.string().optional(),
  hasID: z.string().optional(),
  businessName: z.string().optional(),
  isCoop: z.string().optional(),
  isCommunityMember: z.string().optional(),
  joinCoop: z.string().optional(),
  educationLevel: z.string().optional(),
  fieldOfStudy: z.string().optional(),
  graduationYear: z.string().optional(),
  institution: z.string().optional(),
  hasGoatExperience: z.string().optional(),
  goatExperienceRating: z.string().optional(),
  ownsGoatFarm: z.string().optional(),
  yearsOperated: z.string().optional(),
  highestAnimals: z.string().optional(),
  isDigitallyLiterate: z.string().optional(),
  digitalLiteracyRating: z.string().optional(),
  internetUsage: z.string().optional(),
  devices: z.array(z.string()).optional(),
  onlineTraining: z.string().optional(),
  platformExperience: z.string().optional(),
  toolConfidence: z.string().optional(),
  isBreadwinner: z.string().optional(),
  hasDependants: z.string().optional(),
  dependantsDetail: z.string().optional(),
  dependantsSchoolAge: z.string().optional(),
  hasDisabledInHousehold: z.string().optional(),
  disabledDetail: z.string().optional(),
  benefitedBefore: z.string().optional(),
  benefitedDetail: z.string().optional(),
  biggestChallenge: z.array(z.string()).optional(),
  whyJoin: z.string().optional(),
  hopesToAchieve: z.string().optional(),
  willingTraceability: z.string().optional(),
  hasAccess: z.array(z.string()).optional(),
  willingChampion: z.string().optional(),
  willingDonate: z.string().optional(),
  committedFullTraining: z.string().optional(),
  reference1: z.string().optional(),
  reference2: z.string().optional(),
  understandsCredit: z.boolean().optional(),
  declarationConfirmed: z.boolean().optional(),
});

// POST /applications
router.post("/", async (req: Request, res: Response) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const data = {
      ...parsed.data,
      devices: parsed.data.devices
        ? JSON.stringify(parsed.data.devices)
        : undefined,
      biggestChallenge: parsed.data.biggestChallenge
        ? JSON.stringify(parsed.data.biggestChallenge)
        : undefined,
      hasAccess: parsed.data.hasAccess
        ? JSON.stringify(parsed.data.hasAccess)
        : undefined,
    };

    const [application] = await db
      .insert(applications)
      .values(data)
      .returning();

    await publishEvent("application.submitted", {
      applicationId: application.id,
      email: application.email,
      firstName: application.firstName,
      lastName: application.lastName,
      phone: application.phone,
      submittedAt: application.submittedAt.toISOString(),
    });

    return res.status(201).json({
      message: "Application submitted successfully",
      id: application.id,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to submit application" });
  }
});

// ─────────────────────────────────────────────
// GET /applications — admin only
// ─────────────────────────────────────────────
router.get("/", async (_req: Request, res: Response) => {
  try {
    const all = await db
      .select()
      .from(applications)
      .where(eq(applications.isDeleted, false))
      .orderBy(applications.submittedAt);

    return res.json(all.map(parseArrayFields));
  } catch (err) {
    console.error("[GET /applications] error:", err); // ← add this
    return res.status(500).json({ error: "Failed to fetch applications" });
  }
});

// ─────────────────────────────────────────────
// GET /applications/status/:status
// ⚠️ MUST be before GET /:id
// ─────────────────────────────────────────────
router.get("/status/:status", async (req: Request, res: Response) => {
  const validStatuses = [
    "pending",
    "shortlisted",
    "approved",
    "rejection_review",
    "rejected",
    "archived",
  ];

  if (!validStatuses.includes(req.params.status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    const result = await db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.status, req.params.status as any),
          eq(applications.isDeleted, false)
        )
      )
      .orderBy(applications.submittedAt);

    return res.json(result.map(parseArrayFields));
  } catch {
    return res.status(500).json({ error: "Failed to fetch applications" });
  }
});

// ─────────────────────────────────────────────
// GET /applications/:id
// ⚠️ Wildcard — must be AFTER /status/:status
// ─────────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const [application] = await db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.id, req.params.id),
          eq(applications.isDeleted, false)
        )
      )
      .limit(1);

    if (!application)
      return res.status(404).json({ error: "Application not found" });

    return res.json(parseArrayFields(application));
  } catch {
    return res.status(500).json({ error: "Failed to fetch application" });
  }
});

// ─────────────────────────────────────────────
// PATCH /applications/:id/rescue
// ⚠️ MUST be before PATCH /:id
// ─────────────────────────────────────────────
router.patch("/:id/rescue", async (req: Request, res: Response) => {
  try {
    const [current] = await db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.id, req.params.id),
          eq(applications.isDeleted, false)
        )
      )
      .limit(1);

    if (!current)
      return res.status(404).json({ error: "Application not found" });

    if (current.status !== "rejection_review") {
      return res.status(400).json({
        error: `Only applications in "rejection_review" can be rescued. Current status: "${current.status}"`,
      });
    }

    const [updated] = await db
      .update(applications)
      .set({
        status: "shortlisted",
        rejectionReason: null,
        rejectedAt: null,
        reviewNotes: req.body.reviewNotes ?? current.reviewNotes,
        updatedAt: new Date(),
      })
      .where(eq(applications.id, req.params.id))
      .returning();

    await publishEvent("application.shortlisted", {
      applicationId: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      rescued: true,
    });

    return res.json(parseArrayFields(updated));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to rescue application" });
  }
});

// ─────────────────────────────────────────────
// PATCH /applications/:id — update status
// ⚠️ Wildcard — must be AFTER /:id/rescue
//
// Allowed transitions:
//   pending          → shortlisted, rejection_review
//   shortlisted      → approved, rejection_review
//   rejection_review → shortlisted, rejected
//   approved         → terminal
//   rejected         → terminal
//   archived         → terminal
// ─────────────────────────────────────────────
const updateSchema = z.object({
  status: z.enum([
    "pending",
    "shortlisted",
    "approved",
    "rejection_review",
    "rejected",
    "archived",
  ]),
  cohortId: z.string().uuid().optional(),
  reviewedBy: z.string().uuid().optional(),
  reviewNotes: z.string().optional(),
  rejectionReason: z.string().optional(),
});

const allowedTransitions: Record<string, string[]> = {
  pending:          ["shortlisted", "rejection_review"],
  shortlisted:      ["approved", "rejection_review"],
  rejection_review: ["shortlisted", "rejected"],
  approved:         [],
  rejected:         [],
  archived:         [],
};

router.patch("/:id", async (req: Request, res: Response) => {
  console.log("[PATCH] body received:", JSON.stringify(req.body, null, 2));

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    console.log("[PATCH] validation failed:", JSON.stringify(parsed.error.flatten(), null, 2));
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const [current] = await db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.id, req.params.id),
          eq(applications.isDeleted, false)
        )
      )
      .limit(1);

    if (!current)
      return res.status(404).json({ error: "Application not found" });

    const allowed = allowedTransitions[current.status] ?? [];
    if (!allowed.includes(parsed.data.status)) {
      return res.status(400).json({
        error: `Cannot transition from "${current.status}" to "${parsed.data.status}"`,
        allowedTransitions: allowed,
      });
    }

    const updatePayload: Record<string, any> = {
      ...parsed.data,
      updatedAt: new Date(),
    };

    if (parsed.data.status === "rejected") {
      updatePayload.rejectedAt = new Date();
    }
    if (parsed.data.status === "archived") {
      updatePayload.archivedAt = new Date();
    }

    const [updated] = await db
      .update(applications)
      .set(updatePayload)
      .where(eq(applications.id, req.params.id))
      .returning();

    if (!updated)
      return res.status(404).json({ error: "Application not found" });

    if (updated.status === "shortlisted") {
      await publishEvent("application.shortlisted", {
        applicationId: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
      });
    }

    if (updated.status === "approved") {
      const userId = uuidv4();
      await publishEvent("application.approved", {
        applicationId: updated.id,
        userId,
        email: updated.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
        phone: updated.phone,
        cohortId: updated.cohortId,
      });
    }

    if (updated.status === "rejection_review") {
      await publishEvent("application.rejection_review", {
        applicationId: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        rejectionReason: updated.rejectionReason,
      });
    }

    if (updated.status === "rejected") {
      await publishEvent("application.rejected", {
        applicationId: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        rejectionReason: updated.rejectionReason,
      });
    }

    return res.json(parseArrayFields(updated));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to update application" });
  }
});

// ─────────────────────────────────────────────
// DELETE /applications/:id — admin only
// Only allowed when status is "rejected"
// Soft deletes — keeps row for audit trail
// ─────────────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const [current] = await db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.id, req.params.id),
          eq(applications.isDeleted, false)
        )
      )
      .limit(1);

    if (!current)
      return res.status(404).json({ error: "Application not found" });

    if (current.status !== "rejected") {
      return res.status(400).json({
        error: `Cannot delete application with status "${current.status}". Must be "rejected" first.`,
      });
    }

    await db
      .update(applications)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(applications.id, req.params.id));

    await publishEvent("application.deleted", {
      applicationId: current.id,
      email: current.email,
      firstName: current.firstName,
      deletedAt: new Date().toISOString(),
    });

    return res.json({ message: "Application deleted successfully" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete application" });
  }
});

// ─────────────────────────────────────────────
// HELPER — parse JSON array fields
// ─────────────────────────────────────────────
function parseArrayFields(a: any) {
  return {
    ...a,
    devices: a.devices ? JSON.parse(a.devices) : [],
    biggestChallenge: a.biggestChallenge ? JSON.parse(a.biggestChallenge) : [],
    hasAccess: a.hasAccess ? JSON.parse(a.hasAccess) : [],
  };
}

export default router;