import { Router, Request, Response } from "express";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { db } from "../index";
import {
  masterCurricula,
  curriculumRevisions,
  curriculumModules,
  cohortCurriculumBindings,
  cohortWeekSchedules,
  curriculumAuditLogs,
  weeks,
  lessons,
  quizzes,
} from "../db/schema";

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ADMIN_ROLES = ["admin"];
const ADMIN_OR_SUBADMIN_ROLES = ["admin", "sub_admin"];
const STAFF_ROLES = ["admin", "sub_admin", "trainer", "lead_trainer"];

function getRoleAndActor(req: Request): { role: string | null; userId: string | null } {
  const headerRole = (req.headers["x-user-role"] as string | undefined)?.trim()?.toLowerCase() || null;
  const headerUserId = (req.headers["x-user-id"] as string | undefined)?.trim() || null;
  if (headerRole && headerUserId) {
    return { role: headerRole, userId: headerUserId };
  }
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ") && process.env.JWT_SECRET) {
    try {
      const payload = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET) as {
        role?: string;
        userId?: string;
        sub?: string;
        id?: string;
      };
      return {
        role: payload?.role ? payload.role.toLowerCase() : headerRole,
        userId: headerUserId || payload?.userId || payload?.sub || payload?.id || null,
      };
    } catch {
      // ignore
    }
  }
  return { role: headerRole, userId: headerUserId };
}

function hasRole(req: Request, allowed: string[]): boolean {
  const { role } = getRoleAndActor(req);
  return Boolean(role && allowed.includes(role));
}

export async function getLatestPublishedRevision() {
  const [rev] = await db
    .select()
    .from(curriculumRevisions)
    .where(eq(curriculumRevisions.status, "published"))
    .orderBy(desc(curriculumRevisions.versionNumber))
    .limit(1);
  return rev || null;
}

export async function resolveEffectiveRevisionForCohort(cohortId?: string | null) {
  if (!cohortId || !UUID_REGEX.test(cohortId)) {
    const rev = await getLatestPublishedRevision();
    return { revision: rev, binding: null };
  }

  const [existingBinding] = await db
    .select()
    .from(cohortCurriculumBindings)
    .where(eq(cohortCurriculumBindings.cohortId, cohortId))
    .limit(1);

  if (existingBinding) {
    const [rev] = await db
      .select()
      .from(curriculumRevisions)
      .where(eq(curriculumRevisions.id, existingBinding.revisionId))
      .limit(1);
    return { revision: rev || null, binding: existingBinding };
  }

  // New cohort automatically inherits the latest published Master Curriculum revision
  const latestPublished = await getLatestPublishedRevision();
  if (!latestPublished) {
    return { revision: null, binding: null };
  }

  const [insertedBinding] = await db
    .insert(cohortCurriculumBindings)
    .values({
      cohortId,
      revisionId: latestPublished.id,
      isPinned: true,
    })
    .onConflictDoNothing()
    .returning();

  if (insertedBinding) {
    await db
      .insert(curriculumAuditLogs)
      .values({
        curriculumId: latestPublished.curriculumId,
        revisionId: latestPublished.id,
        cohortId,
        action: "cohort_bound",
        changeClassification: "non_breaking",
        reason: `Auto-bound cohort to published revision ${latestPublished.versionLabel}`,
      })
      .catch(() => {});
  }

  return { revision: latestPublished, binding: insertedBinding || null };
}

