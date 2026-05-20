import { Router, Request, Response } from "express";
import { eq, and, sql, count } from "drizzle-orm";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { db } from "../index";
import { applications } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

// ─────────────────────────────────────────────
// VALIDATION SCHEMAS
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

type ApplicationStatus = "pending" | "shortlisted" | "approved" | "rejection_review" | "rejected" | "archived";

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

// ─────────────────────────────────────────────
// AUTOMATED SELECTION CRITERIA ENGINE (v2.2.2)
// ─────────────────────────────────────────────
function evaluateAutoShortlist(app: z.infer<typeof submitSchema>): boolean {
  // 1. AGE ELIGIBILITY GATE (Pass/Fail: 18 - 40)
  if (app.age) {
    const ageNum = parseInt(app.age, 10);
    if (!isNaN(ageNum) && (ageNum < 18 || ageNum > 40)) return false;
  }

  // 2. RESIDENCY GATE (Pass/Fail: Pilot States Only)
  const pilotStates = ["oyo", "edo", "kwara", "fct", "abuja"];
  const addressString = (app.address || "").toLowerCase();
  const matchesPilotState = pilotStates.some((state) => addressString.includes(state));
  if (!matchesPilotState) return false;

  let totalScore = 0;

  // 3. VULNERABILITY OR MARGINALIZATION SCORING (Max 20 Points)
  const detailsText = `${app.whyJoin || ""} ${app.dependantsDetail || ""}`.toLowerCase();
  if (detailsText.includes("widow") && (detailsText.includes("defense") || detailsText.includes("military") || detailsText.includes("soldier"))) {
    totalScore += 8;
  }
  
  if ((app.isBreadwinner === "yes" || app.isBreadwinner === "true") && (app.hasDependants === "yes" || app.hasDependants === "true")) {
    totalScore += 5;
  }
  
  if (detailsText.includes("orphan") || detailsText.includes("orphaned")) {
    totalScore += 5;
  }

  // 4. EDUCATION LEVEL & DIGITAL INFRASTRUCTURE SCORING (Max 15 Points)
  const isAnimalScience = ["animal science", "animal husbandry"].some((field) => 
    (app.fieldOfStudy || "").toLowerCase().includes(field)
  );
  if (isAnimalScience) {
    totalScore += 10;
  } else if (app.educationLevel && ["secondary", "diploma"].some((l) => app.educationLevel!.toLowerCase().includes(l))) {
    totalScore += 5;
  }

  const deviceList = app.devices || [];
  const hasSmartphone = deviceList.some((d) => d.toLowerCase().includes("smartphone") || d.toLowerCase().includes("phone"));
  if (hasSmartphone || app.isDigitallyLiterate === "yes" || app.internetUsage === "daily") {
    totalScore += 5;
  }

  // 5. EXISTING LIVESTOCK INVOLVEMENT (Max 15 Points)
  if (app.ownsGoatFarm === "yes" || app.ownsGoatFarm === "true" || app.hasGoatExperience === "yes") {
    totalScore += 10;
    const rating = parseInt(app.goatExperienceRating || "0", 10);
    if (rating >= 3) totalScore += 5;
  }

  // 6. COMMITMENT TO TRAINING (Max 15 Points)
  if (app.committedFullTraining === "yes" || app.committedFullTraining === "true" || app.declarationConfirmed === true) {
    totalScore += 15;
  }

  // 7. COMMUNITY LEADERSHIP POTENTIAL (Max 10 Points)
  if (app.isCoop === "yes" || app.isCommunityMember === "yes") {
    totalScore += 10;
  }

  return totalScore >= 25;
}


