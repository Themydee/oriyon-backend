import { Router, Request, Response } from "express";
import { eq, and, isNull, sql, ilike, or, inArray, desc } from "drizzle-orm";
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

function normalizeUserRow(user: any) {
  if (!user) return null;
  const firstName = user.firstName ?? user.first_name ?? "";
  const lastName = user.lastName ?? user.last_name ?? "";
  const passportPicture = user.passportPicture ?? user.passport_picture ?? user.passportUrl ?? user.passport_url ?? user.avatarUrl ?? user.avatar_url ?? user.photo ?? null;
  const idType = user.idType ?? user.id_type ?? null;
  const idDocument = user.idDocument ?? user.id_document ?? null;
  const idFilename = user.idFilename ?? user.id_filename ?? null;
  const idMimeType = user.idMimeType ?? user.id_mime_type ?? null;
  const idUploadedAt = user.idUploadedAt ?? user.id_uploaded_at ?? null;
  const kycStatus = user.kycStatus ?? user.kyc_status ?? null;
  const kycRejectionReason = user.kycRejectionReason ?? user.kyc_rejection_reason ?? null;
  const rawActive = user.isActive ?? user.is_active;
  const isActive = rawActive === true || rawActive === "true" || rawActive === 1;

  return {
    ...user,
    id: user.id,
    email: user.email,
    firstName,
    lastName,
    first_name: firstName,
    last_name: lastName,
    phone: user.phone ?? null,
    address: user.address ?? null,
    role: user.role ?? "trainee",
    assignedState: user.assignedState ?? user.assigned_state ?? null,
    assignedLga: user.assignedLga ?? user.assigned_lga ?? null,
    assignedZone: user.assignedZone ?? user.assigned_zone ?? null,
    physicalSiteId: user.physicalSiteId ?? user.physical_site_id ?? null,
    isCooperativeOnly: user.isCooperativeOnly ?? user.is_cooperative_only ?? false,
    isActive,
    is_active: isActive,
    blacklistReason: user.blacklistReason ?? user.blacklist_reason ?? null,
    approvedRole: user.approvedRole ?? user.approved_role ?? null,
    idType,
    id_type: idType,
    idDocument,
    id_document: idDocument,
    idDocumentUrl: idDocument,
    idFilename,
    id_filename: idFilename,
    idMimeType,
    id_mime_type: idMimeType,
    idUploadedAt,
    id_uploaded_at: idUploadedAt,
    kycStatus,
    kyc_status: kycStatus,
    kycRejectionReason,
    kyc_rejection_reason: kycRejectionReason,
    passportPicture,
    passportUrl: passportPicture,
    avatarUrl: passportPicture,
    photo: passportPicture,
  };
}

