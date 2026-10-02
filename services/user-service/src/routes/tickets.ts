import { Router, Request, Response } from "express";
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../index";
import { publishEvent } from "../rabbitmq";
import {
  users,
  groups,
  groupMembers,
  groupTrainers,
  cohortMembers,
  trainerTickets,
  trainerTicketMessages,
} from "../db/schema";

// ─────────────────────────────────────────────
// TRAINER SUPPORT TICKETS
//   Reporter (any signed-in LMS user): create, view own, reply, reopen, close, rate
//   Staff (admin, sub_admin):          view all, reply, internal notes, triage, assign
// Identity always comes from the gateway-injected x-user-* headers.
// ─────────────────────────────────────────────

export const ticketsRouter = Router();

const STAFF_ROLES = ["admin", "sub_admin"];

export const TICKET_CATEGORIES = [
  { id: "absence", label: "Absent or late to sessions" },
  { id: "conduct", label: "Unprofessional or disrespectful conduct" },
  { id: "harassment", label: "Harassment or abuse" },
  { id: "teaching_quality", label: "Teaching quality or unclear explanations" },
  { id: "assessment", label: "Assessment, grading or attendance records" },
  { id: "extortion", label: "Request for money or favours" },
  { id: "practical_session", label: "Practical session or site organisation" },
  { id: "communication", label: "Unresponsive or hard to reach" },
  { id: "other", label: "Something else" },
] as const;

export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const TICKET_STATUSES = ["open", "in_progress", "awaiting_reporter", "resolved", "closed"] as const;

// Serious categories always start as urgent so they reach the top of the queue
const URGENT_CATEGORIES = new Set(["harassment", "extortion"]);

// Wording used in emails to the reporter
const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  awaiting_reporter: "Waiting for your reply",
  resolved: "Resolved",
  closed: "Closed",
};
// Neutral wording for the audit trail, which both sides can read
const EVENT_STATUS_LABELS: Record<string, string> = { ...STATUS_LABELS, awaiting_reporter: "Waiting for trainee" };

function caller(req: Request) {
  const id = req.headers["x-user-id"] as string | undefined;
  const role = (req.headers["x-user-role"] as string | undefined) || "";
  const email = (req.headers["x-user-email"] as string | undefined) || "";
  return { id, role, email, isStaff: STAFF_ROLES.includes(role) };
}

async function loadProfile(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return u || null;
}

const fullName = (u: { firstName?: string | null; lastName?: string | null; email?: string | null }) =>
  [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "Unknown";

// Short, unambiguous, non-sequential code (no 0/O/1/I)
function newTicketCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(6);
  return "TKT-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// Trainers assigned to the groups this user belongs to
async function trainersForUser(userId: string) {
  const memberships = await db
    .select({ groupId: groupMembers.groupId, groupName: groups.name, cohortId: groups.cohortId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.userId, userId));
  if (!memberships.length) return { memberships, trainers: [] as Array<{ id: string; name: string; groupId: string; groupName: string; assignedDay: string | null }> };

  const rows = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      groupId: groupTrainers.groupId,
      assignedDay: groupTrainers.assignedDay,
    })
    .from(groupTrainers)
    .innerJoin(users, eq(users.id, groupTrainers.trainerId))
    .where(inArray(groupTrainers.groupId, memberships.map((m) => m.groupId)));

  const groupName = new Map(memberships.map((m) => [m.groupId, m.groupName]));
  const seen = new Set<string>();
  const trainers = rows
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map((r) => ({
      id: r.id,
      name: fullName(r),
      groupId: r.groupId,
      groupName: groupName.get(r.groupId) || "",
      assignedDay: r.assignedDay,
    }));
  return { memberships, trainers };
}

// What the reporter is allowed to see: no internal notes, no staff assignment details
function forReporter(ticket: typeof trainerTickets.$inferSelect) {
  const { assignedToId: _a, ...rest } = ticket;
  return rest;
}

async function addEvent(ticketId: string, author: { id: string; name: string; role: string }, body: string) {
  await db.insert(trainerTicketMessages).values({
    ticketId,
    authorId: author.id,
    authorName: author.name,
    authorRole: author.role,
    kind: "event",
    body,
  });
}