export async function overlayCohortSchedules<T extends { id: string; weekNumber: number; unlockDate?: Date | null; requiresQuizPass?: boolean }>(
  weeksList: T[],
  cohortId?: string | null
): Promise<Array<T & { scheduleUnlockDate?: Date | null; practicalRequired?: boolean }>> {
  if (!cohortId || !UUID_REGEX.test(cohortId) || weeksList.length === 0) {
    return weeksList;
  }

  const schedules = await db
    .select()
    .from(cohortWeekSchedules)
    .where(eq(cohortWeekSchedules.cohortId, cohortId));

  if (!schedules.length) {
    return weeksList;
  }

  const scheduleByWeek = new Map(schedules.map((s) => [s.weekNumber, s]));
  return weeksList.map((wk) => {
    const sched = scheduleByWeek.get(wk.weekNumber);
    if (!sched) return wk;
    return {
      ...wk,
      unlockDate: sched.unlockDate ?? wk.unlockDate ?? null,
      scheduleUnlockDate: sched.unlockDate ?? null,
      requiresQuizPass: sched.quizRequired,
      practicalRequired: sched.practicalRequired,
    };
  });
}

export const masterCurriculumRouter = Router();

// GET /lms/curriculum/master — View Master Curriculum & all revisions (Staff/Admin/Sub-Admin/Trainer)
masterCurriculumRouter.get("/master", async (req: Request, res: Response) => {
  if (!hasRole(req, STAFF_ROLES)) {
    return res.status(403).json({ error: "Forbidden. Staff access required." });
  }
  try {
    const [curriculum] = await db.select().from(masterCurricula).limit(1);
    const revisions = curriculum
      ? await db
          .select()
          .from(curriculumRevisions)
          .where(eq(curriculumRevisions.curriculumId, curriculum.id))
          .orderBy(desc(curriculumRevisions.versionNumber))
      : [];
    const publishedRevision = revisions.find((r) => r.status === "published") || null;
    return res.json({ curriculum: curriculum || null, revisions, publishedRevision });
  } catch (err) {
    console.error("[masterCurriculum GET /master] error:", err);
    return res.status(500).json({ error: "Failed to load master curriculum" });
  }
});

