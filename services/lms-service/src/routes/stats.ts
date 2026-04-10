import { Router, Request, Response } from "express";
import { count, eq } from "drizzle-orm";
import { db } from "../index";
import { weeks, lessons, progress, physicalSessions } from "../db/schema";

const router = Router();

// GET /lms/stats/summary  — called internally by user-service admin endpoint
router.get("/summary", async (_req: Request, res: Response) => {
  try {
    const [totalWeeks] = await db.select({ count: count() }).from(weeks);
    const [totalLessons] = await db.select({ count: count() }).from(lessons);
    const [completedLessons] = await db
      .select({ count: count() })
      .from(progress)
      .where(eq(progress.completed, true));
    const [totalProgressRecords] = await db.select({ count: count() }).from(progress);
    const [totalSessions] = await db.select({ count: count() }).from(physicalSessions);

    const completionRate =
      Number(totalProgressRecords.count) > 0
        ? Math.round((Number(completedLessons.count) / Number(totalProgressRecords.count)) * 100)
        : 0;

    return res.json({
      weeks: Number(totalWeeks.count),
      lessons: Number(totalLessons.count),
      completedLessons: Number(completedLessons.count),
      totalProgressRecords: Number(totalProgressRecords.count),
      overallCompletionRate: `${completionRate}%`,
      physicalSessions: Number(totalSessions.count),
    });
  } catch (err) {
    console.error("[lms] stats error:", err);
    return res.status(500).json({ error: "Failed to generate LMS stats" });
  }
});

export default router;
