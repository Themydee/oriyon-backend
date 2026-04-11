import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { db } from "../index";
import { applications } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

const submitSchema = z.object({
  // Personal
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

  // Education
  educationLevel: z.string().optional(),
  fieldOfStudy: z.string().optional(),
  graduationYear: z.string().optional(),
  institution: z.string().optional(),

  // Experience
  hasGoatExperience: z.string().optional(),
  goatExperienceRating: z.string().optional(),
  ownsGoatFarm: z.string().optional(),
  yearsOperated: z.string().optional(),
  highestAnimals: z.string().optional(),

  // Digital Literacy
  isDigitallyLiterate: z.string().optional(),
  digitalLiteracyRating: z.string().optional(),
  internetUsage: z.string().optional(),
  devices: z.array(z.string()).optional(),
  onlineTraining: z.string().optional(),
  platformExperience: z.string().optional(),
  toolConfidence: z.string().optional(),

  // Household
  isBreadwinner: z.string().optional(),
  hasDependants: z.string().optional(),
  dependantsDetail: z.string().optional(),
  dependantsSchoolAge: z.string().optional(),
  hasDisabledInHousehold: z.string().optional(),
  disabledDetail: z.string().optional(),

  // Motivation
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

  // References
  reference1: z.string().optional(),
  reference2: z.string().optional(),
  understandsCredit: z.boolean().optional(),
  declarationConfirmed: z.boolean().optional(),
});

// POST /applications — public
router.post("/", async (req: Request, res: Response) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  try {
    // Serialize array fields to JSON strings for storage
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

// GET /applications — admin only
router.get("/", async (_req: Request, res: Response) => {
  try {
    const all = await db
      .select()
      .from(applications)
      .orderBy(applications.submittedAt);

    // Parse JSON array fields back before returning
    const parsed = all.map((a) => ({
      ...a,
      devices: a.devices ? JSON.parse(a.devices) : [],
      biggestChallenge: a.biggestChallenge ? JSON.parse(a.biggestChallenge) : [],
      hasAccess: a.hasAccess ? JSON.parse(a.hasAccess) : [],
    }));

    return res.json(parsed);
  } catch {
    return res.status(500).json({ error: "Failed to fetch applications" });
  }
});

// GET /applications/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const [application] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);

    if (!application)
      return res.status(404).json({ error: "Application not found" });

    return res.json({
      ...application,
      devices: application.devices ? JSON.parse(application.devices) : [],
      biggestChallenge: application.biggestChallenge
        ? JSON.parse(application.biggestChallenge)
        : [],
      hasAccess: application.hasAccess ? JSON.parse(application.hasAccess) : [],
    });
  } catch {
    return res.status(500).json({ error: "Failed to fetch application" });
  }
});

// PATCH /applications/:id — admin only
router.patch("/:id", async (req: Request, res: Response) => {
  const schema = z.object({
    status: z.enum(["pending", "shortlisted", "approved", "rejected"]),
    cohortId: z.string().uuid().optional(),
    reviewedBy: z.string().uuid().optional(),
    reviewNotes: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [updated] = await db
      .update(applications)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(applications.id, req.params.id))
      .returning();

    if (!updated)
      return res.status(404).json({ error: "Application not found" });

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

    if (updated.status === "rejected") {
      await publishEvent("application.rejected", {
        applicationId: updated.id,
        email: updated.email,
        firstName: updated.firstName,
      });
    }

    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to update application" });
  }
});

export default router;