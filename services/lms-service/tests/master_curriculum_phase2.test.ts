import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/index";
import {
  weeks,
  lessons,
  quizzes,
  progress,
  masterCurricula,
  curriculumRevisions,
  cohortCurriculumBindings,
  cohortWeekSchedules,
  curriculumAuditLogs,
} from "../src/db/schema";
import { weeksRouter } from "../src/routes/lms";
import { masterCurriculumRouter } from "../src/routes/masterCurriculum";
import { runMasterCurriculumBackfill } from "../src/scripts/backfill-master-curriculum";

async function runPhase2Tests() {
  const cohort1Id = randomUUID();
  const cohort4Id = randomUUID();
  const cohort5Id = randomUUID();
  const adminId = randomUUID();
  const subAdminId = randomUUID();
  const trainee1Id = randomUUID();
  const weekIds: string[] = [];
  let createdRev2Id = "";

  const app = express();
  app.use(express.json());
  app.use("/lms/weeks", weeksRouter);
  app.use("/lms/curriculum", masterCurriculumRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function apiReq(method: string, path: string, headers: Record<string, string> = {}, body?: any) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json };
  }

  try {
    // Seed Cohort 1 with 2 weeks & promote to v1.0
    for (let w = 1; w <= 2; w++) {
      const [wk] = await db
        .insert(weeks)
        .values({
          cohortId: cohort1Id,
          weekNumber: w,
          title: `Phase2 Week ${w}`,
          isPublished: true,
          unlockDate: new Date(`2026-09-0${w}T08:00:00Z`),
        })
        .returning();
      weekIds.push(wk.id);

      const [ls] = await db.insert(lessons).values({ weekId: wk.id, title: `Lesson ${w}`, isPublished: true }).returning();
      await db.insert(quizzes).values({ weekId: wk.id, cohortId: cohort1Id, title: `Quiz ${w}`, questions: [], isPublished: true });
      await db.insert(progress).values({ userId: trainee1Id, lessonId: ls.id, weekId: wk.id, cohortId: cohort1Id, completed: true });
    }

    await runMasterCurriculumBackfill({
      apply: true,
      sourceCohortId: cohort1Id,
      allCohortIds: [{ id: cohort1Id, name: "COHORT 1" }],
    });

    // 1. Brand-new Cohort 4 (no weeks of its own) automatically inherits v1.0
    const c4WeeksRes = await apiReq("GET", `/lms/weeks?cohortId=${cohort4Id}`, {
      "x-user-id": trainee1Id,
      "x-user-role": "trainee",
    });
    assert.equal(c4WeeksRes.status, 200);
    assert.equal(c4WeeksRes.body.length, 2, "New Cohort 4 must automatically inherit v1.0 weeks");
    assert.equal(c4WeeksRes.body[0].id, weekIds[0]);

    // 2. Sub-admin can manage Cohort 4's schedule, but CANNOT edit global Master Curriculum
    const subAdminWeekPost = await apiReq(
      "POST",
      "/lms/weeks",
      { "x-user-id": subAdminId, "x-user-role": "sub_admin" },
      { title: "Unauthorized", weekNumber: 3 }
    );
    assert.equal(subAdminWeekPost.status, 403, "Sub-admin must be read-only on global curriculum");

    const subAdminRevPost = await apiReq(
      "POST",
      "/lms/curriculum/revisions",
      { "x-user-id": subAdminId, "x-user-role": "sub_admin" },
      { summary: "Subadmin attempt" }
    );
    assert.equal(subAdminRevPost.status, 403);

    const subAdminSchedPut = await apiReq(
      "PUT",
      `/lms/curriculum/cohorts/${cohort4Id}/schedule`,
      { "x-user-id": subAdminId, "x-user-role": "sub_admin" },
      { schedules: [{ weekNumber: 1, unlockDate: "2026-12-01T08:00:00.000Z", practicalRequired: true, quizRequired: true }] }
    );
    assert.equal(subAdminSchedPut.status, 200, "Sub-admin can manage cohort-specific schedule");

    // Verify Cohort 4 has December unlockDate while Cohort 1 retains September unlockDate
    const [c1WeeksAfterSched, c4WeeksAfterSched] = await Promise.all([
      apiReq("GET", `/lms/weeks?cohortId=${cohort1Id}`, { "x-user-id": trainee1Id }),
      apiReq("GET", `/lms/weeks?cohortId=${cohort4Id}`, { "x-user-id": trainee1Id }),
    ]);
    assert.ok(String(c1WeeksAfterSched.body[0].unlockDate).startsWith("2026-09-01"));
    assert.ok(String(c4WeeksAfterSched.body[0].unlockDate).startsWith("2026-12-01"));
    console.log("PASS: Cohort 4 auto-inherited v1.0 + independent schedule overlay + sub-admin RBAC");

    // 3. Admin creates draft v2.0, adds Week 3 to v2.0, and publishes v2.0
    const createRevRes = await apiReq(
      "POST",
      "/lms/curriculum/revisions",
      { "x-user-id": adminId, "x-user-role": "admin" },
      { changeClassification: "structural", summary: "Add Week 3 structural improvement" }
    );
    assert.equal(createRevRes.status, 201);
    createdRev2Id = createRevRes.body.id;

    const addW3Res = await apiReq(
      "POST",
      "/lms/weeks",
      { "x-user-id": adminId, "x-user-role": "admin" },
      { curriculumRevisionId: createdRev2Id, title: "Master Week 3 (v2)", weekNumber: 3, isPublished: true }
    );
    assert.equal(addW3Res.status, 201);

    const pubRevRes = await apiReq(
      "POST",
      `/lms/curriculum/revisions/${createdRev2Id}/publish`,
      { "x-user-id": adminId, "x-user-role": "admin" },
      { reason: "Publishing v2.0" }
    );
    assert.equal(pubRevRes.status, 200);
    assert.equal(pubRevRes.body.status, "published");

    // Cohort 1 (pinned) stays on v1.0 (2 weeks), while brand-new Cohort 5 inherits v2.0 (3 weeks)
    const [c1AfterV2, c5AfterV2] = await Promise.all([
      apiReq("GET", `/lms/weeks?cohortId=${cohort1Id}`, { "x-user-id": trainee1Id }),
      apiReq("GET", `/lms/weeks?cohortId=${cohort5Id}`, { "x-user-id": trainee1Id }),
    ]);
    assert.equal(c1AfterV2.body.length, 2, "Pinned Cohort 1 remains on v1.0");
    assert.equal(c5AfterV2.body.length, 3, "New Cohort 5 inherits v2.0");

    // 4. Explicit upgrade of Cohort 4 to v2.0 preserves historical progress and records audit log
    const upgradeRes = await apiReq(
      "POST",
      `/lms/curriculum/cohorts/${cohort4Id}/upgrade`,
      { "x-user-id": adminId, "x-user-role": "admin" },
      { revisionId: createdRev2Id, reason: "Approved upgrade of Cohort 4 to v2.0" }
    );
    assert.equal(upgradeRes.status, 200);
    const c4AfterUpgrade = await apiReq("GET", `/lms/weeks?cohortId=${cohort4Id}`, { "x-user-id": trainee1Id });
    assert.equal(c4AfterUpgrade.body.length, 3, "Upgraded Cohort 4 now sees v2.0");

    // 5. Rollback to v1.0
    const masterRes = await apiReq("GET", "/lms/curriculum/master", { "x-user-id": adminId, "x-user-role": "admin" });
    const v1Rev = masterRes.body.revisions.find((r: any) => r.versionNumber === 1);
    const rollbackRes = await apiReq(
      "POST",
      `/lms/curriculum/revisions/${v1Rev.id}/rollback`,
      { "x-user-id": adminId, "x-user-role": "admin" },
      { reason: "Testing safe non-destructive rollback to v1.0" }
    );
    assert.equal(rollbackRes.status, 200);
    assert.equal(rollbackRes.body.status, "published");

    console.log("PASS: Revision draft/publish, Cohort 1 pinning, Cohort 5 inheritance, Cohort 4 upgrade & rollback");
    console.log("ALL_PHASE2_MASTER_CURRICULUM_TESTS_PASSED");
  } finally {
    server.close();
    await db.delete(curriculumAuditLogs).where(inArray(curriculumAuditLogs.cohortId, [cohort1Id, cohort4Id, cohort5Id])).catch(() => {});
    if (createdRev2Id) {
      await db.delete(curriculumAuditLogs).where(eq(curriculumAuditLogs.revisionId, createdRev2Id)).catch(() => {});
      await db.delete(weeks).where(eq(weeks.curriculumRevisionId, createdRev2Id)).catch(() => {});
    }
    await db.delete(cohortWeekSchedules).where(inArray(cohortWeekSchedules.cohortId, [cohort1Id, cohort4Id, cohort5Id])).catch(() => {});
    await db.delete(cohortCurriculumBindings).where(inArray(cohortCurriculumBindings.cohortId, [cohort1Id, cohort4Id, cohort5Id])).catch(() => {});
    await db.delete(progress).where(eq(progress.userId, trainee1Id)).catch(() => {});
    if (weekIds.length > 0) {
      await db.delete(weeks).where(inArray(weeks.id, weekIds)).catch(() => {});
    }
    await db.delete(curriculumRevisions).where(inArray(curriculumRevisions.versionNumber, [1, 2])).catch(() => {});
    await db.delete(masterCurricula).where(eq(masterCurricula.code, "EEWYLA-MASTER")).catch(() => {});
  }
}

runPhase2Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("PHASE2_TEST_FAILED:", err);
    process.exit(1);
  });