// POST /lms/curriculum/revisions — Create a new draft revision cloned from published/source revision (Admin only)
masterCurriculumRouter.post("/revisions", async (req: Request, res: Response) => {
  if (!hasRole(req, ADMIN_ROLES)) {
    return res.status(403).json({ error: "Forbidden. Only administrators can create curriculum revisions." });
  }
  const { userId, role } = getRoleAndActor(req);

  const schema = z.object({
    sourceRevisionId: z.string().uuid().optional(),
    changeClassification: z.enum(["non_breaking", "structural", "controlled"]).default("structural"),
    summary: z.string().trim().min(3, "Revision summary is required."),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
  }

  try {
    const [master] = await db.select().from(masterCurricula).limit(1);
    if (!master) {
      return res.status(404).json({ error: "Master curriculum not initialized. Run Phase 1 backfill first." });
    }

    const existingRevs = await db
      .select()
      .from(curriculumRevisions)
      .where(eq(curriculumRevisions.curriculumId, master.id))
      .orderBy(desc(curriculumRevisions.versionNumber));

    const sourceRev = parsed.data.sourceRevisionId
      ? existingRevs.find((r) => r.id === parsed.data.sourceRevisionId)
      : existingRevs.find((r) => r.status === "published") || existingRevs[0];

    if (!sourceRev) {
      return res.status(404).json({ error: "Source curriculum revision not found." });
    }

    const nextVersionNumber = (existingRevs[0]?.versionNumber || 0) + 1;
    const versionLabel = `v${nextVersionNumber}.0`;

    const createdRev = await db.transaction(async (tx) => {
      const [newRev] = await tx
        .insert(curriculumRevisions)
        .values({
          curriculumId: master.id,
          versionLabel,
          versionNumber: nextVersionNumber,
          changeClassification: parsed.data.changeClassification,
          status: "draft",
          summary: parsed.data.summary,
          parentRevisionId: sourceRev.id,
          createdBy: userId && UUID_REGEX.test(userId) ? userId : null,
        })
        .returning();

      // Clone modules
      const sourceModules = await tx
        .select()
        .from(curriculumModules)
        .where(eq(curriculumModules.revisionId, sourceRev.id));
      const moduleIdMap = new Map<string, string>();
      for (const mod of sourceModules) {
        const [clonedMod] = await tx
          .insert(curriculumModules)
          .values({
            revisionId: newRev.id,
            title: mod.title,
            description: mod.description,
            orderIndex: mod.orderIndex,
          })
          .returning();
        moduleIdMap.set(mod.id, clonedMod.id);
      }

      // Clone weeks, lessons, and quizzes into the new draft revision (preserving source rows intact)
      const sourceWeeks = await tx
        .select()
        .from(weeks)
        .where(and(eq(weeks.curriculumRevisionId, sourceRev.id), eq(weeks.isArchived, false)))
        .orderBy(asc(weeks.weekNumber));

      for (const sw of sourceWeeks) {
        const [clonedWeek] = await tx
          .insert(weeks)
          .values({
            cohortId: sw.cohortId,
            curriculumRevisionId: newRev.id,
            moduleId: sw.moduleId ? moduleIdMap.get(sw.moduleId) || null : null,
            title: sw.title,
            description: sw.description,
            weekNumber: sw.weekNumber,
            requiresQuizPass: sw.requiresQuizPass,
            isPublished: sw.isPublished,
            objectives: sw.objectives,
            unlockDate: sw.unlockDate,
          })
          .returning();

        const sourceLessons = await tx
          .select()
          .from(lessons)
          .where(and(eq(lessons.weekId, sw.id), eq(lessons.isArchived, false)))
          .orderBy(asc(lessons.order));

        for (const sl of sourceLessons) {
          await tx.insert(lessons).values({
            weekId: clonedWeek.id,
            curriculumRevisionId: newRev.id,
            title: sl.title,
            description: sl.description,
            type: sl.type,
            videoUrl: sl.videoUrl,
            audioUrl: sl.audioUrl,
            documentUrl: sl.documentUrl,
            body: sl.body,
            durationMinutes: sl.durationMinutes,
            order: sl.order,
            isPublished: sl.isPublished,
          });
        }

        const sourceQuizzes = await tx
          .select()
          .from(quizzes)
          .where(and(eq(quizzes.weekId, sw.id), eq(quizzes.isArchived, false)));

        for (const sq of sourceQuizzes) {
          await tx.insert(quizzes).values({
            weekId: clonedWeek.id,
            cohortId: sq.cohortId,
            curriculumRevisionId: newRev.id,
            title: sq.title,
            questions: sq.questions,
            passingScore: sq.passingScore,
            isPublished: sq.isPublished,
          });
        }
      }

      await tx.insert(curriculumAuditLogs).values({
        curriculumId: master.id,
        revisionId: newRev.id,
        action: "revision_created",
        changeClassification: parsed.data.changeClassification,
        actorId: userId && UUID_REGEX.test(userId) ? userId : null,
        actorRole: role,
        reason: parsed.data.summary,
        details: { sourceRevisionId: sourceRev.id, versionLabel },
      });

      return newRev;
    });

    return res.status(201).json(createdRev);
  } catch (err) {
    console.error("[masterCurriculum POST /revisions] error:", err);
    return res.status(500).json({ error: "Failed to create curriculum revision" });
  }
});

// POST /lms/curriculum/revisions/:revisionId/publish — Publish a draft revision (Admin only)
masterCurriculumRouter.post("/revisions/:revisionId/publish", async (req: Request, res: Response) => {
  if (!hasRole(req, ADMIN_ROLES)) {
    return res.status(403).json({ error: "Forbidden. Only administrators can publish curriculum revisions." });
  }
  const { userId, role } = getRoleAndActor(req);
  const { revisionId } = req.params;
  if (!UUID_REGEX.test(revisionId)) {
    return res.status(400).json({ error: "Invalid revision ID" });
  }

  try {
    const [targetRev] = await db
      .select()
      .from(curriculumRevisions)
      .where(eq(curriculumRevisions.id, revisionId))
      .limit(1);
    if (!targetRev) {
      return res.status(404).json({ error: "Revision not found" });
    }

    const now = new Date();
    const published = await db.transaction(async (tx) => {
      // Archive prior published revision (pinned cohorts remain on their pinned revision!)
      await tx
        .update(curriculumRevisions)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            eq(curriculumRevisions.curriculumId, targetRev.curriculumId),
            eq(curriculumRevisions.status, "published")
          )
        );

      const [updated] = await tx
        .update(curriculumRevisions)
        .set({
          status: "published",
          publishedBy: userId && UUID_REGEX.test(userId) ? userId : null,
          publishedAt: now,
          effectiveFrom: req.body?.effectiveFrom ? new Date(req.body.effectiveFrom) : now,
          updatedAt: now,
        })
        .where(eq(curriculumRevisions.id, revisionId))
        .returning();

      await tx.insert(curriculumAuditLogs).values({
        curriculumId: targetRev.curriculumId,
        revisionId: targetRev.id,
        action: "revision_published",
        changeClassification: targetRev.changeClassification,
        actorId: userId && UUID_REGEX.test(userId) ? userId : null,
        actorRole: role,
        reason: typeof req.body?.reason === "string" ? req.body.reason : `Published ${targetRev.versionLabel}`,
      });

      return updated;
    });

    return res.json(published);
  } catch (err) {
    console.error("[masterCurriculum POST /revisions/:revisionId/publish] error:", err);
    return res.status(500).json({ error: "Failed to publish curriculum revision" });
  }
});

