import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { subscribers } from "../db/schema";
import { sendEmail, templates } from "../email";

export const contactRouter = Router();
export const newsletterRouter = Router();

// ─────────────────────────────────────────────
// CONTACT
// ─────────────────────────────────────────────

// POST /contact
contactRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(7),
    email: z.string().email(),
    message: z.string().min(10),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { firstName, lastName, email, phone, message } = parsed.data;

  try {
    // Send confirmation to the sender
    const tpl = templates.contactReceived(firstName);
    await sendEmail({ to: email, ...tpl });

    // Forward the message to Oriyon's inbox
    await sendEmail({
      to: process.env.EMAIL_FROM!,
      subject: `New contact message from ${firstName} ${lastName}`,
      html: `
        <p><strong>Name:</strong> ${firstName} ${lastName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone}</p>
        <p><strong>Message:</strong></p>
        <p>${message}</p>
      `,
    });

    return res.json({ message: "Message sent successfully" });
  } catch {
    return res.status(500).json({ error: "Failed to send message" });
  }
});

// ─────────────────────────────────────────────
// NEWSLETTER
// ─────────────────────────────────────────────

// POST /newsletter/subscribe
newsletterRouter.post("/subscribe", async (req: Request, res: Response) => {
  const schema = z.object({
    email: z.string().email(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    await db
      .insert(subscribers)
      .values({ ...parsed.data, isActive: true })
      .onConflictDoNothing();

    return res.json({ message: "Subscribed successfully" });
  } catch {
    return res.status(500).json({ error: "Failed to subscribe" });
  }
});

// DELETE /newsletter/unsubscribe
newsletterRouter.delete("/unsubscribe", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    await db
      .update(subscribers)
      .set({ isActive: false, unsubscribedAt: new Date() })
      .where(eq(subscribers.email, email));
    return res.json({ message: "Unsubscribed successfully" });
  } catch {
    return res.status(500).json({ error: "Failed to unsubscribe" });
  }
});
