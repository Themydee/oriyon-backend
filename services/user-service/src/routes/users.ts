import { Router, Request, Response } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import crypto from "crypto";
import { db } from "../index";
import { users, cohorts, cohortMembers, groups, groupMembers } from "../db/schema";
import { publishEvent } from "../rabbitmq";

export const userRouter = Router();
export const cohortRouter = Router();

// ─────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────

const createUserSchema = z.object({
  id: z.string().uuid().optional(),
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional().nullable(),
  role: z.enum(["trainee", "trainer", "coordinator", "lead_trainer", "admin"]).default("trainee"),
  assignedState: z.string().optional().nullable(),
  assignedLga: z.string().optional().nullable(),
  assignedZone: z.string().optional().nullable(),
  approvedRole: z.string().optional().nullable(),
});

// GET /users
userRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const allUsers = await db.select().from(users).orderBy(users.createdAt);
    const allCohortMembers = await db.select().from(cohortMembers);
    const allGroupMembers = await db.select().from(groupMembers);
    const allCohorts = await db.select().from(cohorts);
    const allGroups = await db.select().from(groups);

    const cohortMap = new Map(allCohorts.map((c) => [c.id, c.name]));
    const groupMap = new Map(allGroups.map((g) => [g.id, g.name]));

    const userCohortMap = new Map<string, { id: string; name: string }[]>();
    for (const cm of allCohortMembers) {
      const cohortName = cohortMap.get(cm.cohortId) || "";
      if (!userCohortMap.has(cm.userId)) userCohortMap.set(cm.userId, []);
      userCohortMap.get(cm.userId)!.push({ id: cm.cohortId, name: cohortName });
    }

    const userGroupMap = new Map<string, { id: string; name: string }[]>();
    for (const gm of allGroupMembers) {
      const groupName = groupMap.get(gm.groupId) || "";
      if (!userGroupMap.has(gm.userId)) userGroupMap.set(gm.userId, []);
      userGroupMap.get(gm.userId)!.push({ id: gm.groupId, name: groupName });
    }

    const usersWithMemberships = allUsers.map((u) => ({
      ...u,
      cohorts: userCohortMap.get(u.id) || [],
      groups: userGroupMap.get(u.id) || [],
    }));

    return res.json(usersWithMemberships);
  } catch (err) {
    console.error(err);
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

    const [membership] = await db
      .select()
      .from(cohortMembers)
      .where(eq(cohortMembers.userId, req.params.id))
      .limit(1);

    return res.json({
      ...user,
      cohortId: membership?.cohortId ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch user" });
  }
});

// POST /users
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

    const userId = parsed.data.id || crypto.randomUUID();
    const insertData = {
      ...parsed.data,
      id: userId,
      phone: parsed.data.phone || null,
      assignedState: parsed.data.assignedState || null,
      assignedLga: parsed.data.assignedLga || null,
      assignedZone: parsed.data.assignedZone || null,
      isActive: false,
    };

    const [newUser] = await db.insert(users).values(insertData).returning();

    await publishEvent("user.created", {
      userId: newUser.id,
      email: newUser.email,
      firstName: newUser.firstName,
      lastName: newUser.lastName,
      role: newUser.role,
      assignedState: newUser.assignedState,
      assignedLga: newUser.assignedLga,
      assignedZone: newUser.assignedZone,
    });

    return res.status(201).json(newUser);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create user" });
  }
});

// POST /users/bulk-email
userRouter.post("/bulk-email", async (req: Request, res: Response) => {
  const schema = z.object({
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    // Find trainees that have no cohort memberships and are not cooperative-only
    const cohortLessTrainees = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .leftJoin(cohortMembers, eq(users.id, cohortMembers.userId))
      .where(
        and(
          eq(users.role, "trainee"),
          eq(users.isCooperativeOnly, false),
          isNull(cohortMembers.id)
        )
      );

    // Publish event for each trainee
    for (const u of cohortLessTrainees) {
      await publishEvent("application.custom_email_requested", {
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        subject: parsed.data.subject,
        body: parsed.data.body,
      });
    }

    return res.json({
      message: `Dispatched bulk email to ${cohortLessTrainees.length} trainees`,
      count: cohortLessTrainees.length,
    });
  } catch (err) {
    console.error("[bulk-email] error:", err);
    return res.status(500).json({ error: "Failed to send bulk email" });
  }
});

// PATCH /users/:id
userRouter.patch("/:id", async (req: Request, res: Response) => {
  const allowedFields = z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional().nullable(),
    isActive: z.boolean().optional(),
    role: z.enum(["trainee", "trainer", "coordinator", "lead_trainer", "admin"]).optional(),
    assignedState: z.string().optional().nullable(),
    assignedLga: z.string().optional().nullable(),
    assignedZone: z.string().optional().nullable(),
    approvedRole: z.string().optional().nullable(),
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

    // Publish event to keep auth-service in sync
    await publishEvent("user.updated", {
      userId: updated.id,
      role: updated.role,
      assignedState: updated.assignedState,
      assignedLga: updated.assignedLga,
      assignedZone: updated.assignedZone,
      isActive: updated.isActive,
    });

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Failed to update user" });
  }
});

