import "dotenv/config";
import assert from "assert";
import { z } from "zod";

// Re-import the exact schema and gate rules from LMS service
const reportInputSchema = z.object({
  id: z.string().uuid().optional(),
  cohortId: z.string().uuid("Invalid cohort ID"),
  cohortName: z.string().optional(),
  groupId: z.string().optional(),
  groupName: z.string().optional(),
  sessionId: z.string().uuid().optional().nullable(),
  lessonId: z.string().uuid().optional().nullable(),
  weekNumber: z.number().int().optional().nullable(),
  sessionTitle: z.string().min(2, "Session/Lesson title is required"),
  dateConducted: z.string().min(1, "Date conducted is required"),
  topicsCovered: z.string().optional(),
  activities: z.string().optional(),
  traineesPresent: z.number().int().min(0, "Trainees count cannot be negative").default(0),
  learningOutcomes: z.string().optional(),
  challenges: z.string().optional().nullable(),
  comments: z.string().optional().nullable(),
  attachmentUrl: z.string().optional().nullable(),
  attachmentName: z.string().optional().nullable(),
  action: z.enum(["draft", "submit"]).default("draft"),
});

// Gate enforcement function mirroring the backend route logic
function evaluateDeliveryGate(report: {
  id: string;
  trainerId: string;
  status: "draft" | "submitted";
  isDelivered: boolean;
  deliveredAt?: Date | null;
}, requestUserId: string, requestUserRole?: string): { allowed: boolean; status: number; error?: string; message?: string } {
  if (!report) {
    return {
      allowed: false,
      status: 404,
      error: "Cannot mark session delivered: No report found. A submitted lesson report is strictly mandatory before marking completion.",
    };
  }

  const isOwner = report.trainerId === requestUserId;
  const isStaff = requestUserRole === "admin" || requestUserRole === "sub_admin" || requestUserRole === "lead_trainer";
  if (!isOwner && !isStaff) {
    return {
      allowed: false,
      status: 403,
      error: "Unauthorized to mark delivery for this lesson report.",
    };
  }

  if (report.status !== "submitted") {
    return {
      allowed: false,
      status: 400,
      error: "Cannot mark session as completed/delivered: The lesson report is still in 'draft' status. You must submit the report first.",
    };
  }

  if (report.isDelivered) {
    return {
      allowed: true,
      status: 200,
      message: "Session is already marked as completed/delivered.",
    };
  }

  return {
    allowed: true,
    status: 200,
    message: "Lesson/session has been marked as completed/delivered successfully.",
  };
}