// GET /users
// Supports: ?page=1&limit=50&search=john&role=trainee
userRouter.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;
    const search = (req.query.search as string) || "";
    const roleFilter = req.query.role as string | undefined;

    // Build where conditions
    const conditions = [];
    if (search) {
      conditions.push(
        or(
          ilike(users.firstName, `%${search}%`),
          ilike(users.lastName, `%${search}%`),
          ilike(users.email, `%${search}%`)
        )
      );
    }
    if (roleFilter) {
      conditions.push(eq(users.role, roleFilter as any));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    let allUsers: any[] = [];
    let count = 0;

    // Paginated users with raw SQL fallback for missing columns on live DB
    try {
      const [usersRows, countRes] = await Promise.all([
        db
          .select()
          .from(users)
          .where(whereClause)
          .orderBy(desc(users.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .where(whereClause),
      ]);
      allUsers = usersRows || [];
      count = Number(countRes?.[0]?.count || 0);
    } catch (drizzleErr) {
      console.error("Drizzle select /users failed, using raw SQL fallback:", drizzleErr);
      try {
        let rawQuery = `SELECT * FROM users`;
        const rawConditions: string[] = [];

        if (search) {
          const escapedSearch = search.replace(/'/g, "''");
          rawConditions.push(`(first_name ILIKE '%${escapedSearch}%' OR last_name ILIKE '%${escapedSearch}%' OR email ILIKE '%${escapedSearch}%')`);
        }
        if (roleFilter) {
          const escapedRole = roleFilter.replace(/'/g, "''");
          rawConditions.push(`role = '${escapedRole}'`);
        }

        if (rawConditions.length > 0) {
          rawQuery += ` WHERE ` + rawConditions.join(" AND ");
        }

        const countQuery = `SELECT count(*)::int AS count FROM (${rawQuery}) sub`;
        rawQuery += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

        const [rawUsersRes, rawCountRes] = await Promise.all([
          db.execute(sql.raw(rawQuery)),
          db.execute(sql.raw(countQuery)),
        ]);

        allUsers = (rawUsersRes as any)?.rows || (Array.isArray(rawUsersRes) ? rawUsersRes : []);
        const countRow = (rawCountRes as any)?.rows?.[0] || (Array.isArray(rawCountRes) ? rawCountRes[0] : null);
        count = Number(countRow?.count || 0);
      } catch (rawErr) {
        console.error("Raw SQL /users fallback failed:", rawErr);
      }
    }

    if (!allUsers || allUsers.length === 0) {
      return res.json({
        data: [],
        pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) || 1 },
      });
    }

    // Only fetch memberships for the current page of users
    const userIds = allUsers.map((u) => u.id).filter(Boolean);

    let allCohortMembers: any[] = [];
    let allGroupMembers: any[] = [];
    let allCohorts: any[] = [];
    let allGroups: any[] = [];

    if (userIds.length > 0) {
      const [cmRes, gmRes, cRes, gRes] = await Promise.all([
        db.select().from(cohortMembers).where(inArray(cohortMembers.userId, userIds)).catch((e) => { console.error("Error fetching cohortMembers:", e); return []; }),
        db.select().from(groupMembers).where(inArray(groupMembers.userId, userIds)).catch((e) => { console.error("Error fetching groupMembers:", e); return []; }),
        db.select().from(cohorts).catch((e) => { console.error("Error fetching cohorts:", e); return []; }),
        db.select().from(groups).catch((e) => { console.error("Error fetching groups:", e); return []; }),
      ]);
      allCohortMembers = cmRes || [];
      allGroupMembers = gmRes || [];
      allCohorts = cRes || [];
      allGroups = gRes || [];
    }

    const cohortMap = new Map((allCohorts || []).map((c: any) => [c.id, c.name]));
    const groupMap = new Map((allGroups || []).map((g: any) => [g.id, g.name]));

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

    const usersWithMemberships = allUsers.map((u) => {
      const normalized = normalizeUserRow(u);
      return {
        ...normalized,
        cohorts: userCohortMap.get(u.id) || [],
        groups: userGroupMap.get(u.id) || [],
      };
    });

    return res.json({
      data: usersWithMemberships,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit) || 1,
      },
    });
  } catch (err) {
    console.error("GET /users error:", err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

// GET /users/:id
userRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(400).json({ error: "Invalid user ID format" });
    }

    const headerUserId = req.headers["x-user-id"] as string | undefined;
    const headerEmail = req.headers["x-user-email"] as string | undefined;
    const headerRole = (req.headers["x-user-role"] as any) || "trainee";

    let user: any = null;

    // 1. Try fetching user by ID using Drizzle
    try {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      user = rows[0] || null;
    } catch (drizzleErr) {
      console.error(`Drizzle select by ID failed, falling back to raw SQL:`, drizzleErr);
      try {
        const rawRes = await db.execute(sql`SELECT * FROM users WHERE id = ${id}::uuid LIMIT 1`);
        const rows = (rawRes as any)?.rows || (Array.isArray(rawRes) ? rawRes : []);
        user = rows[0] || null;
      } catch (rawErr) {
        console.error(`Raw SQL fetch by ID failed:`, rawErr);
      }
    }

    // 2. If not found by ID, try fetching by email
    if (!user && headerEmail) {
      try {
        const rows = await db
          .select()
          .from(users)
          .where(eq(users.email, headerEmail))
          .limit(1);
        user = rows[0] || null;
      } catch (emailErr) {
        console.error(`Drizzle select by email failed, falling back to raw SQL:`, emailErr);
        try {
          const rawRes = await db.execute(sql`SELECT * FROM users WHERE email = ${headerEmail} LIMIT 1`);
          const rows = (rawRes as any)?.rows || (Array.isArray(rawRes) ? rawRes : []);
          user = rows[0] || null;
        } catch (rawErr) {
          console.error(`Raw SQL fetch by email failed:`, rawErr);
        }
      }
    }

    // 3. If still missing and request is for authenticated user's own profile, auto-provision
    if (!user && headerUserId && headerUserId === id && headerEmail) {
      try {
        const [newUser] = await db
          .insert(users)
          .values({
            id,
            email: headerEmail,
            firstName: "Trainee",
            lastName: "User",
            role: ["trainee", "trainer", "coordinator", "lead_trainer", "admin"].includes(headerRole) ? headerRole : "trainee",
            isActive: true,
          })
          .onConflictDoNothing()
          .returning();

        if (newUser) {
          user = newUser;
        } else {
          try {
            const rawRes = await db.execute(sql`SELECT * FROM users WHERE id = ${id}::uuid OR email = ${headerEmail} LIMIT 1`);
            const rows = (rawRes as any)?.rows || (Array.isArray(rawRes) ? rawRes : []);
            user = rows[0] || null;
          } catch { /* ignore */ }
        }
      } catch (provisionErr) {
        console.error(`Auto-provisioning user profile for ${id} failed:`, provisionErr);
      }
    }

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const membershipRes = await db
      .select()
      .from(cohortMembers)
      .where(eq(cohortMembers.userId, id))
      .limit(1)
      .catch((e) => {
        console.error("Error fetching cohort membership for user:", e);
        return [];
      });

    const normalized = normalizeUserRow(user);
    return res.json({
      ...normalized,
      cohortId: membershipRes?.[0]?.cohortId ?? null,
    });
  } catch (err) {
    console.error(`GET /users/${req.params.id} error:`, err);
    return res.status(500).json({ error: "Failed to fetch user" });
  }
});

