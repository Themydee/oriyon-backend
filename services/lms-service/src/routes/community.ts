import { Router, Request, Response } from "express";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import {
  communityQuestions,
  communityAnswers,
  communityReplies,
  communityChatMessages,
} from "../db/schema";

const router = Router();

// Helper to extract author metadata from request headers
function getAuthorInfo(req: Request) {
  const authorId = (req.headers["x-user-id"] as string) || "u-anon";
  const authorName = (req.headers["x-user-name"] as string) || (req.headers["x-user-email"] as string) || "Trainee";
  const authorRole = ((req.headers["x-user-role"] as string) || "trainee") as any;
  const authorAvatar = (req.headers["x-user-avatar"] as string) || undefined;
  return { authorId, authorName, authorRole, authorAvatar };
}

// ─────────────────────────────────────────────
// Q&A FORUM ROUTES
// ─────────────────────────────────────────────

// GET /questions — List questions with filters & nested answers
router.get("/questions", async (req: Request, res: Response) => {
  try {
    const { channel, solved, search, tag, sort } = req.query;

    const conditions = [];

    if (channel && channel !== "all") {
      conditions.push(eq(communityQuestions.channelId, String(channel)));
    }

    if (solved === "true") {
      conditions.push(eq(communityQuestions.isSolved, true));
    } else if (solved === "false") {
      conditions.push(eq(communityQuestions.isSolved, false));
    }

    let query = db
      .select()
      .from(communityQuestions);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    let questionsList = await query.orderBy(desc(communityQuestions.createdAt));

    // Client-side search and tag filtering in memory if provided
    if (search) {
      const q = String(search).toLowerCase();
      questionsList = questionsList.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          item.content.toLowerCase().includes(q) ||
          (item.tags as string[])?.some((t) => t.toLowerCase().includes(q))
      );
    }

    if (tag) {
      const targetTag = String(tag).toLowerCase();
      questionsList = questionsList.filter((item) =>
        (item.tags as string[])?.some((t) => t.toLowerCase() === targetTag)
      );
    }

    if (sort === "upvotes") {
      questionsList.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
    }

    const questionIds = questionsList.map((q) => q.id);

    let answersList: any[] = [];
    let repliesList: any[] = [];

    if (questionIds.length > 0) {
      answersList = await db
        .select()
        .from(communityAnswers)
        .where(inArray(communityAnswers.questionId, questionIds))
        .orderBy(desc(communityAnswers.createdAt));

      const answerIds = answersList.map((a) => a.id);
      if (answerIds.length > 0) {
        repliesList = await db
          .select()
          .from(communityReplies)
          .where(inArray(communityReplies.answerId, answerIds))
          .orderBy(communityReplies.createdAt);
      }
    }

    // Map replies to answers
    const answersWithRepliesMap = new Map();
    answersList.forEach((ans) => {
      answersWithRepliesMap.set(ans.id, {
        ...ans,
        replies: repliesList.filter((r) => r.answerId === ans.id),
      });
    });

    // Map answers to questions
    const fullQuestions = questionsList.map((q) => {
      const qAnswers = answersList
        .filter((a) => a.questionId === q.id)
        .map((a) => answersWithRepliesMap.get(a.id));
      return {
        ...q,
        answers: qAnswers,
      };
    });

    return res.json(fullQuestions);
  } catch (err: any) {
    console.error("[community][GET /questions] Error:", err);
    return res.status(500).json({ error: "Failed to fetch questions" });
  }
});

// POST /questions — Create a new question
const createQuestionSchema = z.object({
  title: z.string().min(3),
  content: z.string().min(5),
  channelId: z.string().default("general"),
  channelName: z.string().default("General Discussion"),
  tags: z.array(z.string()).optional().default([]),
});

router.post("/questions", async (req: Request, res: Response) => {
  const parsed = createQuestionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const { authorId, authorName, authorRole, authorAvatar } = getAuthorInfo(req);

    const [question] = await db
      .insert(communityQuestions)
      .values({
        title: parsed.data.title,
        content: parsed.data.content,
        channelId: parsed.data.channelId,
        channelName: parsed.data.channelName,
        tags: parsed.data.tags,
        authorId,
        authorName,
        authorRole,
        authorAvatar,
      })
      .returning();

    return res.status(201).json({ ...question, answers: [] });
  } catch (err: any) {
    console.error("[community][POST /questions] Error:", err);
    return res.status(500).json({ error: "Failed to post question" });
  }
});

// POST /questions/:id/upvote — Toggle upvote on question
router.post("/questions/:id/upvote", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { authorId } = getAuthorInfo(req);

  try {
    const [q] = await db
      .select()
      .from(communityQuestions)
      .where(eq(communityQuestions.id, id))
      .limit(1);

    if (!q) return res.status(404).json({ error: "Question not found" });

    const currentUpvotedBy: string[] = (q.upvotedBy as string[]) || [];
    const hasUpvoted = currentUpvotedBy.includes(authorId);

    const newUpvotedBy = hasUpvoted
      ? currentUpvotedBy.filter((u) => u !== authorId)
      : [...currentUpvotedBy, authorId];

    const newCount = newUpvotedBy.length;

    const [updated] = await db
      .update(communityQuestions)
      .set({
        upvotes: newCount,
        upvotedBy: newUpvotedBy,
        updatedAt: new Date(),
      })
      .where(eq(communityQuestions.id, id))
      .returning();

    return res.json(updated);
  } catch (err: any) {
    console.error("[community][POST /questions/:id/upvote] Error:", err);
    return res.status(500).json({ error: "Failed to upvote question" });
  }
});

