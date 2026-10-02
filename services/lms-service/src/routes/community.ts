import { Router, Request, Response } from "express";
import { eq, and, desc, sql, inArray, ilike, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import {
  communityQuestions,
  communityAnswers,
  communityReplies,
  communityChatMessages,
} from "../db/schema";

const router = Router();

// ─────────────────────────────────────────────
// CHANNELS — the single list the frontend renders
// ─────────────────────────────────────────────
export const COMMUNITY_CHANNELS = [
  { id: "general", name: "General Discussion", description: "Questions and news for the whole cohort" },
  { id: "poultry", name: "Livestock Care & Housing", description: "Feeding, housing, breeding and daily animal care" },
  { id: "health", name: "Animal Health", description: "Vaccination, disease, treatment and biosecurity" },
  { id: "assignments", name: "Lessons, Quizzes & Exams", description: "Help with weekly lessons, quizzes and assessments" },
  { id: "agribusiness", name: "Agribusiness & Markets", description: "Cooperatives, savings, pricing and selling" },
] as const;
const CHANNEL_IDS = COMMUNITY_CHANNELS.map((c) => c.id) as [string, ...string[]];
const channelName = (id: string) => COMMUNITY_CHANNELS.find((c) => c.id === id)?.name || "General Discussion";

// Staff answers are marked verified; staff can moderate and pin
const STAFF_ROLES = ["trainer", "lead_trainer", "coordinator", "admin", "sub_admin"];
const MODERATOR_ROLES = ["trainer", "lead_trainer", "admin", "sub_admin"];

// ─────────────────────────────────────────────
// AUTHOR IDENTITY
// The gateway only passes id/email/role, so the display name and photo are looked
// up from user-service and cached briefly.
// ─────────────────────────────────────────────
type Author = { authorId: string; authorName: string; authorRole: string; authorAvatar: string | null };
const authorCache = new Map<string, { value: Omit<Author, "authorRole">; expires: number }>();
const AUTHOR_TTL_MS = 10 * 60 * 1000;

async function getAuthor(req: Request): Promise<Author | null> {
  const authorId = req.headers["x-user-id"] as string | undefined;
  if (!authorId || !z.string().uuid().safeParse(authorId).success) return null;
  const authorRole = (req.headers["x-user-role"] as string) || "trainee";
  const email = (req.headers["x-user-email"] as string) || "";

  const cached = authorCache.get(authorId);
  if (cached && cached.expires > Date.now()) return { ...cached.value, authorRole };

  let authorName = email.split("@")[0] || "LMS user";
  let authorAvatar: string | null = null;
  try {
    const r = await fetch(`${process.env.USER_SERVICE_URL}/users/${authorId}`, {
      headers: { "x-user-id": authorId, "x-user-role": authorRole },
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      const u = (await r.json()) as { firstName?: string; lastName?: string; avatarUrl?: string | null };
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
      if (name) authorName = name;
      // Only keep hosted images; base64 photos are far too large to copy onto every post
      if (typeof u.avatarUrl === "string" && /^https:\/\//.test(u.avatarUrl)) authorAvatar = u.avatarUrl;
    }
  } catch (err) {
    console.warn("[community] Could not look up author name:", err);
  }
  const value = { authorId, authorName, authorAvatar };
  authorCache.set(authorId, { value, expires: Date.now() + AUTHOR_TTL_MS });
  return { ...value, authorRole };
}

function requireAuthor(author: Author | null, res: Response): author is Author {
  if (!author) {
    res.status(401).json({ error: "Sign in to take part in the community" });
    return false;
  }
  return true;
}

const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

// Never send the list of who upvoted — just the count and whether the caller did
function presentVotes<T extends { upvotedBy: unknown; upvotes: number }>(row: T, viewerId?: string) {
  const { upvotedBy, ...rest } = row;
  const voters = Array.isArray(upvotedBy) ? (upvotedBy as string[]) : [];
  return { ...rest, hasUpvoted: viewerId ? voters.includes(viewerId) : false };
}

// GET /channels — channel list with question counts
router.get("/channels", async (_req: Request, res: Response) => {
  try {
    const counts = await db
      .select({ channelId: communityQuestions.channelId, count: sql<number>`count(*)::int` })
      .from(communityQuestions)
      .groupBy(communityQuestions.channelId);
    const byId = new Map(counts.map((c) => [c.channelId, c.count]));
    return res.json(COMMUNITY_CHANNELS.map((c) => ({ ...c, questionCount: byId.get(c.id) || 0 })));
  } catch (err) {
    console.error("[community][GET /channels] Error:", err);
    return res.status(500).json({ error: "Failed to load channels" });
  }
});

// ─────────────────────────────────────────────
// Q&A
// ─────────────────────────────────────────────

// GET /questions?channel=&filter=all|unanswered|solved|mine&search=&sort=newest|top|active&page=&limit=
router.get("/questions", async (req: Request, res: Response) => {
  const viewerId = req.headers["x-user-id"] as string | undefined;
  const { channel, filter, search, sort } = req.query as Record<string, string | undefined>;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

  const conditions: SQL[] = [];
  if (channel && channel !== "all") conditions.push(eq(communityQuestions.channelId, channel));
  if (filter === "solved") conditions.push(eq(communityQuestions.isSolved, true));
  if (filter === "unanswered") {
    conditions.push(sql`not exists (select 1 from community_answers a where a.question_id = ${communityQuestions.id})`);
  }
  if (filter === "mine" && viewerId) conditions.push(eq(communityQuestions.authorId, viewerId));
  if (search?.trim()) {
    const q = `%${search.trim()}%`;
    conditions.push(or(ilike(communityQuestions.title, q), ilike(communityQuestions.content, q))!);
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const lastActivity = sql`greatest(${communityQuestions.updatedAt}, coalesce((select max(a.created_at) from community_answers a where a.question_id = ${communityQuestions.id}), ${communityQuestions.createdAt}))`;
  const orderBy =
    sort === "top"
      ? [desc(communityQuestions.upvotes), desc(communityQuestions.createdAt)]
      : sort === "active"
        ? [desc(lastActivity)]
        : [desc(communityQuestions.createdAt)];

  try {
    const [rows, [{ total }]] = await Promise.all([
      db.select().from(communityQuestions).where(where).orderBy(...orderBy).limit(limit).offset((page - 1) * limit),
      db.select({ total: sql<number>`count(*)::int` }).from(communityQuestions).where(where),
    ]);

    const questionIds = rows.map((q) => q.id);
    const answers = questionIds.length
      ? await db
          .select()
          .from(communityAnswers)
          .where(inArray(communityAnswers.questionId, questionIds))
          .orderBy(communityAnswers.createdAt)
      : [];
    const answerIds = answers.map((a) => a.id);
    const replies = answerIds.length
      ? await db
          .select()
          .from(communityReplies)
          .where(inArray(communityReplies.answerId, answerIds))
          .orderBy(communityReplies.createdAt)
      : [];

    const questions = rows.map((q) => ({
      ...presentVotes(q, viewerId),
      channelName: channelName(q.channelId),
      answers: answers
        .filter((a) => a.questionId === q.id)
        .map((a) => ({ ...presentVotes(a, viewerId), replies: replies.filter((r) => r.answerId === a.id) })),
    }));

    return res.json({ questions, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error("[community][GET /questions] Error:", err);
    return res.status(500).json({ error: "Failed to fetch questions" });
  }
});

// GET /questions/:id — one question with all answers and replies
router.get("/questions/:id", async (req: Request, res: Response) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Question not found" });
  const viewerId = req.headers["x-user-id"] as string | undefined;
  try {
    const [question] = await db.select().from(communityQuestions).where(eq(communityQuestions.id, req.params.id)).limit(1);
    if (!question) return res.status(404).json({ error: "Question not found" });
    const answers = await db
      .select()
      .from(communityAnswers)
      .where(eq(communityAnswers.questionId, question.id))
      .orderBy(communityAnswers.createdAt);
    const replies = answers.length
      ? await db
          .select()
          .from(communityReplies)
          .where(inArray(communityReplies.answerId, answers.map((a) => a.id)))
          .orderBy(communityReplies.createdAt)
      : [];
    return res.json({
      ...presentVotes(question, viewerId),
      channelName: channelName(question.channelId),
      answers: answers.map((a) => ({ ...presentVotes(a, viewerId), replies: replies.filter((r) => r.answerId === a.id) })),
    });
  } catch (err) {
    console.error("[community][GET /questions/:id] Error:", err);
    return res.status(500).json({ error: "Failed to fetch question" });
  }
});

const createQuestionSchema = z.object({
  title: z.string().trim().min(8, "Make the title a little longer (at least 8 characters)").max(200),
  content: z.string().trim().min(15, "Add some detail to your question (at least 15 characters)").max(5000),
  channelId: z.enum(CHANNEL_IDS).default("general"),
  tags: z.array(z.string().trim().min(1).max(30)).max(5).optional().default([]),
});

router.post("/questions", async (req: Request, res: Response) => {
  const parsed = createQuestionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid question" });
  try {
    const author = await getAuthor(req);
    if (!requireAuthor(author, res)) return;
    const [question] = await db
      .insert(communityQuestions)
      .values({
        title: parsed.data.title,
        content: parsed.data.content,
        channelId: parsed.data.channelId,
        channelName: channelName(parsed.data.channelId),
        tags: Array.from(new Set(parsed.data.tags.map((t) => t.toLowerCase()))),
        ...author,
      })
      .returning();
    return res.status(201).json({ ...presentVotes(question, author.authorId), answers: [] });
  } catch (err) {
    console.error("[community][POST /questions] Error:", err);
    return res.status(500).json({ error: "Failed to post question" });
  }
});

async function toggleVote(table: typeof communityQuestions | typeof communityAnswers, id: string, voterId: string) {
  const [row] = await db.select().from(table).where(eq(table.id, id)).limit(1);
  if (!row) return null;
  const voters = Array.isArray(row.upvotedBy) ? (row.upvotedBy as string[]) : [];
  const next = voters.includes(voterId) ? voters.filter((v) => v !== voterId) : [...voters, voterId];
  const [updated] = await db
    .update(table)
    .set({ upvotes: next.length, upvotedBy: next })
    .where(eq(table.id, id))
    .returning();
  return updated;
}

router.post("/questions/:id/upvote", async (req: Request, res: Response) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Question not found" });
  try {
    const author = await getAuthor(req);
    if (!requireAuthor(author, res)) return;
    const updated = await toggleVote(communityQuestions, req.params.id, author.authorId);
    if (!updated) return res.status(404).json({ error: "Question not found" });
    return res.json(presentVotes(updated, author.authorId));
  } catch (err) {
    console.error("[community][POST /questions/:id/upvote] Error:", err);
    return res.status(500).json({ error: "Failed to upvote question" });
  }
});

const contentSchema = z.object({ content: z.string().trim().min(2, "Write a little more").max(5000) });

router.post("/questions/:id/answers", async (req: Request, res: Response) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Question not found" });
  const parsed = contentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid answer" });
  try {
    const author = await getAuthor(req);
    if (!requireAuthor(author, res)) return;
    const [question] = await db.select({ id: communityQuestions.id }).from(communityQuestions).where(eq(communityQuestions.id, req.params.id)).limit(1);
    if (!question) return res.status(404).json({ error: "Question not found" });

    const [answer] = await db
      .insert(communityAnswers)
      .values({
        questionId: question.id,
        content: parsed.data.content,
        ...author,
        isVerified: STAFF_ROLES.includes(author.authorRole),
      })
      .returning();
    await db.update(communityQuestions).set({ updatedAt: new Date() }).where(eq(communityQuestions.id, question.id));
    return res.status(201).json({ ...presentVotes(answer, author.authorId), replies: [] });
  } catch (err) {
    console.error("[community][POST /questions/:id/answers] Error:", err);
    return res.status(500).json({ error: "Failed to post answer" });
  }
});

router.post("/answers/:id/upvote", async (req: Request, res: Response) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Answer not found" });
  try {
    const author = await getAuthor(req);
    if (!requireAuthor(author, res)) return;
    const updated = await toggleVote(communityAnswers, req.params.id, author.authorId);
    if (!updated) return res.status(404).json({ error: "Answer not found" });
    return res.json(presentVotes(updated, author.authorId));
  } catch (err) {
    console.error("[community][POST /answers/:id/upvote] Error:", err);
    return res.status(500).json({ error: "Failed to upvote answer" });
  }
});

router.post("/answers/:id/replies", async (req: Request, res: Response) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Answer not found" });
  const parsed = contentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid reply" });
  try {
    const author = await getAuthor(req);
    if (!requireAuthor(author, res)) return;
    const [answer] = await db.select({ id: communityAnswers.id }).from(communityAnswers).where(eq(communityAnswers.id, req.params.id)).limit(1);
    if (!answer) return res.status(404).json({ error: "Answer not found" });
    const [reply] = await db
      .insert(communityReplies)
      .values({ answerId: answer.id, content: parsed.data.content, ...author })
      .returning();
    return res.status(201).json(reply);
  } catch (err) {
    console.error("[community][POST /answers/:id/replies] Error:", err);
    return res.status(500).json({ error: "Failed to post reply" });
  }
});

// PATCH /questions/:id/solve — { answerId } marks the accepted answer; { answerId: null } clears it.
// Only the person who asked, or staff, can do this.
router.patch("/questions/:id/solve", async (req: Request, res: Response) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Question not found" });
  const parsed = z.object({ answerId: z.string().uuid().nullable() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "answerId is required" });
  try {
    const author = await getAuthor(req);
    if (!requireAuthor(author, res)) return;
    const [question] = await db.select().from(communityQuestions).where(eq(communityQuestions.id, req.params.id)).limit(1);
    if (!question) return res.status(404).json({ error: "Question not found" });
    if (question.authorId !== author.authorId && !STAFF_ROLES.includes(author.authorRole)) {
      return res.status(403).json({ error: "Only the person who asked can choose the best answer" });
    }
    if (parsed.data.answerId) {
      const [answer] = await db
        .select({ id: communityAnswers.id })
        .from(communityAnswers)
        .where(and(eq(communityAnswers.id, parsed.data.answerId), eq(communityAnswers.questionId, question.id)))
        .limit(1);
      if (!answer) return res.status(400).json({ error: "That answer does not belong to this question" });
    }
    const [updated] = await db
      .update(communityQuestions)
      .set({ isSolved: Boolean(parsed.data.answerId), solvedAnswerId: parsed.data.answerId, updatedAt: new Date() })
      .where(eq(communityQuestions.id, question.id))
      .returning();
    return res.json(presentVotes(updated, author.authorId));
  } catch (err) {
    console.error("[community][PATCH /questions/:id/solve] Error:", err);
    return res.status(500).json({ error: "Failed to update best answer" });
  }
});