const createUserSchema = z.object({
  id: z.string().uuid().optional(),
  email: z.string().email("Invalid email address"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  phone: z.string().optional().nullable(),
  role: z.enum(["trainee", "trainer", "coordinator", "lead_trainer", "admin", "sub_admin"]).optional().default("trainee"),
  assignedState: z.string().optional().nullable(),
  assignedLga: z.string().optional().nullable(),
  assignedZone: z.string().optional().nullable(),
  physicalSiteId: z.string().optional().nullable(),
  isCooperativeOnly: z.boolean().optional().default(false),
  passportPicture: z.string().optional().nullable(),
  passportUrl: z.string().optional().nullable(),
  avatarUrl: z.string().optional().nullable(),
  photo: z.string().optional().nullable(),
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
    targetUserIds: z.array(z.string().uuid()).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    let recipients: { id: string; email: string; firstName: string; lastName: string }[] = [];

    if (parsed.data.targetUserIds && parsed.data.targetUserIds.length > 0) {
      recipients = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .where(inArray(users.id, parsed.data.targetUserIds));
    } else {
      recipients = await db
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
    }

    for (const u of recipients) {
      await publishEvent("application.custom_email_requested", {
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        subject: parsed.data.subject,
        body: parsed.data.body,
      });
    }

    return res.json({
      message: `Dispatched bulk email to ${recipients.length} trainees`,
      count: recipients.length,
    });
  } catch (err) {
    console.error("[bulk-email] error:", err);
    return res.status(500).json({ error: "Failed to send bulk email" });
  }
});

