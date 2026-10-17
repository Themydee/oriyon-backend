import { Router, Request, Response } from "express";
import { eq, and, isNull, sql, desc, inArray, lte, or, type InferModel } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { weeks, lessons, progress, physicalSessions, sessionGroups, quizzes, quizAttempts, week12Codes, week12Checkins, practicalCheckins, practicalCodes, exams, examQuestions, examSessions, examAnswers, examViolations, platformTutorials, appeals } from "../db/schema";
import { publishEvent } from "../rabbitmq";

type WeekRow = InferModel<typeof weeks>;


export const weeksRouter = Router();
export const lessonsRouter = Router();
export const progressRouter = Router();
export const sessionsRouter = Router();
export const quizzesRouter = Router();
export const examsRouter = Router();
export const tutorialsRouter = Router();
export const practicalRouter = Router();
export const appealsRouter = Router();
// ─────────────────────────────────────────────
// HELPER — fetch user from user-service
// Gets email + firstName + lastName for notifications / verification
// ─────────────────────────────────────────────
export async function fetchUser(userId: string): Promise<{ id?: string; email: string; firstName: string; lastName?: string } | null> {
  try {
    const res = await fetch(`${process.env.USER_SERVICE_URL}/users/${userId}`);
    if (!res.ok) return null;
    const user = await res.json() as { id?: string; email: string; firstName: string; lastName?: string };
    return user;
  } catch {
    console.warn(`[lms-service] Could not fetch user ${userId} from user-service`);
    return null;
  }
}

export async function isWeek12AttendanceComplete(userId: string, cohortId?: string): Promise<boolean> {
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


// Weekly quizzes a trainee still has to take before they may start an exam.
// Counts every published, already-unlocked week in the cohort that has a published
// quiz. A week is satisfied once the user has submitted an attempt on any of its
// quizzes (set REQUIRE_QUIZ_PASS to demand a pass instead).
const REQUIRE_QUIZ_PASS = false;

export async function getMissingWeeklyQuizzes(userId: string, cohortId: string) {
  const now = new Date();
  const cohortWeeks = await db
    .select({ id: weeks.id, weekNumber: weeks.weekNumber, title: weeks.title })
    .from(weeks)
    .where(
      and(
        eq(weeks.cohortId, cohortId),
        eq(weeks.isPublished, true),
        or(isNull(weeks.unlockDate), lte(weeks.unlockDate, now)),
      ),
    )
    .orderBy(weeks.weekNumber);
  if (!cohortWeeks.length) return [];

  const weekIds = cohortWeeks.map((w) => w.id);
  const weekQuizzes = await db
    .select({ id: quizzes.id, weekId: quizzes.weekId, title: quizzes.title, isPublished: quizzes.isPublished, createdAt: quizzes.createdAt })
    .from(quizzes)
    .where(inArray(quizzes.weekId, weekIds))
    .orderBy(desc(quizzes.createdAt));
  if (!weekQuizzes.length) return [];

  const attempts = await db
    .select({ quizId: quizAttempts.quizId, passed: quizAttempts.passed })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.userId, userId), inArray(quizAttempts.quizId, weekQuizzes.map((q) => q.id))));
  const doneQuizIds = new Set(attempts.filter((a) => !REQUIRE_QUIZ_PASS || a.passed).map((a) => a.quizId));

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
      ? await db.select().from(weeks).where(condition)
      : await db.select().from(weeks);

    const weeksWithLessons = await Promise.all(
      allWeeks.map(async (week) => {
        const lessonCondition = includeAll
          ? eq(lessons.weekId, week.id)
          : and(eq(lessons.weekId, week.id), eq(lessons.isPublished, true));

        const weekLessons = await db
          .select()
          .from(lessons)
          .where(lessonCondition)
          .orderBy(lessons.order);

        return { ...week, lessons: weekLessons };
      })
    );

    return res.json(weeksWithLessons);
  } catch (err) {
    console.error(err);
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

// GET /lms/progress/:userId
progressRouter.get("/:userId", async (req: Request, res: Response) => {
  try {
    const all = await db
      .select()
      .from(progress)
      .where(eq(progress.userId, req.params.userId));
    return res.json(all);
  } catch {
    return res.status(500).json({ error: "Failed to fetch progress" });
  }
});

// GET /lms/progress/cohort/:cohortId
progressRouter.get("/cohort/:cohortId", async (req: Request, res: Response) => {
  try {
    const all = await db
      .select()
      .from(progress)
      .where(eq(progress.cohortId, req.params.cohortId));
    return res.json(all);
  } catch {
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
    const all = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.weekId, req.params.weekId))
      .orderBy(desc(quizzes.isPublished), desc(quizzes.createdAt));

    const normalized = all.map((q) => ({
      ...q,
      passingScore: 70,
      isPublished: q.isPublished ?? true,
    }));
    return res.json(normalized);
  } catch {
    return res.status(500).json({ error: "Failed to fetch quizzes" });
  }
});