router.get("/", async (_req: Request, res: Response) => {
  try {
    // ── Status counts ────────────────────────
    const statusCounts = await db
      .select({
        status: applications.status,
        count: count(),
      })
      .from(applications)
      .where(eq(applications.isDeleted, false))
      .groupBy(applications.status);
 
    // ── Gender breakdown ─────────────────────
    const genderCounts = await db
      .select({
        gender: applications.gender,
        count: count(),
      })
      .from(applications)
      .where(eq(applications.isDeleted, false))
      .groupBy(applications.gender);
 
    // ── Age bracket breakdown ────────────────
    // age is stored as varchar e.g. "25", "38"
    const ageBrackets = await db.execute(sql`
      SELECT
        CASE
          WHEN CAST(age AS INTEGER) < 20              THEN 'Under 20'
          WHEN CAST(age AS INTEGER) BETWEEN 20 AND 29 THEN '20–29'
          WHEN CAST(age AS INTEGER) BETWEEN 30 AND 39 THEN '30–39'
          WHEN CAST(age AS INTEGER) BETWEEN 40 AND 49 THEN '40–49'
          WHEN CAST(age AS INTEGER) >= 50             THEN '50+'
          ELSE 'Unknown'
        END AS bracket,
        COUNT(*) AS count
      FROM applications
      WHERE is_deleted = false
        AND age IS NOT NULL
        AND age ~ '^[0-9]+$'
      GROUP BY bracket
      ORDER BY bracket
    `);
 
    // ── Location / address breakdown ─────────
    // Extract state-like keywords from address field
    // since there's no dedicated state column.
    // We use a simple keyword match for Nigerian states.
    const locationCounts = await db.execute(sql`
      SELECT
        CASE
          WHEN LOWER(address) LIKE '%lagos%'     THEN 'Lagos'
          WHEN LOWER(address) LIKE '%oyo%'       THEN 'Oyo'
          WHEN LOWER(address) LIKE '%ogun%'      THEN 'Ogun'
          WHEN LOWER(address) LIKE '%osun%'      THEN 'Osun'
          WHEN LOWER(address) LIKE '%ondo%'      THEN 'Ondo'
          WHEN LOWER(address) LIKE '%ekiti%'     THEN 'Ekiti'
          WHEN LOWER(address) LIKE '%kwara%'     THEN 'Kwara'
          WHEN LOWER(address) LIKE '%abuja%'
            OR LOWER(address) LIKE '%fct%'       THEN 'FCT'
          WHEN LOWER(address) LIKE '%kano%'      THEN 'Kano'
          WHEN LOWER(address) LIKE '%kaduna%'    THEN 'Kaduna'
          WHEN LOWER(address) LIKE '%ibadan%'    THEN 'Oyo'
          WHEN LOWER(address) LIKE '%ikorodu%'   THEN 'Lagos'
          ELSE 'Other'
        END AS state,
        COUNT(*) AS count
      FROM applications
      WHERE is_deleted = false
        AND address IS NOT NULL
      GROUP BY state
      ORDER BY count DESC
      LIMIT 12
    `);
 
    // ── Education breakdown ──────────────────
    const educationCounts = await db
      .select({
        level: applications.educationLevel,
        count: count(),
      })
      .from(applications)
      .where(eq(applications.isDeleted, false))
      .groupBy(applications.educationLevel);
 
    // ── Total ────────────────────────────────
    const [totalRow] = await db
      .select({ total: count() })
      .from(applications)
      .where(eq(applications.isDeleted, false));
 
    // ── Submissions over time (last 30 days) ─
    const submissionsOverTime = await db.execute(sql`
      SELECT
        DATE_TRUNC('day', submitted_at) AS day,
        COUNT(*) AS count
      FROM applications
      WHERE is_deleted = false
        AND submitted_at >= NOW() - INTERVAL '30 days'
      GROUP BY day
      ORDER BY day ASC
    `);
 
    // ── Goat experience ──────────────────────
    const goatExperience = await db
      .select({
        hasExperience: applications.hasGoatExperience,
        count: count(),
      })
      .from(applications)
      .where(eq(applications.isDeleted, false))
      .groupBy(applications.hasGoatExperience);
 
    return res.json({
      total: Number(totalRow.total),
      byStatus:      statusCounts.map((r) => ({ status: r.status, count: Number(r.count) })),
      byGender:      genderCounts.map((r) => ({ gender: r.gender ?? "Unknown", count: Number(r.count) })),
      byAge:         (ageBrackets as any[]).map((r) => ({ bracket: r.bracket, count: Number(r.count) })),
      byLocation:    (locationCounts as any[]).map((r) => ({ state: r.state, count: Number(r.count) })),
      byEducation:   educationCounts.map((r) => ({ level: r.level ?? "Unknown", count: Number(r.count) })),
      byGoatExp:     goatExperience.map((r) => ({ hasExperience: r.hasExperience, count: Number(r.count) })),
      submissionsOverTime: (submissionsOverTime as any[]).map((r) => ({
        day:   r.day,
        count: Number(r.count),
      })),
    });
  } catch (err) {
    console.error("[analytics] error:", err);
    return res.status(500).json({ error: "Failed to compute analytics" });
  }
});

