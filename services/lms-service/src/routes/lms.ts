import { Router, Request, Response } from "express";
import { eq, and, type InferModel } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { weeks, lessons, progress, physicalSessions, sessionGroups, quizzes, quizAttempts, week12Codes, week12Checkins } from "../db/schema";
import { publishEvent } from "../rabbitmq";

type WeekRow = InferModel<typeof weeks>;


export const weeksRouter = Router();
export const lessonsRouter = Router();
export const progressRouter = Router();
export const sessionsRouter = Router();
export const quizzesRouter = Router();

// ─────────────────────────────────────────────
// HELPER — fetch user from user-service
// Gets email + firstName for notification events
// ─────────────────────────────────────────────
async function fetchUser(userId: string): Promise<{ email: string; firstName: string } | null> {
  try {
    const res = await fetch(`${process.env.USER_SERVICE_URL}/users/${userId}`);
    if (!res.ok) return null;
    const user = await res.json() as { email: string; firstName: string };
    return user;
  } catch {
    console.warn(`[lms-service] Could not fetch user ${userId} from user-service`);
    return null;
  }
}

// ─────────────────────────────────────────────
// WEEKS
// ─────────────────────────────────────────────

// GET /lms/weeks?cohortId=
weeksRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { cohortId } = req.query;

    const condition = cohortId
      ? and(
          eq(weeks.cohortId, cohortId as string),
          eq(weeks.isPublished, true)
        )
      : eq(weeks.isPublished, true);

    const allWeeks = await db
      .select()
      .from(weeks)
      .where(condition);

    const weeksWithLessons = await Promise.all(
      allWeeks.map(async (week) => {
        const weekLessons = await db
          .select()
          .from(lessons)
          .where(eq(lessons.weekId, week.id))
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
    const [week] = await db.select().from(weeks).where(eq(weeks.id, req.params.id)).limit(1);
    if (!week) return res.status(404).json({ error: "Week not found" });

    const weekLessons = await db
      .select()
      .from(lessons)
      .where(eq(lessons.weekId, req.params.id))
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
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [week] = await db.insert(weeks).values(parsed.data).returning();
    return res.status(201).json(week);
  } catch {
    return res.status(500).json({ error: "Failed to create week" });
  }
});

// PATCH /lms/weeks/:id
weeksRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const [updated] = await db
      .update(weeks)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(weeks.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Week not found" });
    return res.json(updated);
  } catch {
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
    return res.json(lesson);
  } catch {
    return res.status(500).json({ error: "Failed to fetch lesson" });
  }
});

// POST /lms/lessons
lessonsRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    weekId: z.string().uuid(),
    title: z.string().min(1),
    description: z.string().optional(),
    type: z.enum(["video", "document"]).default("video"),
    videoUrl: z.string().url().optional(),
    documentUrl: z.string().url().optional(),
    durationMinutes: z.number().int().optional(),
    order: z.number().int().default(0),
    isPublished: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [lesson] = await db.insert(lessons).values(parsed.data).returning();
    return res.status(201).json(lesson);
  } catch {
    return res.status(500).json({ error: "Failed to create lesson" });
  }
});

// PATCH /lms/lessons/:id
lessonsRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const [updated] = await db
      .update(lessons)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(lessons.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Lesson not found" });
    return res.json(updated);
  } catch {
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
    const all = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.weekId, req.params.weekId));
    return res.json(all);
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
    return res.json(quiz);
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
    isPublished: z.boolean().optional(),
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
    userId: z.string().uuid(),
    weekId: z.string().uuid(),
    cohortId: z.string().uuid(),
    answers: z.record(z.string(), z.number()),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, weekId, cohortId, answers } = parsed.data;

  try {
    const [quiz] = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.id, req.params.id))
      .limit(1);

    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    // Calculate score
    const questions = quiz.questions as any[];
    let correct = 0;
    questions.forEach((q: any) => {
      if (answers[q.id] === q.correctIndex) correct++;
    });

    const score = questions.length > 0
      ? Math.round((correct / questions.length) * 100)
      : 0;
    const passed = score >= quiz.passingScore;

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
    userId: z.string().uuid(),
    cohortId: z.string().uuid(),
    code: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, cohortId, code } = parsed.data;

  try {
    // Find the code
    const [codeRecord] = await db
      .select()
      .from(week12Codes)
      .where(eq(week12Codes.code, code))
      .limit(1);

    if (!codeRecord) {
      return res.status(400).json({ error: "Invalid code. Please check and try again." });
    }

    // Check code belongs to this cohort
    if (codeRecord.cohortId !== cohortId) {
      return res.status(400).json({ error: "This code is not for your cohort." });
    }

    // Check code is valid for today
    const today = new Date().toISOString().split("T")[0];
    if (codeRecord.validDate !== today) {
      return res.status(400).json({ error: "This code has expired or is not valid today." });
    }

    // Check if already checked in for this day
    const [existing] = await db
      .select()
      .from(week12Checkins)
      .where(
        and(
          eq(week12Checkins.userId, userId),
          eq(week12Checkins.day, codeRecord.day)
        )
      )
      .limit(1);

    if (existing) {
      return res.status(409).json({ error: "You have already checked in for this day." });
    }

    const [checkin] = await db
      .insert(week12Checkins)
      .values({
        userId,
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
    console.error(err);
    return res.status(500).json({ error: "Failed to check in" });
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
    const all = await db
      .select()
      .from(week12Checkins)
      .where(
        and(
          eq(week12Checkins.cohortId, req.params.cohortId),
          eq(week12Checkins.userId, req.params.userId)
        )
      );

    const days = all.map((c) => c.day);
    const fullyAttended = [1, 2, 3, 4, 5].every((d) => days.includes(d));

    return res.json({ checkins: all, days, fullyAttended });
  } catch {
    return res.status(500).json({ error: "Failed to fetch checkins" });
  }
});