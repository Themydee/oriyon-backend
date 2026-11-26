import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, queryClient } from "../src/index";
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
} from "../src/db/schema";
import { runMasterCurriculumBackfill } from "../src/scripts/backfill-master-curriculum";

async function runPhase1Tests() {
  const cohort1Id = randomUUID();
  const cohort2Id = randomUUID();
  const trainee1Id = randomUUID();
  const trainee2Id = randomUUID();
  const week1Ids: string[] = [];
  const lesson1Ids: string[] = [];
  const quiz1Ids: string[] = [];
  let dupWeekId = "";
  let dupLessonId = "";

  try {
    // 1. Apply 0008_master_curriculum_phase1.sql idempotently
    const sqlPath = path.join(__dirname, "../src/db/migrations/0008_master_curriculum_phase1.sql");
    const migrationSql = fs.readFileSync(sqlPath, "utf8");
    await queryClient.unsafe(migrationSql);
    await queryClient.unsafe(migrationSql); // verify idempotency
    console.log("PASS: 0008_master_curriculum_phase1.sql executed idempotently");

    // 2. Seed Cohort 1 (12 weeks, 12 lessons, 12 quizzes, plus progress & quiz_attempts)
    for (let w = 1; w <= 12; w++) {
      const [wk] = await db
        .insert(weeks)
        .values({
          cohortId: cohort1Id,
          weekNumber: w,
          title: `Phase1 Master Week ${w}`,
          isPublished: true,
          unlockDate: new Date(`2026-09-${String(w).padStart(2, "0")}T08:00:00Z`),
        })
        .returning();
      week1Ids.push(wk.id);

      const [ls] = await db
        .insert(lessons)
        .values({
          weekId: wk.id,
          title: `Phase1 Lesson ${w}`,
          isPublished: true,
        })
        .returning();
      lesson1Ids.push(ls.id);

      const [qz] = await db
        .insert(quizzes)
        .values({
          weekId: wk.id,
          cohortId: cohort1Id,
          title: `Phase1 Quiz ${w}`,
          questions: [{ id: `q-${w}`, text: "Q?", options: ["A", "B"], correctIndex: 0 }],
          isPublished: true,
        })
        .returning();
      quiz1Ids.push(qz.id);

      await db.insert(progress).values({
        userId: trainee1Id,
        lessonId: ls.id,
        weekId: wk.id,
        cohortId: cohort1Id,
        completed: true,
        completedAt: new Date(),
      });

      await db.insert(quizAttempts).values({
        userId: trainee1Id,
        quizId: qz.id,
        weekId: wk.id,
        cohortId: cohort1Id,
        answers: { [`q-${w}`]: 0 },
        score: 100,
        passed: true,
      });
    }

    // Seed Cohort 2 with a duplicate Week 1 that has 1 progress row (must be preserved, never deleted)
    const [dupWk] = await db
      .insert(weeks)
      .values({
        cohortId: cohort2Id,
        weekNumber: 1,
        title: "Cohort 2 Duplicate Week 1",
        isPublished: true,
        unlockDate: new Date("2026-12-01T08:00:00Z"),
      })
      .returning();
    dupWeekId = dupWk.id;

    const [dupLs] = await db
      .insert(lessons)
      .values({
        weekId: dupWk.id,
        title: "Cohort 2 Duplicate Lesson 1",
        isPublished: true,
      })
      .returning();
    dupLessonId = dupLs.id;

    await db.insert(progress).values({
      userId: trainee2Id,
      lessonId: dupLs.id,
      weekId: dupWk.id,
      cohortId: cohort2Id,
      completed: true,
      completedAt: new Date(),
    });

    // 3. Dry-run backfill must NOT write curriculum_revisions or mutate weeks
    const dryRun = await runMasterCurriculumBackfill({
      apply: false,
      sourceCohortId: cohort1Id,
      allCohortIds: [
        { id: cohort1Id, name: "Cohort 1" },
        { id: cohort2Id, name: "Cohort 2" },
      ],
    });
    assert.equal(dryRun.mode, "DRY_RUN");
    assert.equal(dryRun.promotedWeekIds.length, 12);
    assert.equal(dryRun.duplicateOrPartialWeeks.length >= 1, true);
    const weeksBeforeApply = await db.select().from(weeks).where(inArray(weeks.id, week1Ids));
    assert.ok(weeksBeforeApply.every((w) => w.curriculumRevisionId === null), "Dry-run must not mutate weeks");
    console.log("PASS: Dry-run backfill previewed 12 weeks with 0 mutations");

    // 4. Apply backfill (and re-run apply for idempotency)
    await runMasterCurriculumBackfill({
      apply: true,
      sourceCohortId: cohort1Id,
      allCohortIds: [
        { id: cohort1Id, name: "Cohort 1" },
        { id: cohort2Id, name: "Cohort 2" },
      ],
    });
    await runMasterCurriculumBackfill({
      apply: true,
      sourceCohortId: cohort1Id,
      allCohortIds: [
        { id: cohort1Id, name: "Cohort 1" },
        { id: cohort2Id, name: "Cohort 2" },
      ],
    });

    // 5. Verify existing UUIDs, progress, quiz_attempts, schedules, bindings, and duplicate preservation
    const [master] = await db.select().from(masterCurricula).where(eq(masterCurricula.code, "EEWYLA-MASTER"));
    assert.ok(master, "Master curriculum record must exist");
    const [rev1] = await db
      .select()
      .from(curriculumRevisions)
      .where(and(eq(curriculumRevisions.curriculumId, master.id), eq(curriculumRevisions.versionNumber, 1)));
    assert.ok(rev1 && rev1.versionLabel === "v1.0" && rev1.status === "published");

    const promotedWeeks = await db.select().from(weeks).where(inArray(weeks.id, week1Ids));
    assert.equal(promotedWeeks.length, 12);
    assert.ok(promotedWeeks.every((w) => w.curriculumRevisionId === rev1.id), "Existing Week UUIDs promoted in-place");

    const trainee1Progress = await db.select().from(progress).where(eq(progress.userId, trainee1Id));
    assert.equal(trainee1Progress.length, 12, "All 12 progress rows preserved");
    assert.ok(trainee1Progress.every((p) => p.curriculumRevisionId === rev1.id));

    const trainee1Attempts = await db.select().from(quizAttempts).where(eq(quizAttempts.userId, trainee1Id));
    assert.equal(trainee1Attempts.length, 12, "All 12 quiz attempts preserved");

    const [dupCheck] = await db.select().from(weeks).where(eq(weeks.id, dupWeekId));
    assert.ok(dupCheck, "Duplicate Cohort 2 week must NOT be deleted");

    const [c1Binding] = await db
      .select()
      .from(cohortCurriculumBindings)
      .where(eq(cohortCurriculumBindings.cohortId, cohort1Id));
    assert.ok(c1Binding && c1Binding.revisionId === rev1.id && c1Binding.isPinned === true);

    const c1Schedules = await db
      .select()
      .from(cohortWeekSchedules)
      .where(eq(cohortWeekSchedules.cohortId, cohort1Id));
    assert.equal(c1Schedules.length, 12, "12 cohort_week_schedules backfilled for Cohort 1");

    console.log("PASS: Apply & idempotency verified; existing UUIDs, progress, quiz attempts, schedules & duplicates preserved");
    console.log("ALL_PHASE1_MASTER_CURRICULUM_TESTS_PASSED");
  } finally {
    // Clean up synthetic test records
    await db.delete(curriculumAuditLogs).where(eq(curriculumAuditLogs.cohortId, cohort1Id)).catch(() => {});
    await db.delete(cohortWeekSchedules).where(inArray(cohortWeekSchedules.cohortId, [cohort1Id, cohort2Id])).catch(() => {});
    await db.delete(cohortCurriculumBindings).where(inArray(cohortCurriculumBindings.cohortId, [cohort1Id, cohort2Id])).catch(() => {});
    await db.delete(quizAttempts).where(eq(quizAttempts.userId, trainee1Id)).catch(() => {});
    await db.delete(progress).where(inArray(progress.userId, [trainee1Id, trainee2Id])).catch(() => {});
    const allTestWeeks = [...week1Ids, ...(dupWeekId ? [dupWeekId] : [])];
    if (allTestWeeks.length > 0) {
      await db.delete(weeks).where(inArray(weeks.id, allTestWeeks)).catch(() => {});
    }
    if (dupLessonId) {
      await db.delete(lessons).where(eq(lessons.id, dupLessonId)).catch(() => {});
    }
    await db.delete(curriculumRevisions).where(eq(curriculumRevisions.versionNumber, 1)).catch(() => {});
    await db.delete(masterCurricula).where(eq(masterCurricula.code, "EEWYLA-MASTER")).catch(() => {});
  }
}

runPhase1Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("PHASE1_TEST_FAILED:", err);
    process.exit(1);
  });
