import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/index";
import {
  weeks,
  quizzes,
  quizAttempts,
  practicalCheckins,
  week12Checkins,
  exams,
  examQuestions,
  examSessions,
  examEligibilityOverrides,
} from "../src/db/schema";
import {
  checkWeeks1To12Attendance,
  getMissingWeeklyQuizzes,
  examsRouter,
} from "../src/routes/lms";

async function runTests() {
  const cohortId = randomUUID();
  const siblingCohortId = randomUUID();
  const adminId = randomUUID();
  const traineeId = randomUUID();
  const candidateMemberId = randomUUID();
  const weekIds: string[] = [];
  const siblingWeekIds: string[] = [];
  const quizIds: string[] = [];
  let examId = "";
  const createdSessionIds: string[] = [];
  const createdOverrideIds: string[] = [];

  // Mock global fetch so fetchUser / resolveCandidateUserIds return deterministic test user + candidateMemberId
  const originalFetch = global.fetch;
  global.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.toString?.() || "";
    if (url.includes(`/users/${traineeId}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: traineeId,
          email: "trainee-test@oriyon.local",
          firstName: "Test",
          lastName: "Trainee",
          role: "trainee",
          cohortId,
          cohortMembers: [{ id: candidateMemberId, cohortId, cohort: { id: cohortId, code: "COH-TEST" } }],
          groupMembers: [],
        }),
      } as any;
    }
    if (url.includes(`/users/${adminId}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: adminId,
          email: "admin-test@oriyon.local",
          firstName: "Admin",
          lastName: "Tester",
          role: "admin",
        }),
      } as any;
    }
    return originalFetch(input, init);
  }) as any;

  const app = express();
  app.use(express.json());
  app.use("/lms/exams", examsRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function apiReq(method: string, path: string, headers: Record<string, string> = {}, body?: any) {
    const res = await originalFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
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
    console.log("Setting up test cohort, 12 weeks, 12 quizzes, and published exam...");

    // Create Weeks 1–12 and a published quiz for each week in cohortId
    for (let w = 1; w <= 12; w++) {
      const [wk] = await db
        .insert(weeks)
        .values({
          cohortId,
          weekNumber: w,
          title: `Test Week ${w}`,
          isPublished: true,
        })
        .returning();
      weekIds.push(wk.id);

      const [qz] = await db
        .insert(quizzes)
        .values({
          weekId: wk.id,
          cohortId,
          title: `Week ${w} Quiz`,
          questions: [{ id: `q-${w}`, text: "Test?", options: ["A", "B"], correctIndex: 0 }],
          isPublished: true,
        })
        .returning();
      quizIds.push(qz.id);
    }

    // Create a sibling Week 12 quiz in another cohort to test sibling quiz matching
    const [sibWk12] = await db
      .insert(weeks)
      .values({
        cohortId: siblingCohortId,
        weekNumber: 12,
        title: "Sibling Week 12",
        isPublished: true,
      })
      .returning();
    siblingWeekIds.push(sibWk12.id);

    // Create Exam with 1 question
    const [exam] = await db
      .insert(exams)
      .values({
        cohortId,
        title: "Final Eligibility Test Exam",
        durationMinutes: 60,
        createdBy: adminId,
        isPublished: true,
        isActive: true,
        totalMarks: 10,
      })
      .returning();
    examId = exam.id;

    await db.insert(examQuestions).values({
      examId,
      type: "mcq",
      questionText: "Sample Exam Question",
      options: ["Yes", "No"],
      correctOptionIndex: 0,
      marks: 10,
      orderIndex: 0,
    });

    // ─── Scenario 1 & 4: 12/12 attendance (Weeks 1–11 practical + Week 12 5-day admin-marked) & 12/12 quizzes
    for (let w = 1; w <= 11; w++) {
      await db.insert(practicalCheckins).values({
        userId: w === 1 ? candidateMemberId : traineeId, // Scenario 7: Week 1 stored under candidateMemberId
        cohortId,
        weekNumber: w,
        codeSubmitted: `PRAC-TEST-W${w}`,
        verifiedBy: adminId,
      });
    }
    for (let d = 1; d <= 5; d++) {
      await db.insert(week12Checkins).values({
        userId: traineeId,
        cohortId,
        day: d,
        verifiedBy: adminId,
      });
    }
    for (let i = 0; i < 12; i++) {
      await db.insert(quizAttempts).values({
        userId: i === 11 ? candidateMemberId : traineeId, // Scenario 7: Week 12 quiz stored under candidateMemberId
        quizId: quizIds[i],
        weekId: weekIds[i],
        cohortId,
        answers: { [`q-${i + 1}`]: 0 },
        score: 100,
        passed: true,
      });
    }

    // Verify Eligible
    const eligRes1 = await apiReq("GET", `/lms/exams/eligibility?cohortId=${cohortId}`, {
      "x-user-id": traineeId,
    });
    assert.equal(eligRes1.status, 200);
    assert.equal(eligRes1.body.ready, true, "Scenario 1: Trainee with 12 attendance + 12 quizzes must be ready");
    assert.equal(eligRes1.body.eligible, true);
    assert.equal(eligRes1.body.eligibilitySource, "SYSTEM_VERIFIED");
    assert.equal(eligRes1.body.attendanceComplete, true);
    assert.equal(eligRes1.body.week12AttendanceComplete, true);
    assert.equal(eligRes1.body.quizzesComplete, true);
    assert.deepEqual(eligRes1.body.missingAttendanceWeeks, []);
    assert.deepEqual(eligRes1.body.missingQuizzes, []);
    console.log("PASS: Scenarios 1, 4, 7 (12/12 attendance + 12/12 quizzes + candidateId + admin W12)");

    // ─── Scenario 2: Missing Week 12 attendance (only 4/5 days) with 12/12 quizzes -> INELIGIBLE
    await db
      .delete(week12Checkins)
      .where(eq(week12Checkins.userId, traineeId));
    for (let d = 1; d <= 4; d++) {
      await db.insert(week12Checkins).values({
        userId: traineeId,
        cohortId,
        day: d,
        verifiedBy: adminId,
      });
    }
    const attCheckMissingW12 = await checkWeeks1To12Attendance(traineeId, cohortId);
    assert.equal(attCheckMissingW12.isComplete, false);
    assert.equal(attCheckMissingW12.week12Complete, false);
    assert.deepEqual(attCheckMissingW12.missingWeeks, [12]);
    console.log("PASS: Scenario 2 (12 quizzes, 11/12 attendance missing W12 -> ineligible)");

    // Restore Week 12 Day 5
    await db.insert(week12Checkins).values({
      userId: traineeId,
      cohortId,
      day: 5,
      verifiedBy: adminId,
    });

    // ─── Scenario 3: 12/12 attendance, missing Week 12 quiz -> INELIGIBLE
    await db.delete(quizAttempts).where(eq(quizAttempts.quizId, quizIds[11]));
    const missingQ12 = await getMissingWeeklyQuizzes(traineeId, cohortId);
    assert.equal(missingQ12.length, 1);
    assert.equal(missingQ12[0].weekNumber, 12);

    const startBlockedQuiz = await apiReq(
      "POST",
      `/lms/exams/${examId}/sessions/start`,
      { "x-user-id": traineeId },
      { userId: traineeId }
    );
    assert.equal(startBlockedQuiz.status, 403);
    assert.equal(startBlockedQuiz.body.code, "QUIZZES_INCOMPLETE");
    console.log("PASS: Scenario 3 & 8a (12/12 attendance, missing W12 quiz -> blocked 403 QUIZZES_INCOMPLETE)");

    // ─── Scenario 5: Duplicate Week 5 attendance (e.g. under candidateMemberId) and missing Week 6 attendance -> INELIGIBLE
    await db.delete(practicalCheckins).where(and(eq(practicalCheckins.cohortId, cohortId), eq(practicalCheckins.weekNumber, 6)));
    await db.insert(practicalCheckins).values({
      userId: candidateMemberId,
      cohortId,
      weekNumber: 5,
      codeSubmitted: "PRAC-DUP-W5",
      verifiedBy: adminId,
    });
    const attDupW5 = await checkWeeks1To12Attendance(traineeId, cohortId);
    assert.equal(attDupW5.isComplete, false);
    assert.ok(attDupW5.missingWeeks.includes(6), "Duplicate Week 5 must not mask missing Week 6");
    console.log("PASS: Scenario 5 (Duplicate Week 5 attendance does not mask missing Week 6)");

    // ─── Scenario 6: Duplicate Week 3 quiz submissions and missing Week 4 quiz -> INELIGIBLE
    await db.delete(quizAttempts).where(eq(quizAttempts.quizId, quizIds[3]));
    await db.insert(quizAttempts).values({
      userId: traineeId,
      quizId: quizIds[2],
      weekId: weekIds[2],
      cohortId,
      answers: { "q-3": 0 },
      score: 100,
      passed: true,
    });
    const missingAfterDup = await getMissingWeeklyQuizzes(traineeId, cohortId);
    const missingWeeksSet = new Set(missingAfterDup.map((m) => m.weekNumber));
    assert.ok(missingWeeksSet.has(4), "Duplicate Week 3 quiz attempts must not mask missing Week 4 quiz");
    assert.ok(missingWeeksSet.has(12), "Missing Week 12 quiz must still be reported");
    console.log("PASS: Scenario 6 (Duplicate Week 3 quiz does not mask missing Week 4)");

    // ─── Scenario 9: Audited Manual Administrative Override
    // 9a. Non-admin role (trainer/trainee) must be rejected with 403
    const nonAdminOverride = await apiReq(
      "POST",
      "/lms/exams/admin/eligibility-override",
      { "x-user-id": adminId, "x-user-role": "trainer" },
      { traineeId, cohortId, examId, reason: "Trainer trying to override" }
    );
    assert.equal(nonAdminOverride.status, 403);

    // 9b. Admin without valid reason must be rejected with 400
    const missingReasonOverride = await apiReq(
      "POST",
      "/lms/exams/admin/eligibility-override",
      { "x-user-id": adminId, "x-user-role": "admin" },
      { traineeId, cohortId, examId, reason: "ok" }
    );
    assert.equal(missingReasonOverride.status, 400);

    // 9c. Admin with valid reason creates audited override without mutating attendance/quizzes
    const grantOverride = await apiReq(
      "POST",
      "/lms/exams/admin/eligibility-override",
      { "x-user-id": adminId, "x-user-role": "admin" },
      {
        traineeId,
        cohortId,
        examId,
        reason: "Verified physical Week 6 & Week 12 attendance sheets with centre coordinator.",
      }
    );
    assert.equal(grantOverride.status, 201);
    createdOverrideIds.push(grantOverride.body.id);

    // Verify trainee is now unlocked for exam requirements AND exam start, while missing lists stay intact for audit
    const reqWithOverride = await apiReq("GET", `/lms/exams/${examId}/quiz-requirements`, {
      "x-user-id": traineeId,
    });
    assert.equal(reqWithOverride.status, 200);
    assert.equal(reqWithOverride.body.ready, true);
    assert.equal(reqWithOverride.body.eligible, true);
    assert.equal(reqWithOverride.body.eligibilitySource, "ADMIN_MANUAL_OVERRIDE");
    assert.ok(reqWithOverride.body.manualOverride?.reason.includes("Verified physical"));
    assert.ok(reqWithOverride.body.missingAttendanceWeeks.includes(6), "Historical attendance gaps remain visible");

    const startWithOverride = await apiReq(
      "POST",
      `/lms/exams/${examId}/sessions/start`,
      { "x-user-id": traineeId },
      { userId: traineeId }
    );
    assert.equal(startWithOverride.status, 201);
    assert.ok(startWithOverride.body.session?.id);
    createdSessionIds.push(startWithOverride.body.session.id);

    // 9d. Revoking override restores ineligibility check
    const revokeRes = await apiReq(
      "DELETE",
      `/lms/exams/admin/eligibility-override/${grantOverride.body.id}`,
      { "x-user-id": adminId, "x-user-role": "admin" },
      { reason: "Testing revocation" }
    );
    assert.equal(revokeRes.status, 200);
    assert.equal(revokeRes.body.isActive, false);

    const reqAfterRevoke = await apiReq("GET", `/lms/exams/${examId}/quiz-requirements`, {
      "x-user-id": traineeId,
    });
    assert.equal(reqAfterRevoke.status, 200);
    assert.equal(reqAfterRevoke.body.ready, false);
    assert.equal(reqAfterRevoke.body.eligibilitySource, "INELIGIBLE");
    console.log("PASS: Scenario 8b & 9 (Exam start + Audited Admin Manual Override grant, use, non-mutation & revoke)");

    console.log("ALL_EXAM_ELIGIBILITY_TESTS_PASSED");
  } finally {
    server.close();
    global.fetch = originalFetch;
    // Cleanup synthetic test records cleanly
    if (createdOverrideIds.length > 0) {
      await db.delete(examEligibilityOverrides).where(inArray(examEligibilityOverrides.id, createdOverrideIds)).catch(() => {});
    }
    if (createdSessionIds.length > 0) {
      await db.delete(examSessions).where(inArray(examSessions.id, createdSessionIds)).catch(() => {});
    }
    if (examId) {
      await db.delete(exams).where(eq(exams.id, examId)).catch(() => {});
    }
    await db.delete(practicalCheckins).where(eq(practicalCheckins.cohortId, cohortId)).catch(() => {});
    await db.delete(week12Checkins).where(eq(week12Checkins.cohortId, cohortId)).catch(() => {});
    await db.delete(quizAttempts).where(eq(quizAttempts.cohortId, cohortId)).catch(() => {});
    const allWeekIds = [...weekIds, ...siblingWeekIds];
    if (allWeekIds.length > 0) {
      await db.delete(weeks).where(inArray(weeks.id, allWeekIds)).catch(() => {});
    }
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("TEST_FAILED:", err);
    process.exit(1);
  });