// POST /lms/curriculum/revisions/:revisionId/rollback — Non-destructively restore a prior revision as published (Admin only)
masterCurriculumRouter.post("/revisions/:revisionId/rollback", async (req: Request, res: Response) => {
  if (!hasRole(req, ADMIN_ROLES)) {
    return res.status(403).json({ error: "Forbidden. Only administrators can roll back revisions." });
  }
  const { userId, role } = getRoleAndActor(req);
  const { revisionId } = req.params;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!UUID_REGEX.test(revisionId)) {
    return res.status(400).json({ error: "Invalid revision ID" });
  }
  if (reason.length < 5) {
    return res.status(400).json({ error: "A rollback audit reason (min 5 characters) is required." });
  }

  try {
    const [targetRev] = await db
      .select()
      .from(curriculumRevisions)
      .where(eq(curriculumRevisions.id, revisionId))
      .limit(1);
    if (!targetRev) {
      return res.status(404).json({ error: "Revision not found" });
    }

    const now = new Date();
    const restored = await db.transaction(async (tx) => {
      await tx
        .update(curriculumRevisions)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            eq(curriculumRevisions.curriculumId, targetRev.curriculumId),
            eq(curriculumRevisions.status, "published")
          )
        );

      const [updated] = await tx
        .update(curriculumRevisions)
        .set({ status: "published", updatedAt: now })
        .where(eq(curriculumRevisions.id, revisionId))
        .returning();

      await tx.insert(curriculumAuditLogs).values({
        curriculumId: targetRev.curriculumId,
        revisionId: targetRev.id,
        action: "rollback",
        changeClassification: "controlled",
        actorId: userId && UUID_REGEX.test(userId) ? userId : null,
        actorRole: role,
        reason,
      });

      return updated;
    });

    return res.json(restored);
  } catch (err) {
    console.error("[masterCurriculum POST /revisions/:revisionId/rollback] error:", err);
    return res.status(500).json({ error: "Failed to roll back curriculum revision" });
  }
});

