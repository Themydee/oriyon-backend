import { Router, Request, Response, NextFunction } from "express";
import { eq, and, isNull, sql, desc, inArray, lte, gte, or, type InferModel } from "drizzle-orm";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { db } from "../index";
import { weeks, lessons, progress, physicalSessions, sessionGroups, quizzes, quizAttempts, week12Codes, week12Checkins, practicalCheckins, practicalCodes, exams, examQuestions, examSessions, examAnswers, examViolations, platformTutorials, appeals, readings, trainerLessonReports } from "../db/schema";
import { publishEvent } from "../rabbitmq";

type WeekRow = InferModel<typeof weeks>;

const STAFF_ROLES = ["admin", "sub_admin", "trainer", "lead_trainer"];

export function isStaffRole(req: Request): boolean {
  const headerRole = req.headers["x-user-role"];
  if (typeof headerRole === "string" && STAFF_ROLES.includes(headerRole.trim().toLowerCase())) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ") && process.env.JWT_SECRET) {
    try {
      const token = authHeader.split(" ")[1];
      const payload = jwt.verify(token, process.env.JWT_SECRET) as { role?: string };
      if (payload?.role && STAFF_ROLES.includes(payload.role.toLowerCase())) {
        return true;
      }
    } catch {
      // Invalid token
    }
  }

  return false;
}


export const weeksRouter = Router();
export const lessonsRouter = Router();
export const progressRouter = Router();
export const sessionsRouter = Router();
export const quizzesRouter = Router();
export const examsRouter = Router();
export const tutorialsRouter = Router();
export const practicalRouter = Router();
export const appealsRouter = Router();
export const readingsRouter = Router();
// ─────────────────────────────────────────────
// HELPER — fetch user from user-service
// Gets user data including cohort memberships for notifications and verification
// ─────────────────────────────────────────────
export interface UserRecord {
  id?: string;
  email: string;
  firstName: string;
  lastName?: string;
  role?: string;
  cohortId?: string;
  cohortMembers?: Array<{ cohortId: string; [key: string]: any }>;
  [key: string]: any;
}

export async function fetchUser(userId: string): Promise<UserRecord | null> {
  try {
    const res = await fetch(`${process.env.USER_SERVICE_URL}/users/${userId}`);
    if (!res.ok) return null;
    const user = (await res.json()) as UserRecord;
    return user;
  } catch {
    console.warn(`[lms-service] Could not fetch user ${userId} from user-service`);
    return null;
  }
}

export async function isWeek12AttendanceComplete(userId: string, cohortId?: string): Promise<boolean> {
  const isUuid = (str: any) => typeof str === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
  if (!isUuid(userId)) return false;
  try {
    // 1. Check if user has an approved appeal for Week 12 physical attendance
    const [approvedAppeal] = await db
      .select({ id: appeals.id })
      .from(appeals)
      .where(
        and(
          eq(appeals.userId, userId),
          eq(appeals.appealType, "week12_attendance"),
          eq(appeals.status, "approved")
        )
      )
      .limit(1);

    if (approvedAppeal) return true;

    // 2. Check if user has a verified Week 12 practical check-in
    const [practicalCheckin] = await db
      .select({ id: practicalCheckins.id })
      .from(practicalCheckins)
      .where(
        and(
          eq(practicalCheckins.userId, userId),
          eq(practicalCheckins.weekNumber, 12)
        )
      )
      .limit(1);

    if (practicalCheckin) return true;

    // Check practicalCodes or generated code for Week 12
    const w12Codes = await db
      .select({ code: practicalCodes.code })
      .from(practicalCodes)
      .where(
        and(
          eq(practicalCodes.userId, userId),
          eq(practicalCodes.weekNumber, 12)
        )
      );
    const w12CodeList = w12Codes.map((c) => c.code).filter(Boolean);
    let uEmail = "";
    try {
      const u = await fetchUser(userId);
      if (u?.email) uEmail = u.email;
    } catch {}
    w12CodeList.push(generatePracticalCodeString(userId, 12, uEmail));
    if (uEmail) {
      w12CodeList.push(generatePracticalCodeString(userId, 12, ""));
    }
    if (w12CodeList.length > 0) {
      const [matchedW12Checkin] = await db
        .select({ id: practicalCheckins.id })
        .from(practicalCheckins)
        .where(
          and(
            eq(practicalCheckins.weekNumber, 12),
            inArray(practicalCheckins.codeSubmitted, w12CodeList)
          )
        )
        .limit(1);
      if (matchedW12Checkin) return true;
    }

    // 3. Check for 5 days of daily codes check-ins (Days 1 to 5)
    const checkinConditions = [eq(week12Checkins.userId, userId)];
    if (cohortId) {
      checkinConditions.push(eq(week12Checkins.cohortId, cohortId));
    }

    const checkins = await db
      .select({ day: week12Checkins.day })
      .from(week12Checkins)
      .where(and(...checkinConditions));

    const attendedDays = new Set(checkins.map((checkin) => checkin.day));
    if ([1, 2, 3, 4, 5].every((day) => attendedDays.has(day))) {
      return true;
    }

    // Also check cross-cohort checkins if cohortId was scoped but user has checkins in another cohort record
    if (cohortId && attendedDays.size < 5) {
      const allCheckins = await db
        .select({ day: week12Checkins.day })
        .from(week12Checkins)
        .where(eq(week12Checkins.userId, userId));
      const allAttendedDays = new Set(allCheckins.map((c) => c.day));
      if ([1, 2, 3, 4, 5].every((day) => allAttendedDays.has(day))) {
        return true;
      }
    }

    return false;
  } catch (err) {
    console.error("[lms-service] Error checking isWeek12AttendanceComplete:", err);
    return false;
  }
}


export interface AttendanceCheckResult {
  isComplete: boolean;
  attendedWeeks: number[];
  missingWeeks: number[];
  week12Complete: boolean;
}

export async function checkWeeks1To12Attendance(
  userId: string,
  cohortId?: string
): Promise<AttendanceCheckResult> {
  const isUuid = (str: any) =>
    typeof str === "string" &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);

  if (!isUuid(userId)) {
    return {
      isComplete: false,
      attendedWeeks: [],
      missingWeeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      week12Complete: false,
    };
  }

  try {
    // 1. Fetch practical checkins for this user across weeks 1 to 12
    const pCheckins = await db
      .select({ weekNumber: practicalCheckins.weekNumber })
      .from(practicalCheckins)
      .where(eq(practicalCheckins.userId, userId));

    const attendedSet = new Set<number>();
    for (const c of pCheckins) {
      const w = Number(c.weekNumber);
      if (Number.isInteger(w) && w >= 1 && w <= 12) {
        attendedSet.add(w);
      }
    }

    // Also check if any checkins match user's known practical codes or generated codes
    const userCodes = await db
      .select({ code: practicalCodes.code, weekNumber: practicalCodes.weekNumber })
      .from(practicalCodes)
      .where(eq(practicalCodes.userId, userId));

    if (userCodes.length > 0) {
      const codeStrings = userCodes.map((u) => u.code).filter(Boolean);
      if (codeStrings.length > 0) {
        const matchingCheckins = await db
          .select({ weekNumber: practicalCheckins.weekNumber })
          .from(practicalCheckins)
          .where(inArray(practicalCheckins.codeSubmitted, codeStrings));
        for (const c of matchingCheckins) {
          const w = Number(c.weekNumber);
          if (Number.isInteger(w) && w >= 1 && w <= 12) {
            attendedSet.add(w);
          }
        }
      }
    }

    // Also check user's email if available to cross-match generated codes
    let userEmail = "";
    try {
      const u = await fetchUser(userId);
      if (u?.email) userEmail = u.email;
    } catch {}

    const potentialCodes: string[] = [];
    for (let w = 1; w <= 12; w++) {
      if (!attendedSet.has(w)) {
        potentialCodes.push(generatePracticalCodeString(userId, w, userEmail));
        if (userEmail) {
          potentialCodes.push(generatePracticalCodeString(userId, w, ""));
        }
      }
    }
    if (potentialCodes.length > 0) {
      const matchedByGenCode = await db
        .select({ weekNumber: practicalCheckins.weekNumber })
        .from(practicalCheckins)
        .where(inArray(practicalCheckins.codeSubmitted, potentialCodes));
      for (const c of matchedByGenCode) {
        const w = Number(c.weekNumber);
        if (Number.isInteger(w) && w >= 1 && w <= 12) {
          attendedSet.add(w);
        }
      }
    }

    // 2. Check Week 12 attendance specifically (5-day on-site checkins, practical checkin, or approved appeal)
    const week12Done = attendedSet.has(12) || (await isWeek12AttendanceComplete(userId, cohortId));
    if (week12Done) {
      attendedSet.add(12);
    }

    const attendedWeeks = Array.from(attendedSet).sort((a, b) => a - b);
    const missingWeeks: number[] = [];
    for (let w = 1; w <= 12; w++) {
      if (!attendedSet.has(w)) {
        missingWeeks.push(w);
      }
    }

    return {
      isComplete: missingWeeks.length === 0,
      attendedWeeks,
      missingWeeks,
      week12Complete: week12Done,
    };
  } catch (err) {
    console.error("[lms-service] Error checking checkWeeks1To12Attendance:", err);
    return {
      isComplete: false,
      attendedWeeks: [],
      missingWeeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      week12Complete: false,
    };
  }
}

// Weekly quizzes a trainee still has to take before they may start an exam.
// Counts every published, already-unlocked week in the cohort that has a published
// quiz. A week is satisfied once the user has submitted an attempt on any of its
// quizzes (set REQUIRE_QUIZ_PASS to demand a pass instead).
const REQUIRE_QUIZ_PASS = false;

export async function getMissingWeeklyQuizzes(userId: string, cohortId?: string) {
  const isUuid = (str: any) =>
    typeof str === "string" &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);

  if (!isUuid(userId)) return [];

  let effectiveCohortId = cohortId;
  try {
    const user = await fetchUser(userId);
    const userCohortId = user?.cohortMembers?.[0]?.cohortId || user?.cohortId;
    if (userCohortId && isUuid(userCohortId)) {
      effectiveCohortId = userCohortId;
    }
  } catch {}

  const now = new Date();
  const weekConditions: any[] = [
    eq(weeks.isPublished, true),
    or(isNull(weeks.unlockDate), lte(weeks.unlockDate, now)),
  ];

  if (effectiveCohortId && isUuid(effectiveCohortId)) {
    weekConditions.push(eq(weeks.cohortId, effectiveCohortId));
  }

  const cohortWeeks = await db
    .select({ id: weeks.id, weekNumber: weeks.weekNumber, title: weeks.title })
    .from(weeks)
    .where(and(...weekConditions))
    .orderBy(weeks.weekNumber);

  if (!cohortWeeks.length) return [];

  const weekIds = cohortWeeks.map((w) => w.id);
  const weekQuizzes = await db
    .select({ id: quizzes.id, weekId: quizzes.weekId, title: quizzes.title, isPublished: quizzes.isPublished, createdAt: quizzes.createdAt })
    .from(quizzes)
    .where(inArray(quizzes.weekId, weekIds))
    .orderBy(desc(quizzes.createdAt));

  // For cohort weeks with no direct quiz, look for sibling published quiz by weekNumber
  const foundWeekIds = new Set(weekQuizzes.map((q) => q.weekId));
  for (const cw of cohortWeeks) {
    if (!foundWeekIds.has(cw.id)) {
      const [siblingQuiz] = await db
        .select({ id: quizzes.id, weekId: quizzes.weekId, title: quizzes.title, isPublished: quizzes.isPublished, createdAt: quizzes.createdAt })
        .from(quizzes)
        .innerJoin(weeks, eq(quizzes.weekId, weeks.id))
        .where(
          and(
            eq(weeks.weekNumber, cw.weekNumber),
            eq(quizzes.isPublished, true)
          )
        )
        .orderBy(desc(quizzes.createdAt))
        .limit(1);
      if (siblingQuiz) {
        weekQuizzes.push({ ...siblingQuiz, weekId: cw.id });
      }
    }
  }

  if (!weekQuizzes.length) return [];

  const allQuizIds = weekQuizzes.map((q) => q.id);
  const attempts = allQuizIds.length > 0
    ? await db
        .select({ quizId: quizAttempts.quizId, passed: quizAttempts.passed, score: quizAttempts.score })
        .from(quizAttempts)
        .where(and(eq(quizAttempts.userId, userId), inArray(quizAttempts.quizId, allQuizIds)))
    : [];
  const doneQuizIds = new Set(attempts.filter((a) => !REQUIRE_QUIZ_PASS || a.passed || (typeof a.score === "number" && a.score >= 70)).map((a) => a.quizId));

  const weekLessons = await db
    .select({ id: lessons.id, weekId: lessons.weekId })
    .from(lessons)
    .where(and(inArray(lessons.weekId, weekIds), eq(lessons.isPublished, true)));
  const completed = await db
    .select({ lessonId: progress.lessonId })
    .from(progress)
    .where(and(eq(progress.userId, userId), eq(progress.completed, true), inArray(progress.weekId, weekIds)));
  const completedLessonIds = new Set(completed.map((p) => p.lessonId));

  const missing = [];
  for (const week of cohortWeeks) {
    const quizzesForWeek = weekQuizzes.filter((q) => q.weekId === week.id);
    // Newest published quiz is the one the week page shows
    const activeQuiz = quizzesForWeek.find((q) => q.isPublished);
    if (!activeQuiz) continue;
    if (quizzesForWeek.some((q) => doneQuizIds.has(q.id))) continue;

    missing.push({
      weekId: week.id,
      weekNumber: week.weekNumber,
      weekTitle: week.title,
      quizId: activeQuiz.id,
      quizTitle: activeQuiz.title,
      lessonsRemaining: weekLessons.filter((l) => l.weekId === week.id && !completedLessonIds.has(l.id)).length,
    });
  }
  return missing;
}

// ─────────────────────────────────────────────
// WEEKS
// ─────────────────────────────────────────────

// GET /lms/weeks?cohortId=&showAll=true
weeksRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { cohortId, showAll } = req.query;
    const includeAll = showAll === "true";

    const condition = cohortId
      ? includeAll
        ? eq(weeks.cohortId, cohortId as string)
        : and(
            eq(weeks.cohortId, cohortId as string),
            eq(weeks.isPublished, true)
          )
      : includeAll
      ? undefined
      : eq(weeks.isPublished, true);

    const allWeeks = condition
      ? await db.select().from(weeks).where(condition).orderBy(weeks.weekNumber)
      : await db.select().from(weeks).orderBy(weeks.weekNumber);

    if (!allWeeks || allWeeks.length === 0) {
      return res.json([]);
    }

    const weekIds = allWeeks.map((w) => w.id);
    const lessonCondition = includeAll
      ? inArray(lessons.weekId, weekIds)
      : and(inArray(lessons.weekId, weekIds), eq(lessons.isPublished, true));

    const allLessons = await db
      .select()
      .from(lessons)
      .where(lessonCondition)
      .orderBy(lessons.order);

    const lessonsByWeek = new Map<string, any[]>();
    for (const l of allLessons) {
      const list = lessonsByWeek.get(l.weekId) || [];
      list.push(l);
      lessonsByWeek.set(l.weekId, list);
    }

    const weeksWithLessons = allWeeks.map((week) => ({
      ...week,
      lessons: lessonsByWeek.get(week.id) || [],
    }));

    return res.json(weeksWithLessons);
  } catch (err) {
    console.error("GET /lms/weeks error:", err);
    return res.status(500).json({ error: "Failed to fetch weeks" });
  }
});

// GET /lms/weeks/:id  — includes lessons
weeksRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const { showAll } = req.query;
    const includeAll = showAll === "true";

    const [week] = await db.select().from(weeks).where(eq(weeks.id, req.params.id)).limit(1);
    if (!week) return res.status(404).json({ error: "Week not found" });

    // Secure unlockDate for trainees
    const userRole = req.headers["x-user-role"] as string;
    if ((userRole === "trainee" || userRole === "coordinator") && week.unlockDate) {
      const now = new Date();
      const unlock = new Date(week.unlockDate);
      if (now < unlock) {
        return res.status(403).json({ error: `This week is locked until ${unlock.toLocaleDateString()}` });
      }
    }

    const lessonCondition = includeAll
      ? eq(lessons.weekId, req.params.id)
      : and(eq(lessons.weekId, req.params.id), eq(lessons.isPublished, true));

    const weekLessons = await db
      .select()
      .from(lessons)
      .where(lessonCondition)
      .orderBy(lessons.order);

    return res.json({ ...week, lessons: weekLessons });
  } catch {
    return res.status(500).json({ error: "Failed to fetch week" });
  }
});

// POST /lms/weeks
weeksRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    cohortId: z.string().uuid(),
    title: z.string().min(1),
    description: z.string().optional(),
    weekNumber: z.number().int().positive(),
    isPublished: z.boolean().optional(),
    objectives: z.array(z.string()).optional(),
    unlockDate: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const values = {
      ...parsed.data,
      unlockDate: parsed.data.unlockDate ? new Date(parsed.data.unlockDate) : null,
    };
    const [week] = await db.insert(weeks).values(values).returning();
    return res.status(201).json(week);
  } catch {
    return res.status(500).json({ error: "Failed to create week" });
  }
});

