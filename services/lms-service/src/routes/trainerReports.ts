import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, asc, inArray } from "drizzle-orm";
import { z } from "zod";
import jwt from "jsonwebtoken";
import multer from "multer";
import { db } from "../index";
import {
  weeks,
  physicalSessions,
  trainerLessonReports,
  trainerReportAttachments,
  trainerReportAuditLogs,
} from "../db/schema";
import { publishEvent } from "../rabbitmq";
import { fetchUser } from "./lms";
import {
  MAX_ATTACHMENT_BYTES,
  getCloudinaryConfig,
  uploadReportAttachmentToCloudinary,
  generateSignedAttachmentAccessUrl,
  deleteCloudinaryAttachment,
} from "../services/cloudinaryReports";

export const trainerReportsRouter = Router();

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ADMIN_REPORT_ROLES = new Set(["admin", "sub_admin", "lead_trainer"]);

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
});

function getAuthUserContext(req: Request) {
  let userId = (req.headers["x-user-id"] as string | undefined)?.trim();
  let role = (req.headers["x-user-role"] as string | undefined)?.trim()?.toLowerCase();
  let email = (req.headers["x-user-email"] as string | undefined)?.trim();
  let name = (req.headers["x-user-name"] as string | undefined)?.trim();

  if (userId === "undefined" || userId === "null") userId = undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (process.env.JWT_SECRET) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET) as any;
        if (!userId && (payload?.id || payload?.userId || payload?.sub)) {
          userId = (payload.userId || payload.id || payload.sub)?.toString();
        }
        if (!role && payload?.role) role = payload.role?.toLowerCase();
        if (!email && payload?.email) email = payload.email;
        if (!name && (payload?.name || payload?.firstName)) {
          name = payload.name || `${payload.firstName || ""} ${payload.lastName || ""}`.trim();
        }
      } catch {}
    }
    if (!userId) {
      try {
        const decoded = jwt.decode(token) as any;
        if (decoded?.id || decoded?.userId || decoded?.sub) {
          userId = (decoded.userId || decoded.id || decoded.sub)?.toString();
        }
        if (!role && decoded?.role) role = decoded.role?.toLowerCase();
        if (!email && decoded?.email) email = decoded.email;
      } catch {}
    }
  }

  return { userId, role, email, name };
}

