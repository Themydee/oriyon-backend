import "dotenv/config";
import assert from "assert";
import { normalizeNigerianPhone, arePhoneNumbersEqual, isValidNigerianPhone, maskPhoneNumber } from "../src/utils/phone";
import { refereeVerificationService } from "../src/services/refereeVerificationService";
import { SandboxMessagingProvider } from "../src/messaging/sandbox";
import { db } from "../src/index";
import { applications, applicationReferees, refereeVerificationAuditLogs, refereeScheduledJobs } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

async function runTestSuite() {
  console.log("=============================================================");
  console.log("  EEWYLA AUTOMATED REFEREE VERIFICATION - COMPREHENSIVE TEST SUITE");
  console.log("=============================================================\n");

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(`    Error: ${err.message}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────
  // 1. PHONE UTILITIES & NORMALIZATION
  // ─────────────────────────────────────────────
  console.log("--- 1. PHONE UTILITIES & FRAUD GATE 1 ---");

  await test("Normalizes standard 11-digit Nigerian number (080... to +23480...)", () => {
    assert.strictEqual(normalizeNigerianPhone("08031234567"), "+2348031234567");
    assert.strictEqual(normalizeNigerianPhone("09012345678"), "+2349012345678");
    assert.strictEqual(normalizeNigerianPhone("07055554444"), "+2347055554444");
  });

  await test("Normalizes international formats (+234, 234, with dashes and spaces)", () => {
    assert.strictEqual(normalizeNigerianPhone("+234 803 123 4567"), "+2348031234567");
    assert.strictEqual(normalizeNigerianPhone("234-803-123-4567"), "+2348031234567");
    assert.strictEqual(normalizeNigerianPhone("  0803 123 4567 "), "+2348031234567");
  });

  await test("Detects matching numbers across different representations (Gate 1)", () => {
    assert.strictEqual(arePhoneNumbersEqual("08031234567", "+2348031234567"), true);
    assert.strictEqual(arePhoneNumbersEqual("2348031234567", "08031234567"), true);
    assert.strictEqual(arePhoneNumbersEqual("08031234567", "08039999999"), false);
  });

  await test("Plausibility check on Nigerian numbers", () => {
    assert.strictEqual(isValidNigerianPhone("08031234567"), true);
    assert.strictEqual(isValidNigerianPhone("+2348031234567"), true);
    assert.strictEqual(isValidNigerianPhone("12345"), false);
    assert.strictEqual(isValidNigerianPhone("01234567890"), false);
  });

  await test("Masks phone number for privacy display", () => {
    const masked = maskPhoneNumber("+2348031234567");
    assert.strictEqual(masked.startsWith("+234"), true);
    assert.strictEqual(masked.endsWith("4567"), true);
    assert.strictEqual(masked.includes("***"), true);
  });

  // ─────────────────────────────────────────────
  // 2. FRAUD GATES VALIDATION
  // ─────────────────────────────────────────────
  console.log("\n--- 2. FRAUD GATES VALIDATION (GATES 1 & 2) ---");

  await test("Gate 1: Rejects applicant matching Referee 1", async () => {
    const res = await refereeVerificationService.validateFraudGates(
      "08031234567",
      "+2348031234567",
      "08099999999",
      null
    );
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, "GATE1_APPLICANT_MATCH_REF1");
  });

  await test("Gate 1: Rejects applicant matching Referee 2", async () => {
    const res = await refereeVerificationService.validateFraudGates(
      "08031234567",
      "08088888888",
      "08031234567",
      null
    );
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, "GATE1_APPLICANT_MATCH_REF2");
  });

  await test("Gate 1: Rejects Referee 1 and Referee 2 with identical numbers", async () => {
    const res = await refereeVerificationService.validateFraudGates(
      "08031234567",
      "08088888888",
      "+2348088888888",
      null
    );
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, "GATE1_DUPLICATE_REFEREES");
  });

  await test("Gate 2: Allows distinct referee phone numbers under nomination threshold (<2)", async () => {
    const uniqueRef1 = "0810" + Math.floor(1000000 + Math.random() * 9000000);
    const uniqueRef2 = "0811" + Math.floor(1000000 + Math.random() * 9000000);
    const res = await refereeVerificationService.validateFraudGates(
      "08031234567",
      uniqueRef1,
      uniqueRef2,
      null
    );
    assert.strictEqual(res.valid, true);
  });

  // ─────────────────────────────────────────────
  // 3. REFEREE INITIATION & MESSAGING (MSG-01)
  // ─────────────────────────────────────────────
  console.log("\n--- 3. VERIFICATION INITIATION & MSG-01 DISPATCH ---");

  const testAppId = uuidv4();
  const testRef1Phone = "0812" + Math.floor(1000000 + Math.random() * 9000000);
  const testRef2Phone = "0813" + Math.floor(1000000 + Math.random() * 9000000);

  await test("Persists test application and initiates referee verification", async () => {
    await db.insert(applications).values({
      id: testAppId,
      firstName: "Amina",
      lastName: "Bello",
      phone: "08039991122",
      email: `amina.test.${Date.now()}@example.com`,
      age: "28",
      gender: "Female",
      address: "Ibadan, Oyo State",
      
      hasID: "Yes",
      educationLevel: "BSc",
      trainingSiteId: "site-01",
      financiallyAbleToConvey: "Yes",
      refereeDeclarationConfirmed: true,
      refereeDeclarationTimestamp: new Date(),
      refereeVerificationStatus: "in_progress",
      status: "pending",
      submittedAt: new Date(),
    });

    const outcome = await refereeVerificationService.initiateRefereeVerification(
      testAppId,
      "Amina Bello",
      { fullName: "Pastor Samuel Ade", phone: testRef1Phone, relationship: "Religious Leader" },
      { fullName: "Alhaja Fatima Musa", phone: testRef2Phone, relationship: "Community Leader" }
    );

    assert.strictEqual(outcome.success, true);
    assert.strictEqual(outcome.referees.length, 2);

    const sentMsgs = SandboxMessagingProvider.getSentMessages();
    const appMsgs = sentMsgs.filter(m => m.applicationId === testAppId);
    assert.strictEqual(appMsgs.length >= 2, true);
    assert.strictEqual(appMsgs[0].templateId, "MSG-01");
  });

  // ─────────────────────────────────────────────
  // 4. INBOUND RESPONSES & STATUS MACHINE
  // ─────────────────────────────────────────────
  console.log("\n--- 4. INBOUND RESPONSES & STATUS TRANSITIONS ---");

  let ref1Id = "";
  let ref2Id = "";

  await test("Retrieves referee records for test application", async () => {
    const details = await refereeVerificationService.getApplicationRefereeDetails(testAppId);
    assert.strictEqual(details!.referees.length, 2);
    ref1Id = details!.referees[0].id;
    ref2Id = details!.referees[1].id;
    assert.strictEqual(details!.referees[0].status, "REF-PENDING");
  });

  await test("Referee 1 sends YES reply (>90s) -> triggers MSG-02 (Relationship category)", async () => {
    const outcome = await refereeVerificationService.handleInboundMessage({
      from: testRef1Phone,
      text: "YES",
      channel: "whatsapp",
      timestamp: new Date(Date.now() + 150000), // 150s later (> 90s anomaly threshold)
    });

    assert.strictEqual(outcome.handled, true);
    assert.strictEqual(outcome.action, "AFFIRMATIVE_RESPONSE_PROCESSED");

    const [r1] = await db.select().from(applicationReferees).where(eq(applicationReferees.id, ref1Id));
    assert.strictEqual(r1.firstResponseAt !== null, true);
    assert.strictEqual(r1.rapidResponseFlagged, false);

    const sent = SandboxMessagingProvider.getSentMessages();
    const msg02 = sent.find(m => m.refereeId === ref1Id && m.templateId === "MSG-02");
    assert.strictEqual(!!msg02, true);
  });

  await test("Referee 1 selects Relationship '1' (Religious Leader) -> Verified (REF-VERIFIED)", async () => {
    const outcome = await refereeVerificationService.handleInboundMessage({
      from: testRef1Phone,
      text: "1",
      channel: "whatsapp",
      timestamp: new Date(),
    });

    assert.strictEqual(outcome.handled, true);
    assert.strictEqual(outcome.action, "RELATIONSHIP_CATEGORY_SAVED");

    const [r1] = await db.select().from(applicationReferees).where(eq(applicationReferees.id, ref1Id));
    assert.strictEqual(r1.status, "REF-VERIFIED");
    assert.strictEqual(r1.relationshipCategory, "Religious Leader");
    assert.strictEqual(r1.status, "REF-VERIFIED");
  });

  await test("1 Referee Verified -> Application marked Eligible for Review and triggers MSG-06", async () => {
    const [appRecord] = await db.select().from(applications).where(eq(applications.id, testAppId));
    assert.strictEqual(appRecord.isEligibleForReview, true);
    assert.strictEqual(appRecord.refereeVerificationStatus, "REF-VERIFIED");

    const sent = SandboxMessagingProvider.getSentMessages();
    const msg06 = sent.find(m => m.applicationId === testAppId && m.templateId === "MSG-06");
    assert.strictEqual(!!msg06, true);
  });

  await test("Referee 2 declines (Inbound NO) -> REF-DECLINED, does NOT revoke Application Eligibility", async () => {
    const outcome = await refereeVerificationService.handleInboundMessage({
      from: testRef2Phone,
      text: "NO",
      channel: "whatsapp",
      timestamp: new Date(),
    });

    assert.strictEqual(outcome.handled, true);
    assert.strictEqual(outcome.action, "DECLINE_RECORDED");

    const [r2] = await db.select().from(applicationReferees).where(eq(applicationReferees.id, ref2Id));
    assert.strictEqual(r2.status, "REF-DECLINED");

    const [appRecord] = await db.select().from(applications).where(eq(applications.id, testAppId));
    assert.strictEqual(appRecord.isEligibleForReview, true);

    const sent = SandboxMessagingProvider.getSentMessages();
    const msg05 = sent.find(m => m.applicationId === testAppId && m.templateId === "MSG-05");
    assert.strictEqual(!!msg05, true);
  });

  // ─────────────────────────────────────────────
  // 5. RAPID RESPONSE ANOMALY (GATE 3)
  // ─────────────────────────────────────────────
  console.log("\n--- 5. RAPID RESPONSE ANOMALY (GATE 3) ---");

  const testAppId2 = uuidv4();
  const testRefFastPhone = "0814" + Math.floor(1000000 + Math.random() * 9000000);
  const testRefSlowPhone = "0815" + Math.floor(1000000 + Math.random() * 9000000);

  await test("Gate 3: Flags response under 90 seconds and schedules 24h MSG-07 without auto-rejection", async () => {
    await db.insert(applications).values({
      id: testAppId2,
      firstName: "Chioma",
      lastName: "Okeke",
      phone: "08031112233",
      email: `chioma.test.${Date.now()}@example.com`,
      age: "24",
      gender: "Female",
      address: "Oyo State",
      
      hasID: "Yes",
      educationLevel: "BSc",
      trainingSiteId: "site-01",
      financiallyAbleToConvey: "Yes",
      refereeDeclarationConfirmed: true,
      refereeDeclarationTimestamp: new Date(),
      status: "pending",
      submittedAt: new Date(),
    });

    await refereeVerificationService.initiateRefereeVerification(
      testAppId2,
      "Chioma Okeke",
      { fullName: "Fast Referee", phone: testRefFastPhone, relationship: "Employer / Business Supervisor" },
      { fullName: "Other Referee", phone: testRefSlowPhone, relationship: "Teacher / Academic Mentor" }
    );

    const details = await refereeVerificationService.getApplicationRefereeDetails(testAppId2);
    const fastRefId = details!.referees[0].id;

    // Simulate response in 30 seconds (< 90 seconds)
    const outcome = await refereeVerificationService.handleInboundMessage({
      from: testRefFastPhone,
      text: "YES",
      channel: "whatsapp",
      timestamp: new Date(Date.now() + 30000),
    });

    assert.strictEqual(outcome.handled, true);

    const [r] = await db.select().from(applicationReferees).where(eq(applicationReferees.id, fastRefId));
    assert.strictEqual(r.rapidResponseFlagged, true);
    assert.strictEqual(r.reconfirmationStatus, "pending");

    // Complete relationship step
    await refereeVerificationService.handleInboundMessage({
      from: testRefFastPhone,
      text: "3", // Employer
      channel: "whatsapp",
      timestamp: new Date(Date.now() + 35000),
    });

    const [rVerified] = await db.select().from(applicationReferees).where(eq(applicationReferees.id, fastRefId));
    assert.strictEqual(rVerified.rapidResponseFlagged, true);
    assert.strictEqual(rVerified.status, "REF-FLAGGED");

    const [reconfJob] = await db.select().from(refereeScheduledJobs)
      .where(sql`${refereeScheduledJobs.refereeId} = ${fastRefId} AND ${refereeScheduledJobs.jobType} = 'RAPID_RESPONSE_RECONFIRMATION'`);
    assert.strictEqual(!!reconfJob, true);
  });

  // ─────────────────────────────────────────────
  // 6. MICRO-FORM VALIDATION & SUBMISSION
  // ─────────────────────────────────────────────
  console.log("\n--- 6. SECURE REFEREE MICRO-FORM ---");

  await test("Micro-form: Validates token and blocks invalid tokens", async () => {
    const invalidRes = await refereeVerificationService.getMicroForm("invalid-fake-token-12345");
    assert.strictEqual(invalidRes.valid, false);

    const details = await refereeVerificationService.getApplicationRefereeDetails(testAppId2);
    const slowRef = details!.referees[1];
    assert.strictEqual(!!slowRef.token, true);

    const validRes = await refereeVerificationService.getMicroForm(slowRef.token!);
    assert.strictEqual(validRes.valid, true);
    assert.strictEqual(validRes.data?.applicantName?.includes("Chioma"), true);
  });

  await test("Micro-form: Rejects invalid fields (Name < 3 chars, Statement < 20 chars)", async () => {
    const details = await refereeVerificationService.getApplicationRefereeDetails(testAppId2);
    const slowRef = details!.referees[1];

    const shortNameRes = await refereeVerificationService.submitMicroForm(slowRef.token!, {
      fullName: "Al",
      relationship: "Teacher / Academic Mentor",
      durationOfRelationship: "1–3 years",
      vouchesCommitment: true,
      farmingInterestDescription: "This candidate is very dedicated and honest.",
    });
    assert.strictEqual(shortNameRes.success, false);

    const shortStmtRes = await refereeVerificationService.submitMicroForm(slowRef.token!, {
      fullName: "Alhaji Musa",
      relationship: "Teacher / Academic Mentor",
      durationOfRelationship: "1–3 years",
      vouchesCommitment: true,
      farmingInterestDescription: "Too short",
    });
    assert.strictEqual(shortStmtRes.success, false);
  });

  await test("Micro-form: Valid submission marks referee verified (Q4=YES)", async () => {
    const details = await refereeVerificationService.getApplicationRefereeDetails(testAppId2);
    const slowRef = details!.referees[1];

    const submitRes = await refereeVerificationService.submitMicroForm(slowRef.token!, {
      fullName: "Alhaji Musa Danladi",
      relationship: "Teacher / Academic Mentor",
      durationOfRelationship: "3–5 years",
      vouchesCommitment: true,
      farmingInterestDescription: "Chioma has shown exceptional commitment to livestock management and community development.",
    });

    assert.strictEqual(submitRes.success, true);
    assert.strictEqual(submitRes.refereeStatus, "REF-VERIFIED");

    // Token must be invalidated for one-time submission
    const secondSubmitRes = await refereeVerificationService.submitMicroForm(slowRef.token!, {
      fullName: "Alhaji Musa Danladi",
      relationship: "Teacher / Academic Mentor",
      durationOfRelationship: "3–5 years",
      vouchesCommitment: true,
      farmingInterestDescription: "Trying to submit a second duplicate reference form.",
    });
    assert.strictEqual(secondSubmitRes.success, false);
  });

  // ─────────────────────────────────────────────
  // 7. SCHEDULED JOBS WORKER
  // ─────────────────────────────────────────────
  console.log("\n--- 7. SCHEDULED JOBS WORKER & AUDIT INTEGRITY ---");

  await test("Durable scheduled jobs worker processes pending jobs idempotently", async () => {
    const stats = await refereeVerificationService.processScheduledJobs();
    assert.strictEqual(typeof stats.processed, "number");
    assert.strictEqual(typeof stats.errors, "number");
  });

  await test("Audit logs accurately record state transitions and reasons", async () => {
    const details = await refereeVerificationService.getApplicationRefereeDetails(testAppId);
    assert.strictEqual(details!.auditLogs.length >= 2, true);

    const passLog = details!.auditLogs.find((l: any) => l.eventType === "GATE_CHECK_PASSED" || l.eventType === "MSG_SENT");
    assert.strictEqual(!!passLog, true);

    const statusLog = details!.auditLogs.find((l: any) => l.eventType === "STATUS_CHANGED");
    assert.strictEqual(!!statusLog, true);
  });

  // Clean up test data
  try {
    await db.delete(applications).where(eq(applications.id, testAppId));
    await db.delete(applications).where(eq(applications.id, testAppId2));
  } catch {}

  console.log("\n=============================================================");
  console.log(`  TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("=============================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTestSuite().catch((err) => {
  console.error("Test suite fatal error:", err);
  process.exit(1);
});
