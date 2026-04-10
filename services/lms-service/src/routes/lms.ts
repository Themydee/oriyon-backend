import { Router, Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { weeks, lessons, progress, physicalSessions, sessionGroups } from "../db/schema";
import { publishEvent } from "../rabbitmq";

export const weeksRouter = Router();
export const lessonsRouter = Router();
export const progressRouter = Router();
export const sessionsRouter = Router();

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
    const all = cohortId
      ? await db.select().from(weeks).where(eq(weeks.cohortId, cohortId as string))
      : await db.select().from(weeks);
    return res.json(all);
  } catch {
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
    type: z.enum(["video", "document", "quiz"]).default("video"),
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