import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { complaints } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

const submitSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().min(7, "Phone number is required"),
  natureOfComplaint: z.string().min(1, "Nature of complaint is required"),
  dateOfIncident: z.string().min(1, "Date of incident is required"),
  description: z.string().min(1, "Description is required"),
  evidence: z.string().optional(),
  evidenceFilename: z.string().optional(),
  evidenceMimeType: z.string().optional(),
});

// POST /api/complaints
router.post("/", async (req: Request, res: Response) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const randomHex = Math.floor(100000 + Math.random() * 900000).toString();
    const trackingCode = `ORIYON-GRV-${randomHex}`;

    const data = {
      ...parsed.data,
      trackingCode,
      status: "pending",
    };

    const [complaint] = await db
      .insert(complaints)
      .values(data)
      .returning();

    // Publish event so notifications-service (or others) can send emails
    await publishEvent("complaint.submitted", {
      complaintId: complaint.id,
      trackingCode: complaint.trackingCode,
      name: complaint.name,
      email: complaint.email,
      phone: complaint.phone,
      natureOfComplaint: complaint.natureOfComplaint,
      dateOfIncident: complaint.dateOfIncident,
      description: complaint.description,
      submittedAt: complaint.createdAt.toISOString(),
    });

    return res.status(201).json({
      status: "success",
      message: "Grievance received successfully.",
      trackingCode: complaint.trackingCode,
      estimatedResponseTime: "5 business days",
    });
  } catch (err: any) {
    console.error("[POST /api/complaints] error:", err);
    return res.status(500).json({ error: "Failed to submit grievance" });
  }
});

// GET /api/complaints/:trackingCode - public status inquiry
router.get("/:trackingCode", async (req: Request, res: Response) => {
  try {
    const [complaint] = await db
      .select({
        id: complaints.id,
        trackingCode: complaints.trackingCode,
        natureOfComplaint: complaints.natureOfComplaint,
        status: complaints.status,
        createdAt: complaints.createdAt,
      })
      .from(complaints)
      .where(eq(complaints.trackingCode, req.params.trackingCode))
      .limit(1);

    if (!complaint) {
      return res.status(404).json({ error: "Complaint not found" });
    }

    return res.json(complaint);
  } catch (err) {
    console.error("[GET /api/complaints/:trackingCode] error:", err);
    return res.status(500).json({ error: "Failed to fetch complaint status" });
  }
});

export default router;