// ─────────────────────────────────────────────
// POST /applications — Public Submission Engine
// ─────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const passesAutoShortlist = evaluateAutoShortlist(parsed.data);
    const calculatedStatus: ApplicationStatus = passesAutoShortlist ? "shortlisted" : "pending";

    const data = {
      ...parsed.data,
      status: calculatedStatus,
      devices: parsed.data.devices ? JSON.stringify(parsed.data.devices) : undefined,
      biggestChallenge: parsed.data.biggestChallenge ? JSON.stringify(parsed.data.biggestChallenge) : undefined,
      hasAccess: parsed.data.hasAccess ? JSON.stringify(parsed.data.hasAccess) : undefined,
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

    if (calculatedStatus === "shortlisted") {
      await publishEvent("application.shortlisted", {
        applicationId: application.id,
        email: application.email,
        firstName: application.firstName,
        lastName: application.lastName,
        isAutomated: true,
      });
    }

    return res.status(201).json({
      message: passesAutoShortlist 
        ? "Application submitted and automatically shortlisted based on criteria." 
        : "Application submitted successfully and is currently under review.",
      id: application.id,
      status: application.status,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to submit application" });
  }
});

// ─────────────────────────────────────────────
// POST /applications/auto-shortlist-existing (Batch Migration Endpoint)
// ─────────────────────────────────────────────
router.post("/auto-shortlist-existing", async (_req: Request, res: Response) => {
  try {
    const activePendingApplications = await db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.status, "pending"),
          eq(applications.isDeleted, false)
        )
      );

    let processedCount = 0;

    for (const app of activePendingApplications) {
      // Normalize null database values out into JavaScript undefined structures
      const sanitizeNulls = Object.fromEntries(
        Object.entries(app).map(([key, val]) => [key, val === null ? undefined : val])
      );

      const typedPayload = {
        ...sanitizeNulls,
        devices: app.devices ? JSON.parse(app.devices) : [],
        biggestChallenge: app.biggestChallenge ? JSON.parse(app.biggestChallenge) : [],
        hasAccess: app.hasAccess ? JSON.parse(app.hasAccess) : [],
      } as unknown as z.infer<typeof submitSchema>;

      if (evaluateAutoShortlist(typedPayload)) {
        await db
          .update(applications)
          .set({ status: "shortlisted" as any, updatedAt: new Date() })
          .where(eq(applications.id, app.id));

        await publishEvent("application.shortlisted", {
          applicationId: app.id,
          email: app.email,
          firstName: app.firstName,
          lastName: app.lastName,
          isAutomatedBatchMigration: true,
        });

        processedCount++;
      }
    }

    return res.json({
      message: "Batch process completed successfully",
      totalPendingScanned: activePendingApplications.length,
      automaticallyShortlistedCount: processedCount,
    });
  } catch (err) {
    console.error("[Batch Shortlist Error]:", err);
    return res.status(500).json({ error: "Failed to process retroactive application updates" });
  }
});

// ─────────────────────────────────────────────
// GET /applications — Admin Only View List
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
    console.error("[GET /applications] error:", err);
    return res.status(500).json({ error: "Failed to fetch applications" });
  }
});

// ─────────────────────────────────────────────
// GET /applications/status/:status
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
        status: "shortlisted" as any,
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
// PATCH /applications/:id — Manual Administrative Updates
// ─────────────────────────────────────────────
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
      .set(updatePayload as any)
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
// DELETE /applications/:id — Soft Delete Archived Nodes
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
// HELPER — PARSE JSON ARRAYS
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