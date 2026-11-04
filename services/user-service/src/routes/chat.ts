import { Router, Request, Response } from "express";
import { eq, desc, asc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { supportChatThreads, supportChatMessages } from "../db/schema";

export const chatRouter = Router();

// GET /threads — list threads
chatRouter.get("/threads", async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    let query = db.select().from(supportChatThreads);

    const rows = status && typeof status === "string"
      ? await query.where(eq(supportChatThreads.status, status)).orderBy(desc(supportChatThreads.updatedAt))
      : await query.orderBy(desc(supportChatThreads.updatedAt));

    return res.json({ threads: rows });
  } catch (err) {
    console.error("[user-service:chat] Failed to fetch threads:", err);
    return res.status(500).json({ error: "Failed to fetch chat threads" });
  }
});

// GET /threads/:sessionId — get thread and its messages
chatRouter.get("/threads/:sessionId", async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    const [thread] = await db
      .select()
      .from(supportChatThreads)
      .where(eq(supportChatThreads.id, sessionId))
      .limit(1);

    if (!thread) {
      return res.status(404).json({ error: "Session not found" });
    }

    const messages = await db
      .select()
      .from(supportChatMessages)
      .where(eq(supportChatMessages.sessionId, sessionId))
      .orderBy(asc(supportChatMessages.createdAt));

    // Reset unread count when thread is inspected
    if (thread.unreadCount > 0) {
      await db
        .update(supportChatThreads)
        .set({ unreadCount: 0 })
        .where(eq(supportChatThreads.id, sessionId));
      thread.unreadCount = 0;
    }

    return res.json({ thread: { ...thread, messages } });
  } catch (err) {
    console.error("[user-service:chat] Failed to fetch thread:", err);
    return res.status(500).json({ error: "Failed to fetch chat session" });
  }
});