// GET /lms/curriculum/bindings — List cohort-to-revision bindings (Staff/Admin/Sub-Admin)
masterCurriculumRouter.get("/bindings", async (req: Request, res: Response) => {
  if (!hasRole(req, STAFF_ROLES)) {
    return res.status(403).json({ error: "Forbidden. Staff access required." });
  }
  try {
    const rows = await db
      .select({
        id: cohortCurriculumBindings.id,
        cohortId: cohortCurriculumBindings.cohortId,
        cohortName: cohortCurriculumBindings.cohortName,
        revisionId: cohortCurriculumBindings.revisionId,
        isPinned: cohortCurriculumBindings.isPinned,
        boundAt: cohortCurriculumBindings.boundAt,
        previousRevisionId: cohortCurriculumBindings.previousRevisionId,
        upgradeReason: cohortCurriculumBindings.upgradeReason,
        versionLabel: curriculumRevisions.versionLabel,
        versionNumber: curriculumRevisions.versionNumber,
        revisionStatus: curriculumRevisions.status,
      })
      .from(cohortCurriculumBindings)
      .leftJoin(curriculumRevisions, eq(cohortCurriculumBindings.revisionId, curriculumRevisions.id))
      .orderBy(asc(cohortCurriculumBindings.createdAt));

    return res.json(rows);
  } catch (err) {
    console.error("[masterCurriculum GET /bindings] error:", err);
    return res.status(500).json({ error: "Failed to fetch cohort curriculum bindings" });
  }
});

