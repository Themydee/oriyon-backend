import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { users, cohorts, cohortMembers } from "../db/schema";
import { publishEvent } from "../rabbitmq";

export const userRouter = Router();
export const cohortRouter = Router();

// ─────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────

const createUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  role: z.enum(["trainee", "trainer", "admin"]).default("trainee"),
});

// GET /users
userRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const all = await db.select().from(users).orderBy(users.createdAt);
    return res.json(all);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

// GET /users/:id
userRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.params.id))
      .limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch user" });
  }
});

// POST /users  — admin manually creates a user
userRouter.post("/", async (req: Request, res: Response) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);
    if (existing) return res.status(409).json({ error: "User already exists" });

    const [newUser] = await db.insert(users).values(parsed.data).returning();

    // Publish user.created so auth-service creates
    // the auth record and generates the setup token
    await publishEvent("user.created", {
      userId: newUser.id,
      email: newUser.email,
      firstName: newUser.firstName,
      lastName: newUser.lastName,
      role: newUser.role,
    });

    return res.status(201).json(newUser);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create user" });
  }
});

// PATCH /users/:id
userRouter.patch("/:id", async (req: Request, res: Response) => {
  const allowedFields = z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional(),
    isActive: z.boolean().optional(),
  });

  const parsed = allowedFields.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [updated] = await db
      .update(users)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(users.id, req.params.id))
      .returning();

    if (!updated) return res.status(404).json({ error: "User not found" });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Failed to update user" });
  }
});

// DELETE /users/:id  — soft delete
userRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    await db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.id, req.params.id));
    return res.json({ message: "User deactivated" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to deactivate user" });
  }
});

// ─────────────────────────────────────────────
// COHORTS
// ─────────────────────────────────────────────

// GET /cohorts
cohortRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const all = await db.select().from(cohorts).orderBy(cohorts.createdAt);
    return res.json(all);
  } catch {
    return res.status(500).json({ error: "Failed to fetch cohorts" });
  }
});

// GET /cohorts/:id
cohortRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const [cohort] = await db
      .select()
      .from(cohorts)
      .where(eq(cohorts.id, req.params.id))
      .limit(1);
    if (!cohort) return res.status(404).json({ error: "Cohort not found" });

    const members = await db
      .select()
      .from(cohortMembers)
      .where(eq(cohortMembers.cohortId, req.params.id));

    return res.json({ ...cohort, members });
  } catch {
    return res.status(500).json({ error: "Failed to fetch cohort" });
  }
});

// POST /cohorts
cohortRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    state: z.string().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [cohort] = await db
      .insert(cohorts)
      .values({
        ...parsed.data,
        startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : undefined,
        endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
      })
      .returning();
    return res.status(201).json(cohort);
  } catch {
    return res.status(500).json({ error: "Failed to create cohort" });
  }
});

// PATCH /cohorts/:id
cohortRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const [updated] = await db
      .update(cohorts)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(cohorts.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Cohort not found" });
    return res.json(updated);
  } catch {
    return res.status(500).json({ error: "Failed to update cohort" });
  }
});

// POST /cohorts/:id/enrol
cohortRouter.post("/:id/enrol", async (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const [enrolment] = await db
      .insert(cohortMembers)
      .values({ userId, cohortId: req.params.id })
      .returning();

    await publishEvent("user.enrolled", {
      userId,
      cohortId: req.params.id,
      enrolledAt: new Date().toISOString(),
    });

    return res.status(201).json(enrolment);
  } catch (err) {
    return res.status(500).json({ error: "Failed to enrol user" });
  }
});