async function notify(routingKey: string, payload: Record<string, unknown>) {
  try {
    await publishEvent(routingKey, payload);
  } catch (err) {
    console.error(`[tickets] Failed to publish ${routingKey}:`, err);
  }
}

// ─────────────────────────────────────────────
// GET /tickets/options — categories + the caller's own trainers for the form
// ─────────────────────────────────────────────
ticketsRouter.get("/options", async (req: Request, res: Response) => {
  const me = caller(req);
  if (!me.id) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { trainers } = await trainersForUser(me.id);
    return res.json({ categories: TICKET_CATEGORIES, priorities: TICKET_PRIORITIES, trainers });
  } catch (err) {
    console.error("[tickets] options error:", err);
    return res.status(500).json({ error: "Failed to load ticket options" });
  }
});

// ─────────────────────────────────────────────
// POST /tickets — raise a ticket
// ─────────────────────────────────────────────
const createSchema = z
  .object({
    trainerId: z.string().uuid().optional(),
    trainerName: z.string().trim().max(255).optional(),
    category: z.enum(TICKET_CATEGORIES.map((c) => c.id) as [string, ...string[]]),
    priority: z.enum(TICKET_PRIORITIES).default("medium"),
    subject: z.string().trim().min(5, "Give the ticket a short title (at least 5 characters)").max(200),
    description: z.string().trim().min(20, "Describe what happened in at least 20 characters").max(5000),
    incidentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    attachmentUrl: z.string().url().startsWith("https://").max(1000).optional(),
    attachmentName: z.string().max(255).optional(),
  })
  .refine((d) => d.trainerId || d.trainerName, { message: "Choose the trainer this ticket is about", path: ["trainerId"] });

ticketsRouter.post("/", async (req: Request, res: Response) => {
  const me = caller(req);
  if (!me.id) return res.status(401).json({ error: "Unauthorized" });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return res.status(400).json({ error: first?.message || "Invalid ticket", details: parsed.error.flatten() });
  }
  const data = parsed.data;

  try {
    const profile = await loadProfile(me.id);
    if (!profile) return res.status(404).json({ error: "Your profile could not be found" });

    const { memberships, trainers } = await trainersForUser(me.id);
    let trainerId: string | null = null;
    let trainerName = data.trainerName || "";
    let groupId: string | null = memberships[0]?.groupId ?? null;
    let groupName: string | null = memberships[0]?.groupName ?? null;

    if (data.trainerId) {
      const trainer = trainers.find((t) => t.id === data.trainerId);
      if (!trainer) return res.status(400).json({ error: "That trainer is not assigned to any of your groups" });
      trainerId = trainer.id;
      trainerName = trainer.name;
      groupId = trainer.groupId;
      groupName = trainer.groupName;
    }

    const [membership] = await db
      .select({ cohortId: cohortMembers.cohortId })
      .from(cohortMembers)
      .where(eq(cohortMembers.userId, me.id))
      .limit(1);

    const priority = URGENT_CATEGORIES.has(data.category) ? "urgent" : data.priority;

    let ticket: typeof trainerTickets.$inferSelect | undefined;
    for (let attempt = 0; attempt < 3 && !ticket; attempt++) {
      try {
        [ticket] = await db
          .insert(trainerTickets)
          .values({
            code: newTicketCode(),
            reporterId: me.id,
            reporterName: fullName(profile),
            reporterEmail: profile.email,
            reporterPhone: profile.phone || null,
            cohortId: membership?.cohortId || null,
            groupId,
            groupName,
            physicalSiteId: profile.physicalSiteId || null,
            trainerId,
            trainerName,
            category: data.category,
            priority,
            subject: data.subject,
            description: data.description,
            incidentDate: data.incidentDate || null,
            attachmentUrl: data.attachmentUrl || null,
            attachmentName: data.attachmentName || null,
          })
          .returning();
      } catch (err: any) {
        if (err?.code !== "23505") throw err; // retry only on code collision
      }
    }
    if (!ticket) throw new Error("Could not allocate a ticket code");

    await addEvent(ticket.id, { id: me.id, name: ticket.reporterName, role: me.role || "trainee" }, "Ticket opened");

    await notify("ticket.created", {
      ticketId: ticket.id,
      code: ticket.code,
      subject: ticket.subject,
      category: TICKET_CATEGORIES.find((c) => c.id === ticket!.category)?.label || ticket.category,
      priority: ticket.priority,
      trainerName: ticket.trainerName,
      reporterName: ticket.reporterName,
      reporterEmail: ticket.reporterEmail,
      firstName: profile.firstName,
    });

    return res.status(201).json(forReporter(ticket));
  } catch (err) {
    console.error("[tickets] create error:", err);
    return res.status(500).json({ error: "Failed to create ticket" });
  }
});