// POST /lms/curriculum/cohorts/:cohortId/upgrade — Explicitly upgrade a cohort to a target revision (Admin only)
masterCurriculumRouter.post("/cohorts/:cohortId/upgrade", async (req: Request, res: Response) => {
  if (!hasRole(req, ADMIN_ROLES)) {
    return res.status(403).json({ error: "Forbidden. Only administrators can upgrade cohort curriculum revisions." });
  }
  const { userId, role } = getRoleAndActor(req);
  const { cohortId } = req.params;
  if (!UUID_REGEX.test(cohortId)) {
    return res.status(400).json({ error: "Invalid cohortId" });
  }

  const schema = z.object({
    revisionId: z.string().uuid(),
    reason: z.string().trim().min(5, "Audit reason (min 5 characters) is required for cohort upgrade."),
    cohortName: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
  }

  try {
    const [targetRev] = await db
      .select()
      .from(curriculumRevisions)
      .where(eq(curriculumRevisions.id, parsed.data.revisionId))
      .limit(1);
    if (!targetRev) {
      return res.status(404).json({ error: "Target curriculum revision not found" });
    }

    const [existing] = await db
      .select()
      .from(cohortCurriculumBindings)
      .where(eq(cohortCurriculumBindings.cohortId, cohortId))
      .limit(1);

    const now = new Date();
    const binding = existing
      ? (
          await db
            .update(cohortCurriculumBindings)
            .set({
              revisionId: targetRev.id,
              previousRevisionId: existing.revisionId,
              upgradeReason: parsed.data.reason,
              boundBy: userId && UUID_REGEX.test(userId) ? userId : null,
              boundAt: now,
              updatedAt: now,
            })
            .where(eq(cohortCurriculumBindings.id, existing.id))
            .returning()
        )[0]
      : (
          await db
            .insert(cohortCurriculumBindings)
            .values({
              cohortId,
              cohortName: parsed.data.cohortName || null,
              revisionId: targetRev.id,
              isPinned: true,
              boundBy: userId && UUID_REGEX.test(userId) ? userId : null,
              boundAt: now,
              upgradeReason: parsed.data.reason,
            })
            .returning()
        )[0];

    await db.insert(curriculumAuditLogs).values({
      curriculumId: targetRev.curriculumId,
      revisionId: targetRev.id,
      cohortId,
      action: "cohort_upgraded",
      changeClassification: targetRev.changeClassification,
      actorId: userId && UUID_REGEX.test(userId) ? userId : null,
      actorRole: role,
      reason: parsed.data.reason,
      details: {
        previousRevisionId: existing?.revisionId || null,
        newRevisionId: targetRev.id,
        versionLabel: targetRev.versionLabel,
      },
    });

    return res.json(binding);
  } catch (err) {
    console.error("[masterCurriculum POST /cohorts/:cohortId/upgrade] error:", err);
    return res.status(500).json({ error: "Failed to upgrade cohort curriculum revision" });
  }
});

// GET /lms/curriculum/cohorts/:cohortId/schedule — Get per-cohort week schedules
masterCurriculumRouter.get("/cohorts/:cohortId/schedule", async (req: Request, res: Response) => {
  const { cohortId } = req.params;
  if (!UUID_REGEX.test(cohortId)) {
    return res.status(400).json({ error: "Invalid cohortId" });
  }
  try {
    const schedules = await db
      .select()
      .from(cohortWeekSchedules)
      .where(eq(cohortWeekSchedules.cohortId, cohortId))
      .orderBy(asc(cohortWeekSchedules.weekNumber));
    return res.json(schedules);
  } catch (err) {
    console.error("[masterCurriculum GET /cohorts/:cohortId/schedule] error:", err);
    return res.status(500).json({ error: "Failed to fetch cohort schedule" });
  }
});

// PUT /lms/curriculum/cohorts/:cohortId/schedule — Manage cohort week unlock dates & requirements (Admin or Sub-Admin)
masterCurriculumRouter.put("/cohorts/:cohortId/schedule", async (req: Request, res: Response) => {
  if (!hasRole(req, ADMIN_OR_SUBADMIN_ROLES)) {
    return res.status(403).json({ error: "Forbidden. Admin or sub-admin access required." });
  }
  const { cohortId } = req.params;
  if (!UUID_REGEX.test(cohortId)) {
    return res.status(400).json({ error: "Invalid cohortId" });
  }

  const itemSchema = z.object({
    weekNumber: z.number().int().min(1).max(52),
    unlockDate: z.string().nullable().optional(),
    practicalRequired: z.boolean().optional().default(true),
    quizRequired: z.boolean().optional().default(true),
  });
  const schema = z.object({
    schedules: z.array(itemSchema).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
  }

  try {
    const now = new Date();
    const results = [];
    for (const item of parsed.data.schedules) {
      const unlockVal = item.unlockDate ? new Date(item.unlockDate) : null;
      const [existing] = await db
        .select()
        .from(cohortWeekSchedules)
        .where(
          and(
            eq(cohortWeekSchedules.cohortId, cohortId),
            eq(cohortWeekSchedules.weekNumber, item.weekNumber)
          )
        )
        .limit(1);

      if (existing) {
        const [updated] = await db
          .update(cohortWeekSchedules)
          .set({
            unlockDate: unlockVal,
            practicalRequired: item.practicalRequired,
            quizRequired: item.quizRequired,
            updatedAt: now,
          })
          .where(eq(cohortWeekSchedules.id, existing.id))
          .returning();
        results.push(updated);
      } else {
        const [inserted] = await db
          .insert(cohortWeekSchedules)
          .values({
            cohortId,
            weekNumber: item.weekNumber,
            unlockDate: unlockVal,
            practicalRequired: item.practicalRequired,
            quizRequired: item.quizRequired,
          })
          .returning();
        results.push(inserted);
      }
    }
    return res.json(results);
  } catch (err) {
    console.error("[masterCurriculum PUT /cohorts/:cohortId/schedule] error:", err);
    return res.status(500).json({ error: "Failed to update cohort schedule" });
  }
});

// GET /lms/curriculum/audit-logs — View curriculum audit history (Admin / Sub-Admin)
masterCurriculumRouter.get("/audit-logs", async (req: Request, res: Response) => {
  if (!hasRole(req, ADMIN_OR_SUBADMIN_ROLES)) {
    return res.status(403).json({ error: "Forbidden. Admin or sub-admin access required." });
  }
  try {
    const logs = await db
      .select()
      .from(curriculumAuditLogs)
      .orderBy(desc(curriculumAuditLogs.createdAt))
      .limit(100);
    return res.json(logs);
  } catch (err) {
    console.error("[masterCurriculum GET /audit-logs] error:", err);
    return res.status(500).json({ error: "Failed to fetch curriculum audit logs" });
  }
});