// PATCH /lms/weeks/:id
weeksRouter.patch("/:id", async (req: Request, res: Response) => {
  const schema = z.object({
    cohortId: z.string().uuid().optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    weekNumber: z.number().int().positive().optional(),
    isPublished: z.boolean().optional(),
    requiresQuizPass: z.boolean().optional(),
    objectives: z.array(z.string()).optional(),
    unlockDate: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const updates: any = {
      ...parsed.data,
      updatedAt: new Date(),
    };
    if (parsed.data.unlockDate !== undefined) {
      updates.unlockDate = parsed.data.unlockDate ? new Date(parsed.data.unlockDate) : null;
    }

    const [updated] = await db
      .update(weeks)
      .set(updates)
      .where(eq(weeks.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Week not found" });
    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to update week" });
  }
});

// ─────────────────────────────────────────────
// LESSONS
// ─────────────────────────────────────────────

// GET /lms/lessons/:id
lessonsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const [lesson] = await db.select().from(lessons).where(eq(lessons.id, req.params.id)).limit(1);
    if (!lesson) return res.status(404).json({ error: "Lesson not found" });

    // Secure unlockDate for trainees
    const userRole = req.headers["x-user-role"] as string;
    if (userRole === "trainee" || userRole === "coordinator") {
      const [week] = await db.select().from(weeks).where(eq(weeks.id, lesson.weekId)).limit(1);
      if (week && week.unlockDate) {
        const now = new Date();
        const unlock = new Date(week.unlockDate);
        if (now < unlock) {
          return res.status(403).json({ error: `This week is locked until ${unlock.toLocaleDateString()}` });
        }
      }
    }

    return res.json(lesson);
  } catch {
    return res.status(500).json({ error: "Failed to fetch lesson" });
  }
});

// Helper to sanitize media URLs (handles S3 URLs, s3:// protocol, spaces in URLs)
function sanitizeMediaUrl(url?: string | null): string | null {
  if (!url || !url.trim()) return null;
  let clean = url.trim();
  if (clean.startsWith("s3://")) {
    const parts = clean.substring(5).split("/");
    const bucket = parts[0];
    const key = parts.slice(1).join("/");
    clean = `https://${bucket}.s3.amazonaws.com/${key}`;
  }
  return clean.replace(/ /g, "%20");
}

// POST /lms/lessons
lessonsRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    weekId: z.string().uuid(),
    title: z.string().min(1),
    description: z.string().optional().nullable(),
    type: z.enum(["video", "document"]).default("video"),
    videoUrl: z.string().optional().nullable(),
    audioUrl: z.string().optional().nullable(),
    documentUrl: z.string().optional().nullable(),
    body: z.string().optional().nullable(),
    durationMinutes: z.number().int().optional().nullable(),
    order: z.number().int().default(0),
    isPublished: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data = {
    ...parsed.data,
    audioUrl: sanitizeMediaUrl(parsed.data.audioUrl),
    videoUrl: sanitizeMediaUrl(parsed.data.videoUrl),
  };

  try {
    const [lesson] = await db.insert(lessons).values(data).returning();
    return res.status(201).json(lesson);
  } catch (err) {
    console.error("Failed to create lesson:", err);
    return res.status(500).json({ error: "Failed to create lesson" });
  }
});

// PATCH /lms/lessons/:id
lessonsRouter.patch("/:id", async (req: Request, res: Response) => {
  const schema = z.object({
    weekId: z.string().uuid().optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    type: z.enum(["video", "document"]).optional(),
    videoUrl: z.string().optional().nullable(),
    audioUrl: z.string().optional().nullable(),
    documentUrl: z.string().optional().nullable(),
    body: z.string().optional().nullable(),
    durationMinutes: z.number().int().optional().nullable(),
    order: z.number().int().optional(),
    isPublished: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updateData: Record<string, any> = {
    ...parsed.data,
    updatedAt: new Date(),
  };

  if (parsed.data.audioUrl !== undefined) {
    updateData.audioUrl = sanitizeMediaUrl(parsed.data.audioUrl);
  }
  if (parsed.data.videoUrl !== undefined) {
    updateData.videoUrl = sanitizeMediaUrl(parsed.data.videoUrl);
  }

  try {
    const [updated] = await db
      .update(lessons)
      .set(updateData)
      .where(eq(lessons.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Lesson not found" });
    return res.json(updated);
  } catch (err) {
    console.error("Failed to update lesson:", err);
    return res.status(500).json({ error: "Failed to update lesson" });
  }
});

// ─────────────────────────────────────────────
// PROGRESS
// ─────────────────────────────────────────────

// POST /lms/progress
progressRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    userId: z.string().uuid(),
    lessonId: z.string().uuid(),
    weekId: z.string().uuid(),
    cohortId: z.string().uuid(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, lessonId, weekId, cohortId } = parsed.data;

  try {
    const [existing] = await db
      .select()
      .from(progress)
      .where(and(eq(progress.userId, userId), eq(progress.lessonId, lessonId)))
      .limit(1);

    if (existing?.completed) {
      return res.json({ message: "Already completed", progress: existing });
    }

    const completedAt = new Date();
    let record;

    if (existing) {
      [record] = await db
        .update(progress)
        .set({ completed: true, completedAt })
        .where(eq(progress.id, existing.id))
        .returning();
    } else {
      [record] = await db
        .insert(progress)
        .values({ userId, lessonId, weekId, cohortId, completed: true, completedAt })
        .returning();
    }

    const user = await fetchUser(userId);
    const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);

    await publishEvent("lesson.completed", {
      userId,
      lessonId,
      lessonTitle: lesson?.title ?? "",
      weekId,
      cohortId,
      completedAt: completedAt.toISOString(),
      email: user?.email ?? null,
      firstName: user?.firstName ?? null,
    });

    const weekLessons = await db
      .select()
      .from(lessons)
      .where(eq(lessons.weekId, weekId));

    const completedLessons = await db
      .select()
      .from(progress)
      .where(
        and(
          eq(progress.userId, userId),
          eq(progress.weekId, weekId),
          eq(progress.completed, true)
        )
      );

    if (completedLessons.length === weekLessons.length) {
      const [week] = await db.select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
      await publishEvent("week.completed", {
        userId,
        weekId,
        weekTitle: week?.title ?? "",
        cohortId,
        completedAt: completedAt.toISOString(),
        email: user?.email ?? null,
        firstName: user?.firstName ?? null,
      });
    }

    return res.status(201).json(record);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to mark progress" });
  }
});

// GET /lms/progress/user/:userId/summary — Authoritative user learning & attendance summary
progressRouter.get("/user/:userId/summary", async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
    if (!isUuid) {
      return res.status(400).json({ error: "Invalid user ID format" });
    }

    let cohortId = req.query.cohortId as string | undefined;
    if (!cohortId) {
      try {
        const user = await fetchUser(userId);
        cohortId = user?.cohortMembers?.[0]?.cohortId || user?.cohortId;
      } catch {}
    }

    const attendanceCheck = await checkWeeks1To12Attendance(userId, cohortId);
    const week12Done = attendanceCheck.week12Complete || (await isWeek12AttendanceComplete(userId, cohortId));

    const userProgress = await db
      .select()
      .from(progress)
      .where(eq(progress.userId, userId));

    const completedLessonIds = userProgress
      .filter((p) => p.completed)
      .map((p) => p.lessonId);

    const passedAttempts = await db
      .select({
        quizId: quizAttempts.quizId,
        weekId: quizAttempts.weekId,
      })
      .from(quizAttempts)
      .where(
        and(
          eq(quizAttempts.userId, userId),
          or(eq(quizAttempts.passed, true), gte(quizAttempts.score, 70))
        )
      );

    const passedWeekIdSet = new Set(passedAttempts.map((a) => a.weekId));
    if (passedWeekIdSet.size > 0) {
      const passedWeeksList = await db
        .select({ id: weeks.id, weekNumber: weeks.weekNumber })
        .from(weeks)
        .where(inArray(weeks.id, Array.from(passedWeekIdSet)));
      const passedNumbers = passedWeeksList.map((w) => w.weekNumber).filter((n): n is number => typeof n === "number");
      if (passedNumbers.length > 0) {
        const siblingWeeks = await db
          .select({ id: weeks.id })
          .from(weeks)
          .where(inArray(weeks.weekNumber, passedNumbers));
        for (const sw of siblingWeeks) {
          passedWeekIdSet.add(sw.id);
        }
      }
    }

    return res.json({
      userId,
      cohortId: cohortId || null,
      practicalWeeks: attendanceCheck.attendedWeeks,
      missingPracticalWeeks: attendanceCheck.missingWeeks,
      attendanceComplete: attendanceCheck.isComplete,
      week12AttendanceComplete: week12Done,
      completedLessonIds,
      passedWeekIds: Array.from(passedWeekIdSet),
      passedQuizIds: Array.from(new Set(passedAttempts.map((a) => a.quizId))),
    });
  } catch (err) {
    console.error("[lms] GET /progress/user/:userId/summary error:", err);
    return res.status(500).json({ error: "Failed to fetch user progress summary" });
  }
});

// GET /lms/progress/:userId
progressRouter.get("/:userId", async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
    if (!isUuid) {
      return res.status(400).json({ error: "Invalid user ID format" });
    }

    const all = await db
      .select()
      .from(progress)
      .where(eq(progress.userId, userId));
    return res.json(all);
  } catch (err) {
    console.error("[lms] GET /progress/:userId error:", err);
    return res.status(500).json({ error: "Failed to fetch progress" });
  }
});

// GET /lms/progress/cohort/:cohortId
progressRouter.get("/cohort/:cohortId", async (req: Request, res: Response) => {
  try {
    const cohortId = req.params.cohortId;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cohortId);
    if (!isUuid) {
      return res.status(400).json({ error: "Invalid cohort ID format" });
    }

    const all = await db
      .select()
      .from(progress)
      .where(eq(progress.cohortId, cohortId));
    return res.json(all);
  } catch (err) {
    console.error("[lms] GET /progress/cohort/:cohortId error:", err);
    return res.status(500).json({ error: "Failed to fetch cohort progress" });
  }
});

// ─────────────────────────────────────────────
// PHYSICAL SESSIONS
// ─────────────────────────────────────────────

// GET /lms/sessions?cohortId=xxx&weekId=yyy
// Both filters optional and combinable.
// Frontend: ?cohortId=xxx&weekId=yyy → student sees
// only their cohort's session for the current week
sessionsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { cohortId, weekId } = req.query;

    let query = db.select().from(physicalSessions);

    if (cohortId && weekId) {
      query = query.where(
        and(
          eq(physicalSessions.cohortId, cohortId as string),
          eq(physicalSessions.weekId, weekId as string)
        )
      ) as typeof query;
    } else if (cohortId) {
      query = query.where(
        eq(physicalSessions.cohortId, cohortId as string)
      ) as typeof query;
    } else if (weekId) {
      query = query.where(
        eq(physicalSessions.weekId, weekId as string)
      ) as typeof query;
    }

    const all = await query.orderBy(physicalSessions.scheduledAt);
    return res.json(all);
  } catch {
    return res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// GET /lms/sessions/:id
sessionsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const [session] = await db
      .select()
      .from(physicalSessions)
      .where(eq(physicalSessions.id, req.params.id))
      .limit(1);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const groups = await db
      .select()
      .from(sessionGroups)
      .where(eq(sessionGroups.sessionId, req.params.id));

    return res.json({ ...session, assignedUsers: groups });
  } catch {
    return res.status(500).json({ error: "Failed to fetch session" });
  }
});

// POST /lms/sessions
sessionsRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    cohortId: z.string().uuid(),
    weekId: z.string().uuid().optional(),   // optional — general sessions have no week
    title: z.string().min(1),
    description: z.string().optional(),
    type: z.enum(["online", "physical"]).default("physical"),
    location: z.string().optional(),
    scheduledAt: z.string().datetime().optional(),
    durationMinutes: z.number().int().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [session] = await db
      .insert(physicalSessions)
      .values({
        ...parsed.data,
        scheduledAt: parsed.data.scheduledAt
          ? new Date(parsed.data.scheduledAt)
          : undefined,
      })
      .returning();
    return res.status(201).json(session);
  } catch {
    return res.status(500).json({ error: "Failed to create session" });
  }
});

// PATCH /lms/sessions/:id
sessionsRouter.patch("/:id", async (req: Request, res: Response) => {
  const schema = z.object({
    weekId: z.string().uuid().optional().nullable(),
    title: z.string().optional(),
    description: z.string().optional(),
    type: z.enum(["online", "physical"]).optional(),
    location: z.string().optional(),
    scheduledAt: z.string().datetime().optional(),
    durationMinutes: z.number().int().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [updated] = await db
      .update(physicalSessions)
      .set({
        ...parsed.data,
        scheduledAt: parsed.data.scheduledAt
          ? new Date(parsed.data.scheduledAt)
          : undefined,
        updatedAt: new Date(),
      })
      .where(eq(physicalSessions.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Session not found" });
    return res.json(updated);
  } catch {
    return res.status(500).json({ error: "Failed to update session" });
  }
});

// POST /lms/sessions/:id/assign
sessionsRouter.post("/:id/assign", async (req: Request, res: Response) => {
  const { userIds } = req.body as { userIds: string[] };
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: "userIds array required" });
  }

  try {
    const inserts = userIds.map((userId) => ({
      sessionId: req.params.id,
      userId,
    }));
    const assigned = await db.insert(sessionGroups).values(inserts).returning();
    return res.status(201).json(assigned);
  } catch {
    return res.status(500).json({ error: "Failed to assign users to session" });
  }
});

// ─────────────────────────────────────────────
// QUIZZES
// ─────────────────────────────────────────────


// GET /lms/quizzes/week/:weekId
quizzesRouter.get("/week/:weekId", async (req: Request, res: Response) => {
  try {
    // Proactively update legacy DB quizzes to 70% passing score
    db.update(quizzes).set({ passingScore: 70 }).execute().catch(() => {});

    // Published quizzes first, newest first, so clients can rely on index 0
    let all = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.weekId, req.params.weekId))
      .orderBy(desc(quizzes.isPublished), desc(quizzes.createdAt));

    if (all.length === 0) {
      const [currentWeek] = await db
        .select({ weekNumber: weeks.weekNumber })
        .from(weeks)
        .where(eq(weeks.id, req.params.weekId))
        .limit(1);
      if (currentWeek?.weekNumber) {
        const siblingQuizzes = await db
          .select({ quiz: quizzes })
          .from(quizzes)
          .innerJoin(weeks, eq(quizzes.weekId, weeks.id))
          .where(
            and(
              eq(weeks.weekNumber, currentWeek.weekNumber),
              eq(quizzes.isPublished, true)
            )
          )
          .orderBy(desc(quizzes.createdAt));
        all = siblingQuizzes.map((s) => s.quiz);
      }
    }

    const isStaff = isStaffRole(req);
    const normalized = all.map((q) => {
      const sanitizedQuestions = Array.isArray(q.questions)
        ? isStaff
          ? q.questions
          : (q.questions as any[]).map(({ correctIndex: _stripped, ...item }) => item)
        : [];
      return {
        ...q,
        questions: sanitizedQuestions,
        passingScore: 70,
        isPublished: q.isPublished ?? true,
      };
    });
    return res.json(normalized);
  } catch {
    return res.status(500).json({ error: "Failed to fetch quizzes" });
  }
});

// ADMIN — list all quiz attempts with quiz title
// GET /lms/quizzes/admin/attempts
quizzesRouter.get("/admin/attempts", async (req: Request, res: Response) => {
  const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

  try {
    if (page || limit) {
      const pageNum = page && page > 0 ? page : 1;
      const limitNum = limit && limit > 0 ? limit : 25;
      const offsetNum = (pageNum - 1) * limitNum;

      const [countRes, paginated] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(quizAttempts),
        db
          .select({
            attemptId: quizAttempts.id,
            userId: quizAttempts.userId,
            quizId: quizAttempts.quizId,
            weekId: quizAttempts.weekId,
            cohortId: quizAttempts.cohortId,
            score: quizAttempts.score,
            passed: quizAttempts.passed,
            attemptedAt: quizAttempts.attemptedAt,
            quizTitle: quizzes.title,
          })
          .from(quizAttempts)
          .leftJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
          .orderBy(desc(quizAttempts.attemptedAt))
          .limit(limitNum)
          .offset(offsetNum),
      ]);

      const total = Number(countRes?.[0]?.count || 0);
      return res.json({
        data: paginated,
        attempts: paginated,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum) || 1,
      });
    }

    const all = await db
      .select({
        attemptId: quizAttempts.id,
        userId: quizAttempts.userId,
        quizId: quizAttempts.quizId,
        weekId: quizAttempts.weekId,
        cohortId: quizAttempts.cohortId,
        score: quizAttempts.score,
        passed: quizAttempts.passed,
        attemptedAt: quizAttempts.attemptedAt,
        quizTitle: quizzes.title,
      })
      .from(quizAttempts)
      .leftJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
      .orderBy(desc(quizAttempts.attemptedAt));

    return res.json(all);
  } catch (err) {
    console.error("GET /lms/quizzes/admin/attempts error:", err);
    return res.status(500).json({ error: "Failed to fetch admin quiz attempts" });
  }
});

// ADMIN — delete an individual quiz attempt
// DELETE /lms/quizzes/admin/attempts/:id
quizzesRouter.delete("/admin/attempts/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [deleted] = await db
      .delete(quizAttempts)
      .where(eq(quizAttempts.id, id))
      .returning();

    if (!deleted) {
      return res.status(404).json({ error: "Quiz attempt not found" });
    }

    return res.json({ message: "Quiz attempt deleted successfully", attemptId: id, deleted });
  } catch (err) {
    console.error("DELETE /lms/quizzes/admin/attempts/:id error:", err);
    return res.status(500).json({ error: "Failed to delete quiz attempt" });
  }
});