// POST /users/bulk-status
userRouter.post("/bulk-status", async (req: Request, res: Response) => {
  const schema = z.object({
    userIds: z.array(z.string().uuid()).min(1, "userIds array cannot be empty"),
    isActive: z.boolean(),
    blacklistReason: z.string().optional().nullable(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userIds, isActive, blacklistReason } = parsed.data;

  try {
    const updatedUsers = await db
      .update(users)
      .set({
        isActive,
        blacklistReason: isActive ? null : (blacklistReason ?? null),
        updatedAt: new Date(),
      })
      .where(inArray(users.id, userIds))
      .returning();

    for (const u of updatedUsers) {
      await publishEvent("user.updated", {
        userId: u.id,
        role: u.role,
        assignedState: u.assignedState,
        assignedLga: u.assignedLga,
        assignedZone: u.assignedZone,
        isActive: u.isActive,
        blacklistReason: u.blacklistReason,
      });
    }

    return res.json({
      message: `Successfully updated status for ${updatedUsers.length} user(s)`,
      updatedCount: updatedUsers.length,
      users: updatedUsers,
    });
  } catch (err) {
    console.error("[bulk-status] error:", err);
    return res.status(500).json({ error: "Failed to update status for users" });
  }
});

// PATCH /users/:id
userRouter.patch("/:id", async (req: Request, res: Response) => {
  const allowedFields = z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    passportPicture: z.string().optional().nullable(),
    passportUrl: z.string().optional().nullable(),
    avatarUrl: z.string().optional().nullable(),
    photo: z.string().optional().nullable(),
    isActive: z.boolean().optional(),
    blacklistReason: z.string().optional().nullable(),
    role: z.enum(["trainee", "trainer", "coordinator", "lead_trainer", "admin", "sub_admin"]).optional(),
    assignedState: z.string().optional().nullable(),
    assignedLga: z.string().optional().nullable(),
    assignedZone: z.string().optional().nullable(),
    approvedRole: z.string().optional().nullable(),
    physicalSiteId: z.string().optional().nullable(),
  });

  const parsed = allowedFields.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const rawTargetId = req.params.id;
    const headerUserId = req.headers["x-user-id"] as string | undefined;
    const headerEmail = req.headers["x-user-email"] as string | undefined;

    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const validTargetId = uuidRegex.test(rawTargetId)
      ? rawTargetId
      : (headerUserId && uuidRegex.test(headerUserId) ? headerUserId : null);
    const escapedEmail = headerEmail ? headerEmail.replace(/'/g, "''") : null;

    const updateData: any = { ...parsed.data, updatedAt: new Date() };
    if (parsed.data.isActive === true) {
      updateData.blacklistReason = null;
    }

    // Populate all passport/photo fields if any photo string is provided
    const photoVal = parsed.data.passportPicture || parsed.data.passportUrl || parsed.data.avatarUrl || parsed.data.photo;
    if (photoVal) {
      updateData.passportPicture = photoVal;
      updateData.passportUrl = photoVal;
      updateData.avatarUrl = photoVal;
      updateData.photo = photoVal;
    }

    let updated: any = null;

    // Try primary Drizzle update if valid UUID targetId
    if (validTargetId) {
      try {
        const [resRow] = await db
          .update(users)
          .set(updateData)
          .where(eq(users.id, validTargetId))
          .returning();
        updated = resRow;
      } catch (updateErr) {
        console.error(`Primary Drizzle update for user ${validTargetId} failed, trying per-column raw SQL fallback:`, updateErr);
      }
    }

    // Per-column raw SQL fallback if primary update failed or targetId was not UUID
    if (!updated) {
      const colMap: Record<string, string> = {
        firstName: "first_name",
        lastName: "last_name",
        phone: "phone",
        address: "address",
        passportPicture: "passport_picture",
        passportUrl: "passport_url",
        avatarUrl: "avatar_url",
        photo: "photo",
        isActive: "is_active",
        blacklistReason: "blacklist_reason",
        role: "role",
        assignedState: "assigned_state",
        assignedLga: "assigned_lga",
        assignedZone: "assigned_zone",
        approvedRole: "approved_role",
        physicalSiteId: "physical_site_id",
      };

      const whereConditions: string[] = [];
      if (validTargetId) whereConditions.push(`id = '${validTargetId}'::uuid`);
      if (escapedEmail) whereConditions.push(`email = '${escapedEmail}'`);

      if (whereConditions.length > 0) {
        const whereSql = whereConditions.join(" OR ");

        for (const [jsKey, sqlCol] of Object.entries(colMap)) {
          if (updateData[jsKey] !== undefined) {
            try {
              const val = updateData[jsKey];
              let valSql = "NULL";
              if (val !== null) {
                if (typeof val === "boolean") {
                  valSql = `${val}`;
                } else {
                  valSql = `'${String(val).replace(/'/g, "''")}'`;
                }
              }
              await db.execute(sql.raw(`UPDATE users SET ${sqlCol} = ${valSql} WHERE ${whereSql}`));
            } catch (colErr) {
              console.warn(`Column ${sqlCol} update skipped (likely missing on DB):`, colErr);
            }
          }
        }

        try {
          await db.execute(sql.raw(`UPDATE users SET updated_at = NOW() WHERE ${whereSql}`));
          const rawRes = await db.execute(sql.raw(`SELECT * FROM users WHERE ${whereSql} LIMIT 1`));
          updated = (rawRes as any)?.rows?.[0] || (Array.isArray(rawRes) ? rawRes[0] : null);
        } catch (fetchErr) {
          console.error(`Fetching updated user row failed:`, fetchErr);
        }
      }
    }

    if (!updated) return res.status(404).json({ error: "User not found" });

    const normalized = normalizeUserRow(updated);

    await publishEvent("user.updated", {
      userId: normalized.id,
      role: normalized.role,
      assignedState: normalized.assignedState,
      assignedLga: normalized.assignedLga,
      assignedZone: normalized.assignedZone,
      isActive: normalized.isActive,
      blacklistReason: normalized.blacklistReason,
    });

    return res.json(normalized);
  } catch (err) {
    console.error("Error updating user:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /users/:id
userRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    await db
      .update(users)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(users.id, req.params.id));
    return res.json({ message: "User deactivated" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to deactivate user" });
  }
});

// ─────────────────────────────────────────────
// COHORTS
// ─────────────────────────────────────────────

cohortRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const all = await db.select().from(cohorts).orderBy(cohorts.createdAt);
    return res.json(all);
  } catch {
    return res.status(500).json({ error: "Failed to fetch cohorts" });
  }
});

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

