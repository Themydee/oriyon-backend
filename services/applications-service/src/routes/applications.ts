import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { db } from "../index";
import { applications } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

const submitSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(7),
  state: z.string().optional(),
  gender: z.string().optional(),
  ageRange: z.string().optional(),
  occupation: z.string().optional(),
  livestockExperience: z.string().optional(),
  motivation: z.string().optional(),
});

// POST /applications  — public
router.post("/", async (req: Request, res: Response) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [application] = await db
      .insert(applications)
      .values(parsed.data)
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

// GET /applications  — admin only (role enforced at gateway)
router.get("/", async (_req: Request, res: Response) => {
  try {
    const all = await db.select().from(applications).orderBy(applications.submittedAt);
    return res.json(all);
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
    if (!application) return res.status(404).json({ error: "Application not found" });
    return res.json(application);
  } catch {
    return res.status(500).json({ error: "Failed to fetch application" });
  }
});

// PATCH /applications/:id  — shortlist / approve / reject
// Auth enforced at gateway via authenticate + requireRole("admin")
router.patch("/:id", async (req: Request, res: Response) => {
  const schema = z.object({
    status: z.enum(["pending", "shortlisted", "approved", "rejected"]),
    cohortId: z.string().uuid().optional(),
    reviewedBy: z.string().uuid().optional(),
    reviewNotes: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [updated] = await db
      .update(applications)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(applications.id, req.params.id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Application not found" });

    if (updated.status === "approved") {
      // Generate a fresh UUID for the new user.
      // IMPORTANT: must NOT reuse updated.id (the application ID).
      // This UUID is passed to both user-service and auth-service
      // so they create matching records under the same identity.
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