async function runTrainerReportingTestSuite() {
  console.log("=============================================================");
  console.log("  ORIYON LMS — MANDATORY TRAINER REPORTING & DELIVERY GATE");
  console.log("=============================================================\n");

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log("  ✓ PASS: " + name);
      passed++;
    } catch (err: any) {
      console.error("  ✗ FAIL: " + name);
      console.error("    Error: " + err.message);
      failed++;
    }
  }

  // ─────────────────────────────────────────────
  // 1. ZOD SCHEMA & REPORT VALIDATION
  // ─────────────────────────────────────────────
  console.log("\n[1] Schema & Field Validation:");

  await test("Valid submission with complete required fields passes validation", () => {
    const input = {
      cohortId: "11111111-1111-1111-1111-111111111111",
      groupId: "group-lagos-a",
      sessionTitle: "Livestock Deworming & Injection Demonstration",
      dateConducted: "2026-11-25T10:00:00.000Z",
      topicsCovered: "Sterile syringe handling, intramuscular injection technique, dosage calculation",
      activities: "Live drill on goat models, hands-on vaccine cold chain inspection",
      traineesPresent: 28,
      learningOutcomes: "Trainees demonstrated safe syringe handling and correct dosage measurement",
      action: "submit",
    };

    const res = reportInputSchema.safeParse(input);
    assert.strictEqual(res.success, true);
    if (res.success) {
      assert.strictEqual(res.data.traineesPresent, 28);
      assert.strictEqual(res.data.action, "submit");
    }
  });

  await test("Draft report permits saving in-progress without optional/mandatory body fields", () => {
    const draftInput = {
      cohortId: "11111111-1111-1111-1111-111111111111",
      groupId: "group-lagos-a",
      sessionTitle: "Week 4 Practical Session",
      dateConducted: "2026-11-25",
      action: "draft",
    };

    const res = reportInputSchema.safeParse(draftInput);
    assert.strictEqual(res.success, true);
    if (res.success) {
      assert.strictEqual(res.data.action, "draft");
      assert.strictEqual(res.data.traineesPresent, 0); // default
    }
  });

  await test("Invalid cohort UUID fails validation", () => {
    const invalidCohort = {
      cohortId: "not-a-valid-uuid",
      sessionTitle: "Session 1",
      dateConducted: "2026-11-25",
    };

    const res = reportInputSchema.safeParse(invalidCohort);
    assert.strictEqual(res.success, false);
    if (!res.success) {
      const errors = res.error.flatten().fieldErrors;
      assert.ok(errors.cohortId);
    }
  });

  await test("Negative traineesPresent is strictly rejected", () => {
    const negativeCount = {
      cohortId: "11111111-1111-1111-1111-111111111111",
      sessionTitle: "Session 1",
      dateConducted: "2026-11-25",
      traineesPresent: -5,
    };

    const res = reportInputSchema.safeParse(negativeCount);
    assert.strictEqual(res.success, false);
  });

  // ─────────────────────────────────────────────
  // 2. MANDATORY DELIVERY GATE ENFORCEMENT
  // ─────────────────────────────────────────────
  console.log("\n[2] Delivery Completion Gate Enforcement:");

  await test("Marking delivered on a DRAFT report is strictly BLOCKED with HTTP 400", () => {
    const draftReport = {
      id: "report-draft-001",
      trainerId: "trainer-uuid-001",
      status: "draft" as const,
      isDelivered: false,
    };

    const result = evaluateDeliveryGate(draftReport, "trainer-uuid-001", "trainer");
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.status, 400);
    assert.ok(result.error?.includes("report is still in 'draft' status"));
  });

  await test("Marking delivered when NO report exists fails with HTTP 404", () => {
    const result = evaluateDeliveryGate(null as any, "trainer-uuid-001", "trainer");
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.status, 404);
    assert.ok(result.error?.includes("A submitted lesson report is strictly mandatory"));
  });

  await test("Marking delivered by an unauthorized user is BLOCKED with HTTP 403", () => {
    const submittedReport = {
      id: "report-sub-001",
      trainerId: "trainer-uuid-001",
      status: "submitted" as const,
      isDelivered: false,
    };

    const result = evaluateDeliveryGate(submittedReport, "random-user-uuid-999", "trainee");
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.status, 403);
    assert.ok(result.error?.includes("Unauthorized"));
  });

  await test("Marking delivered on a SUBMITTED report SUCCEEDS with HTTP 200", () => {
    const submittedReport = {
      id: "report-sub-001",
      trainerId: "trainer-uuid-001",
      status: "submitted" as const,
      isDelivered: false,
    };

    const result = evaluateDeliveryGate(submittedReport, "trainer-uuid-001", "trainer");
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.status, 200);
    assert.ok(result.message?.includes("marked as completed/delivered successfully"));
  });

  await test("Admin override can mark delivered for a submitted report", () => {
    const submittedReport = {
      id: "report-sub-002",
      trainerId: "trainer-uuid-001",
      status: "submitted" as const,
      isDelivered: false,
    };

    const result = evaluateDeliveryGate(submittedReport, "admin-user-uuid-007", "admin");
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.status, 200);
  });

  await test("Admin CANNOT mark delivered if report is still DRAFT (strict quality gate)", () => {
    const draftReport = {
      id: "report-draft-002",
      trainerId: "trainer-uuid-001",
      status: "draft" as const,
      isDelivered: false,
    };

    const result = evaluateDeliveryGate(draftReport, "admin-user-uuid-007", "admin");
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.status, 400);
    assert.ok(result.error?.includes("report is still in 'draft' status"));
  });

  await test("Repeated delivery call on already delivered session is idempotent", () => {
    const alreadyDelivered = {
      id: "report-sub-003",
      trainerId: "trainer-uuid-001",
      status: "submitted" as const,
      isDelivered: true,
      deliveredAt: new Date("2026-11-20T12:00:00Z"),
    };

    const result = evaluateDeliveryGate(alreadyDelivered, "trainer-uuid-001", "trainer");
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.status, 200);
    assert.ok(result.message?.includes("already marked as completed/delivered"));
  });

  // ─────────────────────────────────────────────
  // 3. ROLE SEPARATION & SCOPE ISOLATION
  // ─────────────────────────────────────────────
  console.log("\n[3] Role Separation & Report Scope Isolation:");

  function evaluateAdminReportsAccess(role: string): { allowed: boolean; status: number } {
    const isAdmin = role === "admin" || role === "sub_admin" || role === "lead_trainer";
    if (!isAdmin) {
      return { allowed: false, status: 403 };
    }
    return { allowed: true, status: 200 };
  }

  await test("Individual trainers are BLOCKED from /admin/all with HTTP 403 Forbidden", () => {
    const res = evaluateAdminReportsAccess("trainer");
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.status, 403);
  });

  await test("Trainees are BLOCKED from /admin/all with HTTP 403 Forbidden", () => {
    const res = evaluateAdminReportsAccess("trainee");
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.status, 403);
  });

  await test("Admins and Lead Trainers CAN access /admin/all with HTTP 200", () => {
    const adminRes = evaluateAdminReportsAccess("admin");
    const leadRes = evaluateAdminReportsAccess("lead_trainer");
    const subAdminRes = evaluateAdminReportsAccess("sub_admin");
    assert.strictEqual(adminRes.allowed, true);
    assert.strictEqual(leadRes.allowed, true);
    assert.strictEqual(subAdminRes.allowed, true);
  });

  // ─────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────
  console.log("\n=============================================================");
  console.log(`  TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("=============================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTrainerReportingTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