// GET /lms/quizzes/:id
quizzesRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const [quiz] = await db
      .select() 
      .from(quizzes)
      .where(eq(quizzes.id, req.params.id))
      .limit(1);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    return res.json({ ...quiz, passingScore: 70, isPublished: quiz.isPublished ?? true });
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
    const passedAttempts = await db
      .select({
        quizId: quizAttempts.quizId,
        weekId: quizAttempts.weekId,
      })
      .from(quizAttempts)
      .where(
        and(
          eq(quizAttempts.userId, req.params.userId),
          eq(quizAttempts.passed, true)
        )
      );

    const passedWeekIds = Array.from(new Set(passedAttempts.map((a) => a.weekId)));
    const passedQuizIds = Array.from(new Set(passedAttempts.map((a) => a.quizId)));

    return res.json({ passedWeekIds, passedQuizIds });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch user passed quizzes" });
  }
});

// ADMIN — list all quiz attempts with quiz title
// GET /lms/quizzes/admin/attempts
quizzesRouter.get("/admin/attempts", async (req: Request, res: Response) => {
  const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

  try {
    const baseQuery = db
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
      .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
      .orderBy(quizAttempts.attemptedAt);

    if (page || limit) {
      const pageNum = page && page > 0 ? page : 1;
      const limitNum = limit && limit > 0 ? limit : 25;
      const offsetNum = (pageNum - 1) * limitNum;

      const [allMatched, paginated] = await Promise.all([
        baseQuery,
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
          .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
          .orderBy(quizAttempts.attemptedAt)
          .limit(limitNum)
          .offset(offsetNum),
      ]);

      const total = allMatched.length;
      return res.json({
        data: paginated,
        attempts: paginated,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      });
    }

    const all = await baseQuery;
    return res.json(all);
  } catch (err) {
    console.error(err);
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
    console.error(err);
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
    console.error(err);
    return res.status(500).json({ error: "Failed to clear quiz attempts" });
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

// POST /lms/week12/checkin — trainee checks in with code
week12Router.post("/checkin", async (req: Request, res: Response) => {
  const schema = z.object({
    userId: z.string().uuid().optional(),
    cohortId: z.string().uuid(),
    code: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const headerUserId = req.headers["x-user-id"] as string | undefined;
  const effectiveUserId = headerUserId || parsed.data.userId;

  if (!effectiveUserId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const { cohortId, code } = parsed.data;
  const normalizedCode = code.trim().toUpperCase().replace(/\s+/g, "-");

  try {
    // Find the code (exact match or normalized)
    const [codeRecord] = await db
      .select()
      .from(week12Codes)
      .where(
        or(
          eq(week12Codes.code, code),
          eq(week12Codes.code, normalizedCode)
        )
      )
      .limit(1);

    if (!codeRecord) {
      return res.status(400).json({ error: "Invalid code. Please check and try again." });
    }

    // Check code belongs to this cohort
    if (codeRecord.cohortId !== cohortId) {
      return res.status(400).json({ error: "This code is not for your cohort." });
    }

    // Check code validity with timezone tolerance (WAT = UTC+1 vs UTC)
    const now = new Date();
    const watDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(now);
    const utcDateStr = now.toISOString().split("T")[0];
    const isValidDate = codeRecord.validDate === watDateStr || codeRecord.validDate === utcDateStr;
    const ageHours = codeRecord.createdAt
      ? (now.getTime() - new Date(codeRecord.createdAt).getTime()) / (1000 * 60 * 60)
      : 0;

    if (!isValidDate && ageHours > 28) {
      return res.status(400).json({ error: "This code has expired or is not valid today." });
    }

    // Check if already checked in for this day (Idempotency)
    const [existing] = await db
      .select()
      .from(week12Checkins)
      .where(
        and(
          eq(week12Checkins.userId, effectiveUserId),
          eq(week12Checkins.day, codeRecord.day)
        )
      )
      .limit(1);

    if (existing) {
      return res.status(200).json({
        message: `✅ You are already checked in for Day ${codeRecord.day}!`,
        checkin: existing,
        alreadyCheckedIn: true,
      });
    }

    const [checkin] = await db
      .insert(week12Checkins)
      .values({
        userId: effectiveUserId,
        cohortId,
        codeId: codeRecord.id,
        day: codeRecord.day,
      })
      .returning();

    return res.status(201).json({
      message: `✅ Checked in for Day ${codeRecord.day}!`,
      checkin,
    });
  } catch (err) {
    console.error("[week12Router.post /checkin] error:", err);
    return res.status(500).json({ error: "Failed to check in" });
  }
});

// POST /lms/week12/admin/checkin — admin manually records attendance for a day
week12Router.post("/admin/checkin", async (req: Request, res: Response) => {
  const schema = z.object({
    cohortId: z.string().uuid(),
    userId: z.string().uuid(),
    day: z.number().int().min(1).max(5),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { cohortId, userId, day } = parsed.data;

  try {
    const [existing] = await db
      .select()
      .from(week12Checkins)
      .where(
        and(
          eq(week12Checkins.userId, userId),
          eq(week12Checkins.day, day)
        )
      )
      .limit(1);

    if (existing) {
      return res.json({
        message: `User is already checked in for Day ${day}`,
        checkin: existing,
      });
    }

    const [codeRecord] = await db
      .select({ id: week12Codes.id })
      .from(week12Codes)
      .where(and(eq(week12Codes.cohortId, cohortId), eq(week12Codes.day, day)))
      .limit(1);

    const [checkin] = await db
      .insert(week12Checkins)
      .values({
        cohortId,
        userId,
        day,
        codeId: codeRecord ? codeRecord.id : null,
      })
      .returning();

    return res.status(201).json({
      message: `✅ Manually checked in for Day ${day}`,
      checkin,
    });
  } catch (err) {
    console.error("[week12Router.post /admin/checkin] error:", err);
    return res.status(500).json({ error: "Failed to manually check in trainee" });
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
  try {
    const list = await db
      .select()
      .from(practicalCheckins)
      .where(
        week
          ? and(
              eq(practicalCheckins.cohortId, cohortId),
              eq(practicalCheckins.weekNumber, Number(week))
            )
          : eq(practicalCheckins.cohortId, cohortId)
      );
    return res.json(list);
  } catch (err) {
    console.error("Fetch practical checkins error:", err);
    return res.status(500).json({ error: "Failed to fetch practical checkins" });
  }
});

// POST /lms/practical/checkins
practicalRouter.post("/checkins", async (req: Request, res: Response) => {
  const { cohortId, userId, groupId, weekNumber, codeSubmitted, verifiedBy } = req.body;
  if (!cohortId || !userId || !weekNumber) {
    return res.status(400).json({ error: "Missing required checkin fields" });
  }

  const isUuid = (str: any) => typeof str === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
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
          eq(practicalCheckins.weekNumber, Number(weekNumber))
        )
      );

    if (existing) {
      return res.json({ message: "User already checked in for this week", checkin: existing });
    }

    const [inserted] = await db
      .insert(practicalCheckins)
      .values({
        cohortId,
        userId,
        groupId: groupId || null,
        weekNumber: Number(weekNumber),
        codeSubmitted: codeSubmitted || "VERIFIED",
        verifiedBy: validVerifiedBy,
      })
      .returning();

    return res.status(201).json({ message: "Checkin recorded successfully", checkin: inserted });
  } catch (err) {
    console.error("Record practical checkin error:", err);
    return res.status(500).json({ error: "Failed to record practical checkin" });
  }
});

// GET /lms/practical/checkins/user/:userId
practicalRouter.get("/checkins/user/:userId", async (req: Request, res: Response) => {
  try {
    const list = await db
      .select()
      .from(practicalCheckins)
      .where(eq(practicalCheckins.userId, req.params.userId));
    return res.json(list);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch user checkins" });
  }
});

// DELETE /lms/practical/checkins/:cohortId
practicalRouter.delete("/checkins/:cohortId", async (req: Request, res: Response) => {
  const { cohortId } = req.params;
  const { week, userId } = req.query;

  try {
    const conditions = [eq(practicalCheckins.cohortId, cohortId)];
    if (week) {
      conditions.push(eq(practicalCheckins.weekNumber, Number(week)));
    }
    if (userId && typeof userId === "string") {
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

  try {
    const conditions = [eq(practicalCheckins.userId, userId)];
    if (week) {
      conditions.push(eq(practicalCheckins.weekNumber, Number(week)));
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
      .returning();

    return res.status(201).json({
      success: true,
      message: `✅ Verified! ${traineeName} marked PRESENT for Week ${matchedCode.weekNumber} Practical Session!`,
      alreadyCheckedIn: false,
      checkin: newCheckin,
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
      filters.push(eq(exams.isActive, true));
    }

    let query = db.select().from(exams);
    if (filters.length > 0) {
      query = query.where(and(...filters)) as typeof query;
    }
 
    const all = await query.orderBy(exams.createdAt);
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

  try {
    const baseQuery = db
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
      .orderBy(examSessions.createdAt);

    if (page || limit) {
      const pageNum = page && page > 0 ? page : 1;
      const limitNum = limit && limit > 0 ? limit : 25;
      const offsetNum = (pageNum - 1) * limitNum;

      const [allMatched, paginated] = await Promise.all([
        baseQuery,
        db
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
          .orderBy(examSessions.createdAt)
          .limit(limitNum)
          .offset(offsetNum),
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

    const all = await baseQuery;
    return res.json(all);
  } catch (err) {
    console.error("[examsRouter GET /admin/sessions] error:", err);
    return res.status(500).json({ error: "Failed to fetch admin exam sessions" });
  }
});

// GET /lms/exams/:id/quiz-requirements
// Weekly quizzes and Week 12 physical attendance required before starting this exam.
examsRouter.get("/:id/quiz-requirements", async (req: Request, res: Response) => {
  const userId = req.headers["x-user-id"] as string | undefined;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const [exam] = await db.select().from(exams).where(eq(exams.id, req.params.id)).limit(1);
    if (!exam) return res.status(404).json({ error: "Exam not found" });
    const missingQuizzes = await getMissingWeeklyQuizzes(userId, exam.cohortId);
    const week12AttendanceComplete = await isWeek12AttendanceComplete(userId, exam.cohortId);
    const ready = missingQuizzes.length === 0 && week12AttendanceComplete;
    return res.json({
      ready,
      missingQuizzes,
      week12AttendanceComplete,
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
  });
 
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });
 
  try {
    const [exam] = await db
      .insert(exams)
      .values({ ...parsed.data, totalMarks: 0 })
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
    const [updated] = await db
      .update(exams)
      .set({ ...parsed.data, updatedAt: new Date() })
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
    const isAdmin = req.query.admin === "true";
 
    const questions = await db
      .select()
      .from(examQuestions)
      .where(eq(examQuestions.examId, req.params.id))
      .orderBy(examQuestions.orderIndex);
 
    // Strip correct answer from trainee-facing responses
    const sanitized = isAdmin
      ? questions
      : questions.map(({ correctOptionIndex: _stripped, ...q }) => q);
 
    return res.json(sanitized);
  } catch {
    return res.status(500).json({ error: "Failed to fetch questions" });
  }
});
 
// POST /lms/exams/:id/questions — add a question
examsRouter.post("/:id/questions", async (req: Request, res: Response) => {
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

      const complete = await isWeek12AttendanceComplete(userId, exam.cohortId);
      if (!complete) {
        return res.status(403).json({
          error: "Week 12 physical practical attendance must be complete before taking this exam.",
          code: "WEEK12_ATTENDANCE_INCOMPLETE",
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
            ({ correctOptionIndex: _stripped, ...q }) => q
          );
 
          return res.json({
            session: existing,
            questions: sanitizedQuestions,
            savedAnswers: answers,
            resumed: true,
          });
        }
 
        // Already submitted/auto-submitted/timed-out
        return res.status(409).json({
          error: "You have already taken this exam.",
          status: existing.status,
          sessionId: existing.id,
        });
      }
 
      // Every unlocked weekly quiz must be taken before a new exam session starts
      const missingQuizzes = await getMissingWeeklyQuizzes(userId, exam.cohortId);
      if (missingQuizzes.length > 0) {
        const list = missingQuizzes.map((q) => `Week ${q.weekNumber}: ${q.quizTitle}`).join(", ");
        return res.status(403).json({
          error: `You must take every weekly quiz before this exam. Missing: ${list}.`,
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
      const questions = await db
        .select()
        .from(examQuestions)
        .where(eq(examQuestions.examId, examId))
        .orderBy(examQuestions.orderIndex);
 
      if (questions.length > 0) {
        await db.insert(examAnswers).values(
          questions.map((q) => ({
            sessionId: session.id,
            questionId: q.id,
            answerText: null,
          }))
        );
      }
 
      const sanitizedQuestions = questions.map(
        ({ correctOptionIndex: _stripped, ...q }) => q
      );
 
      return res.status(201).json({
        session,
        questions: sanitizedQuestions,
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
 