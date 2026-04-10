import { Router, Request, Response } from "express";
import { count, eq } from "drizzle-orm";
import axios from "axios";
import { db } from "../index";
import { users, cohorts, cohortMembers } from "../db/schema";

const router = Router();

// GET /admin/stats
// Returns platform-wide counts: users, cohorts, enrolments, and progress summary from lms-service
router.get("/stats", async (_req: Request, res: Response) => {
  try {
    const [totalUsers] = await db.select({ count: count() }).from(users);
    const [activeUsers] = await db
      .select({ count: count() })
      .from(users)
      .where(eq(users.isActive, true));

    const [totalCohorts] = await db.select({ count: count() }).from(cohorts);
    const [activeCohorts] = await db
      .select({ count: count() })
      .from(cohorts)
      .where(eq(cohorts.isActive, true));

    const [totalEnrolments] = await db.select({ count: count() }).from(cohortMembers);

    // Fetch progress summary from lms-service via REST
    let lmsStats = null;
    try {
      const lmsUrl = process.env.LMS_SERVICE_URL || "http://lms-service:3003";
      const { data } = await axios.get(`${lmsUrl}/lms/stats/summary`, { timeout: 3000 });
      lmsStats = data;
    } catch {
      // lms-service unavailable — return partial stats gracefully
      lmsStats = { error: "lms-service unavailable" };
    }

    return res.json({
      users: {
        total: Number(totalUsers.count),
        active: Number(activeUsers.count),
      },
      cohorts: {
        total: Number(totalCohorts.count),
        active: Number(activeCohorts.count),
      },
      enrolments: {
        total: Number(totalEnrolments.count),
      },
      lms: lmsStats,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[admin] stats error:", err);
    return res.status(500).json({ error: "Failed to generate stats" });
  }
});

// GET /admin/users  — paginated user list with cohort info
router.get("/users", async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;

  try {
    const result = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        isActive: users.isActive,
        createdAt: users.createdAt,
      })
      .from(users)
      .limit(limit)
      .offset(offset)
      .orderBy(users.createdAt);

    const [total] = await db.select({ count: count() }).from(users);

    return res.json({
      data: result,
      pagination: {
        page,
        limit,
        total: Number(total.count),
        totalPages: Math.ceil(Number(total.count) / limit),
      },
    });
  } catch {
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

export default router;