async function resolveUserIdentity(userId: string, fallbackName?: string | null, fallbackEmail?: string | null) {
  if (fallbackName && fallbackName.trim() && fallbackEmail) {
    return { name: fallbackName.trim(), email: fallbackEmail };
  }
  const user = await fetchUser(userId);
  const resolvedName = user
    ? `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email
    : fallbackName || null;
  const resolvedEmail = user?.email || fallbackEmail || null;
  return { name: resolvedName, email: resolvedEmail };
}

async function recordReportAudit(params: {
  reportId: string;
  action: string;
  actorId: string;
  actorName?: string | null;
  actorRole?: string | null;
  details?: Record<string, any>;
}) {
  try {
    await db.insert(trainerReportAuditLogs).values({
      reportId: params.reportId,
      action: params.action,
      actorId: params.actorId,
      actorName: params.actorName || null,
      actorRole: params.actorRole || null,
      details: params.details || {},
    });
  } catch (err) {
    console.warn("[lms-service] Audit log write skipped:", err);
  }
}

function serializeAttachmentMetadata(att: typeof trainerReportAttachments.$inferSelect) {
  return {
    id: att.id,
    reportId: att.reportId,
    originalFilename: att.originalFilename,
    resourceType: att.resourceType,
    deliveryType: att.deliveryType,
    fileFormat: att.fileFormat,
    fileSize: att.fileSize,
    attachmentCategory: att.attachmentCategory,
    uploadedBy: att.uploadedBy,
    createdAt: att.createdAt,
  };
}

// Schema for official 7-section EEWYLA report creation / update
const reportInputSchema = z.object({
  id: z.string().uuid().optional().nullable().or(z.literal("")),
  cohortId: z.string().uuid("Invalid cohort ID"),
  cohortName: z.string().optional().nullable().or(z.literal("")),
  groupId: z.string().optional().nullable().or(z.literal("")),
  groupName: z.string().optional().nullable().or(z.literal("")),
  sessionId: z.string().uuid().optional().nullable().or(z.literal("")),
  lessonId: z.string().uuid().optional().nullable().or(z.literal("")),
  weekNumber: z.coerce.number().int().min(1, "Week number must be at least 1").max(12, "Week number cannot exceed 12").default(1),

  // Section 1: Session details
  sessionTitle: z.string().min(2, "Session/Lesson title is required"),
  sessionType: z.enum(["physical", "practical", "online", "hybrid"]).optional().default("practical"),
  dateConducted: z.string().min(1, "Date conducted is required"),
  sessionStartTime: z.string().optional().nullable().or(z.literal("")),
  sessionEndTime: z.string().optional().nullable().or(z.literal("")),
  location: z.string().optional().nullable().or(z.literal("")),

  // Section 2: Attendance
  expectedTrainees: z.coerce.number().int().min(0).optional().default(0),
  traineesPresent: z.coerce.number().int().min(0, "Trainees count cannot be negative").default(0),
  absentTrainees: z.coerce.number().int().min(0).optional().default(0),
  attendanceNotes: z.string().optional().nullable().or(z.literal("")),
  attendanceEvidenceRef: z.string().optional().nullable().or(z.literal("")),

  // Section 3: Objectives and outcomes
  objectives: z.string().optional().nullable().or(z.literal("")),
  topicsCovered: z.string().optional().nullable().or(z.literal("")),
  activities: z.string().optional().nullable().or(z.literal("")),
  learningOutcomes: z.string().optional().nullable().or(z.literal("")),

  // Section 4: Issues raised
  challenges: z.string().optional().nullable().or(z.literal("")),

  // Section 5: Incidents
  incidentsOccurred: z.boolean().optional().default(false),
  incidentDetails: z.string().optional().nullable().or(z.literal("")),

  // Section 6: Looking ahead
  lookingAhead: z.string().optional().nullable().or(z.literal("")),

  // Section 7: Sign-off
  comments: z.string().optional().nullable().or(z.literal("")),
  trainerSignOffName: z.string().optional().nullable().or(z.literal("")),

  // Legacy fields — Base64 explicitly disallowed
  attachmentUrl: z.string().optional().nullable().or(z.literal("")),
  attachmentName: z.string().optional().nullable().or(z.literal("")),
  action: z.enum(["draft", "submit"]).default("draft"),
});

// 1. POST /trainer-reports — Create or update lesson report (7-Section EEWYLA)
trainerReportsRouter.post(["/", ""], async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId || !UUID_REGEX.test(auth.userId)) {
      return res.status(401).json({ error: "Authentication required to submit trainer reports." });
    }

    const parseResult = reportInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Validation error",
        details: parseResult.error.flatten(),
      });
    }

    const data = parseResult.data;
    const isSubmit = data.action === "submit";

    if (data.attachmentUrl && data.attachmentUrl.trim().startsWith("data:")) {
      return res.status(400).json({
        error: "Base64 document contents cannot be stored in the database. Upload supporting documents via Cloudinary.",
      });
    }

    if (isSubmit) {
      if (!data.topicsCovered || data.topicsCovered.trim().length < 5) {
        return res.status(400).json({ error: "Topics covered is required (at least 5 characters) for submission." });
      }
      if (!data.activities || data.activities.trim().length < 5) {
        return res.status(400).json({ error: "Activities or practical exercises is required (at least 5 characters) for submission." });
      }
      if (!data.learningOutcomes || data.learningOutcomes.trim().length < 5) {
        return res.status(400).json({ error: "Learning outcomes is required (at least 5 characters) for submission." });
      }
      if (typeof data.traineesPresent !== "number" || data.traineesPresent < 0) {
        return res.status(400).json({ error: "Valid number of trainees present is required." });
      }
      if (data.incidentsOccurred && (!data.incidentDetails || data.incidentDetails.trim().length < 5)) {
        return res.status(400).json({ error: "Please provide incident details when incidents are marked as having occurred." });
      }
    }

    const parsedDate = new Date(data.dateConducted);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: "Invalid date format for dateConducted." });
    }

    const submissionDeadline = new Date(parsedDate.getTime() + 24 * 60 * 60 * 1000);
    const targetWeek = Number(data.weekNumber) || 1;
    const isTrainerRole = auth.role === "trainer";

    if (data.id === "" || !data.id) data.id = undefined;
    const sanitizedGroupId = data.groupId?.trim() || null;
    const sanitizedCohortName = data.cohortName?.trim() || null;
    const sanitizedGroupName = data.groupName?.trim() || null;
    const sanitizedSessionId = data.sessionId?.trim() || null;
    const sanitizedLessonId = data.lessonId?.trim() || null;
    const sanitizedAttachmentUrl = data.attachmentUrl?.trim() || null;
    const sanitizedAttachmentName = data.attachmentName?.trim() || (sanitizedAttachmentUrl ? "Supporting Evidence" : null);

    // Sequential week progression gate for regular trainers
    if (isTrainerRole && targetWeek > 1) {
      const priorConditions = [
        eq(trainerLessonReports.trainerId, auth.userId),
        eq(trainerLessonReports.cohortId, data.cohortId),
        eq(trainerLessonReports.weekNumber, targetWeek - 1),
        eq(trainerLessonReports.status, "submitted"),
      ];

      const [priorReport] = await db
        .select()
        .from(trainerLessonReports)
        .where(and(...priorConditions))
        .limit(1);

      if (!priorReport) {
        return res.status(400).json({
          error: `Cannot take or submit training for Week ${targetWeek}. You must submit your training report for Week ${targetWeek - 1} first.`,
          code: "PRIOR_WEEK_REPORT_REQUIRED",
          requiredWeek: targetWeek - 1,
          requestedWeek: targetWeek,
        });
      }
    }

    // Enforce one report per actual session when sessionId is provided
    if (!data.id) {
      if (sanitizedSessionId) {
        const [existingSessionReport] = await db
          .select()
          .from(trainerLessonReports)
          .where(
            and(
              eq(trainerLessonReports.trainerId, auth.userId),
              eq(trainerLessonReports.sessionId, sanitizedSessionId)
            )
          )
          .limit(1);
        if (existingSessionReport) {
          data.id = existingSessionReport.id;
        }
      } else {
        const matchConditions = [
          eq(trainerLessonReports.trainerId, auth.userId),
          eq(trainerLessonReports.cohortId, data.cohortId),
          eq(trainerLessonReports.weekNumber, targetWeek),
        ];
        if (sanitizedGroupId) {
          matchConditions.push(eq(trainerLessonReports.groupId, sanitizedGroupId));
        }

        const [existingWeekReport] = await db
          .select()
          .from(trainerLessonReports)
          .where(and(...matchConditions))
          .limit(1);

        if (existingWeekReport) {
          data.id = existingWeekReport.id;
        }
      }
    }

    const identity = await resolveUserIdentity(auth.userId, auth.name, auth.email);
    const computedAbsent =
      data.absentTrainees > 0
        ? data.absentTrainees
        : data.expectedTrainees > data.traineesPresent
        ? data.expectedTrainees - data.traineesPresent
        : 0;

    if (data.id) {
      const [existing] = await db
        .select()
        .from(trainerLessonReports)
        .where(eq(trainerLessonReports.id, data.id))
        .limit(1);

      if (!existing) {
        return res.status(404).json({ error: "Report not found." });
      }

      const isOwner = existing.trainerId === auth.userId;
      const isAdmin = Boolean(auth.role && ADMIN_REPORT_ROLES.has(auth.role));
      if (!isOwner && !isAdmin) {
        return res.status(403).json({ error: "Unauthorized to edit this report." });
      }

      const now = new Date();
      const effectiveSubmittedAt = isSubmit ? (existing.submittedAt || now) : existing.submittedAt;
      const isLate = effectiveSubmittedAt
        ? effectiveSubmittedAt.getTime() > submissionDeadline.getTime()
        : false;

      const updatePayload: any = {
        cohortId: data.cohortId,
        sessionTitle: data.sessionTitle,
        sessionType: data.sessionType || existing.sessionType || "practical",
        dateConducted: parsedDate,
        sessionStartTime: data.sessionStartTime?.trim() || null,
        sessionEndTime: data.sessionEndTime?.trim() || null,
        location: data.location?.trim() || null,
        expectedTrainees: data.expectedTrainees ?? existing.expectedTrainees ?? 0,
        traineesPresent: data.traineesPresent ?? 0,
        absentTrainees: computedAbsent,
        attendanceNotes: data.attendanceNotes?.trim() || null,
        attendanceEvidenceRef: data.attendanceEvidenceRef?.trim() || null,
        objectives: data.objectives?.trim() || null,
        topicsCovered: data.topicsCovered || "",
        activities: data.activities || "",
        learningOutcomes: data.learningOutcomes || "",
        challenges: data.challenges?.trim() || null,
        incidentsOccurred: Boolean(data.incidentsOccurred),
        incidentDetails: data.incidentDetails?.trim() || null,
        lookingAhead: data.lookingAhead?.trim() || null,
        comments: data.comments?.trim() || null,
        trainerSignOffName: data.trainerSignOffName?.trim() || identity.name || existing.trainerSignOffName || null,
        trainerSignedAt: isSubmit ? (existing.trainerSignedAt || now) : existing.trainerSignedAt,
        attachmentUrl: sanitizedAttachmentUrl,
        attachmentName: sanitizedAttachmentName,
        status: isSubmit ? "submitted" : "draft",
        submissionDeadline,
        isLate,
        updatedAt: now,
      };

      if (identity.name && !existing.trainerName) updatePayload.trainerName = identity.name;
      if (identity.email && !existing.trainerEmail) updatePayload.trainerEmail = identity.email;
      if (sanitizedCohortName) updatePayload.cohortName = sanitizedCohortName;
      if (sanitizedGroupId !== undefined) updatePayload.groupId = sanitizedGroupId;
      if (sanitizedGroupName) updatePayload.groupName = sanitizedGroupName;
      if (sanitizedSessionId !== undefined) updatePayload.sessionId = sanitizedSessionId;
      if (sanitizedLessonId !== undefined) updatePayload.lessonId = sanitizedLessonId;
      if (data.weekNumber !== undefined) updatePayload.weekNumber = data.weekNumber;
      if (isSubmit && !existing.submittedAt) {
        updatePayload.submittedAt = now;
      }

      const [updated] = await db
        .update(trainerLessonReports)
        .set(updatePayload)
        .where(eq(trainerLessonReports.id, data.id))
        .returning();

      const auditAction =
        existing.status === "submitted"
          ? "amended"
          : isSubmit
          ? "submitted"
          : "draft_saved";

      await recordReportAudit({
        reportId: updated.id,
        action: auditAction,
        actorId: auth.userId,
        actorName: identity.name,
        actorRole: auth.role,
        details: {
          weekNumber: updated.weekNumber,
          isLate: updated.isLate,
          status: updated.status,
        },
      });

      if (isSubmit) {
        publishEvent("trainer.report.submitted", {
          reportId: updated.id,
          trainerId: updated.trainerId,
          cohortId: updated.cohortId,
          groupId: updated.groupId,
          sessionTitle: updated.sessionTitle,
          traineesPresent: updated.traineesPresent,
          isLate: updated.isLate,
          submittedAt: updated.submittedAt,
        }).catch(() => {});
      }

      return res.json({
        success: true,
        message: isSubmit
          ? updated.isLate
            ? "Lesson report submitted (marked as submitted after 24-hour SLA)."
            : "Lesson report submitted successfully."
          : "Draft saved successfully.",
        report: updated,
      });
    }

    const now = new Date();
    const submittedAt = isSubmit ? now : null;
    const isLate = submittedAt ? submittedAt.getTime() > submissionDeadline.getTime() : false;

    const [created] = await db
      .insert(trainerLessonReports)
      .values({
        trainerId: auth.userId,
        trainerName: identity.name,
        trainerEmail: identity.email,
        cohortId: data.cohortId,
        cohortName: sanitizedCohortName,
        groupId: sanitizedGroupId,
        groupName: sanitizedGroupName,
        sessionId: sanitizedSessionId,
        lessonId: sanitizedLessonId,
        weekNumber: data.weekNumber || null,
        sessionTitle: data.sessionTitle,
        sessionType: data.sessionType || "practical",
        dateConducted: parsedDate,
        sessionStartTime: data.sessionStartTime?.trim() || null,
        sessionEndTime: data.sessionEndTime?.trim() || null,
        location: data.location?.trim() || null,
        expectedTrainees: data.expectedTrainees ?? 0,
        traineesPresent: data.traineesPresent ?? 0,
        absentTrainees: computedAbsent,
        attendanceNotes: data.attendanceNotes?.trim() || null,
        attendanceEvidenceRef: data.attendanceEvidenceRef?.trim() || null,
        objectives: data.objectives?.trim() || null,
        topicsCovered: data.topicsCovered || "",
        activities: data.activities || "",
        learningOutcomes: data.learningOutcomes || "",
        challenges: data.challenges?.trim() || null,
        incidentsOccurred: Boolean(data.incidentsOccurred),
        incidentDetails: data.incidentDetails?.trim() || null,
        lookingAhead: data.lookingAhead?.trim() || null,
        comments: data.comments?.trim() || null,
        trainerSignOffName: data.trainerSignOffName?.trim() || identity.name || null,
        trainerSignedAt: isSubmit ? now : null,
        attachmentUrl: sanitizedAttachmentUrl,
        attachmentName: sanitizedAttachmentName,
        status: isSubmit ? "submitted" : "draft",
        submissionDeadline,
        isLate,
        isDelivered: false,
        submittedAt,
      })
      .returning();

    await recordReportAudit({
      reportId: created.id,
      action: isSubmit ? "submitted" : "created",
      actorId: auth.userId,
      actorName: identity.name,
      actorRole: auth.role,
      details: {
        weekNumber: created.weekNumber,
        isLate: created.isLate,
        status: created.status,
      },
    });

    if (isSubmit) {
      publishEvent("trainer.report.submitted", {
        reportId: created.id,
        trainerId: created.trainerId,
        cohortId: created.cohortId,
        groupId: created.groupId,
        sessionTitle: created.sessionTitle,
        traineesPresent: created.traineesPresent,
        isLate: created.isLate,
        submittedAt: created.submittedAt,
      }).catch(() => {});
    }

    return res.status(201).json({
      success: true,
      message: isSubmit
        ? created.isLate
          ? "Lesson report submitted (marked as submitted after 24-hour SLA)."
          : "Lesson report submitted successfully."
        : "Draft saved successfully.",
      report: created,
    });
  } catch (err: any) {
    console.error("[lms-service] Error saving trainer report:", err);
    return res.status(500).json({ error: "Failed to save trainer report", details: err?.message });
  }
});

// 2. GET /trainer-reports/my-schedule — Trainer's assigned reporting weeks & actual sessions
trainerReportsRouter.get("/my-schedule", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId || !UUID_REGEX.test(auth.userId)) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const myReports = await db
      .select()
      .from(trainerLessonReports)
      .where(eq(trainerLessonReports.trainerId, auth.userId))
      .orderBy(desc(trainerLessonReports.updatedAt));

    const myAttachments = myReports.length
      ? await db
          .select()
          .from(trainerReportAttachments)
          .where(inArray(trainerReportAttachments.reportId, myReports.map((r) => r.id)))
      : [];

    const attachCountByReport = new Map<string, number>();
    for (const att of myAttachments) {
      attachCountByReport.set(att.reportId, (attachCountByReport.get(att.reportId) || 0) + 1);
    }

    let assignments: any[] = [];
    try {
      const schedRes = await fetch(`${process.env.USER_SERVICE_URL}/users/trainers/my-schedules`, {
        headers: {
          "x-user-id": auth.userId,
          "x-user-email": auth.email || "",
          "x-user-role": auth.role || "trainer",
        },
      });
      if (schedRes.ok) {
        const parsed = await schedRes.json();
        if (Array.isArray(parsed)) assignments = parsed;
      }
    } catch {}

    const cohortIds = Array.from(
      new Set([
        ...assignments.map((a) => a.cohortId).filter((id) => id && UUID_REGEX.test(id)),
        ...myReports.map((r) => r.cohortId).filter((id) => id && UUID_REGEX.test(id)),
      ])
    );

    const cohortWeeks = cohortIds.length
      ? await db
          .select()
          .from(weeks)
          .where(inArray(weeks.cohortId, cohortIds))
          .orderBy(asc(weeks.weekNumber))
      : [];

    const cohortSessions = cohortIds.length
      ? await db
          .select()
          .from(physicalSessions)
          .where(inArray(physicalSessions.cohortId, cohortIds))
          .orderBy(asc(physicalSessions.scheduledAt))
      : [];

    const weekById = new Map(cohortWeeks.map((w) => [w.id, w]));
    const items: any[] = [];
    const matchedReportIds = new Set<string>();

    const deriveStatus = (rep: typeof trainerLessonReports.$inferSelect | undefined) => {
      if (!rep) return "not_submitted";
      if (rep.epaConfirmed) return "confirmed_by_epa";
      if (rep.status === "submitted" && rep.isLate) return "submitted_late";
      if (rep.status === "submitted") return "submitted";
      return "draft";
    };

    for (const sess of cohortSessions) {
      const wk = sess.weekId ? weekById.get(sess.weekId) : undefined;
      const matchingAssignment = assignments.find((a) => a.cohortId === sess.cohortId);
      const rep = myReports.find((r) => r.sessionId === sess.id);
      if (rep) matchedReportIds.add(rep.id);

      const sessionDate = sess.scheduledAt ? sess.scheduledAt.toISOString() : rep?.dateConducted?.toISOString() || null;
      const deadline = sess.scheduledAt
        ? new Date(sess.scheduledAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
        : rep?.submissionDeadline?.toISOString() || null;

      items.push({
        itemKey: `session-${sess.id}`,
        weekNumber: wk?.weekNumber || rep?.weekNumber || 1,
        cohortId: sess.cohortId,
        cohortName: matchingAssignment?.cohortName || rep?.cohortName || "EEWYLA Cohort",
        groupId: matchingAssignment?.groupId || rep?.groupId || null,
        groupName: matchingAssignment?.groupName || rep?.groupName || null,
        sessionId: sess.id,
        sessionTitle: sess.title,
        sessionType: sess.type || "physical",
        sessionDate,
        location: sess.location || rep?.location || null,
        submissionDeadline: deadline,
        reportingStatus: deriveStatus(rep),
        reportId: rep?.id || null,
        submittedAt: rep?.submittedAt ? rep.submittedAt.toISOString() : null,
        isLate: Boolean(rep?.isLate),
        isDelivered: Boolean(rep?.isDelivered),
        epaConfirmed: Boolean(rep?.epaConfirmed),
        epaConfirmedAt: rep?.epaConfirmedAt ? rep.epaConfirmedAt.toISOString() : null,
        epaConfirmedByName: rep?.epaConfirmedByName || null,
        attachmentCount: rep ? attachCountByReport.get(rep.id) || 0 : 0,
        expectedTrainees: matchingAssignment?.studentCount || rep?.expectedTrainees || 0,
      });
    }

    for (const wk of cohortWeeks) {
      const hasSessionsInWeek = cohortSessions.some((s) => s.weekId === wk.id);
      if (hasSessionsInWeek) continue;

      const matchingAssignment = assignments.find((a) => a.cohortId === wk.cohortId);
      const rep = myReports.find(
        (r) => !matchedReportIds.has(r.id) && r.cohortId === wk.cohortId && r.weekNumber === wk.weekNumber
      );
      if (rep) matchedReportIds.add(rep.id);

      items.push({
        itemKey: `week-${wk.id}`,
        weekNumber: wk.weekNumber,
        cohortId: wk.cohortId,
        cohortName: matchingAssignment?.cohortName || rep?.cohortName || "EEWYLA Cohort",
        groupId: matchingAssignment?.groupId || rep?.groupId || null,
        groupName: matchingAssignment?.groupName || rep?.groupName || null,
        sessionId: null,
        sessionTitle: rep?.sessionTitle || `Week ${wk.weekNumber}: ${wk.title}`,
        sessionType: rep?.sessionType || "practical",
        sessionDate: rep?.dateConducted ? rep.dateConducted.toISOString() : null,
        location: rep?.location || null,
        submissionDeadline: rep?.submissionDeadline ? rep.submissionDeadline.toISOString() : null,
        reportingStatus: deriveStatus(rep),
        reportId: rep?.id || null,
        submittedAt: rep?.submittedAt ? rep.submittedAt.toISOString() : null,
        isLate: Boolean(rep?.isLate),
        isDelivered: Boolean(rep?.isDelivered),
        epaConfirmed: Boolean(rep?.epaConfirmed),
        epaConfirmedAt: rep?.epaConfirmedAt ? rep.epaConfirmedAt.toISOString() : null,
        epaConfirmedByName: rep?.epaConfirmedByName || null,
        attachmentCount: rep ? attachCountByReport.get(rep.id) || 0 : 0,
        expectedTrainees: matchingAssignment?.studentCount || rep?.expectedTrainees || 0,
      });
    }

    for (const rep of myReports) {
      if (matchedReportIds.has(rep.id)) continue;
      items.push({
        itemKey: `report-${rep.id}`,
        weekNumber: rep.weekNumber || 1,
        cohortId: rep.cohortId,
        cohortName: rep.cohortName || "EEWYLA Cohort",
        groupId: rep.groupId || null,
        groupName: rep.groupName || null,
        sessionId: rep.sessionId || null,
        sessionTitle: rep.sessionTitle,
        sessionType: rep.sessionType || "practical",
        sessionDate: rep.dateConducted ? rep.dateConducted.toISOString() : null,
        location: rep.location || null,
        submissionDeadline: rep.submissionDeadline ? rep.submissionDeadline.toISOString() : null,
        reportingStatus: deriveStatus(rep),
        reportId: rep.id,
        submittedAt: rep.submittedAt ? rep.submittedAt.toISOString() : null,
        isLate: Boolean(rep.isLate),
        isDelivered: Boolean(rep.isDelivered),
        epaConfirmed: Boolean(rep.epaConfirmed),
        epaConfirmedAt: rep.epaConfirmedAt ? rep.epaConfirmedAt.toISOString() : null,
        epaConfirmedByName: rep.epaConfirmedByName || null,
        attachmentCount: attachCountByReport.get(rep.id) || 0,
        expectedTrainees: rep.expectedTrainees || 0,
      });
    }

    items.sort((a, b) => (a.weekNumber || 0) - (b.weekNumber || 0));

    return res.json({
      success: true,
      assignments,
      items,
      reports: myReports.map((r) => ({
        ...r,
        attachments: myAttachments.filter((a) => a.reportId === r.id).map(serializeAttachmentMetadata),
      })),
    });
  } catch (err: any) {
    console.error("[lms-service] Error fetching trainer schedule:", err);
    return res.status(500).json({ error: "Failed to fetch trainer reporting schedule" });
  }
});

// 3. GET /trainer-reports/my-reports — Fetch strictly the logged-in trainer's own reports
trainerReportsRouter.get("/my-reports", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId || !UUID_REGEX.test(auth.userId)) {
      return res.json({ success: true, count: 0, reports: [] });
    }

    const { cohortId, groupId, sessionId, lessonId, weekNumber, status } = req.query;

    const conditions: any[] = [eq(trainerLessonReports.trainerId, auth.userId)];

    if (cohortId && typeof cohortId === "string" && UUID_REGEX.test(cohortId)) {
      conditions.push(eq(trainerLessonReports.cohortId, cohortId));
    }
    if (groupId && typeof groupId === "string") {
      conditions.push(eq(trainerLessonReports.groupId, groupId));
    }
    if (sessionId && typeof sessionId === "string" && UUID_REGEX.test(sessionId)) {
      conditions.push(eq(trainerLessonReports.sessionId, sessionId));
    }
    if (lessonId && typeof lessonId === "string" && UUID_REGEX.test(lessonId)) {
      conditions.push(eq(trainerLessonReports.lessonId, lessonId));
    }
    if (weekNumber !== undefined && !isNaN(Number(weekNumber))) {
      conditions.push(eq(trainerLessonReports.weekNumber, Number(weekNumber)));
    }
    if (status && (status === "draft" || status === "submitted")) {
      conditions.push(eq(trainerLessonReports.status, status as any));
    }

    const reports = await db
      .select()
      .from(trainerLessonReports)
      .where(and(...conditions))
      .orderBy(desc(trainerLessonReports.createdAt));

    const attachmentRows = reports.length
      ? await db
          .select()
          .from(trainerReportAttachments)
          .where(inArray(trainerReportAttachments.reportId, reports.map((r) => r.id)))
      : [];

    const enriched = reports.map((rep) => ({
      ...rep,
      attachments: attachmentRows.filter((a) => a.reportId === rep.id).map(serializeAttachmentMetadata),
    }));

    return res.json({ success: true, count: enriched.length, reports: enriched });
  } catch (err: any) {
    console.error("[lms-service] Error fetching my reports:", err);
    return res.status(500).json({ error: "Failed to fetch reports" });
  }
});

// 4. GET /trainer-reports/admin/all — Administrator & EPA Central Reporting Dashboard
trainerReportsRouter.get("/admin/all", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    const isAdmin = Boolean(auth.role && ADMIN_REPORT_ROLES.has(auth.role));
    if (!isAdmin) {
      return res.status(403).json({
        error: "Administrator or Lead Trainer privilege required to view all trainer reports.",
      });
    }

    const {
      cohortId,
      trainerId,
      trainerName,
      groupId,
      weekNumber,
      sessionType,
      sessionDate,
      submittedDate,
      deadlineStatus,
      status,
      isDelivered,
      epaConfirmed,
      search,
      limit = 200,
      offset = 0,
    } = req.query;

    const conditions: any[] = [];
    if (cohortId && typeof cohortId === "string" && UUID_REGEX.test(cohortId)) {
      conditions.push(eq(trainerLessonReports.cohortId, cohortId));
    }
    if (trainerId && typeof trainerId === "string" && UUID_REGEX.test(trainerId)) {
      conditions.push(eq(trainerLessonReports.trainerId, trainerId));
    }
    if (groupId && typeof groupId === "string") {
      conditions.push(eq(trainerLessonReports.groupId, groupId));
    }
    if (weekNumber !== undefined && weekNumber !== "" && !isNaN(Number(weekNumber))) {
      conditions.push(eq(trainerLessonReports.weekNumber, Number(weekNumber)));
    }
    if (sessionType && typeof sessionType === "string" && sessionType !== "all") {
      conditions.push(eq(trainerLessonReports.sessionType, sessionType));
    }
    if (status && (status === "draft" || status === "submitted")) {
      conditions.push(eq(trainerLessonReports.status, status as any));
    }
    if (isDelivered !== undefined && isDelivered !== "") {
      conditions.push(eq(trainerLessonReports.isDelivered, isDelivered === "true"));
    }
    if (epaConfirmed !== undefined && epaConfirmed !== "") {
      conditions.push(eq(trainerLessonReports.epaConfirmed, epaConfirmed === "true"));
    }
    if (deadlineStatus === "late") {
      conditions.push(eq(trainerLessonReports.isLate, true));
    } else if (deadlineStatus === "on_time") {
      conditions.push(eq(trainerLessonReports.isLate, false));
    }

    const queryLimit = Math.min(Number(limit) || 200, 500);
    const queryOffset = Number(offset) || 0;
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rawReports = await db
      .select()
      .from(trainerLessonReports)
      .where(whereClause)
      .orderBy(desc(trainerLessonReports.createdAt))
      .limit(queryLimit)
      .offset(queryOffset);

    const missingNameTrainerIds = Array.from(
      new Set(
        rawReports
          .filter((r) => !r.trainerName || r.trainerName.trim() === "" || r.trainerName === r.trainerId)
          .map((r) => r.trainerId)
      )
    );

    const userCache = new Map<string, { name: string; email: string | null }>();
    await Promise.all(
      missingNameTrainerIds.map(async (tid) => {
        const resolved = await resolveUserIdentity(tid);
        userCache.set(tid, {
          name: resolved.name || "Unknown Trainer",
          email: resolved.email,
        });
      })
    );

    const attachmentRows = rawReports.length
      ? await db
          .select()
          .from(trainerReportAttachments)
          .where(inArray(trainerReportAttachments.reportId, rawReports.map((r) => r.id)))
      : [];

    let reports = rawReports.map((rep) => {
      const cached = userCache.get(rep.trainerId);
      const resolvedTrainerName =
        rep.trainerName && rep.trainerName.trim() ? rep.trainerName : cached?.name || "Unknown Trainer";
      const resolvedTrainerEmail = rep.trainerEmail || cached?.email || null;
      const attachments = attachmentRows
        .filter((a) => a.reportId === rep.id)
        .map(serializeAttachmentMetadata);

      return {
        ...rep,
        trainerName: resolvedTrainerName,
        trainerEmail: resolvedTrainerEmail,
        attachments,
        attachmentCount: attachments.length,
      };
    });

    if (trainerName && typeof trainerName === "string" && trainerName.trim()) {
      const tn = trainerName.trim().toLowerCase();
      reports = reports.filter(
        (r) =>
          (r.trainerName || "").toLowerCase().includes(tn) ||
          (r.trainerEmail || "").toLowerCase().includes(tn)
      );
    }

    if (sessionDate && typeof sessionDate === "string" && sessionDate.trim()) {
      const targetDay = sessionDate.trim();
      reports = reports.filter(
        (r) => r.dateConducted && r.dateConducted.toISOString().slice(0, 10) === targetDay
      );
    }

    if (submittedDate && typeof submittedDate === "string" && submittedDate.trim()) {
      const targetDay = submittedDate.trim();
      reports = reports.filter(
        (r) => r.submittedAt && r.submittedAt.toISOString().slice(0, 10) === targetDay
      );
    }

    if (search && typeof search === "string" && search.trim()) {
      const q = search.trim().toLowerCase();
      reports = reports.filter(
        (r) =>
          (r.trainerName || "").toLowerCase().includes(q) ||
          (r.trainerEmail || "").toLowerCase().includes(q) ||
          (r.cohortName || "").toLowerCase().includes(q) ||
          (r.groupName || "").toLowerCase().includes(q) ||
          (r.sessionTitle || "").toLowerCase().includes(q) ||
          (r.topicsCovered || "").toLowerCase().includes(q)
      );
    }

    return res.json({
      success: true,
      count: reports.length,
      reports,
    });
  } catch (err: any) {
    console.error("[lms-service] Error fetching admin reports:", err);
    return res.status(500).json({ error: "Failed to fetch admin reports" });
  }
});

// 5. GET /trainer-reports/progression-status — Check 12-week progression and unlocked weeks
trainerReportsRouter.get("/progression-status", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const cohortId = (req.query.cohortId as string)?.trim();
    const groupId = (req.query.groupId as string)?.trim();
    const targetTrainerId =
      auth.role && ADMIN_REPORT_ROLES.has(auth.role) && req.query.trainerId
        ? (req.query.trainerId as string).trim()
        : auth.userId;

    if (!cohortId || !UUID_REGEX.test(cohortId) || !targetTrainerId || !UUID_REGEX.test(targetTrainerId)) {
      const defaultWeeks = Array.from({ length: 12 }, (_, i) => ({
        weekNumber: i + 1,
        status: (i === 0 ? "unlocked" : "locked") as "unlocked" | "locked",
        isSubmitted: false,
        isDelivered: false,
        isDraft: false,
        isUnlocked: i === 0,
        reportId: null,
        sessionTitle: null,
        dateConducted: null,
        deliveredAt: null,
      }));
      return res.json({
        cohortId: cohortId || "",
        groupId: groupId || null,
        trainerId: targetTrainerId || null,
        maxUnlockedWeek: 1,
        currentUnlockedWeek: 1,
        totalSubmitted: 0,
        totalDelivered: 0,
        weeks: defaultWeeks,
      });
    }

    const conditions: any[] = [
      eq(trainerLessonReports.trainerId, targetTrainerId),
      eq(trainerLessonReports.cohortId, cohortId),
    ];
    if (groupId) {
      conditions.push(eq(trainerLessonReports.groupId, groupId));
    }

    const existingReports = await db
      .select()
      .from(trainerLessonReports)
      .where(and(...conditions));

    const reportByWeek = new Map<number, typeof trainerLessonReports.$inferSelect>();
    for (const rep of existingReports) {
      if (rep.weekNumber && rep.weekNumber >= 1 && rep.weekNumber <= 12) {
        const curr = reportByWeek.get(rep.weekNumber);
        if (!curr || (rep.status === "submitted" && curr.status !== "submitted")) {
          reportByWeek.set(rep.weekNumber, rep);
        }
      }
    }

    const weeksList = [];
    let maxUnlockedWeek = 1;

    for (let w = 1; w <= 12; w++) {
      const rep = reportByWeek.get(w);
      const isSubmitted = rep?.status === "submitted";
      const isDelivered = Boolean(rep?.isDelivered);
      const isDraft = rep?.status === "draft";
      const isUnlocked = w === 1 || reportByWeek.get(w - 1)?.status === "submitted";

      if (isUnlocked && w > maxUnlockedWeek) {
        maxUnlockedWeek = w;
      }

      let weekStatus: "submitted" | "draft" | "unlocked" | "locked" = "locked";
      if (isSubmitted) weekStatus = "submitted";
      else if (isDraft) weekStatus = "draft";
      else if (isUnlocked) weekStatus = "unlocked";

      weeksList.push({
        weekNumber: w,
        status: weekStatus,
        isSubmitted,
        isDelivered,
        isDraft,
        isUnlocked,
        reportId: rep?.id || null,
        sessionTitle: rep?.sessionTitle || null,
        dateConducted: rep?.dateConducted ? rep.dateConducted.toISOString() : null,
        deliveredAt: rep?.deliveredAt ? rep.deliveredAt.toISOString() : null,
      });
    }

    const currentWeekItem = weeksList.find((wk) => wk.isUnlocked && !wk.isSubmitted);
    const currentUnlockedWeek = currentWeekItem
      ? currentWeekItem.weekNumber
      : maxUnlockedWeek < 12
      ? maxUnlockedWeek + 1
      : 12;

    return res.json({
      cohortId,
      groupId: groupId || null,
      trainerId: targetTrainerId,
      maxUnlockedWeek,
      currentUnlockedWeek,
      totalSubmitted: weeksList.filter((w) => w.isSubmitted).length,
      totalDelivered: weeksList.filter((w) => w.isDelivered).length,
      weeks: weeksList,
    });
  } catch (err: any) {
    console.error("[lms-service] Error fetching progression status:", err);
    return res.status(500).json({ error: "Failed to fetch progression status", details: err?.message });
  }
});

// 6. POST /trainer-reports/:id/attachments — Backend-authorized Cloudinary upload
trainerReportsRouter.post(
  "/:id/attachments",
  (req: Request, res: Response, next: NextFunction) => {
    attachmentUpload.single("file")(req, res, (err: any) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "File size exceeds the 10 MB limit." });
        }
        return res.status(400).json({ error: err.message || "Invalid file upload." });
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      const auth = getAuthUserContext(req);
      if (!auth.userId || !UUID_REGEX.test(auth.userId)) {
        return res.status(401).json({ error: "Authentication required." });
      }

      const reportId = req.params.id;
      if (!reportId || !UUID_REGEX.test(reportId)) {
        return res.status(400).json({ error: "Valid report ID is required." });
      }

      const [report] = await db
        .select()
        .from(trainerLessonReports)
        .where(eq(trainerLessonReports.id, reportId))
        .limit(1);

      if (!report) {
        return res.status(404).json({ error: "Report not found." });
      }

      const isOwner = report.trainerId === auth.userId;
      const isAdmin = Boolean(auth.role && ADMIN_REPORT_ROLES.has(auth.role));
      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: "Forbidden: You cannot upload attachments to another trainer's report.",
        });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "No file uploaded. Attach a file under field name 'file'." });
      }

      const category = (req.body?.category as string)?.trim() || "other";
      const validCategories = new Set(["attendance", "photo", "farm_evidence", "other"]);
      const attachmentCategory = validCategories.has(category) ? category : "other";
      const uploadNonce = (req.body?.uploadNonce as string)?.trim() || undefined;

      if (uploadNonce) {
        const [existingByNonce] = await db
          .select()
          .from(trainerReportAttachments)
          .where(
            and(
              eq(trainerReportAttachments.reportId, report.id),
              eq(trainerReportAttachments.uploadNonce, uploadNonce)
            )
          )
          .limit(1);

        if (existingByNonce) {
          return res.status(200).json({
            success: true,
            deduplicated: true,
            attachment: serializeAttachmentMetadata(existingByNonce),
          });
        }
      }

      const cfg = getCloudinaryConfig();
      if (!cfg.isConfigured) {
        return res.status(503).json({
          error:
            "Cloudinary backend credentials (CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET) are not configured on lms-service. Your report data is preserved.",
        });
      }

      let uploaded;
      try {
        uploaded = await uploadReportAttachmentToCloudinary({
          buffer: file.buffer,
          mimetype: file.mimetype,
          originalFilename: file.originalname,
          trainerId: report.trainerId,
          reportId: report.id,
          uploadNonce,
        });
      } catch (uploadErr: any) {
        return res.status(400).json({
          error: uploadErr?.message || "Cloudinary upload failed. Your report data has not been lost.",
        });
      }

      const [existingByPublicId] = await db
        .select()
        .from(trainerReportAttachments)
        .where(
          and(
            eq(trainerReportAttachments.reportId, report.id),
            eq(trainerReportAttachments.cloudinaryPublicId, uploaded.publicId)
          )
        )
        .limit(1);

      if (existingByPublicId) {
        return res.status(200).json({
          success: true,
          deduplicated: true,
          attachment: serializeAttachmentMetadata(existingByPublicId),
        });
      }

      const identity = await resolveUserIdentity(auth.userId, auth.name, auth.email);

      const [created] = await db
        .insert(trainerReportAttachments)
        .values({
          reportId: report.id,
          trainerId: report.trainerId,
          cloudinaryPublicId: uploaded.publicId,
          resourceType: uploaded.resourceType,
          deliveryType: uploaded.deliveryType,
          originalFilename: uploaded.originalFilename,
          fileFormat: uploaded.format,
          fileSize: uploaded.bytes,
          attachmentCategory,
          uploadedBy: auth.userId,
          uploadNonce: uploadNonce || null,
        })
        .returning();

      await recordReportAudit({
        reportId: report.id,
        action: "attachment_added",
        actorId: auth.userId,
        actorName: identity.name,
        actorRole: auth.role,
        details: {
          attachmentId: created.id,
          originalFilename: created.originalFilename,
          attachmentCategory: created.attachmentCategory,
          resourceType: created.resourceType,
        },
      });

      return res.status(201).json({
        success: true,
        attachment: serializeAttachmentMetadata(created),
      });
    } catch (err: any) {
      console.error("[lms-service] Error uploading attachment:", err);
      return res.status(500).json({ error: "Failed to upload supporting document" });
    }
  }
);

// 7. GET /trainer-reports/:id/attachments/:attachmentId/access — Authorized short-lived signed URL
trainerReportsRouter.get("/:id/attachments/:attachmentId/access", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId || !UUID_REGEX.test(auth.userId)) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const { id: reportId, attachmentId } = req.params;
    if (!UUID_REGEX.test(reportId) || !UUID_REGEX.test(attachmentId)) {
      return res.status(400).json({ error: "Invalid report or attachment ID." });
    }

    const [attachment] = await db
      .select()
      .from(trainerReportAttachments)
      .where(
        and(
          eq(trainerReportAttachments.id, attachmentId),
          eq(trainerReportAttachments.reportId, reportId)
        )
      )
      .limit(1);

    if (!attachment) {
      return res.status(404).json({ error: "Supporting document not found." });
    }

    const isOwner = attachment.trainerId === auth.userId;
    const isAdmin = Boolean(auth.role && ADMIN_REPORT_ROLES.has(auth.role));
    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        error: "Forbidden: You are not authorized to access another trainer's supporting documents.",
      });
    }

    const cfg = getCloudinaryConfig();
    if (!cfg.isConfigured) {
      return res.status(503).json({
        error: "Cloudinary backend credentials are not configured to sign private document access.",
      });
    }

    const download = req.query.download === "true";
    const signed = generateSignedAttachmentAccessUrl({
      publicId: attachment.cloudinaryPublicId,
      resourceType: attachment.resourceType,
      format: attachment.fileFormat,
      download,
      ttlSeconds: 300,
    });

    return res.json({
      success: true,
      url: signed.url,
      expiresAt: signed.expiresAt,
      originalFilename: attachment.originalFilename,
      resourceType: attachment.resourceType,
      fileFormat: attachment.fileFormat,
    });
  } catch (err: any) {
    console.error("[lms-service] Error generating attachment access URL:", err);
    return res.status(500).json({ error: "Failed to authorize document access" });
  }
});

// 8. DELETE /trainer-reports/:id/attachments/:attachmentId — Authorized attachment removal
trainerReportsRouter.delete("/:id/attachments/:attachmentId", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId || !UUID_REGEX.test(auth.userId)) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const { id: reportId, attachmentId } = req.params;
    if (!UUID_REGEX.test(reportId) || !UUID_REGEX.test(attachmentId)) {
      return res.status(400).json({ error: "Invalid report or attachment ID." });
    }

    const [attachment] = await db
      .select()
      .from(trainerReportAttachments)
      .where(
        and(
          eq(trainerReportAttachments.id, attachmentId),
          eq(trainerReportAttachments.reportId, reportId)
        )
      )
      .limit(1);

    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found." });
    }

    const isOwner = attachment.trainerId === auth.userId;
    const isAdmin = Boolean(auth.role && ADMIN_REPORT_ROLES.has(auth.role));
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "Forbidden: You cannot delete another trainer's attachment." });
    }

    await deleteCloudinaryAttachment({
      publicId: attachment.cloudinaryPublicId,
      resourceType: attachment.resourceType,
    });

    await db.delete(trainerReportAttachments).where(eq(trainerReportAttachments.id, attachment.id));

    const identity = await resolveUserIdentity(auth.userId, auth.name, auth.email);
    await recordReportAudit({
      reportId,
      action: "attachment_removed",
      actorId: auth.userId,
      actorName: identity.name,
      actorRole: auth.role,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
      },
    });

    return res.json({ success: true, message: "Attachment removed." });
  } catch (err: any) {
    console.error("[lms-service] Error deleting attachment:", err);
    return res.status(500).json({ error: "Failed to remove attachment" });
  }
});

// 9. POST /trainer-reports/:id/epa-confirm — Oriyon EPA Receipt Confirmation (Non-blocking acknowledgement)
trainerReportsRouter.post("/:id/epa-confirm", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId || !UUID_REGEX.test(auth.userId)) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const isAuthorizedEpa = Boolean(auth.role && ADMIN_REPORT_ROLES.has(auth.role));
    if (!isAuthorizedEpa) {
      return res.status(403).json({
        error: "Forbidden: Only authorized administrators or the Oriyon EPA can confirm report receipt.",
      });
    }

    const reportId = req.params.id;
    if (!reportId || !UUID_REGEX.test(reportId)) {
      return res.status(400).json({ error: "Valid report ID is required." });
    }

    const [report] = await db
      .select()
      .from(trainerLessonReports)
      .where(eq(trainerLessonReports.id, reportId))
      .limit(1);

    if (!report) {
      return res.status(404).json({ error: "Report not found." });
    }

    if (report.status !== "submitted") {
      return res.status(400).json({
        error: "Cannot confirm receipt of a draft report. The trainer must submit the report first.",
      });
    }

    const identity = await resolveUserIdentity(auth.userId, auth.name, auth.email);
    const epaNotes = (req.body?.epaNotes as string | undefined)?.trim() || report.epaNotes || null;
    const confirmedAt = report.epaConfirmedAt || new Date();

    const [updated] = await db
      .update(trainerLessonReports)
      .set({
        epaConfirmed: true,
        epaConfirmedBy: auth.userId,
        epaConfirmedByName: identity.name || "Oriyon EPA",
        epaConfirmedAt: confirmedAt,
        epaNotes,
        updatedAt: new Date(),
      })
      .where(eq(trainerLessonReports.id, reportId))
      .returning();

    await recordReportAudit({
      reportId: updated.id,
      action: "epa_confirmed",
      actorId: auth.userId,
      actorName: identity.name || "Oriyon EPA",
      actorRole: auth.role,
      details: {
        epaConfirmedAt: updated.epaConfirmedAt,
        epaNotes,
      },
    });

    return res.json({
      success: true,
      message: "Report receipt confirmed by Oriyon EPA.",
      report: updated,
    });
  } catch (err: any) {
    console.error("[lms-service] Error confirming EPA receipt:", err);
    return res.status(500).json({ error: "Failed to confirm EPA receipt" });
  }
});

// 10. POST /trainer-reports/:id/mark-delivered — MANDATORY GATED DELIVERY ACTION (Independent of EPA confirmation)
trainerReportsRouter.post("/:id/mark-delivered", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const reportId = req.params.id;
    if (!reportId || !UUID_REGEX.test(reportId)) {
      return res.status(400).json({ error: "Valid report ID is required." });
    }

    const [report] = await db
      .select()
      .from(trainerLessonReports)
      .where(eq(trainerLessonReports.id, reportId))
      .limit(1);

    if (!report) {
      return res.status(404).json({
        error:
          "Cannot mark session delivered: No report found. A submitted lesson report is strictly mandatory before marking completion.",
      });
    }

    const isOwner = report.trainerId === auth.userId;
    const isStaff = Boolean(auth.role && ADMIN_REPORT_ROLES.has(auth.role));
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: "Unauthorized to mark this session as delivered." });
    }

    if (report.status !== "submitted") {
      return res.status(400).json({
        error:
          "QUALITY GATE BLOCKED: Your lesson report is currently saved as a DRAFT. You must SUBMIT the complete report before marking this lesson/session as delivered.",
      });
    }

    if (report.isDelivered) {
      return res.json({
        success: true,
        message: "Lesson/session is already marked as delivered.",
        report,
      });
    }

    const [updated] = await db
      .update(trainerLessonReports)
      .set({
        isDelivered: true,
        deliveredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(trainerLessonReports.id, reportId))
      .returning();

    const identity = await resolveUserIdentity(auth.userId, auth.name, auth.email);
    await recordReportAudit({
      reportId: updated.id,
      action: "marked_delivered",
      actorId: auth.userId,
      actorName: identity.name,
      actorRole: auth.role,
      details: { deliveredAt: updated.deliveredAt },
    });

    publishEvent("trainer.session.delivered", {
      reportId: updated.id,
      trainerId: updated.trainerId,
      cohortId: updated.cohortId,
      groupId: updated.groupId,
      sessionTitle: updated.sessionTitle,
      deliveredAt: updated.deliveredAt,
    }).catch(() => {});

    return res.json({
      success: true,
      message: "Lesson/session has been marked as completed/delivered successfully.",
      report: updated,
    });
  } catch (err: any) {
    console.error("[lms-service] Error marking session delivered:", err);
    return res.status(500).json({ error: "Failed to mark session as delivered" });
  }
});

// 11. GET /trainer-reports/:id — Fetch a single report with 7 sections, attachments metadata, and audit history
trainerReportsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId || !UUID_REGEX.test(auth.userId)) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const reportId = req.params.id;
    if (!UUID_REGEX.test(reportId)) {
      return res.status(400).json({ error: "Invalid report ID." });
    }

    const [report] = await db
      .select()
      .from(trainerLessonReports)
      .where(eq(trainerLessonReports.id, reportId))
      .limit(1);

    if (!report) {
      return res.status(404).json({ error: "Report not found." });
    }

    const isOwner = report.trainerId === auth.userId;
    const isStaff = Boolean(auth.role && ADMIN_REPORT_ROLES.has(auth.role));
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: "Unauthorized to view this report." });
    }

    const identity = await resolveUserIdentity(report.trainerId, report.trainerName, report.trainerEmail);
    const attachments = await db
      .select()
      .from(trainerReportAttachments)
      .where(eq(trainerReportAttachments.reportId, report.id))
      .orderBy(asc(trainerReportAttachments.createdAt));

    const auditLogs = await db
      .select()
      .from(trainerReportAuditLogs)
      .where(eq(trainerReportAuditLogs.reportId, report.id))
      .orderBy(desc(trainerReportAuditLogs.createdAt));

    return res.json({
      success: true,
      report: {
        ...report,
        trainerName: identity.name || report.trainerName || "Trainer",
        trainerEmail: identity.email || report.trainerEmail,
        attachments: attachments.map(serializeAttachmentMetadata),
      },
      attachments: attachments.map(serializeAttachmentMetadata),
      auditLogs,
    });
  } catch (err: any) {
    console.error("[lms-service] Error fetching report:", err);
    return res.status(500).json({ error: "Failed to fetch report" });
  }
});