// POST /questions/:id/answers — Add answer to a question
const createAnswerSchema = z.object({
  content: z.string().min(2),
});

router.post("/questions/:id/answers", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = createAnswerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const { authorId, authorName, authorRole, authorAvatar } = getAuthorInfo(req);
    const isTrainerOrAdmin = ["trainer", "lead_trainer", "coordinator", "admin"].includes(authorRole);

    const [answer] = await db
      .insert(communityAnswers)
      .values({
        questionId: id,
        content: parsed.data.content,
        authorId,
        authorName,
        authorRole,
        authorAvatar,
        isVerified: isTrainerOrAdmin,
      })
      .returning();

    return res.status(201).json({ ...answer, replies: [] });
  } catch (err: any) {
    console.error("[community][POST /questions/:id/answers] Error:", err);
    return res.status(500).json({ error: "Failed to post answer" });
  }
});

// POST /answers/:id/upvote — Toggle upvote on an answer
router.post("/answers/:id/upvote", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { authorId } = getAuthorInfo(req);

  try {
    const [ans] = await db
      .select()
      .from(communityAnswers)
      .where(eq(communityAnswers.id, id))
      .limit(1);

    if (!ans) return res.status(404).json({ error: "Answer not found" });

    const currentUpvotedBy: string[] = (ans.upvotedBy as string[]) || [];
    const hasUpvoted = currentUpvotedBy.includes(authorId);

    const newUpvotedBy = hasUpvoted
      ? currentUpvotedBy.filter((u) => u !== authorId)
      : [...currentUpvotedBy, authorId];

    const newCount = newUpvotedBy.length;

    const [updated] = await db
      .update(communityAnswers)
      .set({
        upvotes: newCount,
        upvotedBy: newUpvotedBy,
        updatedAt: new Date(),
      })
      .where(eq(communityAnswers.id, id))
      .returning();

    return res.json(updated);
  } catch (err: any) {
    console.error("[community][POST /answers/:id/upvote] Error:", err);
    return res.status(500).json({ error: "Failed to upvote answer" });
  }
});

// POST /answers/:id/replies — Add reply to an answer
const createReplySchema = z.object({
  content: z.string().min(1),
});

router.post("/answers/:id/replies", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = createReplySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const { authorId, authorName, authorRole, authorAvatar } = getAuthorInfo(req);

    const [reply] = await db
      .insert(communityReplies)
      .values({
        answerId: id,
        content: parsed.data.content,
        authorId,
        authorName,
        authorRole,
        authorAvatar,
      })
      .returning();

    return res.status(201).json(reply);
  } catch (err: any) {
    console.error("[community][POST /answers/:id/replies] Error:", err);
    return res.status(500).json({ error: "Failed to post reply" });
  }
});

// PATCH /questions/:id/solve — Mark best answer as solved
router.patch("/questions/:id/solve", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { answerId } = req.body;

  if (!answerId) {
    return res.status(400).json({ error: "answerId is required" });
  }

  try {
    const [updated] = await db
      .update(communityQuestions)
      .set({
        isSolved: true,
        solvedAnswerId: answerId,
        updatedAt: new Date(),
      })
      .where(eq(communityQuestions.id, id))
      .returning();

    return res.json(updated);
  } catch (err: any) {
    console.error("[community][PATCH /questions/:id/solve] Error:", err);
    return res.status(500).json({ error: "Failed to mark as solved" });
  }
});

// ─────────────────────────────────────────────
// LIVE PEER CHAT ROUTES
// ─────────────────────────────────────────────

// GET /chat/:channelId — Fetch chat messages for a channel
router.get("/chat/:channelId", async (req: Request, res: Response) => {
  const { channelId } = req.params;
  try {
    const messages = await db
      .select()
      .from(communityChatMessages)
      .where(eq(communityChatMessages.channelId, channelId))
      .orderBy(communityChatMessages.createdAt)
      .limit(200);

    return res.json(messages);
  } catch (err: any) {
    console.error("[community][GET /chat/:channelId] Error:", err);
    return res.status(500).json({ error: "Failed to fetch chat messages" });
  }
});

// POST /chat/:channelId — Send a chat message
const createChatMessageSchema = z.object({
  text: z.string().min(1),
  isPinned: z.boolean().optional().default(false),
});

router.post("/chat/:channelId", async (req: Request, res: Response) => {
  const { channelId } = req.params;
  const parsed = createChatMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const { authorId, authorName, authorRole, authorAvatar } = getAuthorInfo(req);

    const [message] = await db
      .insert(communityChatMessages)
      .values({
        channelId,
        text: parsed.data.text,
        isPinned: parsed.data.isPinned,
        authorId,
        authorName,
        authorRole,
        authorAvatar,
      })
      .returning();

    return res.status(201).json(message);
  } catch (err: any) {
    console.error("[community][POST /chat/:channelId] Error:", err);
    return res.status(500).json({ error: "Failed to send chat message" });
  }
});

export default router;
