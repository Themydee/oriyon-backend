import { Router, Request, Response } from "express";
import { eq, and, sql, count } from "drizzle-orm";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import postgres from "postgres";
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
  desiredRoleOption1: z.string().optional(),
  desiredRoleOption2: z.string().optional(),
  idDocument: z.string().optional(),
  idDocumentUrl: z.string().optional(),
  idType: z.string().optional(),
  idFilename: z.string().optional(),
  idMimeType: z.string().optional(),
});

type ApplicationStatus = "pending" | "shortlisted" | "approved" | "rejection_review" | "rejected" | "archived";

const updateSchema = z.object({
  status: z
    .enum([
      "pending",
      "shortlisted",
      "approved",
      "rejection_review",
      "rejected",
      "archived",
    ])
    .optional(),
  cohortId: z.string().uuid().optional().nullable().or(z.literal("")),
  groupId: z.string().uuid().optional().nullable().or(z.literal("")),
  reviewedBy: z.string().uuid().optional().nullable().or(z.literal("")),
  reviewNotes: z.string().optional().nullable(),
  rejectionReason: z.string().optional().nullable(),
  approvedRole: z.string().optional().nullable(),
  kycStatus: z.string().optional().nullable(),
  kycRejectionReason: z.string().optional().nullable(),
});

const allowedTransitions: Record<string, string[]> = {
  pending: ["pending", "shortlisted", "approved", "rejection_review", "rejected", "archived"],
  shortlisted: ["pending", "shortlisted", "approved", "rejection_review", "rejected", "archived"],
  rejection_review: ["pending", "shortlisted", "approved", "rejection_review", "rejected", "archived"],
  approved: ["pending", "shortlisted", "approved", "rejection_review", "rejected", "archived"],
  rejected: ["pending", "shortlisted", "approved", "rejection_review", "rejected", "archived"],
  archived: ["pending", "shortlisted", "approved", "rejection_review", "rejected", "archived"],
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



router.post("/", async (req: Request, res: Response) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  try {
    // Duplicate email check
    const [dupEmail] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(sql`LOWER(${applications.email})`, parsed.data.email.toLowerCase()))
      .limit(1);
    if (dupEmail) {
      return res.status(409).json({ error: "An application with this email already exists." });
    }

    // Duplicate phone check
    const [dupPhone] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.phone, parsed.data.phone))
      .limit(1);
    if (dupPhone) {
      return res.status(409).json({ error: "An application with this phone number already exists." });
    }

    // Duplicate name check (regular & inversed, case-insensitive)
    const fNameLower = parsed.data.firstName.toLowerCase();
    const lNameLower = parsed.data.lastName.toLowerCase();
    const [dupName] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        sql`(LOWER(${applications.firstName}) = ${fNameLower} AND LOWER(${applications.lastName}) = ${lNameLower}) OR 
            (LOWER(${applications.firstName}) = ${lNameLower} AND LOWER(${applications.lastName}) = ${fNameLower})`
      )
      .limit(1);
    if (dupName) {
      return res.status(409).json({ error: "An application with this name already exists." });
    }

    const passesAutoShortlist = evaluateAutoShortlist(parsed.data);
    const calculatedStatus: ApplicationStatus = passesAutoShortlist ? "shortlisted" : "pending";

    const hasDocFile = Boolean(parsed.data.idDocument || parsed.data.idDocumentUrl);
    const data = {
      ...parsed.data,
      status: calculatedStatus,
      devices: parsed.data.devices ? JSON.stringify(parsed.data.devices) : undefined,
      biggestChallenge: parsed.data.biggestChallenge ? JSON.stringify(parsed.data.biggestChallenge) : undefined,
      hasAccess: parsed.data.hasAccess ? JSON.stringify(parsed.data.hasAccess) : undefined,
      idDocumentUrl: parsed.data.idDocumentUrl || parsed.data.idDocument || undefined,
      idType: parsed.data.idType || (parsed.data.hasID && parsed.data.hasID !== "No" ? parsed.data.hasID : undefined),
      idFilename: parsed.data.idFilename || (hasDocFile ? `${parsed.data.firstName}_${parsed.data.lastName}_ID` : undefined),
      idMimeType: parsed.data.idMimeType || (hasDocFile ? "image/jpeg" : undefined),
      idUploadedAt: hasDocFile ? new Date() : undefined,
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
// AUTO-SHORTLIST BATCH RUNNER
// ─────────────────────────────────────────────
export async function runAutoShortlistCheck() {
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

    return {
      totalPendingScanned: activePendingApplications.length,
      automaticallyShortlistedCount: processedCount,
    };
  } catch (err) {
    console.error("[Auto Shortlist Check Error]:", err);
    throw err;
  }
}