// DELETE — authors can remove their own posts; trainers and admins can remove anything
async function deleteOwned(
  req: Request,
  res: Response,
  table: typeof communityQuestions | typeof communityAnswers | typeof communityReplies | typeof communityChatMessages,
  label: string,
) {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: `${label} not found` });
  try {
    const author = await getAuthor(req);
    if (!requireAuthor(author, res)) return;
    const [row] = await db.select({ authorId: table.authorId }).from(table).where(eq(table.id, req.params.id)).limit(1);
    if (!row) return res.status(404).json({ error: `${label} not found` });
    if (row.authorId !== author.authorId && !MODERATOR_ROLES.includes(author.authorRole)) {
      return res.status(403).json({ error: `You can only delete your own ${label.toLowerCase()}` });
    }
    if (table === communityAnswers) {
      // Clear "solved" if the accepted answer is removed
      await db
        .update(communityQuestions)
        .set({ isSolved: false, solvedAnswerId: null })
        .where(eq(communityQuestions.solvedAnswerId, req.params.id));
    }
    await db.delete(table).where(eq(table.id, req.params.id));
    return res.status(204).end();
  } catch (err) {
    console.error(`[community][DELETE ${label}] Error:`, err);
    return res.status(500).json({ error: `Failed to delete ${label.toLowerCase()}` });
  }
}