// ADMIN — clear all quiz attempts
// DELETE /lms/quizzes/admin/attempts
quizzesRouter.delete("/admin/attempts", async (req: Request, res: Response) => {
  try {
    await db.delete(quizAttempts);
    return res.json({ message: "All quiz attempts cleared successfully" });
  } catch (err) {
    console.error("DELETE /lms/quizzes/admin/attempts error:", err);
    return res.status(500).json({ error: "Failed to clear quiz attempts" });
  }
});

// GET /lms/quizzes/:id
quizzesRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id);
  if (!isUuid) return next();

  try {
    const [quiz] = await db
      .select() 
      .from(quizzes)
      .where(eq(quizzes.id, req.params.id))
      .limit(1);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    const isStaff = isStaffRole(req);
    const sanitizedQuestions = Array.isArray(quiz.questions)
      ? isStaff
        ? quiz.questions
        : (quiz.questions as any[]).map(({ correctIndex: _stripped, ...q }) => q)
      : [];

    return res.json({
      ...quiz,
      questions: sanitizedQuestions,
      passingScore: 70,
      isPublished: quiz.isPublished ?? true,
    });
  } catch {
    return res.status(500).json({ error: "Failed to fetch quiz" });
  }
});

// POST /lms/quizzes
quizzesRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    weekId: z.string().uuid(),
    cohortId: z.string().uuid(),
    title: z.string().min(1),
    questions: z.array(z.object({
      id: z.string(),
      question: z.string(),
      options: z.array(z.string()),
      correctIndex: z.number().int(),
    })).default([]),
    passingScore: z.number().int().min(1).max(100).default(70),
    isPublished: z.boolean().default(true),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [quiz] = await db.insert(quizzes).values(parsed.data).returning();
    return res.status(201).json(quiz);
  } catch {
    return res.status(500).json({ error: "Failed to create quiz" });
  }
});

// PATCH /lms/quizzes/:id
quizzesRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const [updated] = await db
      .update(quizzes)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(quizzes.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Quiz not found" });
    return res.json(updated);
  } catch {
    return res.status(500).json({ error: "Failed to update quiz" });
  }
});

// POST /lms/quizzes/:id/attempt
quizzesRouter.post("/:id/attempt", async (req: Request, res: Response) => {
  const schema = z.object({
    userId: z.string().optional().or(z.literal("")),
    weekId: z.string().optional().or(z.literal("")),
    cohortId: z.string().optional().or(z.literal("")),
    answers: z.record(z.string(), z.number()),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return res.status(400).json({ error: `Invalid request payload: ${issues}` });
  }

  const rawUserId = (parsed.data.userId && z.string().uuid().safeParse(parsed.data.userId).success ? parsed.data.userId : null) || (req.headers["x-user-id"] as string) || (req as any).user?.id || (req as any).user?.userId;
  if (!rawUserId || !z.string().uuid().safeParse(rawUserId).success) {
    return res.status(400).json({ error: "A valid User ID is required to submit a quiz attempt." });
  }
  const userId = rawUserId;
  const { answers } = parsed.data;

  try {
    const [quiz] = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.id, req.params.id))
      .limit(1);

    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    const weekId = (parsed.data.weekId && z.string().uuid().safeParse(parsed.data.weekId).success)
      ? parsed.data.weekId
      : quiz.weekId;

    let cohortId = (parsed.data.cohortId && z.string().uuid().safeParse(parsed.data.cohortId).success)
      ? parsed.data.cohortId
      : "";

    if (!cohortId) {
      const [w] = await db.select({ cohortId: weeks.cohortId }).from(weeks).where(eq(weeks.id, weekId)).limit(1);
      if (w?.cohortId) {
        cohortId = w.cohortId;
      }
    }

    if (!cohortId || !z.string().uuid().safeParse(cohortId).success) {
      if (quiz.cohortId && z.string().uuid().safeParse(quiz.cohortId).success) {
        cohortId = quiz.cohortId;
      } else {
        try {
          const u = await fetchUser(userId);
          const uCohort = u?.cohortMembers?.[0]?.cohortId || u?.cohortId;
          if (uCohort && z.string().uuid().safeParse(uCohort).success) {
            cohortId = uCohort;
          }
        } catch {}
      }
    }

    if (!cohortId || !z.string().uuid().safeParse(cohortId).success) {
      return res.status(400).json({ error: "Cohort ID could not be determined for this quiz attempt." });
    }

    // Verify all published lessons for this week are completed before allowing quiz attempt
    const weekLessons = await db
      .select({ id: lessons.id })
      .from(lessons)
      .where(and(eq(lessons.weekId, weekId), eq(lessons.isPublished, true)));

    if (weekLessons.length > 0) {
      const userProgress = await db
        .select({ lessonId: progress.lessonId })
        .from(progress)
        .where(
          and(
            eq(progress.userId, userId),
            eq(progress.weekId, weekId),
            eq(progress.completed, true)
          )
        );

      const completedLessonIds = new Set(userProgress.map((p) => p.lessonId));
      const allLessonsCompleted = weekLessons.every((l) => completedLessonIds.has(l.id));

      if (!allLessonsCompleted) {
        return res.status(403).json({
          error: "You must complete all lessons for this week before attempting the quiz.",
        });
      }
    }

    // Check quiz attempt limit (max 10 attempts per quiz)
    const existingAttempts = await db
      .select()
      .from(quizAttempts)
      .where(
        and(
          eq(quizAttempts.quizId, quiz.id),
          eq(quizAttempts.userId, userId)
        )
      );

    // Block retakes if user has already passed this quiz (70%+)
    const alreadyPassed = existingAttempts.some(
      (a) => a.passed === true || (typeof a.score === "number" && a.score >= 70)
    );
    if (alreadyPassed) {
      return res.status(403).json({
        error: "You have already passed this quiz with a passing score (70%+). Retakes are not allowed once passed.",
        alreadyPassed: true,
      });
    }

    if (existingAttempts.length >= 10) {
      return res.status(403).json({
        error: "Attempt limit reached: You can take a quiz a maximum of 10 times.",
        attemptsCount: existingAttempts.length,
        maxAttempts: 10,
      });
    }
    const questions = quiz.questions as any[];
    let correct = 0;
    questions.forEach((q: any) => {
      if (Number(answers[q.id]) === Number(q.correctIndex)) correct++;
    });

    const score = questions.length > 0
      ? Math.round((correct / questions.length) * 100)
      : 0;
    const requiredPassScore = 70;
    const passed = score >= requiredPassScore;

    const [attempt] = await db
      .insert(quizAttempts)
      .values({
        userId,
        quizId: quiz.id,
        weekId,
        cohortId,
        answers,
        score,
        passed,
      })
      .returning();

    return res.status(201).json({ attempt, score, passed, correct, total: questions.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to submit quiz attempt" });
  }
});

// GET /lms/quizzes/:id/attempts/:userId
quizzesRouter.get("/:id/attempts/:userId", async (req: Request, res: Response) => {
  try {
    const all = await db
      .select()
      .from(quizAttempts)
      .where(
        and(
          eq(quizAttempts.quizId, req.params.id),
          eq(quizAttempts.userId, req.params.userId)
        )
      );
    return res.json(all);
  } catch {
    return res.status(500).json({ error: "Failed to fetch attempts" });
  }
});

// GET /lms/quizzes/user/:userId/passed — get all passed quiz and week IDs for a user
quizzesRouter.get("/user/:userId/passed", async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
    if (!isUuid) {
      return res.status(400).json({ error: "Invalid user ID format" });
    }

    const passedAttempts = await db
      .select({
        quizId: quizAttempts.quizId,
        weekId: quizAttempts.weekId,
      })
      .from(quizAttempts)
      .where(
        and(
          eq(quizAttempts.userId, userId),
          or(
            eq(quizAttempts.passed, true),
            gte(quizAttempts.score, 70)
          )
        )
      );

    const passedWeekIds = Array.from(new Set(passedAttempts.map((a) => a.weekId)));
    const passedQuizIds = Array.from(new Set(passedAttempts.map((a) => a.quizId)));

    // Map sibling week IDs with the same weekNumbers across cohorts
    if (passedWeekIds.length > 0) {
      const passedWeekRows = await db
        .select({ weekNumber: weeks.weekNumber })
        .from(weeks)
        .where(inArray(weeks.id, passedWeekIds));
      const numbers = Array.from(new Set(passedWeekRows.map((w) => w.weekNumber).filter((n): n is number => typeof n === "number")));
      if (numbers.length > 0) {
        const siblingWeeks = await db
          .select({ id: weeks.id })
          .from(weeks)
          .where(inArray(weeks.weekNumber, numbers));
        for (const sw of siblingWeeks) {
          if (!passedWeekIds.includes(sw.id)) {
            passedWeekIds.push(sw.id);
          }
        }
      }
    }

    return res.json({ passedWeekIds, passedQuizIds });
  } catch (err) {
    console.error("[lms] GET /quizzes/user/:userId/passed error:", err);
    return res.status(500).json({ error: "Failed to fetch user passed quizzes" });
  }
});



// ─────────────────────────────────────────────
// WEEK 12 CODES
// ─────────────────────────────────────────────
export const week12Router = Router();