// ─────────────────────────────────────────────
// POST /applications/auto-shortlist-existing (Batch Migration Endpoint)
// ─────────────────────────────────────────────
router.post("/auto-shortlist-existing", async (_req: Request, res: Response) => {
  try {
    const result = await runAutoShortlistCheck();
    return res.json({
      message: "Batch process completed successfully",
      ...result,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to process retroactive application updates" });
  }
});

// ─────────────────────────────────────────────
// GET /applications — Admin Only View List (Paginated)
// ─────────────────────────────────────────────
router.get("/", async (req: Request, res: Response) => {
  try {
    const { page, limit, status, search, cohortId } = req.query;

    const p = Math.max(1, parseInt(String(page || 1), 10) || 1);
    const l = Math.min(200, Math.max(1, parseInt(String(limit || 50), 10) || 50));
    const offset = (p - 1) * l;

    const conditions = [eq(applications.isDeleted, false)];

    if (status && status !== "all") {
      conditions.push(eq(applications.status, String(status) as any));
    }

    if (cohortId && cohortId !== "all") {
      conditions.push(eq(applications.cohortId, String(cohortId)));
    }

    if (search) {
      const q = `%${String(search).trim().toLowerCase()}%`;
      conditions.push(
        sql`(
          LOWER(${applications.firstName}) LIKE ${q} OR
          LOWER(${applications.lastName}) LIKE ${q} OR
          LOWER(${applications.email}) LIKE ${q} OR
          LOWER(${applications.phone}) LIKE ${q} OR
          LOWER(COALESCE(${applications.businessName}, '')) LIKE ${q}
        )`
      );
    }

    const whereClause = and(...conditions);

    const [countRes] = await db
      .select({ total: count() })
      .from(applications)
      .where(whereClause);

    const total = Number(countRes?.total || 0);

    const pageRows = await db
      .select()
      .from(applications)
      .where(whereClause)
      .orderBy(applications.submittedAt)
      .limit(l)
      .offset(offset);

    const parsedRows = pageRows.map(parseArrayFields);

    return res.json({
      applications: parsedRows,
      data: parsedRows,
      total,
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l),
    });
  } catch (err) {
    console.error("[GET /applications] Drizzle query error, using raw fallback:", err);
    try {
      const rawRes: any = await db.execute(sql`SELECT * FROM applications WHERE is_deleted = false ORDER BY submitted_at ASC LIMIT 50`);
      const rows = (rawRes?.rows || rawRes || []) as any[];
      const parsedRows = rows.map(parseArrayFields);
      return res.json({
        applications: parsedRows,
        data: parsedRows,
        total: parsedRows.length,
        page: 1,
        limit: 50,
        totalPages: 1,
      });
    } catch (fallbackErr) {
      console.error("[GET /applications] fallback error:", fallbackErr);
      return res.status(500).json({ error: "Failed to fetch applications" });
    }
  }
});

// ─────────────────────────────────────────────
// ADMIN — Analytics
// GET /applications/admin/analytics
// Returns counts by status, counts by cohort, and recent daily submission trends
// ─────────────────────────────────────────────
router.get("/admin/analytics", async (req: Request, res: Response) => {
  try {
    // Counts by status
    const byStatus = await db
      .select({ status: applications.status, count: count() })
      .from(applications)
      .where(eq(applications.isDeleted, false))
      .groupBy(applications.status);

    // Counts by cohort (cohortId may be null)
    const byCohort = await db
      .select({ cohortId: applications.cohortId, count: count() })
      .from(applications)
      .where(eq(applications.isDeleted, false))
      .groupBy(applications.cohortId);

    // Daily submissions for the last 30 days
    const daily = await db
      .select({ date: sql<string>`TO_CHAR(${applications.submittedAt}::date, 'YYYY-MM-DD')`, count: count() })
      .from(applications)
      .where(and(eq(applications.isDeleted, false), sql`${applications.submittedAt} >= (CURRENT_DATE - INTERVAL '30 days')`))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    return res.json({ byStatus, byCohort, daily });
  } catch (err) {
    console.error("[GET /applications/admin/analytics] error:", err);
    return res.status(500).json({ error: "Failed to fetch analytics" });
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
  } catch (err) {
    console.error("[GET /applications/status] error, running fallback:", err);
    try {
      const rawRes: any = await db.execute(sql`SELECT * FROM applications WHERE status = ${req.params.status} AND is_deleted = false ORDER BY submitted_at ASC`);
      const rows = (rawRes?.rows || rawRes || []) as any[];
      return res.json(rows.map(parseArrayFields));
    } catch {
      return res.status(500).json({ error: "Failed to fetch applications" });
    }
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
  } catch (err) {
    console.error("[GET /applications/:id] error, running fallback:", err);
    try {
      const rawRes: any = await db.execute(sql`SELECT * FROM applications WHERE id = ${req.params.id} AND is_deleted = false LIMIT 1`);
      const rows = (rawRes?.rows || rawRes || []) as any[];
      if (!rows || rows.length === 0) return res.status(404).json({ error: "Application not found" });
      return res.json(parseArrayFields(rows[0]));
    } catch {
      return res.status(500).json({ error: "Failed to fetch application" });
    }
  }
});


// ─────────────────────────────────────────────
// POST /applications/bulk-email — Send Bulk Email to Applicants
// ─────────────────────────────────────────────
router.post("/bulk-email", async (req: Request, res: Response) => {
  const bulkEmailSchema = z.object({
    status: z.enum([
      "all",
      "pending",
      "shortlisted",
      "approved",
      "rejection_review",
      "rejected",
      "archived",
    ]),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Message body is required"),
  });

  const parsed = bulkEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const { status, subject, body } = parsed.data;

    let queryConditions = [eq(applications.isDeleted, false)];
    if (status !== "all") {
      queryConditions.push(eq(applications.status, status as any));
    }

    const targets = await db
      .select()
      .from(applications)
      .where(and(...queryConditions));

    if (targets.length === 0) {
      return res.status(404).json({ error: "No applicants found matching criteria." });
    }

    // Publish event for each target to be processed by notifications service
    for (const app of targets) {
      await publishEvent("application.custom_email_requested", {
        applicationId: app.id,
        email: app.email,
        firstName: app.firstName,
        lastName: app.lastName,
        subject,
        body,
      });
    }

    return res.json({
      message: `Bulk email successfully queued for ${targets.length} applicants.`,
      count: targets.length,
    });
  } catch (err) {
    console.error("[POST /applications/bulk-email] error:", err);
    return res.status(500).json({ error: "Failed to dispatch bulk email requests" });
  }
});