cohortRouter.get("/:id/groups", async (req: Request, res: Response) => {
  try {
    const allGroups = await db
      .select()
      .from(groups)
      .where(eq(groups.cohortId, req.params.id))
      .orderBy(groups.createdAt);

    const groupsWithMembers = await Promise.all(
      allGroups.map(async (group) => {
        const members = await db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            phone: users.phone,
            physicalSiteId: users.physicalSiteId,
            joinedAt: groupMembers.joinedAt,
          })
          .from(groupMembers)
          .innerJoin(users, eq(users.id, groupMembers.userId))
          .where(eq(groupMembers.groupId, group.id));

        return { ...group, memberCount: members.length, members };
      })
    );

    return res.json(groupsWithMembers);
  } catch {
    return res.status(500).json({ error: "Failed to fetch groups" });
  }
});

cohortRouter.post("/:cohortId/groups/:groupId/members", async (req: Request, res: Response) => {
  const schema = z.object({ userId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { cohortId, groupId } = req.params;
  const { userId } = parsed.data;

  try {
    const [cohortMember] = await db
      .select()
      .from(cohortMembers)
      .where(and(eq(cohortMembers.userId, userId), eq(cohortMembers.cohortId, cohortId)))
      .limit(1);

    if (!cohortMember) {
      return res.status(400).json({ error: "User must be enrolled in this cohort before joining a group" });
    }

    const [group] = await db
      .select()
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);

    if (!group || group.cohortId !== cohortId) {
      return res.status(400).json({ error: "Group does not belong to this cohort" });
    }

    const [alreadyMember] = await db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .limit(1);

    if (alreadyMember) {
      return res.status(409).json({ error: "User is already a member of this group" });
    }

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

cohortRouter.delete("/:cohortId/groups/:groupId/members/:userId", async (req: Request, res: Response) => {
  const { groupId, userId } = req.params;
  if (!groupId || !userId) {
    return res.status(400).json({ error: "Missing required route parameters" });
  }
  try {
    await db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
    return res.json({ message: "Member removed from group" });
  } catch {
    return res.status(500).json({ error: "Failed to remove member from group" });
  }
});