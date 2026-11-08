import { Router, Request, Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../index";
import { eventRegistrations } from "../db/schema";
import { sendEventRegistrationEmail } from "../services/eventEmails";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "oriyon-secret-key-2026-qa-test";

export const KNOWN_EVENTS: Record<
  string,
  {
    slug: string;
    title: string;
    programme: string;
    venue: string;
    schedule: string;
    startDate: string;
    endDate: string;
    fee: string;
    audience: string;
    description: string;
  }
> = {
  "eewyla-week-12": {
    slug: "eewyla-week-12",
    title: "EEWYLA Week 12 – Agribusiness Guest Seminars",
    programme: "Economic Empowerment of Women and Youth in Livestock Agriculture (EEWYLA)",
    venue: "LAUTECH, Ogbomoso",
    schedule: "Monday, 16 November 2026 • 11:00 AM – 1:00 PM daily",
    startDate: "2026-11-16T10:00:00.000Z",
    endDate: "2026-11-20T12:00:00.000Z",
    fee: "FREE",
    audience: "Open to everyone (students, farmers, agribusiness professionals, entrepreneurs, and general public)",
    description:
      "A transformative week-long agribusiness guest seminar series featuring distinguished livestock experts, market linkage partners, and commercial small-ruminant pioneers.",
  },
};

const registrationSchema = z.object({
  fullName: z
    .string({ required_error: "Please enter your full name" })
    .trim()
    .min(2, "Full Name must be at least 2 characters")
    .max(150, "Full Name cannot exceed 150 characters")
    .refine((val) => !/^[\s]+$/.test(val), { message: "Full Name cannot be only whitespace" }),
  gender: z.enum(["Male", "Female", "Prefer not to say"], {
    errorMap: () => ({ message: "Please select a valid gender option (Male, Female, or Prefer not to say)" }),
  }),
  email: z
    .string({ required_error: "Please enter your email address" })
    .trim()
    .email("Please enter a valid email address")
    .max(255, "Email address is too long"),
  age: z.coerce
    .number({ required_error: "Please enter your age", invalid_type_error: "Age must be a valid number" })
    .int("Age must be a whole number")
    .min(1, "Age must be at least 1")
    .max(120, "Age must be a realistic number (120 or less)"),
});

// ─────────────────────────────────────────────
// 1. GET /api/events/:eventSlug
// Public — Event details and metadata
// ─────────────────────────────────────────────
router.get("/:eventSlug", (req: Request, res: Response) => {
  const { eventSlug } = req.params;
  const event = KNOWN_EVENTS[eventSlug];

  if (!event) {
    return res.status(404).json({ error: "Event not found." });
  }

  return res.json({ event });
});

// ─────────────────────────────────────────────
// 2. POST /api/events/:eventSlug/registrations
// Public — Register for event (4 fields only: fullName, gender, email, age)
// ─────────────────────────────────────────────
router.post("/:eventSlug/registrations", async (req: Request, res: Response) => {
  const { eventSlug } = req.params;
  const event = KNOWN_EVENTS[eventSlug];

  if (!event) {
    return res.status(404).json({ error: "Event not found." });
  }

  const validation = registrationSchema.safeParse(req.body);
  if (!validation.success) {
    const formattedErrors = validation.error.flatten().fieldErrors;
    const firstErrorMessage =
      validation.error.errors[0]?.message || "Invalid input data. Please check the form.";
    return res.status(400).json({
      error: firstErrorMessage,
      details: formattedErrors,
    });
  }

  const { fullName, gender, age } = validation.data;
  const normalizedEmail = validation.data.email.trim().toLowerCase();
  const trimmedName = fullName.trim();

  try {
    // 1. Duplicate check (eventSlug + email)
    const [existing] = await db
      .select({
        id: eventRegistrations.id,
        registrationReference: eventRegistrations.registrationReference,
        fullName: eventRegistrations.fullName,
        email: eventRegistrations.email,
        createdAt: eventRegistrations.createdAt,
      })
      .from(eventRegistrations)
      .where(
        and(
          eq(eventRegistrations.eventSlug, eventSlug),
          eq(eventRegistrations.email, normalizedEmail)
        )
      )
      .limit(1);

    if (existing) {
      return res.status(200).json({
        success: true,
        alreadyRegistered: true,
        message: `You are already registered for ${event.title}! Your seat is reserved.`,
        registrationReference: existing.registrationReference,
        event: {
          title: event.title,
          venue: event.venue,
          schedule: event.schedule,
          fee: event.fee,
        },
      });
    }

    // 2. Generate unique registration reference
    const refSuffix = crypto.randomBytes(4).toString("hex").toUpperCase();
    const prefix = eventSlug === "eewyla-week-12" ? "W12" : eventSlug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const registrationReference = `EVT-${prefix}-${refSuffix}`;

    // 3. Persist registration to PostgreSQL
    const [created] = await db
      .insert(eventRegistrations)
      .values({
        eventSlug,
        registrationReference,
        fullName: trimmedName,
        gender,
        email: normalizedEmail,
        age,
      })
      .returning();

    // 4. Send confirmation email asynchronously (non-blocking)
    sendEventRegistrationEmail({
      to: normalizedEmail,
      fullName: trimmedName,
      registrationReference: created.registrationReference,
      eventTitle: event.title,
      venue: event.venue,
      schedule: event.schedule,
    }).catch((err) => {
      console.warn(`[events] Confirmation email dispatch failed for ${normalizedEmail}:`, err.message);
    });

    return res.status(201).json({
      success: true,
      alreadyRegistered: false,
      message: `Registration successful! Your seat for ${event.title} has been reserved.`,
      registrationReference: created.registrationReference,
      event: {
        title: event.title,
        venue: event.venue,
        schedule: event.schedule,
        fee: event.fee,
      },
    });
  } catch (err: any) {
    // Graceful handling of concurrent unique constraint race condition
    if (err.code === "23505" || err.message?.includes("idx_event_registrations_slug_email")) {
      const [existing] = await db
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.eventSlug, eventSlug),
            eq(eventRegistrations.email, normalizedEmail)
          )
        )
        .limit(1);

      if (existing) {
        return res.status(200).json({
          success: true,
          alreadyRegistered: true,
          message: `You are already registered for ${event.title}! Your seat is reserved.`,
          registrationReference: existing.registrationReference,
          event: {
            title: event.title,
            venue: event.venue,
            schedule: event.schedule,
            fee: event.fee,
          },
        });
      }
    }

    console.error("[events] registration error:", err);
    return res.status(500).json({ error: "Failed to complete event registration. Please try again." });
  }
});