// ─────────────────────────────────────────────
// POST /applications/:id/email & POST /applications/:id/send-email — Send Direct Custom Email
// ─────────────────────────────────────────────
const handleSendEmailRequest = async (req: Request, res: Response) => {
  const emailSchema = z.object({
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Message body is required"),
  });

  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    let application: any = null;
    try {
      const [appRecord] = await db
        .select()
        .from(applications)
        .where(
          and(
            eq(applications.id, req.params.id),
            eq(applications.isDeleted, false)
          )
        )
        .limit(1);
      application = appRecord;
    } catch (dbErr) {
      console.error("[POST /applications/:id/email] Drizzle query failed, using raw fallback:", dbErr);
      const rawRes: any = await db.execute(sql`SELECT * FROM applications WHERE id = ${req.params.id} AND is_deleted = false LIMIT 1`);
      const rows = (rawRes?.rows || rawRes || []) as any[];
      if (rows && rows.length > 0) {
        application = {
          id: rows[0].id,
          email: rows[0].email,
          firstName: rows[0].first_name || rows[0].firstName,
          lastName: rows[0].last_name || rows[0].lastName,
        };
      }
    }

    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    await publishEvent("application.custom_email_requested", {
      applicationId: application.id,
      email: application.email,
      firstName: application.firstName,
      lastName: application.lastName,
      subject: parsed.data.subject,
      body: parsed.data.body,
    });

    return res.json({ message: "Custom email request dispatched successfully" });
  } catch (err) {
    console.error("[POST /applications/:id/email] error:", err);
    return res.status(500).json({ error: "Failed to dispatch email request" });
  }
};

router.post("/:id/email", handleSendEmailRequest);
router.post("/:id/send-email", handleSendEmailRequest);

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

    if (current.status !== "rejection_review" && current.status !== "rejected") {
      return res.status(400).json({
        error: `Only applications in "rejection_review" or "rejected" status can be rescued. Current status: "${current.status}"`,
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

    try {
      await publishEvent("application.shortlisted", {
        applicationId: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
        rescued: true,
      });
    } catch (pubErr) {
      console.error("[applications-service][rescue] Non-fatal publish error:", pubErr);
    }

    return res.json(parseArrayFields(updated));
  } catch (err: any) {
    console.error("[applications-service][rescue] Error:", err);
    return res.status(500).json({ error: err?.message || "Failed to rescue application" });
  }
});