// POST /threads — create thread
chatRouter.post("/threads", async (req: Request, res: Response) => {
  const schema = z.object({
    sessionId: z.string().optional(),
    visitorName: z.string().min(1).default("Guest Visitor"),
    visitorEmail: z.string().min(1).default("guest@oriyoninternational.com"),
    visitorPhone: z.string().optional().nullable(),
    initialMessages: z
      .array(
        z.object({
          id: z.string().optional(),
          sender: z.enum(["visitor", "agent", "system"]),
          senderName: z.string().min(1),
          text: z.string().min(1),
          quickReplies: z.any().optional(),
          actionLink: z.any().optional(),
          createdAt: z.string().optional(),
        })
      )
      .optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }

  try {
    const { sessionId, visitorName, visitorEmail, visitorPhone, initialMessages } = parsed.data;
    const finalSessionId = sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date();

    const lastMsgText = initialMessages && initialMessages.length > 0
      ? initialMessages[initialMessages.length - 1].text
      : "Session started";

    const [newThread] = await db
      .insert(supportChatThreads)
      .values({
        id: finalSessionId,
        visitorName,
        visitorEmail,
        visitorPhone: visitorPhone ?? null,
        status: "open",
        lastMessage: lastMsgText,
        unreadCount: 0,
        agentTakenOver: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const insertedMessages = [];
    if (initialMessages && initialMessages.length > 0) {
      for (const m of initialMessages) {
        const msgId = m.id || `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const [inserted] = await db
          .insert(supportChatMessages)
          .values({
            id: msgId,
            sessionId: finalSessionId,
            sender: m.sender,
            senderName: m.senderName,
            text: m.text,
            isRead: m.sender === "agent",
            quickReplies: m.quickReplies ?? null,
            actionLink: m.actionLink ?? null,
            createdAt: m.createdAt ? new Date(m.createdAt) : new Date(),
          })
          .returning();
        insertedMessages.push(inserted);
      }
    }

    return res.status(201).json({
      success: true,
      thread: { ...newThread, messages: insertedMessages },
    });
  } catch (err) {
    console.error("[user-service:chat] Failed to create thread:", err);
    return res.status(500).json({ error: "Failed to create chat thread" });
  }
});

// POST /threads/:sessionId/messages — send message
chatRouter.post("/threads/:sessionId/messages", async (req: Request, res: Response) => {
  const schema = z.object({
    id: z.string().optional(),
    sender: z.enum(["visitor", "agent", "system"]).default("visitor"),
    senderName: z.string().optional(),
    text: z.string().min(1),
    quickReplies: z.any().optional(),
    actionLink: z.any().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }

  try {
    const sessionId = req.params.sessionId;
    const [thread] = await db
      .select()
      .from(supportChatThreads)
      .where(eq(supportChatThreads.id, sessionId))
      .limit(1);

    if (!thread) {
      return res.status(404).json({ error: "Session not found" });
    }

    const { id, sender, senderName, text, quickReplies, actionLink } = parsed.data;
    const msgId = id || `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const effectiveSenderName = senderName || (sender === "agent" ? "Oriyon Support Rep" : thread.visitorName);
    const now = new Date();

    const [message] = await db
      .insert(supportChatMessages)
      .values({
        id: msgId,
        sessionId,
        sender,
        senderName: effectiveSenderName,
        text: text.trim(),
        isRead: sender === "agent",
        quickReplies: quickReplies ?? null,
        actionLink: actionLink ?? null,
        createdAt: now,
      })
      .returning();

    // Update thread state
    let nextStatus = thread.status;
    let nextUnreadCount = thread.unreadCount;
    let nextAgentTakenOver = thread.agentTakenOver;

    if (sender === "visitor") {
      nextUnreadCount += 1;
      if (thread.status === "resolved") {
        nextStatus = "open";
      }
    } else if (sender === "agent") {
      nextUnreadCount = 0;
      nextAgentTakenOver = true;
      if (thread.status === "open") {
        nextStatus = "in_progress";
      }
    }

    const [updatedThread] = await db
      .update(supportChatThreads)
      .set({
        lastMessage: text.trim(),
        unreadCount: nextUnreadCount,
        status: nextStatus,
        agentTakenOver: nextAgentTakenOver,
        updatedAt: now,
      })
      .where(eq(supportChatThreads.id, sessionId))
      .returning();

    return res.status(201).json({
      success: true,
      message,
      thread: updatedThread,
    });
  } catch (err) {
    console.error("[user-service:chat] Failed to send message:", err);
    return res.status(500).json({ error: "Failed to send message" });
  }
});

// PATCH /threads/:sessionId/status — update status
chatRouter.patch("/threads/:sessionId/status", async (req: Request, res: Response) => {
  const schema = z.object({
    status: z.enum(["open", "in_progress", "resolved"]),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }

  try {
    const sessionId = req.params.sessionId;
    const { status } = parsed.data;
    const now = new Date();

    const [updated] = await db
      .update(supportChatThreads)
      .set({
        status,
        updatedAt: now,
      })
      .where(eq(supportChatThreads.id, sessionId))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (status === "resolved") {
      await db.insert(supportChatMessages).values({
        id: `msg-${Date.now()}-sys`,
        sessionId,
        sender: "system",
        senderName: "Oriyon System",
        text: "This support conversation has been marked as resolved. Feel free to send a message anytime if you need further assistance!",
        createdAt: now,
      });
    }

    return res.json({ success: true, thread: updated });
  } catch (err) {
    console.error("[user-service:chat] Failed to update thread status:", err);
    return res.status(500).json({ error: "Failed to update thread status" });
  }
});

// PATCH /threads/:sessionId/takeover — toggle agent takeover
chatRouter.patch("/threads/:sessionId/takeover", async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    const [thread] = await db
      .select()
      .from(supportChatThreads)
      .where(eq(supportChatThreads.id, sessionId))
      .limit(1);

    if (!thread) {
      return res.status(404).json({ error: "Session not found" });
    }

    const explicit = req.body && typeof req.body.agentTakenOver === "boolean"
      ? req.body.agentTakenOver
      : !thread.agentTakenOver;

    const [updated] = await db
      .update(supportChatThreads)
      .set({
        agentTakenOver: explicit,
        updatedAt: new Date(),
      })
      .where(eq(supportChatThreads.id, sessionId))
      .returning();

    return res.json({ success: true, thread: updated });
  } catch (err) {
    console.error("[user-service:chat] Failed to toggle agent takeover:", err);
    return res.status(500).json({ error: "Failed to toggle agent takeover" });
  }
});

