import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { users } from "../db/schema";

const router = Router();

const ID_TYPES = [
  "National ID (NIN)",
  "Voters Card",
  "Drivers Licence",
  "International Passport",
] as const;

const MAX_BASE64_LENGTH = 15_000_000; // ~10 MB raw

// ─────────────────────────────────────────────
// PATCH /users/:id/id-document
// Trainee uploads their ID document.
// Body: { idType, idDocument, idFilename, idMimeType }
// idDocument = full base64 data URI
// ─────────────────────────────────────────────
router.patch("/:id/id-document", async (req: Request, res: Response) => {
  const schema = z.object({
    idType: z.enum(ID_TYPES),
    idDocument: z
      .string()
      .startsWith("data:", { message: "Must be a base64 data URI" })
      .max(MAX_BASE64_LENGTH, { message: "File too large (max 10 MB)" }),
    idFilename: z.string().max(255),
    idMimeType: z.enum([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "application/pdf",
    ]),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { idType, idDocument, idFilename, idMimeType } = parsed.data;

  try {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, req.params.id))
      .limit(1);

    if (!user) return res.status(404).json({ error: "User not found" });

    const [updated] = await db
      .update(users)
      .set({
        idType,
        idDocument,
        idFilename,
        idMimeType,
        idUploadedAt: new Date(),
        kycStatus: "pending",
        kycRejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, req.params.id))
      .returning({
        id:           users.id,
        idType:       users.idType,
        idFilename:   users.idFilename,
        idMimeType:   users.idMimeType,
        idUploadedAt: users.idUploadedAt,
        kycStatus:    users.kycStatus,
        kycRejectionReason: users.kycRejectionReason,
      });

    return res.json({
      message: "ID document uploaded successfully",
      ...updated,
    });
  } catch (err) {
    console.error("[users] id-document upload error:", err);
    return res.status(500).json({ error: "Failed to save ID document" });
  }
});

// ─────────────────────────────────────────────
// GET /users/:id/id-document/meta
// Returns metadata only — no binary.
// Used by admin dashboard to check upload status.
// ─────────────────────────────────────────────
router.get("/:id/id-document/meta", async (req: Request, res: Response) => {
  try {
    const [user] = await db
      .select({
        id:           users.id,
        idType:       users.idType,
        idFilename:   users.idFilename,
        idMimeType:   users.idMimeType,
        idUploadedAt: users.idUploadedAt,
        kycStatus:    users.kycStatus,
        kycRejectionReason: users.kycRejectionReason,
      })
      .from(users)
      .where(eq(users.id, req.params.id))
      .limit(1);

    if (!user) return res.status(404).json({ error: "User not found" });

    return res.json({
      hasDocument:  !!user.idType,
      idType:       user.idType,
      idFilename:   user.idFilename,
      idMimeType:   user.idMimeType,
      idUploadedAt: user.idUploadedAt,
      kycStatus:    user.kycStatus,
      kycRejectionReason: user.kycRejectionReason,
    });
  } catch (err) {
    console.error("[users] id-document meta error:", err);
    return res.status(500).json({ error: "Failed to retrieve metadata" });
  }
});

// ─────────────────────────────────────────────
// GET /users/:id/id-document
// Streams the binary file — admin only (enforced at gateway).
// ─────────────────────────────────────────────
router.get("/:id/id-document", async (req: Request, res: Response) => {
  try {
    const [user] = await db
      .select({
        idDocument:  users.idDocument,
        idFilename:  users.idFilename,
        idMimeType:  users.idMimeType,
      })
      .from(users)
      .where(eq(users.id, req.params.id))
      .limit(1);

    if (!user)             return res.status(404).json({ error: "User not found" });
    if (!user.idDocument)  return res.status(404).json({ error: "No ID document uploaded yet" });

    const base64Data = user.idDocument.replace(/^data:[^;]+;base64,/, "");
    const buffer     = Buffer.from(base64Data, "base64");

    res.setHeader("Content-Type", user.idMimeType ?? "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${user.idFilename ?? "id-document"}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.send(buffer);
  } catch (err) {
    console.error("[users] id-document download error:", err);
    return res.status(500).json({ error: "Failed to retrieve ID document" });
  }
});

// ─────────────────────────────────────────────
// POST /users/:id/kyc-verify
// Admin verifies (approves/rejects) a user's uploaded ID document.
// Body: { status: "approved" | "rejected", rejectionReason?: string }
// ─────────────────────────────────────────────
router.post("/:id/kyc-verify", async (req: Request, res: Response) => {
  const schema = z.object({
    status: z.enum(["approved", "rejected"]),
    rejectionReason: z.string().optional().nullable(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { status, rejectionReason } = parsed.data;

  try {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, req.params.id))
      .limit(1);

    if (!user) return res.status(404).json({ error: "User not found" });

    const [updated] = await db
      .update(users)
      .set({
        kycStatus: status,
        kycRejectionReason: status === "rejected" ? rejectionReason || "ID details did not match or file was unreadable." : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, req.params.id))
      .returning({
        id: users.id,
        kycStatus: users.kycStatus,
        kycRejectionReason: users.kycRejectionReason,
      });

    return res.json({
      message: `KYC document successfully ${status}`,
      ...updated,
    });
  } catch (err) {
    console.error("[users] kyc-verify error:", err);
    return res.status(500).json({ error: "Failed to verify KYC status" });
  }
});

export default router;