// POST /lms/week12/codes — admin generates a daily code
week12Router.post("/codes", async (req: Request, res: Response) => {
  const schema = z.object({
    cohortId: z.string().uuid(),
    day: z.number().int().min(1).max(5),
    validDate: z.string(), // YYYY-MM-DD
    createdBy: z.string().uuid(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    // Generate a random 8-char code
    const code = `EEWYLA-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${parsed.data.day}`;

    const [record] = await db
      .insert(week12Codes)
      .values({ ...parsed.data, code })
      .returning();

    return res.status(201).json(record);
  } catch {
    return res.status(500).json({ error: "Failed to generate code" });
  }
});

// GET /lms/week12/codes/:cohortId — get all codes for a cohort
week12Router.get("/codes/:cohortId", async (req: Request, res: Response) => {
  try {
    const all = await db
      .select()
      .from(week12Codes)
      .where(eq(week12Codes.cohortId, req.params.cohortId));
    return res.json(all);
  } catch {
    return res.status(500).json({ error: "Failed to fetch codes" });
  }
});

// POST /lms/week12/checkin — trainee checks in with code (DISABLED: Admin-only recording)
week12Router.post("/checkin", async (_req: Request, res: Response) => {
  return res.status(403).json({
    error: "Trainee self-check-in is disabled for Week 12. Physical attendance must be recorded directly by an authorized administrator or trainer.",
  });
});

// POST /lms/week12/admin/checkin — admin manually records attendance for a day
week12Router.post("/admin/checkin", async (req: Request, res: Response) => {
  const callerRole = req.headers["x-user-role"] as string | undefined;
  if (callerRole === "trainee") {
    return res.status(403).json({ error: "Forbidden: Trainees cannot mark attendance. Attendance must be recorded by an administrator or trainer." });
  }

  const schema = z.object({
    cohortId: z.string().uuid(),
    userId: z.string().uuid(),
    day: z.number().int().min(1).max(5),
    groupId: z.string().optional(),
    verifiedBy: z.string().uuid().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { cohortId, userId, day, groupId, verifiedBy } = parsed.data;
  const headerUserId = req.headers["x-user-id"] as string | undefined;
  const isUuid = (str: any) => typeof str === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
  const effectiveVerifiedBy = isUuid(verifiedBy) ? verifiedBy : (isUuid(headerUserId) ? headerUserId : null);

  try {
    const [existing] = await db
      .select()
      .from(week12Checkins)
      .where(
        and(
          eq(week12Checkins.cohortId, cohortId),
          eq(week12Checkins.userId, userId),
          eq(week12Checkins.day, day)
        )
      )
      .limit(1);

    if (existing) {
      return res.status(200).json({
        message: `User is already checked in for Day ${day}`,
        checkin: existing,
        alreadyCheckedIn: true,
      });
    }

    let codeId: string | null = null;
    const [codeRecord] = await db
      .select({ id: week12Codes.id })
      .from(week12Codes)
      .where(and(eq(week12Codes.cohortId, cohortId), eq(week12Codes.day, day)))
      .limit(1);

    if (codeRecord) {
      codeId = codeRecord.id;
    } else {
      // Auto-provision a system code record for this cohort and day so that foreign-key and NOT NULL constraints are always satisfied
      try {
        const dummyCode = `W12-D${day}-${cohortId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4)}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const adminId = effectiveVerifiedBy || userId;
        const [newCode] = await db
          .insert(week12Codes)
          .values({
            cohortId,
            day,
            code: dummyCode,
            validDate: new Date().toISOString().split("T")[0],
            createdBy: adminId,
          })
          .returning({ id: week12Codes.id });
        if (newCode) codeId = newCode.id;
      } catch {
        // Fallback: check if created concurrently
        const [fallback] = await db
          .select({ id: week12Codes.id })
          .from(week12Codes)
          .where(and(eq(week12Codes.cohortId, cohortId), eq(week12Codes.day, day)))
          .limit(1);
        if (fallback) codeId = fallback.id;
      }
    }

    const [checkin] = await db
      .insert(week12Checkins)
      .values({
        cohortId,
        userId,
        day,
        groupId: groupId || null,
        codeId: codeId || null,
        verifiedBy: effectiveVerifiedBy,
      })
      .returning();

    return res.status(201).json({
      message: `✅ Manually checked in for Day ${day}`,
      checkin,
    });
  } catch (err: any) {
    console.error("[week12Router.post /admin/checkin] error:", err?.message || err, err);
    return res.status(500).json({ error: "Failed to manually check in trainee", details: err?.message });
  }
});

// DELETE /lms/week12/admin/checkin — admin removes a checkin for a day (if marked by mistake)
week12Router.delete("/admin/checkin", async (req: Request, res: Response) => {
  const callerRole = req.headers["x-user-role"] as string | undefined;
  if (callerRole === "trainee") {
    return res.status(403).json({ error: "Forbidden: Trainees cannot remove attendance." });
  }

  const schema = z.object({
    cohortId: z.string().uuid(),
    userId: z.string().uuid(),
    day: z.number().int().min(1).max(5),
  });

  const bodyData = req.body && Object.keys(req.body).length > 0 ? req.body : req.query;
  const parsed = schema.safeParse(bodyData);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { cohortId, userId, day } = parsed.data;

  try {
    await db
      .delete(week12Checkins)
      .where(
        and(
          eq(week12Checkins.cohortId, cohortId),
          eq(week12Checkins.userId, userId),
          eq(week12Checkins.day, day)
        )
      );

    return res.json({ message: `Check-in removed for Day ${day}` });
  } catch (err) {
    console.error("[week12Router.delete /admin/checkin] error:", err);
    return res.status(500).json({ error: "Failed to remove check-in" });
  }
});

// GET /lms/week12/checkins/:cohortId — admin sees all checkins
week12Router.get("/checkins/:cohortId", async (req: Request, res: Response) => {
  try {
    const all = await db
      .select()
      .from(week12Checkins)
      .where(eq(week12Checkins.cohortId, req.params.cohortId));
    return res.json(all);
  } catch {
    return res.status(500).json({ error: "Failed to fetch checkins" });
  }
});

// GET /lms/week12/checkins/:cohortId/:userId — check a specific trainee's attendance
week12Router.get("/checkins/:cohortId/:userId", async (req: Request, res: Response) => {
  try {
    const { cohortId, userId } = req.params;
    const all = await db
      .select()
      .from(week12Checkins)
      .where(
        and(
          eq(week12Checkins.cohortId, cohortId),
          eq(week12Checkins.userId, userId)
        )
      );

    const days = all.map((c) => c.day);
    const fullyAttended = await isWeek12AttendanceComplete(userId, cohortId);

    return res.json({ checkins: all, days, fullyAttended });
  } catch {
    return res.status(500).json({ error: "Failed to fetch checkins" });
  }
});

// ─── Practical Attendance Check-ins Router ──────────────────────────────────────

// GET /lms/practical/checkins/:cohortId
practicalRouter.get("/checkins/:cohortId", async (req: Request, res: Response) => {
  const { cohortId } = req.params;
  const { week } = req.query;

  const isUuid = (str: any) => typeof str === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
  if (!isUuid(cohortId)) {
    return res.status(400).json({ error: "Invalid cohortId format (must be UUID)" });
  }

  try {
    const conditions = [eq(practicalCheckins.cohortId, cohortId)];
    if (week) {
      const wNum = Number(week);
      if (Number.isInteger(wNum) && wNum > 0) {
        conditions.push(eq(practicalCheckins.weekNumber, wNum));
      }
    }

    const list = await db
      .select()
      .from(practicalCheckins)
      .where(and(...conditions));
    return res.json(list);
  } catch (err) {
    console.error("Fetch practical checkins error:", err);
    return res.status(500).json({ error: "Failed to fetch practical checkins" });
  }
});

// POST /lms/practical/checkins
practicalRouter.post("/checkins", async (req: Request, res: Response) => {
  const callerRole = req.headers["x-user-role"] as string | undefined;
  if (callerRole === "trainee") {
    return res.status(403).json({ error: "Forbidden: Trainees cannot mark attendance. Attendance must be recorded by an administrator or trainer." });
  }

  const { cohortId, userId, groupId, weekNumber, codeSubmitted, verifiedBy } = req.body;
  if (!cohortId || !userId || !weekNumber) {
    return res.status(400).json({ error: "Missing required checkin fields" });
  }

  const isUuid = (str: any) => typeof str === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
  if (!isUuid(cohortId)) {
    return res.status(400).json({ error: "Invalid cohortId format (must be UUID)" });
  }
  if (!isUuid(userId)) {
    return res.status(400).json({ error: "Invalid userId format (must be UUID)" });
  }
  const wNum = Number(weekNumber);
  if (!Number.isInteger(wNum) || wNum < 1 || wNum > 52) {
    return res.status(400).json({ error: "Invalid weekNumber (must be integer between 1 and 52)" });
  }

  const headerUserId = req.headers["x-user-id"] as string | undefined;
  const validVerifiedBy = isUuid(verifiedBy) ? verifiedBy : (isUuid(headerUserId) ? headerUserId : null);

  try {
    const [existing] = await db
      .select()
      .from(practicalCheckins)
      .where(
        and(
          eq(practicalCheckins.cohortId, cohortId),
          eq(practicalCheckins.userId, userId),
          eq(practicalCheckins.weekNumber, wNum)
        )
      );

    if (existing) {
      return res.status(200).json({ message: "User already checked in for this week", checkin: existing });
    }

    const fallbackCode = generatePracticalCodeString(userId, wNum, "");
    const finalCodeSubmitted = typeof codeSubmitted === "string" && codeSubmitted.trim() && codeSubmitted.trim() !== "VERIFIED"
      ? codeSubmitted.trim().slice(0, 128)
      : fallbackCode;

    const [inserted] = await db
      .insert(practicalCheckins)
      .values({
        cohortId,
        userId,
        groupId: typeof groupId === "string" ? groupId.slice(0, 128) : null,
        weekNumber: wNum,
        codeSubmitted: finalCodeSubmitted,
        verifiedBy: validVerifiedBy,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      const [recheck] = await db
        .select()
        .from(practicalCheckins)
        .where(
          and(
            eq(practicalCheckins.cohortId, cohortId),
            eq(practicalCheckins.userId, userId),
            eq(practicalCheckins.weekNumber, wNum)
          )
        );
      return res.status(200).json({ message: "User already checked in for this week", checkin: recheck || null });
    }

    return res.status(201).json({ message: "Checkin recorded successfully", checkin: inserted });
  } catch (err: any) {
    if (err?.code === "23505") {
      try {
        const [recheck] = await db
          .select()
          .from(practicalCheckins)
          .where(
            and(
              eq(practicalCheckins.cohortId, cohortId),
              eq(practicalCheckins.userId, userId),
              eq(practicalCheckins.weekNumber, wNum)
            )
          );
        return res.status(200).json({ message: "User already checked in for this week", checkin: recheck || null });
      } catch {}
    }
    console.error("Record practical checkin error:", err);
    return res.status(500).json({ error: "Failed to record practical checkin" });
  }
});

// GET /lms/practical/checkins/user/:userId
practicalRouter.get("/checkins/user/:userId", async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
    if (!isUuid) {
      return res.status(400).json({ error: "Invalid user ID format" });
    }

    const list = await db
      .select()
      .from(practicalCheckins)
      .where(eq(practicalCheckins.userId, userId));

    const existingWeeks = new Set(list.map((c) => Number(c.weekNumber)));

    // Also look up any practical checkins matching user's registered or deterministic codes
    const userCodes = await db
      .select({ code: practicalCodes.code, weekNumber: practicalCodes.weekNumber })
      .from(practicalCodes)
      .where(eq(practicalCodes.userId, userId));

    let userEmail = "";
    try {
      const u = await fetchUser(userId);
      if (u?.email) userEmail = u.email;
    } catch {}

    const codeStrings = new Set<string>(userCodes.map((u) => u.code).filter(Boolean));
    for (let w = 1; w <= 12; w++) {
      if (!existingWeeks.has(w)) {
        codeStrings.add(generatePracticalCodeString(userId, w, userEmail));
        if (userEmail) {
          codeStrings.add(generatePracticalCodeString(userId, w, ""));
        }
      }
    }

    if (codeStrings.size > 0) {
      const matched = await db
        .select()
        .from(practicalCheckins)
        .where(inArray(practicalCheckins.codeSubmitted, Array.from(codeStrings)));
      for (const m of matched) {
        if (!existingWeeks.has(Number(m.weekNumber))) {
          existingWeeks.add(Number(m.weekNumber));
          list.push(m);
        }
      }
    }

    return res.json(list);
  } catch (err) {
    console.error("[lms] GET /practical/checkins/user/:userId error:", err);
    return res.status(500).json({ error: "Failed to fetch user checkins" });
  }
});

// DELETE /lms/practical/checkins/:cohortId
practicalRouter.delete("/checkins/:cohortId", async (req: Request, res: Response) => {
  const { cohortId } = req.params;
  const { week, userId } = req.query;

  const isUuid = (str: any) => typeof str === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
  if (!isUuid(cohortId)) {
    return res.status(400).json({ error: "Invalid cohortId format (must be UUID)" });
  }

  try {
    const conditions = [eq(practicalCheckins.cohortId, cohortId)];
    if (week) {
      const wNum = Number(week);
      if (Number.isInteger(wNum) && wNum > 0) {
        conditions.push(eq(practicalCheckins.weekNumber, wNum));
      }
    }
    if (userId && typeof userId === "string" && isUuid(userId)) {
      conditions.push(eq(practicalCheckins.userId, userId));
    }

    const deleted = await db
      .delete(practicalCheckins)
      .where(and(...conditions))
      .returning();

    return res.json({
      message: `Successfully deleted ${deleted.length} practical check-in record(s)`,
      deletedCount: deleted.length,
      deleted,
    });
  } catch (err) {
    console.error("DELETE practical checkins error:", err);
    return res.status(500).json({ error: "Failed to delete practical checkins" });
  }
});

// DELETE /lms/practical/checkins/user/:userId
practicalRouter.delete("/checkins/user/:userId", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { week } = req.query;

  const isUuid = (str: any) => typeof str === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
  if (!isUuid(userId)) {
    return res.status(400).json({ error: "Invalid userId format (must be UUID)" });
  }

  try {
    const conditions = [eq(practicalCheckins.userId, userId)];
    if (week) {
      const wNum = Number(week);
      if (Number.isInteger(wNum) && wNum > 0) {
        conditions.push(eq(practicalCheckins.weekNumber, wNum));
      }
    }

    const deleted = await db
      .delete(practicalCheckins)
      .where(and(...conditions))
      .returning();

    return res.json({
      message: `Successfully deleted ${deleted.length} check-in record(s) for user`,
      deletedCount: deleted.length,
      deleted,
    });
  } catch (err) {
    console.error("DELETE user practical checkins error:", err);
    return res.status(500).json({ error: "Failed to delete user practical checkins" });
  }
});

// ─── Authoritative Practical Code Lifecycle (Weeks 1 to 12) ───────────────────

export function generatePracticalCodeString(
  userId: string,
  weekNumber: number,
  email = ""
): string {
  const cleanEmail = (email || "").toLowerCase().trim();
  const cleanUserId = (userId || "id").trim();
  const seed = `ORIYON-PRAC-CODE-V3-${cleanUserId}-${cleanEmail}-W${weekNumber}-SALT`;
  let hash1 = 0;
  let hash2 = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash1 = (hash1 << 5) - hash1 + char;
    hash1 |= 0;
    hash2 = (hash2 << 3) ^ char;
  }

  const p1 = Math.abs(hash1).toString(36).toUpperCase().padStart(4, "7").slice(0, 4);
  const p2 = Math.abs(hash2).toString(36).toUpperCase().padStart(4, "9").slice(0, 4);
  return `PRAC-W${weekNumber}-${p1}-${p2}`;
}

export function normalizePracticalCodeInput(raw: string): string {
  return (raw || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-]/gi, "")
    .replace(/-+/g, "-")
    .toUpperCase();
}

// POST /lms/practical/code
// Generates or retrieves an authoritative practical attendance code persisted in PostgreSQL
practicalRouter.post("/code", async (req: Request, res: Response) => {
  const headerUserId = req.headers["x-user-id"] as string | undefined;
  const userId = headerUserId || req.body.userId;
  const { cohortId, groupId, weekNumber, email } = req.body;

  if (!userId) {
    return res.status(401).json({ error: "User authentication required" });
  }

  const wNum = Number(weekNumber);
  if (isNaN(wNum) || wNum < 1 || wNum > 12) {
    return res.status(400).json({ error: "Invalid week number. Practical sessions run from Week 1 to Week 12." });
  }

  const cleanCohortId = String(cohortId || "00000000-0000-0000-0000-000000000000").trim();
  const cleanUserId = String(userId).trim();
  const cleanGroupId = groupId ? String(groupId).trim() : null;

  try {
    // 1. Check if user already has an authoritative code for this week
    const existingList = await db
      .select()
      .from(practicalCodes)
      .where(
        and(
          eq(practicalCodes.userId, cleanUserId),
          eq(practicalCodes.weekNumber, wNum)
        )
      );

    if (existingList.length > 0) {
      const existing = existingList[0];
      return res.json({
        success: true,
        code: existing.code,
        weekNumber: existing.weekNumber,
        cohortId: existing.cohortId,
        groupId: existing.groupId,
        isExisting: true,
      });
    }

    // 2. Generate authoritative code
    const generatedCode = generatePracticalCodeString(cleanUserId, wNum, email);

    // 3. Persist to database
    const [inserted] = await db
      .insert(practicalCodes)
      .values({
        cohortId: cleanCohortId,
        userId: cleanUserId,
        groupId: cleanGroupId,
        weekNumber: wNum,
        code: generatedCode,
      })
      .onConflictDoUpdate({
        target: [practicalCodes.cohortId, practicalCodes.userId, practicalCodes.weekNumber],
        set: {
          code: generatedCode,
          updatedAt: new Date(),
        },
      })
      .returning();

    return res.status(201).json({
      success: true,
      code: inserted.code,
      weekNumber: inserted.weekNumber,
      cohortId: inserted.cohortId,
      groupId: inserted.groupId,
      isExisting: false,
    });
  } catch (err: any) {
    console.error("Generate practical code error:", err);
    try {
      const [retryExisting] = await db
        .select()
        .from(practicalCodes)
        .where(
          and(
            eq(practicalCodes.userId, cleanUserId),
            eq(practicalCodes.weekNumber, wNum)
          )
        );
      if (retryExisting) {
        return res.json({
          success: true,
          code: retryExisting.code,
          weekNumber: retryExisting.weekNumber,
          cohortId: retryExisting.cohortId,
          groupId: retryExisting.groupId,
          isExisting: true,
        });
      }
    } catch {}

    return res.status(500).json({ error: "Failed to generate or retrieve attendance code" });
  }
});

// GET /lms/practical/code/user/:userId
practicalRouter.get("/code/user/:userId", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { week } = req.query;

  try {
    const conditions = [eq(practicalCodes.userId, userId)];
    if (week && !isNaN(Number(week))) {
      conditions.push(eq(practicalCodes.weekNumber, Number(week)));
    }

    const list = await db
      .select()
      .from(practicalCodes)
      .where(and(...conditions));

    return res.json(list);
  } catch (err) {
    console.error("Fetch user practical codes error:", err);
    return res.status(500).json({ error: "Failed to fetch practical codes" });
  }
});

// POST /lms/practical/verify-code
// Authoritative endpoint for administrators to verify a trainee's physical attendance code
practicalRouter.post("/verify-code", async (req: Request, res: Response) => {
  const rawCode = String(req.body.code || "").trim();
  const normalized = normalizePracticalCodeInput(rawCode);
  const selectedWeekNum = req.body.weekNumber !== undefined && !isNaN(Number(req.body.weekNumber))
    ? Number(req.body.weekNumber)
    : undefined;
  const cohortId = req.body.cohortId as string | undefined;

  if (!normalized) {
    return res.status(400).json({ error: "Please enter an attendance code to verify." });
  }

  const isUuid = (str: any) =>
    typeof str === "string" &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);

  try {
    // 1. O(1) Authoritative lookup in practical_codes
    let [matchedCode] = await db
      .select()
      .from(practicalCodes)
      .where(eq(practicalCodes.code, normalized));

    // 1b. If not found by exact string, check prefix variations e.g. without PRAC- or with PRAC-
    if (!matchedCode) {
      if (!normalized.startsWith("PRAC-")) {
        const withPrefix = `PRAC-${normalized}`;
        const [foundWithPrefix] = await db
          .select()
          .from(practicalCodes)
          .where(eq(practicalCodes.code, withPrefix));
        if (foundWithPrefix) matchedCode = foundWithPrefix;
      }
    }

    // 1c. Legacy checkin fallback: Did a previous checkin record this exact code?
    if (!matchedCode) {
      const [existingCheckin] = await db
        .select()
        .from(practicalCheckins)
        .where(eq(practicalCheckins.codeSubmitted, normalized));

      if (existingCheckin) {
        // Dynamically backfill into practical_codes
        const [backfilled] = await db
          .insert(practicalCodes)
          .values({
            cohortId: existingCheckin.cohortId,
            userId: existingCheckin.userId,
            groupId: existingCheckin.groupId,
            weekNumber: existingCheckin.weekNumber,
            code: normalized,
          })
          .onConflictDoUpdate({
            target: [practicalCodes.cohortId, practicalCodes.userId, practicalCodes.weekNumber],
            set: { code: normalized, updatedAt: new Date() },
          })
          .returning();
        matchedCode = backfilled;
      }
    }

    // 2. If code does not exist anywhere in database
    if (!matchedCode) {
      // Check if format hints at a specific week for helpful diagnostic feedback
      const matchWeek = normalized.match(/PRAC-W(\d+)-/);
      const hintWeek = matchWeek ? Number(matchWeek[1]) : null;

      return res.status(404).json({
        error: "Invalid attendance code",
        message: hintWeek
          ? `Code not found in system database. Trainee must generate and view their Week ${hintWeek} code in their dashboard before physical verification.`
          : `Attendance code "${rawCode}" does not exist in the system database.`,
        code: normalized,
      });
    }

    // 3. User Identity Resolution
    const trainee = await fetchUser(matchedCode.userId);
    const traineeName = trainee
      ? `${trainee.firstName} ${trainee.lastName || ""}`.trim()
      : "Trainee";

    // 4. Week Mismatch Check
    if (selectedWeekNum !== undefined && matchedCode.weekNumber !== selectedWeekNum) {
      return res.status(400).json({
        error: "Week mismatch",
        message: `⚠️ This code is registered to ${traineeName} for WEEK ${matchedCode.weekNumber}! You currently have Week ${selectedWeekNum} selected. Please select Week ${matchedCode.weekNumber} to verify.`,
        codeWeek: matchedCode.weekNumber,
        selectedWeek: selectedWeekNum,
        user: {
          id: matchedCode.userId,
          firstName: trainee?.firstName || "Trainee",
          lastName: trainee?.lastName || "",
          email: trainee?.email || "",
          cohortId: matchedCode.cohortId,
          groupId: matchedCode.groupId,
        },
      });
    }

    // 5. Idempotent check: Is user already checked in for this practical week?
    const [alreadyRecorded] = await db
      .select()
      .from(practicalCheckins)
      .where(
        and(
          eq(practicalCheckins.userId, matchedCode.userId),
          eq(practicalCheckins.weekNumber, matchedCode.weekNumber)
        )
      );

    if (alreadyRecorded) {
      return res.status(200).json({
        success: true,
        message: `Trainee ${traineeName} is ALREADY marked PRESENT for Week ${matchedCode.weekNumber} Practical Session.`,
        alreadyCheckedIn: true,
        checkin: alreadyRecorded,
        user: {
          id: matchedCode.userId,
          firstName: trainee?.firstName || "Trainee",
          lastName: trainee?.lastName || "",
          email: trainee?.email || "",
          cohortId: matchedCode.cohortId,
          groupId: matchedCode.groupId,
        },
      });
    }

    // 6. Record verified practical attendance
    const headerAdminId = req.headers["x-user-id"] as string | undefined;
    const verifiedBy = isUuid(headerAdminId) ? headerAdminId : null;

    if (!isUuid(matchedCode.userId)) {
      return res.status(400).json({ error: "Invalid user ID associated with code (must be UUID)" });
    }

    let targetCohortId = matchedCode.cohortId;
    if (!isUuid(targetCohortId)) {
      if (cohortId && isUuid(cohortId)) {
        targetCohortId = cohortId;
      } else {
        targetCohortId = "00000000-0000-0000-0000-000000000000";
      }
    }

    const [newCheckin] = await db
      .insert(practicalCheckins)
      .values({
        cohortId: targetCohortId,
        userId: matchedCode.userId,
        groupId: matchedCode.groupId || null,
        weekNumber: matchedCode.weekNumber,
        codeSubmitted: matchedCode.code,
        verifiedBy,
      })
      .onConflictDoNothing()
      .returning();

    const resultCheckin = newCheckin || (await db
      .select()
      .from(practicalCheckins)
      .where(
        and(
          eq(practicalCheckins.cohortId, targetCohortId),
          eq(practicalCheckins.userId, matchedCode.userId),
          eq(practicalCheckins.weekNumber, matchedCode.weekNumber)
        )
      )
      .then((r) => r[0]));

    return res.status(200).json({
      success: true,
      message: newCheckin
        ? `✅ Verified! ${traineeName} marked PRESENT for Week ${matchedCode.weekNumber} Practical Session!`
        : `Trainee ${traineeName} is ALREADY marked PRESENT for Week ${matchedCode.weekNumber} Practical Session.`,
      alreadyCheckedIn: !newCheckin,
      checkin: resultCheckin,
      user: {
        id: matchedCode.userId,
        firstName: trainee?.firstName || "Trainee",
        lastName: trainee?.lastName || "",
        email: trainee?.email || "",
        cohortId: matchedCode.cohortId,
        groupId: matchedCode.groupId,
      },
    });
  } catch (err) {
    console.error("Authoritative practical verify-code error:", err);
    return res.status(500).json({ error: "Failed to verify attendance code" });
  }
});

// ─────────────────────────────────────────────
// APPEALS ROUTER (Exam Score & Week 12 Physical Attendance)
// ─────────────────────────────────────────────

// GET /lms/appeals — list appeals with filters
appealsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { cohortId, userId, appealType, status } = req.query;
    const headerUserId = req.headers["x-user-id"] as string | undefined;
    const headerUserRole = req.headers["x-user-role"] as string | undefined;

    const conditions: any[] = [];

    // If student/trainee, enforce viewing only their own appeals
    const isStaff = headerUserRole && ["admin", "sub_admin", "trainer", "lead_trainer"].includes(headerUserRole);
    if (!isStaff && headerUserId) {
      conditions.push(eq(appeals.userId, headerUserId));
    } else if (userId && typeof userId === "string") {
      conditions.push(eq(appeals.userId, userId));
    }

    if (cohortId && typeof cohortId === "string") {
      conditions.push(eq(appeals.cohortId, cohortId));
    }
    if (appealType && typeof appealType === "string") {
      conditions.push(eq(appeals.appealType, appealType as any));
    }
    if (status && typeof status === "string") {
      conditions.push(eq(appeals.status, status as any));
    }

    let query = db.select().from(appeals);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    const list = await query.orderBy(desc(appeals.createdAt));
    return res.json(list);
  } catch (err) {
    console.error("[appealsRouter GET /] error:", err);
    return res.status(500).json({ error: "Failed to fetch appeals" });
  }
});

// GET /lms/appeals/user/:userId — trainee's appeals
appealsRouter.get("/user/:userId", async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const list = await db
      .select()
      .from(appeals)
      .where(eq(appeals.userId, userId))
      .orderBy(desc(appeals.createdAt));
    return res.json(list);
  } catch (err) {
    console.error("[appealsRouter GET /user/:userId] error:", err);
    return res.status(500).json({ error: "Failed to fetch user appeals" });
  }
});

// GET /lms/appeals/:id — single appeal
appealsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const [record] = await db
      .select()
      .from(appeals)
      .where(eq(appeals.id, req.params.id))
      .limit(1);

    if (!record) return res.status(404).json({ error: "Appeal not found" });
    return res.json(record);
  } catch (err) {
    console.error("[appealsRouter GET /:id] error:", err);
    return res.status(500).json({ error: "Failed to fetch appeal" });
  }
});

// POST /lms/appeals — submit a new appeal
appealsRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    userId: z.string().uuid().optional(),
    userName: z.string().min(1),
    userEmail: z.string().email(),
    cohortId: z.string().uuid().optional().nullable(),
    appealType: z.enum(["exam_score", "week12_attendance"]),
    sessionId: z.string().uuid().optional().nullable(),
    score: z.number().optional().nullable(),
    daysAttended: z.number().int().min(1).max(5).optional().nullable(),
    reason: z.string().min(5),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const headerUserId = req.headers["x-user-id"] as string | undefined;
  const effectiveUserId = headerUserId || parsed.data.userId;

  if (!effectiveUserId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const [inserted] = await db
      .insert(appeals)
      .values({
        userId: effectiveUserId,
        userName: parsed.data.userName,
        userEmail: parsed.data.userEmail,
        cohortId: parsed.data.cohortId || null,
        appealType: parsed.data.appealType,
        sessionId: parsed.data.sessionId || null,
        score: parsed.data.score !== undefined ? parsed.data.score : null,
        daysAttended: parsed.data.daysAttended || null,
        reason: parsed.data.reason,
        status: "pending",
      })
      .returning();

    return res.status(201).json({
      message: "Appeal submitted successfully",
      appeal: inserted,
    });
  } catch (err) {
    console.error("[appealsRouter POST /] error:", err);
    return res.status(500).json({ error: "Failed to submit appeal" });
  }
});

// PATCH /lms/appeals/:id — admin updates status and notes
appealsRouter.patch("/:id", async (req: Request, res: Response) => {
  const schema = z.object({
    status: z.enum(["pending", "approved", "rejected"]),
    adminNotes: z.string().optional().nullable(),
    reviewedBy: z.string().optional().nullable(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const headerUserId = req.headers["x-user-id"] as string | undefined;
  const reviewer = parsed.data.reviewedBy || headerUserId || "admin";

  try {
    const [updated] = await db
      .update(appeals)
      .set({
        status: parsed.data.status,
        adminNotes: parsed.data.adminNotes,
        reviewedBy: reviewer,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(appeals.id, req.params.id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Appeal not found" });
    }

    return res.json({
      message: `Appeal updated to ${parsed.data.status}`,
      appeal: updated,
    });
  } catch (err) {
    console.error("[appealsRouter PATCH /:id] error:", err);
    return res.status(500).json({ error: "Failed to update appeal" });
  }
});

// ─────────────────────────────────────────────
// HELPER — recalculate and sync exam totalMarks
// Called after any question create/update/delete
// ─────────────────────────────────────────────
async function syncExamTotalMarks(examId: string) {
  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${examQuestions.marks}), 0)` })
    .from(examQuestions)
    .where(eq(examQuestions.examId, examId));
 
  await db
    .update(exams)
    .set({ totalMarks: result[0].total, updatedAt: new Date() })
    .where(eq(exams.id, examId));
}
 
// ─────────────────────────────────────────────
// HELPER — auto-score MCQ answers and write
// marksAwarded + isCorrect to exam_answers rows.
// Returns the total MCQ score for the session.
// ─────────────────────────────────────────────
async function scoreMcqAnswers(sessionId: string): Promise<number> {
  // Fetch all answers for this session that belong to MCQ questions
  const rows = await db
    .select({
      answerId: examAnswers.id,
      answerText: examAnswers.answerText,
      correctOptionIndex: examQuestions.correctOptionIndex,
      marks: examQuestions.marks,
      type: examQuestions.type,
    })
    .from(examAnswers)
    .innerJoin(examQuestions, eq(examAnswers.questionId, examQuestions.id))
    .where(eq(examAnswers.sessionId, sessionId));
 
  let mcqScore = 0;
 
  for (const row of rows) {
    if (row.type !== "mcq") continue;
 
    const selectedIndex =
      row.answerText !== null ? parseInt(row.answerText, 10) : null;
    const isCorrect =
      selectedIndex !== null && selectedIndex === row.correctOptionIndex;
    const marksAwarded = isCorrect ? row.marks : 0;
 
    await db
      .update(examAnswers)
      .set({ isCorrect, marksAwarded, updatedAt: new Date() })
      .where(eq(examAnswers.id, row.answerId));
 
    mcqScore += marksAwarded;
  }
 
  return mcqScore;
}
 
// ─────────────────────────────────────────────
// HELPER — check if all short/essay answers are
// marked, and if so, finalize the session score
// ─────────────────────────────────────────────
async function tryFinalizeScore(sessionId: string) {
  const pending = await db
    .select({ id: examAnswers.id })
    .from(examAnswers)
    .innerJoin(examQuestions, eq(examAnswers.questionId, examQuestions.id))
    .where(
      and(
        eq(examAnswers.sessionId, sessionId),
        // short_answer or essay with no marks yet
        isNull(examAnswers.marksAwarded),
        sql`${examQuestions.type} IN ('short_answer', 'essay')`
      )
    )
    .limit(1);
 
  if (pending.length > 0) return; // still unmarked answers — do nothing
 
  // All marked — sum everything
  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${examAnswers.marksAwarded}), 0)`,
    })
    .from(examAnswers)
    .where(eq(examAnswers.sessionId, sessionId));
 
  await db
    .update(examSessions)
    .set({
      score: result[0].total,
      isFullyMarked: true,
      updatedAt: new Date(),
    })
    .where(eq(examSessions.id, sessionId));
}

// ─────────────────────────────────────────────
// HELPER — Deterministic seeded question shuffle
// Ensures different trainees receive differently arranged questions,
// while remaining strictly consistent across reloads for the same user/session.
// ─────────────────────────────────────────────
function shuffleSeeded<T>(items: T[], seedStr: string): T[] {
  const result = [...items];
  if (result.length <= 1) return result;

  // 32-bit FNV-1a hash of seed string
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619) >>> 0;
  }

  // Mulberry32 PRNG
  function prng() {
    let t = (h += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Fisher-Yates shuffle
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }

  return result;
}

// ═════════════════════════════════════════════
// ADMIN — EXAM MANAGEMENT
// ═════════════════════════════════════════════

// GET /lms/exams?cohortId=&showAll=true
// showAll=true → include unpublished (admin use)
examsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { cohortId, showAll } = req.query;
    const includeAll = showAll === "true";
    const filters: any[] = [];

    if (cohortId) filters.push(eq(exams.cohortId, cohortId as string));
    if (!includeAll) {
      filters.push(eq(exams.isPublished, true));
      filters.push(or(eq(exams.isActive, true), isNull(exams.isActive)));
    }

    let query = db.select().from(exams);
    if (filters.length > 0) {
      query = query.where(and(...filters)) as typeof query;
    }

    let all = await query.orderBy(exams.createdAt);

    // Trainee portal fallback: if a specific cohortId was queried but returned 0 published exams,
    // fallback to returning all published active exams. This ensures trainees are not blocked if
    // exams were published under the main cohort or if trainee profile cohortId is mismatched.
    if (!includeAll && cohortId && all.length === 0) {
      all = await db
        .select()
        .from(exams)
        .where(
          and(
            eq(exams.isPublished, true),
            or(eq(exams.isActive, true), isNull(exams.isActive))
          )
        )
        .orderBy(exams.createdAt);
    }

    return res.json(all);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch exams" });
  }
});
 
// ADMIN — list all exam sessions with exam title
// GET /lms/exams/admin/sessions (Must be defined BEFORE /:id to prevent route collision)
examsRouter.get("/admin/sessions", async (req: Request, res: Response) => {
  const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const userIdFilter = req.query.userId as string | undefined;
  const examIdFilter = req.query.examId as string | undefined;
  const statusFilter = req.query.status as string | undefined;

  try {
    const filters: any[] = [];
    if (userIdFilter) {
      filters.push(eq(examSessions.userId, userIdFilter));
    }
    if (examIdFilter) {
      filters.push(eq(examSessions.examId, examIdFilter));
    }
    if (statusFilter) {
      filters.push(eq(examSessions.status, statusFilter as any));
    }

    let baseQuery = db
      .select({
        sessionId: examSessions.id,
        userId: examSessions.userId,
        examId: examSessions.examId,
        status: examSessions.status,
        mcqScore: examSessions.mcqScore,
        score: examSessions.score,
        submittedAt: examSessions.submittedAt,
        startedAt: examSessions.startedAt,
        isFullyMarked: examSessions.isFullyMarked,
        examTitle: exams.title,
      })
      .from(examSessions)
      .innerJoin(exams, eq(examSessions.examId, exams.id));

    if (filters.length > 0) {
      baseQuery = baseQuery.where(and(...filters)) as typeof baseQuery;
    }

    const orderedQuery = baseQuery.orderBy(desc(examSessions.createdAt));

    if (page || limit) {
      const pageNum = page && page > 0 ? page : 1;
      const limitNum = limit && limit > 0 ? limit : 25;
      const offsetNum = (pageNum - 1) * limitNum;

      let countQuery = db
        .select({
          sessionId: examSessions.id,
        })
        .from(examSessions);

      if (filters.length > 0) {
        countQuery = countQuery.where(and(...filters)) as typeof countQuery;
      }

      const [allMatched, paginated] = await Promise.all([
        countQuery,
        orderedQuery.limit(limitNum).offset(offsetNum),
      ]);

      const total = allMatched.length;
      return res.json({
        data: paginated,
        sessions: paginated,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      });
    }

    const all = await orderedQuery;
    return res.json(all);
  } catch (err) {
    console.error("[examsRouter GET /admin/sessions] error:", err);
    return res.status(500).json({ error: "Failed to fetch admin exam sessions" });
  }
});

// ADMIN — get all exam sessions for a specific user
// GET /lms/exams/admin/user/:userId/sessions
examsRouter.get("/admin/user/:userId/sessions", async (req: Request, res: Response) => {
  if (!isStaffRole(req)) {
    return res.status(403).json({ error: "Unauthorized. Staff access required." });
  }
  try {
    const { userId } = req.params;
    const sessions = await db
      .select({
        sessionId: examSessions.id,
        userId: examSessions.userId,
        examId: examSessions.examId,
        status: examSessions.status,
        mcqScore: examSessions.mcqScore,
        score: examSessions.score,
        submittedAt: examSessions.submittedAt,
        startedAt: examSessions.startedAt,
        isFullyMarked: examSessions.isFullyMarked,
        examTitle: exams.title,
      })
      .from(examSessions)
      .innerJoin(exams, eq(examSessions.examId, exams.id))
      .where(eq(examSessions.userId, userId))
      .orderBy(desc(examSessions.createdAt));

    return res.json(sessions);
  } catch (err) {
    console.error("[examsRouter GET /admin/user/:userId/sessions] error:", err);
    return res.status(500).json({ error: "Failed to fetch user exam sessions" });
  }
});

// ADMIN — delete a specific exam session to allow trainee to rewrite (resets attempt)
// DELETE /lms/exams/admin/sessions/:sessionId
examsRouter.delete("/admin/sessions/:sessionId", async (req: Request, res: Response) => {
  if (!isStaffRole(req)) {
    return res.status(403).json({ error: "Unauthorized. Staff access required." });
  }
  try {
    const { sessionId } = req.params;

    // Explicitly delete dependent child records first to ensure clean cascade across any DB constraint variant
    await db.delete(examAnswers).where(eq(examAnswers.sessionId, sessionId)).catch(() => null);
    await db.delete(examViolations).where(eq(examViolations.sessionId, sessionId)).catch(() => null);

    const [deleted] = await db
      .delete(examSessions)
      .where(eq(examSessions.id, sessionId))
      .returning();

    if (!deleted) {
      return res.status(404).json({ error: "Exam session not found" });
    }

    return res.json({
      message: "Exam session deleted successfully. Trainee is eligible to rewrite the exam.",
      session: deleted,
    });
  } catch (err) {
    console.error("[examsRouter DELETE /admin/sessions/:sessionId] error:", err);
    return res.status(500).json({ error: "Failed to delete exam session" });
  }
});

// ADMIN — delete all exam sessions for a specific user and exam
// DELETE /lms/exams/admin/user/:userId/exam/:examId
examsRouter.delete("/admin/user/:userId/exam/:examId", async (req: Request, res: Response) => {
  if (!isStaffRole(req)) {
    return res.status(403).json({ error: "Unauthorized. Staff access required." });
  }
  try {
    const { userId, examId } = req.params;

    const matchedSessions = await db
      .select({ id: examSessions.id })
      .from(examSessions)
      .where(and(eq(examSessions.userId, userId), eq(examSessions.examId, examId)));

    const sessionIds = matchedSessions.map((s) => s.id);
    if (sessionIds.length > 0) {
      await db.delete(examAnswers).where(inArray(examAnswers.sessionId, sessionIds)).catch(() => null);
      await db.delete(examViolations).where(inArray(examViolations.sessionId, sessionIds)).catch(() => null);
    }

    const deleted = await db
      .delete(examSessions)
      .where(and(eq(examSessions.userId, userId), eq(examSessions.examId, examId)))
      .returning();

    return res.json({
      message: `Deleted ${deleted.length} exam session(s). Trainee can now rewrite the exam.`,
      deletedCount: deleted.length,
      sessions: deleted,
    });
  } catch (err) {
    console.error("[examsRouter DELETE /admin/user/:userId/exam/:examId] error:", err);
    return res.status(500).json({ error: "Failed to reset exam for user" });
  }
});

// GET /lms/exams/eligibility
// Trainee portal eligibility check across Weeks 1–12 physical attendance and weekly quizzes
examsRouter.get("/eligibility", async (req: Request, res: Response) => {
  const headerUserId = req.headers["x-user-id"] as string | undefined;
  const queryUserId = req.query.userId as string | undefined;
  const userId = headerUserId || queryUserId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    let cohortId = req.query.cohortId as string | undefined;
    if (!cohortId) {
      const user = await fetchUser(userId);
      cohortId = user?.cohortMembers?.[0]?.cohortId || user?.cohortId;
    }

    const attendanceCheck = await checkWeeks1To12Attendance(userId, cohortId);
    const missingQuizzes = await getMissingWeeklyQuizzes(userId, cohortId);
    const ready = attendanceCheck.isComplete && missingQuizzes.length === 0;

    return res.json({
      ready,
      attendanceComplete: attendanceCheck.isComplete,
      missingAttendanceWeeks: attendanceCheck.missingWeeks,
      attendedWeeks: attendanceCheck.attendedWeeks,
      week12AttendanceComplete: attendanceCheck.week12Complete,
      quizzesComplete: missingQuizzes.length === 0,
      missingQuizzes,
      cohortId: cohortId || null,
    });
  } catch (err) {
    console.error("[examsRouter GET /eligibility] error:", err);
    return res.status(500).json({ error: "Failed to check portal eligibility" });
  }
});

// GET /lms/exams/:id/quiz-requirements
// Weekly quizzes (Weeks 1–12) and Physical Attendance (Weeks 1–12) required before starting this exam.
examsRouter.get("/:id/quiz-requirements", async (req: Request, res: Response) => {
  const userId = req.headers["x-user-id"] as string | undefined;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const [exam] = await db.select().from(exams).where(eq(exams.id, req.params.id)).limit(1);
    if (!exam) return res.status(404).json({ error: "Exam not found" });

    const attendanceCheck = await checkWeeks1To12Attendance(userId, exam.cohortId);
    const missingQuizzes = await getMissingWeeklyQuizzes(userId, exam.cohortId);
    const ready = attendanceCheck.isComplete && missingQuizzes.length === 0;

    // Check if user has already taken or started this exam (strict 1-attempt policy)
    const [existingSession] = await db
      .select({
        id: examSessions.id,
        status: examSessions.status,
        submittedAt: examSessions.submittedAt,
        score: examSessions.score,
        mcqScore: examSessions.mcqScore,
        isFullyMarked: examSessions.isFullyMarked,
      })
      .from(examSessions)
      .where(
        and(
          eq(examSessions.userId, userId),
          eq(examSessions.examId, exam.id)
        )
      )
      .limit(1);

    const alreadyTaken = Boolean(
      existingSession && existingSession.status !== "in_progress"
    );

    return res.json({
      ready,
      attendanceComplete: attendanceCheck.isComplete,
      missingAttendanceWeeks: attendanceCheck.missingWeeks,
      attendedWeeks: attendanceCheck.attendedWeeks,
      week12AttendanceComplete: attendanceCheck.week12Complete,
      quizzesComplete: missingQuizzes.length === 0,
      missingQuizzes,
      existingSession: existingSession || null,
      alreadyTaken,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to check quiz requirements" });
  }
});

// GET /lms/exams/:id
examsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const [exam] = await db
      .select()
      .from(exams)
      .where(eq(exams.id, req.params.id))
      .limit(1);
    if (!exam) return res.status(404).json({ error: "Exam not found" });
    return res.json(exam);
  } catch {
    return res.status(500).json({ error: "Failed to fetch exam" });
  }
});
 
// POST /lms/exams — admin creates exam
examsRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    cohortId: z.string().uuid(),
    title: z.string().min(1),
    description: z.string().optional(),
    durationMinutes: z.number().int().positive().default(60),
    createdBy: z.string().uuid(),
    isPublished: z.boolean().optional().default(false),
    isActive: z.boolean().optional().default(true),
  });
 
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });
 
  try {
    const [exam] = await db
      .insert(exams)
      .values({
        ...parsed.data,
        isActive: parsed.data.isActive ?? true,
        totalMarks: 0,
      })
      .returning();
    return res.status(201).json(exam);
  } catch {
    return res.status(500).json({ error: "Failed to create exam" });
  }
});
 
// PATCH /lms/exams/:id — admin updates/publishes exam
examsRouter.patch("/:id", async (req: Request, res: Response) => {
  const schema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    durationMinutes: z.number().int().positive().optional(),
    isPublished: z.boolean().optional(),
    isActive: z.boolean().optional(),
  });
 
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });
 
  try {
    const updateData: any = { ...parsed.data, updatedAt: new Date() };
    if (parsed.data.isPublished === true && parsed.data.isActive === undefined) {
      updateData.isActive = true;
    }
    const [updated] = await db
      .update(exams)
      .set(updateData)
      .where(eq(exams.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Exam not found" });
    return res.json(updated);
  } catch {
    return res.status(500).json({ error: "Failed to update exam" });
  }
});
 
// ═════════════════════════════════════════════
// ADMIN — QUESTION BUILDER
// ═════════════════════════════════════════════
 
// GET /lms/exams/:id/questions
// Returns questions. For trainees (taking exam), correctOptionIndex is stripped.
// Pass ?admin=true to get full data.
examsRouter.get("/:id/questions", async (req: Request, res: Response) => {
  try {
    const isStaff = isStaffRole(req);

    const questions = await db
      .select()
      .from(examQuestions)
      .where(eq(examQuestions.examId, req.params.id))
      .orderBy(examQuestions.orderIndex);

    // Normalize options to always be string[]
    const normalized = questions.map((q) => {
      let safeOptions: string[] = [];
      if (Array.isArray(q.options)) {
        safeOptions = q.options as string[];
      } else if (typeof q.options === "string") {
        try {
          const parsed = JSON.parse(q.options);
          if (Array.isArray(parsed)) safeOptions = parsed;
        } catch {}
      }
      return {
        ...q,
        options: safeOptions,
      };
    });

    // Strip correct answer from trainee-facing responses
    const sanitized = isStaff
      ? normalized
      : normalized.map(({ correctOptionIndex: _stripped, ...q }) => q);

    // Preserve orderIndex for admins/staff; shuffle deterministically per-trainee for examinees
    if (!isStaff) {
      const headerUserId = req.headers["x-user-id"] as string | undefined;
      const queryUserId = req.query.userId as string | undefined;
      const traineeId = headerUserId || queryUserId;
      if (traineeId) {
        return res.json(shuffleSeeded(sanitized, `${traineeId}-${req.params.id}`));
      }
    }

    return res.json(sanitized);
  } catch {
    return res.status(500).json({ error: "Failed to fetch questions" });
  }
});
 
// POST /lms/exams/:id/questions — add a question
examsRouter.post("/:id/questions", async (req: Request, res: Response) => {
  if (!isStaffRole(req)) {
    return res.status(403).json({ error: "Unauthorized. Staff access required." });
  }
  const schema = z
    .object({
      type: z.enum(["mcq", "short_answer", "essay"]),
      questionText: z.string().min(1),
      options: z.array(z.string()).optional(),
      correctOptionIndex: z.number().int().min(0).optional(),
      marks: z.number().int().positive().default(1),
      orderIndex: z.number().int().min(0).default(0),
    })
    .refine(
      (data) => {
        // MCQ must have options and a correct answer
        if (data.type === "mcq") {
          return (
            Array.isArray(data.options) &&
            data.options.length >= 2 &&
            data.correctOptionIndex !== undefined
          );
        }
        return true;
      },
      {
        message:
          "MCQ questions require options (min 2) and correctOptionIndex",
      }
    );
 
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });
 
  // Confirm exam exists
  const [exam] = await db
    .select()
    .from(exams)
    .where(eq(exams.id, req.params.id))
    .limit(1);
  if (!exam) return res.status(404).json({ error: "Exam not found" });
 
  try {
    const [question] = await db
      .insert(examQuestions)
      .values({ ...parsed.data, examId: req.params.id })
      .returning();
 
    // Keep totalMarks in sync
    await syncExamTotalMarks(req.params.id);
 
    return res.status(201).json(question);
  } catch {
    return res.status(500).json({ error: "Failed to create question" });
  }
});
 
// PATCH /lms/exams/questions/:questionId — edit a question
examsRouter.patch(
  "/questions/:questionId",
  async (req: Request, res: Response) => {
    if (!isStaffRole(req)) {
      return res.status(403).json({ error: "Unauthorized. Staff access required." });
    }
    const schema = z.object({
      questionText: z.string().min(1).optional(),
      options: z.array(z.string()).optional(),
      correctOptionIndex: z.number().int().min(0).optional(),
      marks: z.number().int().positive().optional(),
      orderIndex: z.number().int().min(0).optional(),
    });
 
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });
 
    try {
      const [updated] = await db
        .update(examQuestions)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(examQuestions.id, req.params.questionId))
        .returning();
 
      if (!updated)
        return res.status(404).json({ error: "Question not found" });
 
      await syncExamTotalMarks(updated.examId);
 
      return res.json(updated);
    } catch {
      return res.status(500).json({ error: "Failed to update question" });
    }
  }
);
 
// DELETE /lms/exams/questions/:questionId
examsRouter.delete(
  "/questions/:questionId",
  async (req: Request, res: Response) => {
    if (!isStaffRole(req)) {
      return res.status(403).json({ error: "Unauthorized. Staff access required." });
    }
    try {
      const [deleted] = await db
        .delete(examQuestions)
        .where(eq(examQuestions.id, req.params.questionId))
        .returning();
 
      if (!deleted)
        return res.status(404).json({ error: "Question not found" });
 
      await syncExamTotalMarks(deleted.examId);
 
      return res.json({ message: "Question deleted" });
    } catch {
      return res.status(500).json({ error: "Failed to delete question" });
    }
  }
);
 
// ═════════════════════════════════════════════
// TRAINEE — EXAM SESSION
// ═════════════════════════════════════════════
 
// POST /lms/exams/:id/sessions/start
// Creates a new session. Blocks if a completed session already exists.
examsRouter.post(
  "/:id/sessions/start",
  async (req: Request, res: Response) => {
    const schema = z.object({
      userId: z.string().uuid().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const headerUserId = req.headers["x-user-id"] as string | undefined;
    const userId = headerUserId || parsed.data.userId;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const examId = req.params.id;

    try {
      const [exam] = await db
        .select()
        .from(exams)
        .where(and(eq(exams.id, examId), eq(exams.isPublished, true)))
        .limit(1);

      if (!exam)
        return res.status(404).json({ error: "Exam not found or not published" });

      const attendanceCheck = await checkWeeks1To12Attendance(userId, exam.cohortId);
      if (!attendanceCheck.isComplete) {
        return res.status(403).json({
          error: `Physical practical attendance for Weeks 1–12 must be complete before taking this exam. Missing attendance for Week(s): ${attendanceCheck.missingWeeks.join(", ")}.`,
          code: "ATTENDANCE_INCOMPLETE",
          missingAttendanceWeeks: attendanceCheck.missingWeeks,
          attendedWeeks: attendanceCheck.attendedWeeks,
        });
      }
 
      // Session lock — check for any existing session for this user+exam
      const [existing] = await db
        .select()
        .from(examSessions)
        .where(
          and(
            eq(examSessions.userId, userId),
            eq(examSessions.examId, examId)
          )
        )
        .limit(1);
 
      if (existing) {
        // Allow re-entry only if still in_progress and not past deadline
        if (existing.status === "in_progress") {
          const now = new Date();
          if (now > existing.deadlineAt) {
            // Deadline passed server-side — auto-submit and block
            await db
              .update(examSessions)
              .set({
                status: "timed_out",
                submittedAt: now,
                updatedAt: now,
              })
              .where(eq(examSessions.id, existing.id));
 
            return res
              .status(403)
              .json({ error: "Your exam time has expired." });
          }
 
          // Resume in-progress session
          const questions = await db
            .select()
            .from(examQuestions)
            .where(eq(examQuestions.examId, examId))
            .orderBy(examQuestions.orderIndex);

          const answers = await db
            .select()
            .from(examAnswers)
            .where(eq(examAnswers.sessionId, existing.id));

          const sanitizedQuestions = questions.map(
            ({ correctOptionIndex: _stripped, ...q }) => {
              let safeOptions: string[] = [];
              if (Array.isArray(q.options)) {
                safeOptions = q.options as string[];
              } else if (typeof q.options === "string") {
                try {
                  const parsed = JSON.parse(q.options);
                  if (Array.isArray(parsed)) safeOptions = parsed;
                } catch {}
              }
              return {
                ...q,
                options: safeOptions,
              };
            }
          );
          const shuffledQuestions = shuffleSeeded(
            sanitizedQuestions,
            `${existing.id}-${existing.userId}`
          );

          return res.json({
            session: existing,
            questions: shuffledQuestions,
            savedAnswers: answers,
            resumed: true,
          });
        }
 
        // Already submitted/auto-submitted/timed-out — strictly 1 attempt allowed
        return res.status(409).json({
          error: "You have already taken this exam. Each exam can only be taken once.",
          code: "EXAM_ALREADY_TAKEN",
          status: existing.status,
          sessionId: existing.id,
        });
      }
 
      // Pre-verify that questions actually exist for this exam before creating a session!
      // This prevents locking trainees into an empty exam session if admin hasn't added questions yet.
      const questions = await db
        .select()
        .from(examQuestions)
        .where(eq(examQuestions.examId, examId))
        .orderBy(examQuestions.orderIndex);

      if (!questions || questions.length === 0) {
        return res.status(400).json({
          error: "No questions have been configured for this exam yet. Please notify your administrator.",
          code: "NO_QUESTIONS",
        });
      }

      // Every unlocked weekly quiz (Weeks 1–12) must be taken before a new exam session starts
      const missingQuizzes = await getMissingWeeklyQuizzes(userId, exam.cohortId);
      if (missingQuizzes.length > 0) {
        const list = missingQuizzes.map((q) => `Week ${q.weekNumber}: ${q.quizTitle}`).join(", ");
        return res.status(403).json({
          error: `All weekly quizzes (Weeks 1–12) must be completed before taking this exam. Missing: ${list}.`,
          code: "QUIZZES_INCOMPLETE",
          missingQuizzes,
        });
      }

      // Create new session
      const startedAt = new Date();
      const deadlineAt = new Date(
        startedAt.getTime() + exam.durationMinutes * 60 * 1000
      );
 
      const [session] = await db
        .insert(examSessions)
        .values({
          userId,
          examId,
          startedAt,
          deadlineAt,
          status: "in_progress",
        })
        .returning();
 
      // Pre-create empty answer rows for every question
      // so autosave is always an UPDATE, never an INSERT race condition
      await db.insert(examAnswers).values(
        questions.map((q) => ({
          sessionId: session.id,
          questionId: q.id,
          answerText: null,
        }))
      );
 
      const sanitizedQuestions = questions.map(
        ({ correctOptionIndex: _stripped, ...q }) => {
          let safeOptions: string[] = [];
          if (Array.isArray(q.options)) {
            safeOptions = q.options as string[];
          } else if (typeof q.options === "string") {
            try {
              const parsed = JSON.parse(q.options);
              if (Array.isArray(parsed)) safeOptions = parsed;
            } catch {}
          }
          return {
            ...q,
            options: safeOptions,
          };
        }
      );
      const shuffledQuestions = shuffleSeeded(
        sanitizedQuestions,
        `${session.id}-${session.userId}`
      );

      return res.status(201).json({
        session,
        questions: shuffledQuestions,
        savedAnswers: [],
        resumed: false,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to start exam" });
    }
  }
);
 
// PATCH /lms/exams/sessions/:sessionId/autosave
// Saves current answers every 30s. Also enforces server-side deadline.
examsRouter.patch(
  "/sessions/:sessionId/autosave",
  async (req: Request, res: Response) => {
    const schema = z.object({
      // { [questionId]: answerText }
      answers: z.record(z.string().uuid(), z.string()),
    });
 
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });
 
    try {
      const [session] = await db
        .select()
        .from(examSessions)
        .where(eq(examSessions.id, req.params.sessionId))
        .limit(1);
 
      if (!session) return res.status(404).json({ error: "Session not found" });
 
      if (session.status !== "in_progress") {
        return res
          .status(409)
          .json({ error: "Exam already submitted", status: session.status });
      }
 
      // Server-side deadline check
      if (new Date() > session.deadlineAt) {
        await db
          .update(examSessions)
          .set({ status: "timed_out", submittedAt: new Date(), updatedAt: new Date() })
          .where(eq(examSessions.id, session.id));
        return res
          .status(403)
          .json({ error: "Time expired. Exam auto-submitted." });
      }
 
      // Upsert each answer
      for (const [questionId, answerText] of Object.entries(
        parsed.data.answers
      )) {
        const [existingAns] = await db
          .select({ id: examAnswers.id })
          .from(examAnswers)
          .where(
            and(
              eq(examAnswers.sessionId, session.id),
              eq(examAnswers.questionId, questionId)
            )
          )
          .limit(1);

        if (existingAns) {
          await db
            .update(examAnswers)
            .set({ answerText, updatedAt: new Date() })
            .where(eq(examAnswers.id, existingAns.id));
        } else {
          await db.insert(examAnswers).values({
            sessionId: session.id,
            questionId,
            answerText,
          });
        }
      }
 
      await db
        .update(examSessions)
        .set({ updatedAt: new Date() })
        .where(eq(examSessions.id, session.id));
 
      return res.json({ message: "Saved" });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to autosave" });
    }
  }
);
 
// POST /lms/exams/sessions/:sessionId/submit
// Final submit. Scores MCQ, sets mcqScore, leaves short/essay pending.
examsRouter.post(
  "/sessions/:sessionId/submit",
  async (req: Request, res: Response) => {
    const schema = z.object({
      // Final answers batch — same shape as autosave
      answers: z.record(z.string().uuid(), z.string()).optional(),
    });
 
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });
 
    try {
      const [session] = await db
        .select()
        .from(examSessions)
        .where(eq(examSessions.id, req.params.sessionId))
        .limit(1);
 
      if (!session) return res.status(404).json({ error: "Session not found" });
 
      if (session.status !== "in_progress") {
        return res
          .status(409)
          .json({ error: "Exam already submitted", status: session.status });
      }
 
      const now = new Date();
      const timedOut = now > session.deadlineAt;
 
      // Flush any final answers first
      if (parsed.data.answers) {
        for (const [questionId, answerText] of Object.entries(
          parsed.data.answers
        )) {
          await db
            .update(examAnswers)
            .set({ answerText, updatedAt: now })
            .where(
              and(
                eq(examAnswers.sessionId, session.id),
                eq(examAnswers.questionId, questionId)
              )
            );
        }
      }
 
      // Auto-score MCQ
      const mcqScore = await scoreMcqAnswers(session.id);
 
      // Determine if there are any short/essay questions
      const pendingCount = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(examAnswers)
        .innerJoin(examQuestions, eq(examAnswers.questionId, examQuestions.id))
        .where(
          and(
            eq(examAnswers.sessionId, session.id),
            sql`${examQuestions.type} IN ('short_answer', 'essay')`
          )
        );
 
      const hasPending = Number(pendingCount[0].count) > 0;
 
      const [updated] = await db
        .update(examSessions)
        .set({
          status: timedOut ? "timed_out" : "submitted",
          submittedAt: now,
          mcqScore,
          // If no short/essay questions, fully marked immediately
          score: hasPending ? null : mcqScore,
          isFullyMarked: !hasPending,
          updatedAt: now,
        })
        .where(eq(examSessions.id, session.id))
        .returning();
 
      // Publish event
      const user = await fetchUser(session.userId);
      await publishEvent("exam.submitted", {
        userId: session.userId,
        examId: session.examId,
        sessionId: session.id,
        mcqScore,
        hasPending,
        timedOut,
        email: user?.email ?? null,
        firstName: user?.firstName ?? null,
      });
 
      return res.json({
        session: updated,
        mcqScore,
        pendingMarks: hasPending,
        message: hasPending
          ? `Exam submitted. MCQ score: ${mcqScore}. Short answer / essay marks pending admin review.`
          : `Exam submitted. Your score: ${mcqScore}.`,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to submit exam" });
    }
  }
);
 
// POST /lms/exams/sessions/:sessionId/violations
// Records a violation. Auto-submits if violationCount reaches 3.
examsRouter.post(
  "/sessions/:sessionId/violations",
  async (req: Request, res: Response) => {
    const schema = z.object({
      type: z.enum(["tab_switch", "fullscreen_exit", "devtools", "copy_paste"]),
    });
 
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });
 
    try {
      const [session] = await db
        .select()
        .from(examSessions)
        .where(eq(examSessions.id, req.params.sessionId))
        .limit(1);
 
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.status !== "in_progress") {
        return res.json({ message: "Session already closed" });
      }
 
      // Log the violation
      await db
        .insert(examViolations)
        .values({ sessionId: session.id, type: parsed.data.type });
 
      const newCount = session.violationCount + 1;
 
      await db
        .update(examSessions)
        .set({ violationCount: newCount, updatedAt: new Date() })
        .where(eq(examSessions.id, session.id));
 
      // Auto-submit at 3 violations
      if (newCount >= 3) {
        const mcqScore = await scoreMcqAnswers(session.id);
 
        const pendingCount = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(examAnswers)
          .innerJoin(
            examQuestions,
            eq(examAnswers.questionId, examQuestions.id)
          )
          .where(
            and(
              eq(examAnswers.sessionId, session.id),
              sql`${examQuestions.type} IN ('short_answer', 'essay')`
            )
          );
 
        const hasPending = Number(pendingCount[0].count) > 0;
        const now = new Date();
 
        await db
          .update(examSessions)
          .set({
            status: "auto_submitted",
            submittedAt: now,
            mcqScore,
            score: hasPending ? null : mcqScore,
            isFullyMarked: !hasPending,
            updatedAt: now,
          })
          .where(eq(examSessions.id, session.id));
 
        const user = await fetchUser(session.userId);
        await publishEvent("exam.auto_submitted", {
          userId: session.userId,
          examId: session.examId,
          sessionId: session.id,
          reason: "violation_limit",
          violationCount: newCount,
          email: user?.email ?? null,
          firstName: user?.firstName ?? null,
        });
 
        return res.json({
          autoSubmitted: true,
          violationCount: newCount,
          message: "Exam auto-submitted due to repeated violations.",
        });
      }
 
      return res.json({
        autoSubmitted: false,
        violationCount: newCount,
        remaining: 3 - newCount,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to log violation" });
    }
  }
);
 
// ═════════════════════════════════════════════
// TRAINEE — RESULT
// ═════════════════════════════════════════════
 
// GET /lms/exams/sessions/:sessionId/result
// Returns score breakdown visible to trainee post-submit
examsRouter.get(
  "/sessions/:sessionId/result",
  async (req: Request, res: Response) => {
    try {
      const [session] = await db
        .select()
        .from(examSessions)
        .where(eq(examSessions.id, req.params.sessionId))
        .limit(1);
 
      if (!session) return res.status(404).json({ error: "Session not found" });
 
      if (session.status === "in_progress") {
        return res.status(403).json({ error: "Exam not yet submitted" });
      }
 
      // Count pending (unmarked) short/essay answers
      const pendingRows = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(examAnswers)
        .innerJoin(examQuestions, eq(examAnswers.questionId, examQuestions.id))
        .where(
          and(
            eq(examAnswers.sessionId, session.id),
            isNull(examAnswers.marksAwarded),
            sql`${examQuestions.type} IN ('short_answer', 'essay')`
          )
        );
 
      const pendingCount = Number(pendingRows[0].count);
 
      return res.json({
        sessionId: session.id,
        status: session.status,
        mcqScore: session.mcqScore,
        finalScore: session.isFullyMarked ? session.score : null,
        isFullyMarked: session.isFullyMarked,
        pendingMarksCount: pendingCount,
        violationCount: session.violationCount,
        submittedAt: session.submittedAt,
      });
    } catch {
      return res.status(500).json({ error: "Failed to fetch result" });
    }
  }
);
 
// ═════════════════════════════════════════════
// ADMIN — SUBMISSIONS & MARKING
// ═════════════════════════════════════════════
 
// GET /lms/exams/:id/sessions — admin lists all sessions for an exam
// Optional ?status=submitted|auto_submitted|timed_out|in_progress
examsRouter.get("/:id/sessions", async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
 
    const sessions = await db
      .select()
      .from(examSessions)
      .where(
        status
          ? and(
              eq(examSessions.examId, req.params.id),
              eq(
                examSessions.status,
                status as "submitted" | "auto_submitted" | "timed_out" | "in_progress"
              )
            )
          : eq(examSessions.examId, req.params.id)
      )
      .orderBy(examSessions.submittedAt);
    return res.json(sessions);
  } catch {
    return res.status(500).json({ error: "Failed to fetch sessions" });
  }
});
 
// GET /lms/exams/sessions/:sessionId/answers — admin marking view
// Returns all answers with question text + current marks
examsRouter.get(
  "/sessions/:sessionId/answers",
  async (req: Request, res: Response) => {
    if (!isStaffRole(req)) {
      return res.status(403).json({ error: "Unauthorized. Staff access required." });
    }
    try {
      const rows = await db
        .select({
          answerId: examAnswers.id,
          questionId: examQuestions.id,
          type: examQuestions.type,
          questionText: examQuestions.questionText,
          options: examQuestions.options,
          correctOptionIndex: examQuestions.correctOptionIndex,
          maxMarks: examQuestions.marks,
          orderIndex: examQuestions.orderIndex,
          answerText: examAnswers.answerText,
          isCorrect: examAnswers.isCorrect,
          marksAwarded: examAnswers.marksAwarded,
          markedBy: examAnswers.markedBy,
          markedAt: examAnswers.markedAt,
        })
        .from(examAnswers)
        .innerJoin(examQuestions, eq(examAnswers.questionId, examQuestions.id))
        .where(eq(examAnswers.sessionId, req.params.sessionId))
        .orderBy(examQuestions.orderIndex);
 
      return res.json(rows);
    } catch {
      return res.status(500).json({ error: "Failed to fetch answers" });
    }
  }
);
 
// PATCH /lms/exams/answers/:answerId/mark — admin marks one short/essay answer
examsRouter.patch(
  "/answers/:answerId/mark",
  async (req: Request, res: Response) => {
    if (!isStaffRole(req)) {
      return res.status(403).json({ error: "Unauthorized. Staff access required." });
    }
    const schema = z.object({
      marksAwarded: z.number().int().min(0),
      markedBy: z.string().uuid(),
    });
 
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });
 
    try {
      const [answer] = await db
        .select()
        .from(examAnswers)
        .where(eq(examAnswers.id, req.params.answerId))
        .limit(1);
 
      if (!answer) return res.status(404).json({ error: "Answer not found" });
 
      // Validate marksAwarded doesn't exceed question max
      const [question] = await db
        .select()
        .from(examQuestions)
        .where(eq(examQuestions.id, answer.questionId))
        .limit(1);
 
      if (parsed.data.marksAwarded > question.marks) {
        return res.status(400).json({
          error: `marksAwarded cannot exceed question max marks (${question.marks})`,
        });
      }
 
      const [updated] = await db
        .update(examAnswers)
        .set({
          marksAwarded: parsed.data.marksAwarded,
          markedBy: parsed.data.markedBy,
          markedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(examAnswers.id, req.params.answerId))
        .returning();
 
      // Check if this was the last unmarked answer — finalize score if so
      await tryFinalizeScore(answer.sessionId);
 
      return res.json(updated);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to mark answer" });
    }
  }
);

// ─────────────────────────────────────────────
// PLATFORM VIDEO TUTORIALS
// ─────────────────────────────────────────────

let isTableCreated = false;

async function ensurePlatformTutorialsTable() {
  if (isTableCreated) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS platform_tutorials (
        id VARCHAR(128) PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        category VARCHAR(64) NOT NULL DEFAULT 'Getting Started',
        video_url TEXT NOT NULL,
        thumbnail_url TEXT,
        duration VARCHAR(32) DEFAULT '3 min',
        target_audience VARCHAR(64) NOT NULL DEFAULT 'All',
        notes JSONB,
        is_featured BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    isTableCreated = true;
  } catch (e) {
    console.warn("[lms-service] Could not ensure platform_tutorials table:", e);
  }
}

// GET /tutorials — Get all platform video tutorials
tutorialsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    await ensurePlatformTutorialsTable();
    const list = await db
      .select()
      .from(platformTutorials)
      .orderBy(desc(platformTutorials.isFeatured), desc(platformTutorials.createdAt));
    return res.json(list);
  } catch (err) {
    console.error("[lms-service] Error fetching tutorials:", err);
    return res.json([]);
  }
});

// POST /tutorials — Add new platform video tutorial
tutorialsRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    id: z.string().optional(),
    title: z.string().min(1, "Title is required"),
    description: z.string().optional().default(""),
    category: z.string().optional().default("Getting Started"),
    videoUrl: z.string().min(1, "Video URL is required"),
    thumbnailUrl: z.string().optional(),
    duration: z.string().optional().default("3 min"),
    targetAudience: z.string().optional().default("All"),
    notes: z.array(z.string()).optional().default([]),
    isFeatured: z.boolean().optional().default(false),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    await ensurePlatformTutorialsTable();
    const id = parsed.data.id || `tut_${Date.now()}`;
    const [inserted] = await db
      .insert(platformTutorials)
      .values({
        id,
        title: parsed.data.title,
        description: parsed.data.description,
        category: parsed.data.category,
        videoUrl: parsed.data.videoUrl,
        thumbnailUrl: parsed.data.thumbnailUrl,
        duration: parsed.data.duration,
        targetAudience: parsed.data.targetAudience,
        notes: parsed.data.notes,
        isFeatured: parsed.data.isFeatured,
      })
      .returning();

    return res.status(201).json(inserted);
  } catch (err) {
    console.error("[lms-service] Error creating tutorial:", err);
    return res.status(500).json({ error: "Failed to create video tutorial" });
  }
});

// PATCH /tutorials/:id — Update platform video tutorial
tutorialsRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const [existing] = await db
      .select()
      .from(platformTutorials)
      .where(eq(platformTutorials.id, req.params.id))
      .limit(1);

    if (!existing) {
      return res.status(404).json({ error: "Tutorial not found" });
    }

    const { title, description, category, videoUrl, thumbnailUrl, duration, targetAudience, notes, isFeatured } = req.body;

    const [updated] = await db
      .update(platformTutorials)
      .set({
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(category !== undefined && { category }),
        ...(videoUrl !== undefined && { videoUrl }),
        ...(thumbnailUrl !== undefined && { thumbnailUrl }),
        ...(duration !== undefined && { duration }),
        ...(targetAudience !== undefined && { targetAudience }),
        ...(notes !== undefined && { notes }),
        ...(isFeatured !== undefined && { isFeatured }),
        updatedAt: new Date(),
      })
      .where(eq(platformTutorials.id, req.params.id))
      .returning();

    return res.json(updated);
  } catch (err) {
    console.error("[lms-service] Error updating tutorial:", err);
    return res.status(500).json({ error: "Failed to update video tutorial" });
  }
});

// DELETE /tutorials/:id — Delete platform video tutorial
tutorialsRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const [deleted] = await db
      .delete(platformTutorials)
      .where(eq(platformTutorials.id, req.params.id))
      .returning();

    if (!deleted) {
      return res.status(404).json({ error: "Tutorial not found" });
    }

    return res.json({ success: true, id: deleted.id });
  } catch (err) {
    console.error("[lms-service] Error deleting tutorial:", err);
    return res.status(500).json({ error: "Failed to delete video tutorial" });
  }
});

// ─────────────────────────────────────────────
// RECOMMENDED READINGS ROUTER
// ─────────────────────────────────────────────

// GET /readings — List all readings (optional filter ?week=X, ?category=Y)
readingsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { week, category } = req.query;
    let query = db.select().from(readings);

    const conditions = [];
    if (week) {
      const parsedWeek = parseInt(week as string, 10);
      if (!isNaN(parsedWeek)) {
        conditions.push(eq(readings.recommendedWeek, parsedWeek));
      }
    }
    if (category && typeof category === "string") {
      conditions.push(eq(readings.category, category));
    }

    const rows = conditions.length > 0
      ? await query.where(and(...conditions)).orderBy(readings.recommendedWeek, desc(readings.publishedAt))
      : await query.orderBy(readings.recommendedWeek, desc(readings.publishedAt));

    return res.json(rows);
  } catch (err) {
    console.error("[lms-service] Error fetching readings:", err);
    return res.status(500).json({ error: "Failed to fetch readings" });
  }
});

// GET /readings/week/:weekNum — List readings for specific week
readingsRouter.get("/week/:weekNum", async (req: Request, res: Response) => {
  try {
    const weekNum = parseInt(req.params.weekNum, 10);
    if (isNaN(weekNum)) {
      return res.status(400).json({ error: "Invalid week number" });
    }

    const rows = await db
      .select()
      .from(readings)
      .where(eq(readings.recommendedWeek, weekNum))
      .orderBy(desc(readings.publishedAt));

    return res.json(rows);
  } catch (err) {
    console.error("[lms-service] Error fetching week readings:", err);
    return res.status(500).json({ error: "Failed to fetch week readings" });
  }
});

// GET /readings/:id — Get reading by ID
readingsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const [row] = await db
      .select()
      .from(readings)
      .where(eq(readings.id, req.params.id))
      .limit(1);

    if (!row) {
      return res.status(404).json({ error: "Reading not found" });
    }

    return res.json(row);
  } catch (err) {
    console.error("[lms-service] Error fetching reading:", err);
    return res.status(500).json({ error: "Failed to fetch reading" });
  }
});

// POST /readings — Create recommended reading (Staff only)
readingsRouter.post("/", async (req: Request, res: Response) => {
  if (!isStaffRole(req)) {
    return res.status(403).json({ error: "Unauthorized. Staff access required." });
  }

  const schema = z.object({
    id: z.string().optional(),
    recommendedWeek: z.number().int().min(1).max(20),
    title: z.string().min(1),
    subtitle: z.string().optional(),
    category: z.string().default("Livestock Management"),
    author: z.string().min(1),
    readTime: z.string().default("10 min read"),
    type: z.string().default("Article"),
    chapterReference: z.string().optional(),
    coverImage: z.string().optional(),
    summary: z.string().min(1),
    content: z.string().min(1),
    downloadUrl: z.string().optional(),
    externalUrl: z.string().optional(),
    featured: z.boolean().optional().default(false),
    publishedAt: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }

  try {
    const {
      id,
      recommendedWeek,
      title,
      subtitle,
      category,
      author,
      readTime,
      type,
      chapterReference,
      coverImage,
      summary,
      content,
      downloadUrl,
      externalUrl,
      featured,
      publishedAt,
    } = parsed.data;

    const readingId = id || `reading-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const [created] = await db
      .insert(readings)
      .values({
        id: readingId,
        recommendedWeek,
        title,
        subtitle: subtitle ?? null,
        category,
        author,
        readTime,
        type,
        chapterReference: chapterReference ?? null,
        coverImage: coverImage ?? null,
        summary,
        content,
        downloadUrl: downloadUrl ?? null,
        externalUrl: externalUrl ?? null,
        featured: featured ?? false,
        publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return res.status(201).json(created);
  } catch (err) {
    console.error("[lms-service] Error creating reading:", err);
    return res.status(500).json({ error: "Failed to create reading" });
  }
});

// PATCH /readings/:id — Update recommended reading (Staff only)
readingsRouter.patch("/:id", async (req: Request, res: Response) => {
  if (!isStaffRole(req)) {
    return res.status(403).json({ error: "Unauthorized. Staff access required." });
  }

  const schema = z.object({
    recommendedWeek: z.number().int().min(1).max(20).optional(),
    title: z.string().min(1).optional(),
    subtitle: z.string().optional().nullable(),
    category: z.string().optional(),
    author: z.string().min(1).optional(),
    readTime: z.string().optional(),
    type: z.string().optional(),
    chapterReference: z.string().optional().nullable(),
    coverImage: z.string().optional().nullable(),
    summary: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    downloadUrl: z.string().optional().nullable(),
    externalUrl: z.string().optional().nullable(),
    featured: z.boolean().optional(),
    publishedAt: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }

  try {
    const data = parsed.data;
    const [updated] = await db
      .update(readings)
      .set({
        ...(data.recommendedWeek !== undefined && { recommendedWeek: data.recommendedWeek }),
        ...(data.title !== undefined && { title: data.title }),
        ...(data.subtitle !== undefined && { subtitle: data.subtitle }),
        ...(data.category !== undefined && { category: data.category }),
        ...(data.author !== undefined && { author: data.author }),
        ...(data.readTime !== undefined && { readTime: data.readTime }),
        ...(data.type !== undefined && { type: data.type }),
        ...(data.chapterReference !== undefined && { chapterReference: data.chapterReference }),
        ...(data.coverImage !== undefined && { coverImage: data.coverImage }),
        ...(data.summary !== undefined && { summary: data.summary }),
        ...(data.content !== undefined && { content: data.content }),
        ...(data.downloadUrl !== undefined && { downloadUrl: data.downloadUrl }),
        ...(data.externalUrl !== undefined && { externalUrl: data.externalUrl }),
        ...(data.featured !== undefined && { featured: data.featured }),
        ...(data.publishedAt !== undefined && { publishedAt: new Date(data.publishedAt) }),
        updatedAt: new Date(),
      })
      .where(eq(readings.id, req.params.id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Reading not found" });
    }

    return res.json(updated);
  } catch (err) {
    console.error("[lms-service] Error updating reading:", err);
    return res.status(500).json({ error: "Failed to update reading" });
  }
});

// DELETE /readings/:id — Delete recommended reading (Staff only)
readingsRouter.delete("/:id", async (req: Request, res: Response) => {
  if (!isStaffRole(req)) {
    return res.status(403).json({ error: "Unauthorized. Staff access required." });
  }

  try {
    const [deleted] = await db
      .delete(readings)
      .where(eq(readings.id, req.params.id))
      .returning();

    if (!deleted) {
      return res.status(404).json({ error: "Reading not found" });
    }

    return res.json({ success: true, id: deleted.id });
  } catch (err) {
    console.error("[lms-service] Error deleting reading:", err);
    return res.status(500).json({ error: "Failed to delete reading" });
  }
});

// ─── Trainer Lesson Reports Router ──────────────────────────────────────────
export const trainerReportsRouter = Router();

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

// Schema for report creation / update
const reportInputSchema = z.object({
  id: z.string().uuid().optional().nullable().or(z.literal("")),
  cohortId: z.string().uuid("Invalid cohort ID"),
  cohortName: z.string().optional().nullable().or(z.literal("")),
  groupId: z.string().optional().nullable().or(z.literal("")),
  groupName: z.string().optional().nullable().or(z.literal("")),
  sessionId: z.string().uuid().optional().nullable().or(z.literal("")),
  lessonId: z.string().uuid().optional().nullable().or(z.literal("")),
  weekNumber: z.coerce.number().int().min(1, "Week number must be at least 1").max(12, "Week number cannot exceed 12").default(1),
  sessionTitle: z.string().min(2, "Session/Lesson title is required"),
  dateConducted: z.string().min(1, "Date conducted is required"),
  topicsCovered: z.string().optional().nullable().or(z.literal("")),
  activities: z.string().optional().nullable().or(z.literal("")),
  traineesPresent: z.coerce.number().int().min(0, "Trainees count cannot be negative").default(0),
  learningOutcomes: z.string().optional().nullable().or(z.literal("")),
  challenges: z.string().optional().nullable().or(z.literal("")),
  comments: z.string().optional().nullable().or(z.literal("")),
  attachmentUrl: z.string().optional().nullable().or(z.literal("")),
  attachmentName: z.string().optional().nullable().or(z.literal("")),
  action: z.enum(["draft", "submit"]).default("draft"),
});

// 1. POST /trainer-reports — Create or update lesson report
trainerReportsRouter.post(["/", ""], async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId) {
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

    // Strict validation when submitting
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
    }

    const parsedDate = new Date(data.dateConducted);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: "Invalid date format for dateConducted." });
    }

    const targetWeek = Number(data.weekNumber) || 1;
    const isTrainerRole = auth.role === "trainer";

    // Clean optional values
    if (data.id === "" || !data.id) data.id = undefined;
    const sanitizedGroupId = data.groupId?.trim() || null;
    const sanitizedCohortName = data.cohortName?.trim() || null;
    const sanitizedGroupName = data.groupName?.trim() || null;
    const sanitizedSessionId = data.sessionId?.trim() || null;
    const sanitizedLessonId = data.lessonId?.trim() || null;
    const sanitizedAttachmentUrl = data.attachmentUrl?.trim() || null;
    const sanitizedAttachmentName = data.attachmentName?.trim() || (sanitizedAttachmentUrl ? "Supporting Evidence" : null);
    const sanitizedChallenges = data.challenges?.trim() || null;
    const sanitizedComments = data.comments?.trim() || null;

    // ─── SEQUENTIAL WEEK PROGRESSION GATE ───
    // Trainers cannot conduct or submit a report for Week W > 1 unless Week W - 1 was submitted.
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

    // Auto-link existing report for the same trainer/cohort/week if id is not passed
    if (!data.id) {
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

    // Check if updating existing report
    if (data.id) {
      const [existing] = await db
        .select()
        .from(trainerLessonReports)
        .where(eq(trainerLessonReports.id, data.id))
        .limit(1);

      if (!existing) {
        return res.status(404).json({ error: "Report not found." });
      }

      // Ensure caller is the report author or admin
      const isOwner = existing.trainerId === auth.userId;
      const isAdmin = auth.role === "admin" || auth.role === "sub_admin";
      if (!isOwner && !isAdmin) {
        return res.status(403).json({ error: "Unauthorized to edit this report." });
      }

      const updatePayload: any = {
        cohortId: data.cohortId,
        sessionTitle: data.sessionTitle,
        dateConducted: parsedDate,
        topicsCovered: data.topicsCovered || "",
        activities: data.activities || "",
        traineesPresent: data.traineesPresent ?? 0,
        learningOutcomes: data.learningOutcomes || "",
        challenges: sanitizedChallenges,
        comments: sanitizedComments,
        attachmentUrl: sanitizedAttachmentUrl,
        attachmentName: sanitizedAttachmentName,
        status: isSubmit ? "submitted" : "draft",
        updatedAt: new Date(),
      };

      if (sanitizedCohortName) updatePayload.cohortName = sanitizedCohortName;
      if (sanitizedGroupId !== undefined) updatePayload.groupId = sanitizedGroupId;
      if (sanitizedGroupName) updatePayload.groupName = sanitizedGroupName;
      if (sanitizedSessionId !== undefined) updatePayload.sessionId = sanitizedSessionId;
      if (sanitizedLessonId !== undefined) updatePayload.lessonId = sanitizedLessonId;
      if (data.weekNumber !== undefined) updatePayload.weekNumber = data.weekNumber;
      if (isSubmit && !existing.submittedAt) {
        updatePayload.submittedAt = new Date();
      }

      const [updated] = await db
        .update(trainerLessonReports)
        .set(updatePayload)
        .where(eq(trainerLessonReports.id, data.id))
        .returning();

      if (isSubmit) {
        publishEvent("trainer.report.submitted", {
          reportId: updated.id,
          trainerId: updated.trainerId,
          cohortId: updated.cohortId,
          groupId: updated.groupId,
          sessionTitle: updated.sessionTitle,
          traineesPresent: updated.traineesPresent,
          submittedAt: updated.submittedAt,
        }).catch(() => {});
      }

      return res.json({
        success: true,
        message: isSubmit ? "Lesson report submitted successfully." : "Draft saved successfully.",
        report: updated,
      });
    }

    // New report insertion
    const [created] = await db
      .insert(trainerLessonReports)
      .values({
        trainerId: auth.userId,
        trainerName: auth.name || null,
        trainerEmail: auth.email || null,
        cohortId: data.cohortId,
        cohortName: sanitizedCohortName,
        groupId: sanitizedGroupId,
        groupName: sanitizedGroupName,
        sessionId: sanitizedSessionId,
        lessonId: sanitizedLessonId,
        weekNumber: data.weekNumber || null,
        sessionTitle: data.sessionTitle,
        dateConducted: parsedDate,
        topicsCovered: data.topicsCovered || "",
        activities: data.activities || "",
        traineesPresent: data.traineesPresent ?? 0,
        learningOutcomes: data.learningOutcomes || "",
        challenges: sanitizedChallenges,
        comments: sanitizedComments,
        attachmentUrl: sanitizedAttachmentUrl,
        attachmentName: sanitizedAttachmentName,
        status: isSubmit ? "submitted" : "draft",
        isDelivered: false,
        submittedAt: isSubmit ? new Date() : null,
      })
      .returning();

    if (isSubmit) {
      publishEvent("trainer.report.submitted", {
        reportId: created.id,
        trainerId: created.trainerId,
        cohortId: created.cohortId,
        groupId: created.groupId,
        sessionTitle: created.sessionTitle,
        traineesPresent: created.traineesPresent,
        submittedAt: created.submittedAt,
      }).catch(() => {});
    }

    return res.status(201).json({
      success: true,
      message: isSubmit ? "Lesson report submitted successfully." : "Draft saved successfully.",
      report: created,
    });
  } catch (err: any) {
    console.error("[lms-service] Error saving trainer report:", err);
    return res.status(500).json({ error: "Failed to save trainer report", details: err?.message });
  }
});

// 2. GET /trainer-reports/my-reports — Fetch all reports created by the logged-in trainer
trainerReportsRouter.get("/my-reports", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!auth.userId || !UUID_REGEX.test(auth.userId)) {
      return res.json({ success: true, count: 0, reports: [] });
    }

    const { cohortId, groupId, sessionId, lessonId, weekNumber, status } = req.query;

    const conditions: any[] = [eq(trainerLessonReports.trainerId, auth.userId)];

    if (cohortId && typeof cohortId === "string") {
      conditions.push(eq(trainerLessonReports.cohortId, cohortId));
    }
    if (groupId && typeof groupId === "string") {
      conditions.push(eq(trainerLessonReports.groupId, groupId));
    }
    if (sessionId && typeof sessionId === "string") {
      conditions.push(eq(trainerLessonReports.sessionId, sessionId));
    }
    if (lessonId && typeof lessonId === "string") {
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

    return res.json({ success: true, count: reports.length, reports });
  } catch (err: any) {
    console.error("[lms-service] Error fetching my reports:", err);
    return res.status(500).json({ error: "Failed to fetch reports" });
  }
});