// ─────────────────────────────────────────────
// 3. GET /api/events/:eventSlug/admin/registrations
// Admin Protected — Administrative visibility of registrations
// ─────────────────────────────────────────────
router.get("/:eventSlug/admin/registrations", async (req: Request, res: Response) => {
  let userRole = req.headers["x-user-role"] as string;

  if (!userRole && req.headers.authorization?.startsWith("Bearer ")) {
    try {
      const token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      if (decoded && decoded.role) {
        userRole = decoded.role;
      }
    } catch {
      // invalid token
    }
  }

  if (!userRole || !["admin", "super_admin", "sub_admin", "coordinator"].includes(userRole)) {
    return res.status(403).json({ error: "Access forbidden: Administrator privileges required." });
  }

  const { eventSlug } = req.params;
  const isAll = !eventSlug || eventSlug === "all";

  try {
    const baseQuery = db
      .select({
        id: eventRegistrations.id,
        eventSlug: eventRegistrations.eventSlug,
        registrationReference: eventRegistrations.registrationReference,
        fullName: eventRegistrations.fullName,
        gender: eventRegistrations.gender,
        email: eventRegistrations.email,
        age: eventRegistrations.age,
        createdAt: eventRegistrations.createdAt,
        updatedAt: eventRegistrations.updatedAt,
      })
      .from(eventRegistrations);

    const list = isAll
      ? await baseQuery.orderBy(desc(eventRegistrations.createdAt))
      : await baseQuery
          .where(eq(eventRegistrations.eventSlug, eventSlug))
          .orderBy(desc(eventRegistrations.createdAt));

    return res.json({
      eventSlug,
      total: list.length,
      registrations: list,
    });
  } catch (err) {
    console.error("[events] admin registrations fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch event registrations." });
  }
});

export default router;