// DELETE /users/:id
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

// ─────────────────────────────────────────────
// GET /cohorts/groups/:id — single group with members
// ⚠️ MUST be before /:id to avoid "groups" being
// treated as a cohort ID
// ─────────────────────────────────────────────
cohortRouter.get("/groups/:id", async (req: Request, res: Response) => {
  try {
    const [group] = await db
      .select()
      .from(groups)
      .where(eq(groups.id, req.params.id))
      .limit(1);

    if (!group) return res.status(404).json({ error: "Group not found" });

    const members = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        phone: users.phone,
        joinedAt: groupMembers.joinedAt,
      })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, group.id));

    return res.json({ ...group, members });
  } catch {
    return res.status(500).json({ error: "Failed to fetch group" });
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
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const startDate = parsed.data.startDate ? new Date(parsed.data.startDate) : undefined;
  const endDate = parsed.data.endDate ? new Date(parsed.data.endDate) : undefined;
  if (startDate && isNaN(startDate.getTime())) return res.status(400).json({ error: "Invalid startDate" });
  if (endDate && isNaN(endDate.getTime())) return res.status(400).json({ error: "Invalid endDate" });

  try {
    const [cohort] = await db
      .insert(cohorts)
      .values({ ...parsed.data, startDate, endDate })
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

// ─────────────────────────────────────────────
// GROUPS
// ─────────────────────────────────────────────

// POST /cohorts/:id/groups — create a group
cohortRouter.post("/:id/groups", async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    practicalDay: z.string().optional().nullable(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const [group] = await db
      .insert(groups)
      .values({ cohortId: req.params.id, ...parsed.data })
      .returning();

    return res.status(201).json(group);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create group" });
  }
});

// PATCH /cohorts/:cohortId/groups/:groupId — update a group
cohortRouter.patch("/:cohortId/groups/:groupId", async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    practicalDay: z.string().optional().nullable(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { groupId } = req.params;

  try {
    const [updated] = await db
      .update(groups)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(groups.id, groupId))
      .returning();

    if (!updated) return res.status(404).json({ error: "Group not found" });

    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to update group" });
  }
});

// DELETE /cohorts/:cohortId/groups/:groupId — delete a group
cohortRouter.delete("/:cohortId/groups/:groupId", async (req: Request, res: Response) => {
  const { groupId } = req.params;
  try {
    await db.delete(groups).where(eq(groups.id, groupId));
    return res.json({ message: "Group deleted successfully" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete group" });
  }
});

// GET /cohorts/:id/groups — list groups with member details
cohortRouter.get("/:id/groups", async (req: Request, res: Response) => {
  try {
    const allGroups = await db
      .select()
      .from(groups)
      .where(eq(groups.cohortId, req.params.id))
      .orderBy(groups.createdAt);

    // For each group fetch its members
    const groupsWithMembers = await Promise.all(
      allGroups.map(async (group) => {
        const members = await db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            phone: users.phone,
            joinedAt: groupMembers.joinedAt,
          })
          .from(groupMembers)
          .innerJoin(users, eq(users.id, groupMembers.userId))
          .where(eq(groupMembers.groupId, group.id));

        return {
          ...group,
          memberCount: members.length,
          members,
        };
      })
    );

    return res.json(groupsWithMembers);
  } catch {
    return res.status(500).json({ error: "Failed to fetch groups" });
  }
});

// POST /cohorts/:cohortId/groups/:groupId/members — add member to group
cohortRouter.post("/:cohortId/groups/:groupId/members", async (req: Request, res: Response) => {
  const schema = z.object({
    userId: z.string().uuid(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { cohortId, groupId } = req.params;
  const { userId } = parsed.data;

  try {
    // 1. Check user is enrolled in cohort
    const [cohortMember] = await db
      .select()
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.userId, userId),
          eq(cohortMembers.cohortId, cohortId)
        )
      )
      .limit(1);

    if (!cohortMember) {
      return res.status(400).json({
        error: "User must be enrolled in this cohort before joining a group",
      });
    }

    // 2. Check group belongs to cohort
    const [group] = await db
      .select()
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);

    if (!group || group.cohortId !== cohortId) {
      return res.status(400).json({ error: "Group does not belong to this cohort" });
    }

    // 3. Check not already in this group
    const [alreadyMember] = await db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, userId)
        )
      )
      .limit(1);

    if (alreadyMember) {
      return res.status(409).json({ error: "User is already a member of this group" });
    }

    // 4. Add to group
    const [member] = await db
      .insert(groupMembers)
      .values({ groupId, userId })
      .returning();

    return res.status(201).json(member);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to add user to group" });
  }
});

// DELETE /cohorts/:cohortId/groups/:groupId/members/:userId
cohortRouter.delete("/:cohortId/groups/:groupId/members/:userId", async (req: Request, res: Response) => {
  const { groupId, userId } = req.params;
  if (!groupId || !userId) {
    return res.status(400).json({ error: "Missing required route parameters" });
  }
  try {
    await db
      .delete(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, userId)
        )
      );
    return res.json({ message: "Member removed from group" });
  } catch {
    return res.status(500).json({ error: "Failed to remove member from group" });
  }
});