// 3. GET /trainer-reports/admin/all — Administrator & Lead Trainer monitoring view
trainerReportsRouter.get("/admin/all", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    const isAdmin = auth.role === "admin" || auth.role === "sub_admin" || auth.role === "lead_trainer";
    if (!isAdmin) {
      return res.status(403).json({ error: "Administrator or Lead Trainer privilege required to view all trainer reports." });
    }

    const { trainerId, cohortId, groupId, weekNumber, status, isDelivered, limit, offset } = req.query;

    const conditions: any[] = [];
    if (trainerId && typeof trainerId === "string") {
      conditions.push(eq(trainerLessonReports.trainerId, trainerId));
    }

    if (cohortId && typeof cohortId === "string") {
      conditions.push(eq(trainerLessonReports.cohortId, cohortId));
    }
    if (groupId && typeof groupId === "string") {
      conditions.push(eq(trainerLessonReports.groupId, groupId));
    }
    if (weekNumber !== undefined && !isNaN(Number(weekNumber))) {
      conditions.push(eq(trainerLessonReports.weekNumber, Number(weekNumber)));
    }
    if (status && (status === "draft" || status === "submitted")) {
      conditions.push(eq(trainerLessonReports.status, status as any));
    }
    if (isDelivered !== undefined) {
      conditions.push(eq(trainerLessonReports.isDelivered, isDelivered === "true"));
    }

    const queryLimit = Math.min(Number(limit) || 100, 500);
    const queryOffset = Number(offset) || 0;

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const reports = await db
      .select()
      .from(trainerLessonReports)
      .where(whereClause)
      .orderBy(desc(trainerLessonReports.createdAt))
      .limit(queryLimit)
      .offset(queryOffset);

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

// 4. GET /trainer-reports/progression-status — Check 12-week progression and unlocked weeks
trainerReportsRouter.get("/progression-status", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const cohortId = (req.query.cohortId as string)?.trim();
    const groupId = (req.query.groupId as string)?.trim();
    const targetTrainerId =
      (auth.role === "admin" || auth.role === "sub_admin" || auth.role === "lead_trainer") && req.query.trainerId
        ? (req.query.trainerId as string).trim()
        : auth.userId;

    const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

    // Guard against invalid or missing UUIDs - return default 12-week progression safely instead of crashing
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

    // Map existing reports by weekNumber (1..12)
    const reportByWeek = new Map<number, typeof trainerLessonReports.$inferSelect>();
    for (const rep of existingReports) {
      if (rep.weekNumber && rep.weekNumber >= 1 && rep.weekNumber <= 12) {
        const curr = reportByWeek.get(rep.weekNumber);
        if (!curr || (rep.status === "submitted" && curr.status !== "submitted")) {
          reportByWeek.set(rep.weekNumber, rep);
        }
      }
    }

    // Build the 12-week progression array
    // Week 1 is always unlocked.
    // Week N (N > 1) is unlocked IF Week N-1 is submitted.
    const weeks = [];
    let maxUnlockedWeek = 1;

    for (let w = 1; w <= 12; w++) {
      const rep = reportByWeek.get(w);
      const isSubmitted = rep?.status === "submitted";
      const isDelivered = Boolean(rep?.isDelivered);
      const isDraft = rep?.status === "draft";

      const isUnlocked = w === 1 || (reportByWeek.get(w - 1)?.status === "submitted");

      if (isUnlocked && w > maxUnlockedWeek) {
        maxUnlockedWeek = w;
      }

      let weekStatus: "submitted" | "draft" | "unlocked" | "locked" = "locked";
      if (isSubmitted) {
        weekStatus = "submitted";
      } else if (isDraft) {
        weekStatus = "draft";
      } else if (isUnlocked) {
        weekStatus = "unlocked";
      } else {
        weekStatus = "locked";
      }

      weeks.push({
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

    const currentWeekItem = weeks.find((wk) => wk.isUnlocked && !wk.isSubmitted);
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
      totalSubmitted: weeks.filter((w) => w.isSubmitted).length,
      totalDelivered: weeks.filter((w) => w.isDelivered).length,
      weeks,
    });
  } catch (err: any) {
    console.error("[lms-service] Error fetching progression status:", err);
    return res.status(500).json({ error: "Failed to fetch progression status", details: err?.message });
  }
});