// ─────────────────────────────────────────────
// GET /tickets/mine — the caller's own tickets
// ─────────────────────────────────────────────
ticketsRouter.get("/mine", async (req: Request, res: Response) => {
  const me = caller(req);
  if (!me.id) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = await db
      .select()
      .from(trainerTickets)
      .where(eq(trainerTickets.reporterId, me.id))
      .orderBy(desc(trainerTickets.updatedAt));
    return res.json(rows.map(forReporter));
  } catch (err) {
    console.error("[tickets] mine error:", err);
    return res.status(500).json({ error: "Failed to load your tickets" });
  }
});

// ─────────────────────────────────────────────
// GET /tickets — staff queue with filters
// ─────────────────────────────────────────────
ticketsRouter.get("/", async (req: Request, res: Response) => {
  const me = caller(req);
  if (!me.isStaff) return res.status(403).json({ error: "Forbidden" });

  const { status, priority, category, trainerId, assignedTo, search } = req.query as Record<string, string | undefined>;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

  const conditions: SQL[] = [];
  if (status === "active") conditions.push(inArray(trainerTickets.status, ["open", "in_progress", "awaiting_reporter"]));
  else if (status && status !== "all") conditions.push(eq(trainerTickets.status, status));
  if (priority && priority !== "all") conditions.push(eq(trainerTickets.priority, priority));
  if (category && category !== "all") conditions.push(eq(trainerTickets.category, category));
  if (trainerId) conditions.push(eq(trainerTickets.trainerId, trainerId));
  if (assignedTo === "me" && me.id) conditions.push(eq(trainerTickets.assignedToId, me.id));
  else if (assignedTo === "unassigned") conditions.push(sql`${trainerTickets.assignedToId} is null`);
  if (search?.trim()) {
    const q = `%${search.trim()}%`;
    conditions.push(
      or(
        ilike(trainerTickets.code, q),
        ilike(trainerTickets.subject, q),
        ilike(trainerTickets.reporterName, q),
        ilike(trainerTickets.reporterEmail, q),
        ilike(trainerTickets.trainerName, q),
      )!,
    );
  }
  const where = conditions.length ? and(...conditions) : undefined;

  try {
    const priorityOrder = sql`case ${trainerTickets.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(trainerTickets)
        .where(where)
        .orderBy(priorityOrder, desc(trainerTickets.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: sql<number>`count(*)::int` }).from(trainerTickets).where(where),
    ]);
    return res.json({ tickets: rows, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error("[tickets] list error:", err);
    return res.status(500).json({ error: "Failed to load tickets" });
  }
});

// ─────────────────────────────────────────────
// GET /tickets/stats — staff dashboard numbers
// ─────────────────────────────────────────────
ticketsRouter.get("/stats", async (req: Request, res: Response) => {
  const me = caller(req);
  if (!me.isStaff) return res.status(403).json({ error: "Forbidden" });
  try {
    const byStatus = await db
      .select({ status: trainerTickets.status, count: sql<number>`count(*)::int` })
      .from(trainerTickets)
      .groupBy(trainerTickets.status);

    const [summary] = await db
      .select({
        urgentActive: sql<number>`count(*) filter (where ${trainerTickets.priority} = 'urgent' and ${trainerTickets.status} in ('open','in_progress','awaiting_reporter'))::int`,
        unassignedActive: sql<number>`count(*) filter (where ${trainerTickets.assignedToId} is null and ${trainerTickets.status} in ('open','in_progress','awaiting_reporter'))::int`,
        overdue: sql<number>`count(*) filter (where ${trainerTickets.firstResponseAt} is null and ${trainerTickets.status} = 'open' and ${trainerTickets.createdAt} < now() - interval '48 hours')::int`,
        avgFirstResponseHours: sql<number | null>`round(avg(extract(epoch from (${trainerTickets.firstResponseAt} - ${trainerTickets.createdAt})) / 3600)::numeric, 1)::float`,
        avgSatisfaction: sql<number | null>`round(avg(${trainerTickets.satisfactionRating})::numeric, 1)::float`,
      })
      .from(trainerTickets);

    // Trainers with the most tickets in the last 90 days — patterns matter more than single reports
    const byTrainer = await db
      .select({
        trainerId: trainerTickets.trainerId,
        trainerName: trainerTickets.trainerName,
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${trainerTickets.status} in ('open','in_progress','awaiting_reporter'))::int`,
      })
      .from(trainerTickets)
      .where(sql`${trainerTickets.createdAt} > now() - interval '90 days'`)
      .groupBy(trainerTickets.trainerId, trainerTickets.trainerName)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    return res.json({
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
      ...summary,
      byTrainer,
    });
  } catch (err) {
    console.error("[tickets] stats error:", err);
    return res.status(500).json({ error: "Failed to load ticket stats" });
  }
});