const validApplicationColumns = new Set([
  "firstName", "lastName", "email", "phone", "age", "gender", "address",
  "hasID", "idType", "idDocumentUrl", "idFilename", "idMimeType", "idUploadedAt",
  "kycStatus", "kycRejectionReason", "businessName", "isCoop", "isCommunityMember",
  "joinCoop", "educationLevel", "fieldOfStudy", "graduationYear", "institution",
  "hasGoatExperience", "goatExperienceRating", "ownsGoatFarm", "yearsOperated",
  "highestAnimals", "isDigitallyLiterate", "digitalLiteracyRating", "internetUsage",
  "devices", "onlineTraining", "platformExperience", "toolConfidence", "isBreadwinner",
  "hasDependants", "dependantsDetail", "dependantsSchoolAge", "hasDisabledInHousehold",
  "disabledDetail", "benefitedBefore", "benefitedDetail", "biggestChallenge", "whyJoin",
  "hopesToAchieve", "willingTraceability", "hasAccess", "willingChampion", "willingDonate",
  "committedFullTraining", "reference1", "reference2", "understandsCredit",
  "declarationConfirmed", "desiredRoleOption1", "desiredRoleOption2", "approvedRole",
  "status", "cohortId", "reviewedBy", "reviewNotes", "rejectionReason", "rejectedAt",
  "archivedAt", "isDeleted", "deletedAt", "submittedAt", "updatedAt"
]);

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

    if (parsed.data.status) {
      const allowed = allowedTransitions[current.status] ?? [];
      if (!allowed.includes(parsed.data.status)) {
        return res.status(400).json({
          error: `Cannot transition from "${current.status}" to "${parsed.data.status}"`,
          allowedTransitions: allowed,
        });
      }
    }

    const targetStatus = parsed.data.status || current.status;
    const wasApproved = current.status === "approved";
    const groupId = parsed.data.groupId;

    const updatePayload: Record<string, any> = {
      updatedAt: new Date(),
    };

    for (const [key, value] of Object.entries(parsed.data)) {
      if (validApplicationColumns.has(key) && value !== undefined) {
        if ((key === "cohortId" || key === "reviewedBy") && value === "") {
          updatePayload[key] = null;
        } else {
          updatePayload[key] = value;
        }
      }
    }

    if (wasApproved && targetStatus === "rejection_review") {
      updatePayload.approvedRole = null;
      updatePayload.cohortId = null;
    }

    if (targetStatus === "rejected") {
      updatePayload.rejectedAt = new Date();
    }
    if (targetStatus === "archived") {
      updatePayload.archivedAt = new Date();
    }

    const [updated] = await db
      .update(applications)
      .set(updatePayload as any)
      .where(eq(applications.id, req.params.id))
      .returning();

    if (!updated)
      return res.status(404).json({ error: "Application not found" });

    if (parsed.data.status && updated.status === "shortlisted") {
      await publishEvent("application.shortlisted", {
        applicationId: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
      });
    }

    if (parsed.data.status && updated.status === "approved") {
      const userId = uuidv4();
      await publishEvent("application.approved", {
        applicationId: updated.id,
        userId,
        email: updated.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
        phone: updated.phone,
        cohortId: updated.cohortId,
        approvedRole: updated.approvedRole,
        groupId: groupId || undefined,
      });
    }

    if (parsed.data.status && updated.status === "rejection_review") {
      if (wasApproved) {
        await publishEvent("application.revoked", {
          applicationId: updated.id,
          email: updated.email,
        });
      }
      await publishEvent("application.rejection_review", {
        applicationId: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        rejectionReason: updated.rejectionReason,
      });
    }

    if (parsed.data.status && updated.status === "rejected") {
      await publishEvent("application.rejected", {
        applicationId: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        rejectionReason: updated.rejectionReason,
      });
    }

    return res.json(parseArrayFields(updated));
  } catch (err: any) {
    console.error("[applications-service][PATCH] Error updating application:", err);
    return res.status(500).json({ error: err?.message || "Failed to update application" });
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
// HELPER — PARSE JSON ARRAYS & NORMALIZE FIELDS
// ─────────────────────────────────────────────
function parseArrayFields(a: any) {
  if (!a) return a;
  const parseSafe = (val: any) => {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (typeof val === "object") return val;
    try {
      return JSON.parse(val);
    } catch {
      return [];
    }
  };

  return {
    ...a,
    devices: parseSafe(a.devices),
    biggestChallenge: parseSafe(a.biggest_challenge || a.biggestChallenge),
    hasAccess: parseSafe(a.has_access || a.hasAccess),
    firstName: a.first_name || a.firstName,
    lastName: a.last_name || a.lastName,
    idDocumentUrl: a.id_document_url || a.idDocumentUrl,
    idType: a.id_type || a.idType,
    idFilename: a.id_filename || a.idFilename,
    idMimeType: a.id_mime_type || a.idMimeType,
    idUploadedAt: a.id_uploaded_at || a.idUploadedAt,
    kycStatus: a.kyc_status || a.kycStatus,
    kycRejectionReason: a.kyc_rejection_reason || a.kycRejectionReason,
  };
}

export default router;