router.delete("/questions/:id", (req, res) => deleteOwned(req, res, communityQuestions, "Question"));
router.delete("/answers/:id", (req, res) => deleteOwned(req, res, communityAnswers, "Answer"));
router.delete("/replies/:id", (req, res) => deleteOwned(req, res, communityReplies, "Reply"));
router.delete("/chat/messages/:id", (req, res) => deleteOwned(req, res, communityChatMessages, "Message"));

// ─────────────────────────────────────────────
// LIVE CHAT
// ─────────────────────────────────────────────

// GET /chat/:channelId?after=<ISO time> — latest messages, or only newer ones when polling
router.get("/chat/:channelId", async (req: Request, res: Response) => {
  const { channelId } = req.params;
  if (!CHANNEL_IDS.includes(channelId)) return res.status(404).json({ error: "Channel not found" });
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const after = typeof req.query.after === "string" ? new Date(req.query.after) : null;

  try {
    const conditions = [eq(communityChatMessages.channelId, channelId)];
    // Clients only see millisecond precision, so compare at that precision or the last seen message repeats
    if (after && !Number.isNaN(after.getTime())) {
      conditions.push(sql`date_trunc('milliseconds', ${communityChatMessages.createdAt}) > ${after.toISOString()}::timestamp`);
    }
    const messages = await db
      .select()
      .from(communityChatMessages)
      .where(and(...conditions))
      .orderBy(desc(communityChatMessages.createdAt))
      .limit(limit);
    return res.json(messages.reverse());
  } catch (err) {
    console.error("[community][GET /chat/:channelId] Error:", err);
    return res.status(500).json({ error: "Failed to fetch chat messages" });
  }
});

const chatSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  isPinned: z.boolean().optional().default(false),
});

router.post("/chat/:channelId", async (req: Request, res: Response) => {
  const { channelId } = req.params;
  if (!CHANNEL_IDS.includes(channelId)) return res.status(404).json({ error: "Channel not found" });
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Messages must be 1–1000 characters" });
  try {
    const author = await getAuthor(req);
    if (!requireAuthor(author, res)) return;
    const [message] = await db
      .insert(communityChatMessages)
      .values({
        channelId,
        text: parsed.data.text,
        // Only staff can pin announcements
        isPinned: parsed.data.isPinned && MODERATOR_ROLES.includes(author.authorRole),
        ...author,
      })
      .returning();
    return res.status(201).json(message);
  } catch (err) {
    console.error("[community][POST /chat/:channelId] Error:", err);
    return res.status(500).json({ error: "Failed to send chat message" });
  }
});

export default router;