// ─────────────────────────────────────────────
// GET /tickets/assignees — staff who can own tickets
// ─────────────────────────────────────────────
ticketsRouter.get("/assignees", async (req: Request, res: Response) => {
  const me = caller(req);
  if (!me.isStaff) return res.status(403).json({ error: "Forbidden" });
  try {
    const staff = await db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, role: users.role })
      .from(users)
      .where(and(inArray(users.role, STAFF_ROLES), eq(users.isActive, true)));
    return res.json(staff.map((s) => ({ id: s.id, name: fullName(s), role: s.role })));
  } catch (err) {
    console.error("[tickets] assignees error:", err);
    return res.status(500).json({ error: "Failed to load staff" });
  }
});

async function loadTicketFor(req: Request, res: Response) {
  const me = caller(req);
  if (!me.id) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(404).json({ error: "Ticket not found" });
    return null;
  }
  const [ticket] = await db.select().from(trainerTickets).where(eq(trainerTickets.id, req.params.id)).limit(1);
  if (!ticket || (!me.isStaff && ticket.reporterId !== me.id)) {
    res.status(404).json({ error: "Ticket not found" });
    return null;
  }
  return { me, ticket };
}

// ─────────────────────────────────────────────
// GET /tickets/:id — ticket + conversation
// ─────────────────────────────────────────────
ticketsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const ctx = await loadTicketFor(req, res);
    if (!ctx) return;
    const { me, ticket } = ctx;

    const messages = await db
      .select()
      .from(trainerTicketMessages)
      .where(
        me.isStaff
          ? eq(trainerTicketMessages.ticketId, ticket.id)
          : and(eq(trainerTicketMessages.ticketId, ticket.id), inArray(trainerTicketMessages.kind, ["reply", "event"])),
      )
      .orderBy(trainerTicketMessages.createdAt);

    if (!me.isStaff) return res.json({ ticket: forReporter(ticket), messages });

    // Other tickets about the same trainer help staff see a pattern
    const related = ticket.trainerId
      ? await db
          .select({
            id: trainerTickets.id,
            code: trainerTickets.code,
            subject: trainerTickets.subject,
            status: trainerTickets.status,
            createdAt: trainerTickets.createdAt,
          })
          .from(trainerTickets)
          .where(and(eq(trainerTickets.trainerId, ticket.trainerId), sql`${trainerTickets.id} <> ${ticket.id}`))
          .orderBy(desc(trainerTickets.createdAt))
          .limit(10)
      : [];

    return res.json({ ticket, messages, relatedTickets: related });
  } catch (err) {
    console.error("[tickets] get error:", err);
    return res.status(500).json({ error: "Failed to load ticket" });
  }
});