// 4. POST /trainer-reports/:id/mark-delivered — MANDATORY GATED DELIVERY ACTION
trainerReportsRouter.post("/:id/mark-delivered", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    if (!auth.userId) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const reportId = req.params.id;
    if (!reportId) {
      return res.status(400).json({ error: "Report ID is required." });
    }

    const [report] = await db
      .select()
      .from(trainerLessonReports)
      .where(eq(trainerLessonReports.id, reportId))
      .limit(1);

    if (!report) {
      return res.status(404).json({
        error: "Cannot mark session delivered: No report found. A submitted lesson report is strictly mandatory before marking completion.",
      });
    }

    // Permission check: only assigned trainer or staff
    const isOwner = report.trainerId === auth.userId;
    const isStaff = auth.role === "admin" || auth.role === "sub_admin" || auth.role === "lead_trainer";
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: "Unauthorized to mark delivery for this lesson report." });
    }

    // ─── STRICT GATE ENFORCEMENT ───
    if (report.status !== "submitted") {
      return res.status(400).json({
        error: "Cannot mark session as completed/delivered: The lesson report is still in 'draft' status. You must submit the report first.",
        status: report.status,
      });
    }

    if (report.isDelivered) {
      return res.json({
        success: true,
        message: "Session is already marked as completed/delivered.",
        report,
      });
    }

    const deliveredAt = new Date();
    const [updated] = await db
      .update(trainerLessonReports)
      .set({
        isDelivered: true,
        deliveredAt,
        updatedAt: deliveredAt,
      })
      .where(eq(trainerLessonReports.id, reportId))
      .returning();

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

// 5. GET /trainer-reports/:id — Fetch a single report by ID
trainerReportsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const auth = getAuthUserContext(req);
    const reportId = req.params.id;

    const [report] = await db
      .select()
      .from(trainerLessonReports)
      .where(eq(trainerLessonReports.id, reportId))
      .limit(1);

    if (!report) {
      return res.status(404).json({ error: "Report not found." });
    }

    // Only allow owner or staff
    const isOwner = auth.userId && report.trainerId === auth.userId;
    const isStaff = auth.role === "admin" || auth.role === "sub_admin" || auth.role === "lead_trainer";
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: "Unauthorized to view this report." });
    }

    return res.json({ success: true, report });
  } catch (err: any) {
    console.error("[lms-service] Error fetching report:", err);
    return res.status(500).json({ error: "Failed to fetch report" });
  }
});

 