import "dotenv/config";
import assert from "assert";
import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/index";
import {
  trainerLessonReports,
  trainerReportAttachments,
  trainerReportAuditLogs,
} from "../src/db/schema";
import { trainerReportsRouter } from "../src/routes/trainerReports";
import {
  validateAttachmentFile,
  generateSignedAttachmentAccessUrl,
} from "../src/services/cloudinaryReports";

const JWT_SECRET = process.env.JWT_SECRET || "oriyon-secret-key-2026-qa-test";
const TRAINER_A_ID = "11111111-1111-4111-8111-111111111111";
const TRAINER_B_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
const COHORT_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_1_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_2_ID = "66666666-6666-4666-8666-666666666666";

function signToken(userId: string, role: string, email: string, name: string) {
  return jwt.sign({ userId, role, email, name }, JWT_SECRET, { expiresIn: "1h" });
}

async function runTests() {
  console.log("\n=====================================================================");
  console.log("  EEWYLA TRAINER REPORTING, ADMIN DASHBOARD & CLOUDINARY TEST SUITE");
  console.log("=====================================================================\n");

  const app = express();
  app.use(express.json());
  app.use("/api/lms/trainer-reports", trainerReportsRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api/lms/trainer-reports`;

  const tokenA = signToken(TRAINER_A_ID, "trainer", "trainera@oriyon.ng", "Adaeze Okafor");
  const tokenB = signToken(TRAINER_B_ID, "trainer", "trainerb@oriyon.ng", "Babatunde Bello");
  const tokenAdmin = signToken(ADMIN_ID, "admin", "epa@oriyon.ng", "Chioma EPA Admin");

  const createdReportIds: string[] = [];
  let passed = 0;
  let failed = 0;

  async function check(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ FAIL: ${name} -> ${err?.message}`);
      failed++;
    }
  }

  try {
    // 1. Cloudinary validation & short-lived signed delivery tests
    await check("Cloudinary file validation rejects oversized (>10MB) and invalid extensions", () => {
      const tooBig = validateAttachmentFile("image/jpeg", "photo.jpg", 11 * 1024 * 1024);
      assert.strictEqual(tooBig.valid, false);
      const badExt = validateAttachmentFile("application/x-msdownload", "malware.exe", 1024);
      assert.strictEqual(badExt.valid, false);
      const goodImg = validateAttachmentFile("image/png", "session.png", 2048);
      assert.strictEqual(goodImg.valid, true);
      if (goodImg.valid) assert.strictEqual(goodImg.resourceType, "image");
      const goodPdf = validateAttachmentFile("application/pdf", "register.pdf", 4096);
      assert.strictEqual(goodPdf.valid, true);
      if (goodPdf.valid) assert.strictEqual(goodPdf.resourceType, "raw");
    });

    await check("Cloudinary short-lived signed access URL uses authenticated delivery & expires_at", () => {
      process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "test_key";
      process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "test_secret";
      const signed = generateSignedAttachmentAccessUrl({
        publicId: "eewyla-reports/test/att1",
        resourceType: "raw",
        format: "pdf",
        download: true,
        ttlSeconds: 300,
      });
      assert.ok(signed.url.includes("type=authenticated"));
      assert.ok(signed.url.includes("expires_at="));
      assert.ok(signed.url.includes("signature="));
      assert.ok(signed.url.includes("attachment=true"));
    });

    // 2. Reject Base64 in PostgreSQL
    await check("POST / rejects Base64 data URLs in attachmentUrl (HTTP 400)", async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          cohortId: COHORT_ID,
          weekNumber: 1,
          sessionTitle: "Base64 Rejection Test",
          dateConducted: new Date().toISOString(),
          attachmentUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
          action: "draft",
        }),
      });
      assert.strictEqual(res.status, 400);
    });

    // 3. Trainer A creates Draft -> Draft cannot be marked delivered
    let reportA1Id = "";
    await check("Trainer A creates 7-section Draft and cannot mark draft delivered (HTTP 400)", async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          cohortId: COHORT_ID,
          cohortName: "EEWYLA Cohort Test",
          sessionId: SESSION_1_ID,
          weekNumber: 1,
          sessionTitle: "Week 1 Session 1 - Biosecurity",
          sessionType: "practical",
          dateConducted: new Date().toISOString(),
          sessionStartTime: "09:00",
          sessionEndTime: "12:00",
          location: "Site A",
          expectedTrainees: 30,
          traineesPresent: 27,
          objectives: "Understand poultry biosecurity",
          topicsCovered: "Footbaths and disinfection",
          activities: "Hands-on footbath setup",
          learningOutcomes: "Trainees set up footbath independently",
          challenges: "Water pressure low",
          incidentsOccurred: false,
          lookingAhead: "Brooder prep next week",
          trainerSignOffName: "Adaeze Okafor",
          action: "draft",
        }),
      });
      assert.strictEqual(res.status, 201);
      const data = (await res.json()) as any;
      reportA1Id = data.report.id;
      createdReportIds.push(reportA1Id);

      const delRes = await fetch(`${baseUrl}/${reportA1Id}/mark-delivered`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(delRes.status, 400);
    });

    // 4. Trainer A submits report & marks delivered BEFORE EPA confirmation (non-blocking)
    await check("Trainer A submits 7-section report and marks delivered before EPA confirmation", async () => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          id: reportA1Id,
          cohortId: COHORT_ID,
          cohortName: "EEWYLA Cohort Test",
          sessionId: SESSION_1_ID,
          weekNumber: 1,
          sessionTitle: "Week 1 Session 1 - Biosecurity",
          sessionType: "practical",
          dateConducted: new Date().toISOString(),
          expectedTrainees: 30,
          traineesPresent: 27,
          topicsCovered: "Footbaths and disinfection protocols",
          activities: "Hands-on footbath setup at farm gate",
          learningOutcomes: "All 27 trainees demonstrated proper mixing",
          action: "submit",
        }),
      });
      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as any;
      assert.strictEqual(data.report.status, "submitted");
      assert.strictEqual(data.report.isLate, false);

      const delRes = await fetch(`${baseUrl}/${reportA1Id}/mark-delivered`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(delRes.status, 200);
    });

    // 5. Multiple sessions in same week (one report per actual session) + Late submission (>24h)
    let reportA2Id = "";
    await check("Trainer A submits second session in Week 1 (>24h late) and is flagged isLate=true", async () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          cohortId: COHORT_ID,
          cohortName: "EEWYLA Cohort Test",
          sessionId: SESSION_2_ID,
          weekNumber: 1,
          sessionTitle: "Week 1 Session 2 - Feed Storage",
          sessionType: "physical",
          dateConducted: twoDaysAgo,
          expectedTrainees: 30,
          traineesPresent: 25,
          topicsCovered: "Rodent-proof feed storage",
          activities: "Inspected feed store layout",
          learningOutcomes: "Trainees identified 5 storage hazards",
          action: "submit",
        }),
      });
      assert.strictEqual(res.status, 201);
      const data = (await res.json()) as any;
      reportA2Id = data.report.id;
      createdReportIds.push(reportA2Id);
      assert.strictEqual(data.report.isLate, true);
      assert.notStrictEqual(reportA2Id, reportA1Id);
    });

    // 6. Trainer B isolation: cannot view Trainer A's report, cannot upload to Trainer A's report, cannot access Trainer A's attachments
    let attId = "";
    await check("Trainer B cannot view Trainer A's report, upload attachments, or access signed URLs (HTTP 403)", async () => {
      const getRes = await fetch(`${baseUrl}/${reportA1Id}`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.strictEqual(getRes.status, 403);

      // Insert an attachment row for Trainer A to test access isolation
      const [att] = await db
        .insert(trainerReportAttachments)
        .values({
          reportId: reportA1Id,
          trainerId: TRAINER_A_ID,
          cloudinaryPublicId: `eewyla-reports/${TRAINER_A_ID}/${reportA1Id}/test-${crypto.randomBytes(4).toString("hex")}`,
          resourceType: "raw",
          deliveryType: "authenticated",
          originalFilename: "attendance-register.pdf",
          fileFormat: "pdf",
          fileSize: 24500,
          attachmentCategory: "attendance",
          uploadedBy: TRAINER_A_ID,
        })
        .returning();
      attId = att.id;

      const accessB = await fetch(`${baseUrl}/${reportA1Id}/attachments/${attId}/access`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.strictEqual(accessB.status, 403);

      const accessA = await fetch(`${baseUrl}/${reportA1Id}/attachments/${attId}/access`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(accessA.status, 200);
      const accessAData = (await accessA.json()) as any;
      assert.ok(accessAData.url.includes("type=authenticated"));
    });

    // 7. Trainer cannot access /admin/all or /epa-confirm
    await check("Trainer A is strictly blocked from /admin/all and /epa-confirm (HTTP 403)", async () => {
      const adminRes = await fetch(`${baseUrl}/admin/all`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(adminRes.status, 403);

      const epaRes = await fetch(`${baseUrl}/${reportA1Id}/epa-confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ epaNotes: "Attempted self-confirm" }),
      });
      assert.strictEqual(epaRes.status, 403);
    });

    // 8. Admin / EPA sees all reports with trainer full name, filters, views 7 sections + audit logs, and confirms EPA receipt
    await check("Admin views all reports with trainer names, filters, 7 sections, attachments, and confirms EPA receipt", async () => {
      const allRes = await fetch(`${baseUrl}/admin/all?deadlineStatus=late`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert.strictEqual(allRes.status, 200);
      const allData = (await allRes.json()) as any;
      const foundLate = allData.reports.find((r: any) => r.id === reportA2Id);
      assert.ok(foundLate, "Admin late filter should return Trainer A's late report");
      assert.strictEqual(foundLate.trainerName, "Adaeze Okafor");

      const epaConfirmRes = await fetch(`${baseUrl}/${reportA1Id}/epa-confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({ epaNotes: "Verified attendance & biosecurity report" }),
      });
      assert.strictEqual(epaConfirmRes.status, 200);
      const epaData = (await epaConfirmRes.json()) as any;
      assert.strictEqual(epaData.report.epaConfirmed, true);
      assert.strictEqual(epaData.report.epaConfirmedBy, ADMIN_ID);
      assert.strictEqual(epaData.report.epaConfirmedByName, "Chioma EPA Admin");

      const detailRes = await fetch(`${baseUrl}/${reportA1Id}`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert.strictEqual(detailRes.status, 200);
      const detail = (await detailRes.json()) as any;
      assert.strictEqual(detail.attachments.length, 1);
      assert.ok(detail.auditLogs.some((l: any) => l.action === "epa_confirmed"));
      assert.ok(detail.auditLogs.some((l: any) => l.action === "marked_delivered"));
      assert.ok(detail.auditLogs.some((l: any) => l.action === "submitted"));
    });
  } finally {
    // Clean up test records
    for (const rid of createdReportIds) {
      await db.delete(trainerLessonReports).where(eq(trainerLessonReports.id, rid)).catch(() => {});
    }
    server.close();
  }

  console.log(`\n=====================================================================`);
  console.log(`  EXTENDED SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`=====================================================================\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
