import "dotenv/config";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../index";
import {
  weeks,
  lessons,
  quizzes,
  progress,
  quizAttempts,
  masterCurricula,
  curriculumRevisions,
  cohortCurriculumBindings,
  cohortWeekSchedules,
  curriculumAuditLogs,
} from "../db/schema";

interface CohortSummary {
  cohortId: string;
  totalWeeks: number;
  distinctWeeks: number;
  publishedWeeks: number;
  lessonsCount: number;
  quizzesCount: number;
  progressRefs: number;
  quizAttemptRefs: number;
}

export interface BackfillOptions {
  apply: boolean;
  sourceCohortId?: string;
  allCohortIds?: Array<{ id: string; name?: string }>;
}

export async function runMasterCurriculumBackfill(options: BackfillOptions) {
  const allWeeks = await db.select().from(weeks).orderBy(asc(weeks.cohortId), asc(weeks.weekNumber), asc(weeks.createdAt));
  const allLessons = await db.select().from(lessons);
  const allQuizzes = await db.select().from(quizzes);
  const allProgress = await db.select({ weekId: progress.weekId, lessonId: progress.lessonId }).from(progress);
  const allAttempts = await db.select({ weekId: quizAttempts.weekId, quizId: quizAttempts.quizId }).from(quizAttempts);

  const lessonsByWeek = new Map<string, number>();
  for (const l of allLessons) lessonsByWeek.set(l.weekId, (lessonsByWeek.get(l.weekId) || 0) + 1);

  const quizzesByWeek = new Map<string, number>();
  for (const q of allQuizzes) quizzesByWeek.set(q.weekId, (quizzesByWeek.get(q.weekId) || 0) + 1);

  const progressByWeek = new Map<string, number>();
  for (const p of allProgress) progressByWeek.set(p.weekId, (progressByWeek.get(p.weekId) || 0) + 1);

  const attemptsByWeek = new Map<string, number>();
  for (const a of allAttempts) attemptsByWeek.set(a.weekId, (attemptsByWeek.get(a.weekId) || 0) + 1);

  const cohortMap = new Map<string, typeof allWeeks>();
  for (const w of allWeeks) {
    const list = cohortMap.get(w.cohortId) || [];
    list.push(w);
    cohortMap.set(w.cohortId, list);
  }

  const summaries: CohortSummary[] = [];
  for (const [cid, list] of cohortMap.entries()) {
    summaries.push({
      cohortId: cid,
      totalWeeks: list.length,
      distinctWeeks: new Set(list.map((w) => w.weekNumber)).size,
      publishedWeeks: list.filter((w) => w.isPublished).length,
      lessonsCount: list.reduce((acc, w) => acc + (lessonsByWeek.get(w.id) || 0), 0),
      quizzesCount: list.reduce((acc, w) => acc + (quizzesByWeek.get(w.id) || 0), 0),
      progressRefs: list.reduce((acc, w) => acc + (progressByWeek.get(w.id) || 0), 0),
      quizAttemptRefs: list.reduce((acc, w) => acc + (attemptsByWeek.get(w.id) || 0), 0),
    });
  }

  // Pick authoritative source cohort: explicit flag or cohort with most distinct weeks & progress
  const sortedCandidates = [...summaries].sort(
    (a, b) =>
      b.distinctWeeks - a.distinctWeeks ||
      b.lessonsCount - a.lessonsCount ||
      b.progressRefs - a.progressRefs
  );
  const authoritativeCohortId = options.sourceCohortId || sortedCandidates[0]?.cohortId || "";

  const authWeeksRaw = cohortMap.get(authoritativeCohortId) || [];
  // Deduplicate by weekNumber, preferring published weeks with more lessons/progress
  const canonicalWeekByNumber = new Map<number, (typeof authWeeksRaw)[number]>();
  for (const w of authWeeksRaw) {
    const existing = canonicalWeekByNumber.get(w.weekNumber);
    if (!existing) {
      canonicalWeekByNumber.set(w.weekNumber, w);
    } else {
      const scoreNew = (w.isPublished ? 1000 : 0) + (lessonsByWeek.get(w.id) || 0) * 10 + (progressByWeek.get(w.id) || 0);
      const scoreOld = (existing.isPublished ? 1000 : 0) + (lessonsByWeek.get(existing.id) || 0) * 10 + (progressByWeek.get(existing.id) || 0);
      if (scoreNew > scoreOld) canonicalWeekByNumber.set(w.weekNumber, w);
    }
  }

  const canonicalWeeks = Array.from(canonicalWeekByNumber.values()).sort((a, b) => a.weekNumber - b.weekNumber);
  const canonicalWeekIds = canonicalWeeks.map((w) => w.id);
  const canonicalLessons = allLessons.filter((l) => canonicalWeekIds.includes(l.weekId));
  const canonicalQuizzes = allQuizzes.filter((q) => canonicalWeekIds.includes(q.weekId));

  const nonAuthoritativeWeeks = allWeeks.filter((w) => !canonicalWeekIds.includes(w.id));
  const duplicateSummary = nonAuthoritativeWeeks.map((w) => ({
    weekId: w.id,
    cohortId: w.cohortId,
    weekNumber: w.weekNumber,
    title: w.title,
    lessonsCount: lessonsByWeek.get(w.id) || 0,
    quizzesCount: quizzesByWeek.get(w.id) || 0,
    progressRefs: progressByWeek.get(w.id) || 0,
    quizAttemptRefs: attemptsByWeek.get(w.id) || 0,
    action: "PRESERVE_UNTOUCHED_NO_DELETE",
  }));

  const cohortsToBind = new Map<string, string | undefined>();
  for (const s of summaries) cohortsToBind.set(s.cohortId, undefined);
  for (const c of options.allCohortIds || []) cohortsToBind.set(c.id, c.name);

  const preview = {
    mode: options.apply ? "APPLY" : "DRY_RUN",
    cohortSummaries: summaries,
    authoritativeSourceCohortId: authoritativeCohortId,
    promotedWeekIds: canonicalWeekIds,
    promotedLessonCount: canonicalLessons.length,
    promotedQuizCount: canonicalQuizzes.length,
    duplicateOrPartialWeeks: duplicateSummary,
    cohortsToBind: Array.from(cohortsToBind.entries()).map(([id, name]) => ({ cohortId: id, cohortName: name || null })),
    schedulesToBackfill: allWeeks.length,
  };

  if (!options.apply) {
    return preview;
  }

  await db.transaction(async (tx) => {
    // 1. Ensure Master Curriculum record exists
    const [existingMaster] = await tx
      .select()
      .from(masterCurricula)
      .where(eq(masterCurricula.code, "EEWYLA-MASTER"))
      .limit(1);

    const master =
      existingMaster ||
      (
        await tx
          .insert(masterCurricula)
          .values({
            code: "EEWYLA-MASTER",
            title: "Oriyon EEWYLA Master Curriculum",
            description: "Single authoritative curriculum for all Oriyon training cohorts.",
            isActive: true,
          })
          .returning()
      )[0];

    // 2. Ensure v1.0 Revision exists
    const [existingRev] = await tx
      .select()
      .from(curriculumRevisions)
      .where(and(eq(curriculumRevisions.curriculumId, master.id), eq(curriculumRevisions.versionNumber, 1)))
      .limit(1);

    const rev1 =
      existingRev ||
      (
        await tx
          .insert(curriculumRevisions)
          .values({
            curriculumId: master.id,
            versionLabel: "v1.0",
            versionNumber: 1,
            changeClassification: "initial",
            status: "published",
            summary: `Promoted in-place from cohort ${authoritativeCohortId}`,
            effectiveFrom: new Date(),
            publishedAt: new Date(),
          })
          .returning()
      )[0];

    // 3. Promote existing weeks, lessons, quizzes in-place (preserving exact UUIDs!)
    if (canonicalWeekIds.length > 0) {
      await tx
        .update(weeks)
        .set({ curriculumRevisionId: rev1.id })
        .where(and(inArray(weeks.id, canonicalWeekIds), sql`${weeks.curriculumRevisionId} IS NULL`));

      await tx
        .update(lessons)
        .set({ curriculumRevisionId: rev1.id })
        .where(and(inArray(lessons.weekId, canonicalWeekIds), sql`${lessons.curriculumRevisionId} IS NULL`));

      await tx
        .update(quizzes)
        .set({ curriculumRevisionId: rev1.id })
        .where(and(inArray(quizzes.weekId, canonicalWeekIds), sql`${quizzes.curriculumRevisionId} IS NULL`));

      await tx
        .update(progress)
        .set({ curriculumRevisionId: rev1.id })
        .where(and(inArray(progress.weekId, canonicalWeekIds), sql`${progress.curriculumRevisionId} IS NULL`));

      await tx
        .update(quizAttempts)
        .set({ curriculumRevisionId: rev1.id })
        .where(and(inArray(quizAttempts.weekId, canonicalWeekIds), sql`${quizAttempts.curriculumRevisionId} IS NULL`));
    }

    // 4. Bind cohorts to v1.0 (pinned by default, idempotent)
    for (const [cid, cname] of cohortsToBind.entries()) {
      await tx
        .insert(cohortCurriculumBindings)
        .values({
          cohortId: cid,
          cohortName: cname || null,
          revisionId: rev1.id,
          isPinned: true,
        })
        .onConflictDoNothing();
    }

    // 5. Backfill cohort_week_schedules from existing weeks.unlockDate (non-destructive, idempotent)
    for (const w of allWeeks) {
      const masterWeek = canonicalWeekByNumber.get(w.weekNumber);
      await tx
        .insert(cohortWeekSchedules)
        .values({
          cohortId: w.cohortId,
          weekNumber: w.weekNumber,
          masterWeekId: masterWeek?.id || w.id,
          unlockDate: w.unlockDate || null,
          practicalRequired: true,
          quizRequired: w.requiresQuizPass,
        })
        .onConflictDoNothing();
    }

    // 6. Record audit log
    await tx.insert(curriculumAuditLogs).values({
      curriculumId: master.id,
      revisionId: rev1.id,
      cohortId: authoritativeCohortId || null,
      action: "backfill_promoted",
      changeClassification: "initial",
      reason: "Phase 1 in-place promotion of authoritative curriculum into v1.0",
      details: {
        promotedWeeks: canonicalWeekIds.length,
        promotedLessons: canonicalLessons.length,
        promotedQuizzes: canonicalQuizzes.length,
        preservedDuplicateWeeks: duplicateSummary.length,
      },
    });
  });

  return preview;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const sourceArg = args.find((a) => a.startsWith("--source-cohort="));
  const sourceCohortId = sourceArg ? sourceArg.split("=")[1] : undefined;
  const cohortsArg = args.find((a) => a.startsWith("--cohorts="));
  const allCohortIds = cohortsArg
    ? cohortsArg
        .split("=")[1]
        .split(",")
        .map((entry) => {
          const [id, name] = entry.split(":");
          return { id: id.trim(), name: name?.trim() };
        })
        .filter((c) => Boolean(c.id))
    : undefined;

  runMasterCurriculumBackfill({ apply, sourceCohortId, allCohortIds })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Backfill error:", err);
      process.exit(1);
    });
}