// ─────────────────────────────────────────────
// POST /tickets/:id/messages — reply (or staff internal note)
// ─────────────────────────────────────────────
const messageSchema = z.object({
  body: z.string().trim().min(1, "Write a message").max(5000),
  internal: z.boolean().optional().default(false),
});

ticketsRouter.post("/:id/messages", async (req: Request, res: Response) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid message" });

  try {
    const ctx = await loadTicketFor(req, res);
    if (!ctx) return;
    const { me, ticket } = ctx;
    const internal = me.isStaff && parsed.data.internal;

    if (!me.isStaff && ticket.status === "closed") {
      return res.status(409).json({ error: "This ticket is closed. Open a new ticket if you need more help." });
    }

    const profile = await loadProfile(me.id!);
    const authorName = profile ? fullName(profile) : me.email || "Staff";
    const now = new Date();

    const [message] = await db
      .insert(trainerTicketMessages)
      .values({
        ticketId: ticket.id,
        authorId: me.id!,
        authorName,
        authorRole: me.role || "trainee",
        kind: internal ? "internal_note" : "reply",
        body: parsed.data.body,
      })
      .returning();

    const updates: Partial<typeof trainerTickets.$inferInsert> = { updatedAt: now };
    if (me.isStaff && !internal) {
      if (!ticket.firstResponseAt) updates.firstResponseAt = now;
      if (ticket.status === "open") updates.status = "in_progress";
    }
    // A reporter replying to a "waiting for you" or resolved ticket puts it back in the queue
    if (!me.isStaff && ["awaiting_reporter", "resolved"].includes(ticket.status)) {
      updates.status = "in_progress";
      updates.resolvedAt = null;
    }
    const [updated] = await db.update(trainerTickets).set(updates).where(eq(trainerTickets.id, ticket.id)).returning();
    if (updates.status && updates.status !== ticket.status) {
      await addEvent(
        ticket.id,
        { id: me.id!, name: authorName, role: me.role || "trainee" },
        `Status changed from "${EVENT_STATUS_LABELS[ticket.status]}" to "${EVENT_STATUS_LABELS[updates.status]}"`,
      );
    }

    if (me.isStaff && !internal) {
      await notify("ticket.replied", {
        ticketId: ticket.id,
        code: ticket.code,
        subject: ticket.subject,
        reporterEmail: ticket.reporterEmail,
        reporterName: ticket.reporterName,
        message: parsed.data.body,
        status: STATUS_LABELS[updated.status] || updated.status,
      });
    }

    return res.status(201).json({ message, ticket: me.isStaff ? updated : forReporter(updated) });
  } catch (err) {
    console.error("[tickets] message error:", err);
    return res.status(500).json({ error: "Failed to send message" });
  }
});

// ─────────────────────────────────────────────
// PATCH /tickets/:id — staff triage; reporter may reopen or close
// ─────────────────────────────────────────────
const staffUpdateSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  category: z.enum(TICKET_CATEGORIES.map((c) => c.id) as [string, ...string[]]).optional(),
  assignedToId: z.string().uuid().nullable().optional(),
});
const reporterUpdateSchema = z.object({ status: z.enum(["in_progress", "closed"]) });

ticketsRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const ctx = await loadTicketFor(req, res);
    if (!ctx) return;
    const { me, ticket } = ctx;
    const profile = await loadProfile(me.id!);
    const actor = { id: me.id!, name: profile ? fullName(profile) : me.email || "Staff", role: me.role };
    const now = new Date();
    const updates: Partial<typeof trainerTickets.$inferInsert> = { updatedAt: now };
    const events: string[] = [];

    if (me.isStaff) {
      const parsed = staffUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid update" });
      const d = parsed.data;

      if (d.priority && d.priority !== ticket.priority) {
        updates.priority = d.priority;
        events.push(`Priority changed from ${ticket.priority} to ${d.priority}`);
      }
      if (d.category && d.category !== ticket.category) {
        updates.category = d.category;
        events.push(`Category changed to "${TICKET_CATEGORIES.find((c) => c.id === d.category)?.label}"`);
      }
      if (d.assignedToId !== undefined && d.assignedToId !== ticket.assignedToId) {
        if (d.assignedToId) {
          const assignee = await loadProfile(d.assignedToId);
          if (!assignee || !STAFF_ROLES.includes(assignee.role)) {
            return res.status(400).json({ error: "Tickets can only be assigned to an admin or sub-admin" });
          }
          updates.assignedToId = assignee.id;
          updates.assignedToName = fullName(assignee);
          events.push(`Assigned to ${fullName(assignee)}`);
        } else {
          updates.assignedToId = null;
          updates.assignedToName = null;
          events.push("Unassigned");
        }
      }
      if (d.status && d.status !== ticket.status) updates.status = d.status;
    } else {
      const parsed = reporterUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "You can only reopen or close your ticket" });
      const target = parsed.data.status;
      if (target === "in_progress" && !["resolved", "awaiting_reporter"].includes(ticket.status)) {
        return res.status(409).json({ error: "Only resolved tickets can be reopened" });
      }
      if (target === "closed" && ticket.status === "closed") {
        return res.status(409).json({ error: "This ticket is already closed" });
      }
      updates.status = target;
    }

    if (updates.status) {
      events.push(`Status changed from "${EVENT_STATUS_LABELS[ticket.status]}" to "${EVENT_STATUS_LABELS[updates.status]}"`);
      if (updates.status === "resolved") updates.resolvedAt = now;
      if (updates.status === "closed") updates.closedAt = now;
      if (["open", "in_progress", "awaiting_reporter"].includes(updates.status)) {
        updates.resolvedAt = null;
        updates.closedAt = null;
      }
      if (me.isStaff && !ticket.firstResponseAt && updates.status !== "open") updates.firstResponseAt = now;
    }

    if (!events.length) return res.json(me.isStaff ? ticket : forReporter(ticket));

    const [updated] = await db.update(trainerTickets).set(updates).where(eq(trainerTickets.id, ticket.id)).returning();
    for (const e of events) await addEvent(ticket.id, actor, e);

    if (me.isStaff && updates.status && ["awaiting_reporter", "resolved", "closed"].includes(updates.status)) {
      await notify("ticket.status_changed", {
        ticketId: ticket.id,
        code: ticket.code,
        subject: ticket.subject,
        reporterEmail: ticket.reporterEmail,
        reporterName: ticket.reporterName,
        status: STATUS_LABELS[updates.status],
      });
    }

    return res.json(me.isStaff ? updated : forReporter(updated));
  } catch (err) {
    console.error("[tickets] update error:", err);
    return res.status(500).json({ error: "Failed to update ticket" });
  }
});

// ─────────────────────────────────────────────
// POST /tickets/:id/rating — reporter rates how it was handled
// ─────────────────────────────────────────────
const ratingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});

ticketsRouter.post("/:id/rating", async (req: Request, res: Response) => {
  const parsed = ratingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Rating must be a whole number from 1 to 5" });
  try {
    const ctx = await loadTicketFor(req, res);
    if (!ctx) return;
    const { me, ticket } = ctx;
    if (ticket.reporterId !== me.id) return res.status(403).json({ error: "Only the person who raised the ticket can rate it" });
    if (!["resolved", "closed"].includes(ticket.status)) {
      return res.status(409).json({ error: "You can rate a ticket once it is resolved" });
    }
    const [updated] = await db
      .update(trainerTickets)
      .set({
        satisfactionRating: parsed.data.rating,
        satisfactionComment: parsed.data.comment || null,
        updatedAt: new Date(),
      })
      .where(eq(trainerTickets.id, ticket.id))
      .returning();
    return res.json(forReporter(updated));
  } catch (err) {
    console.error("[tickets] rating error:", err);
    return res.status(500).json({ error: "Failed to save rating" });
  }
});
