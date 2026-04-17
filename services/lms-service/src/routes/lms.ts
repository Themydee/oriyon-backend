import { Router, Request, Response } from "express";
import { eq, and, isNull, sql,  type InferModel } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { weeks, lessons, progress, physicalSessions, sessionGroups, quizzes, quizAttempts, week12Codes, week12Checkins, exams, examQuestions, examSessions, examAnswers, examViolations } from "../db/schema";
import { publishEvent } from "../rabbitmq";

type WeekRow = InferModel<typeof weeks>;


export const weeksRouter = Router();
export const lessonsRouter = Router();
export const progressRouter = Router();
export const sessionsRouter = Router();
export const quizzesRouter = Router();
export const examsRouter = Router();
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
    const { cohortId, weekId, showAll } = req.query;
    const includeAll = showAll === "true";
    const filters: any[] = [];
 
    if (cohortId) filters.push(eq(exams.cohortId, cohortId as string));
    if (weekId) filters.push(eq(exams.weekId, weekId as string));
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
    weekId: z.string().uuid().optional(),
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
    weekId: z.string().uuid().optional().nullable(),
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
      userId: z.string().uuid(),
    });
 
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });
 
    const { userId } = parsed.data;
    const examId = req.params.id;
 
    try {
      const [exam] = await db
        .select()
        .from(exams)
        .where(and(eq(exams.id, examId), eq(exams.isPublished, true)))
        .limit(1);
 
      if (!exam)
        return res.status(404).json({ error: "Exam not found or not published" });
 
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
        await db
          .update(examAnswers)
          .set({ answerText, updatedAt: new Date() })
          .where(
            and(
              eq(examAnswers.sessionId, session.id),
              eq(examAnswers.questionId, questionId)
            )
          );
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
 