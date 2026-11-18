import { Router, Request, Response } from "express";
import { eq, sql } from "drizzle-orm";
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

const MAX_BASE64_LENGTH = 25_000_000; // ~18 MB raw
const VALID_ROLES = new Set([
  "trainee",
  "trainer",
  "coordinator",
  "lead_trainer",
  "admin",
  "sub_admin",
  "cooperative",
  "corper",
]);

interface ResolvedIdDocUser {
  id: string;
  idType: string | null;
  idFilename: string | null;
  idMimeType: string | null;
  idUploadedAt: Date | string | null;
  kycStatus: string | null;
  kycRejectionReason: string | null;
}

function normalizeMetaRow(row: any): ResolvedIdDocUser | null {
  if (!row || !row.id) return null;
  return {
    id: row.id,
    idType: row.idType ?? row.id_type ?? null,
    idFilename: row.idFilename ?? row.id_filename ?? null,
    idMimeType: row.idMimeType ?? row.id_mime_type ?? null,
    idUploadedAt: row.idUploadedAt ?? row.id_uploaded_at ?? null,
    kycStatus: row.kycStatus ?? row.kyc_status ?? null,
    kycRejectionReason: row.kycRejectionReason ?? row.kyc_rejection_reason ?? null,
  };
}

async function fetchUserMetaById(id: string): Promise<ResolvedIdDocUser | null> {
  try {
    const [u] = await db
      .select({
        id: users.id,
        idType: users.idType,
        idFilename: users.idFilename,
        idMimeType: users.idMimeType,
        idUploadedAt: users.idUploadedAt,
        kycStatus: users.kycStatus,
        kycRejectionReason: users.kycRejectionReason,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return normalizeMetaRow(u);
  } catch (drizzleErr) {
    console.error("[users] id-document meta Drizzle select error, falling back to raw SQL:", drizzleErr);
    try {
      const rawRes = await db.execute(sql`
        SELECT
          id, id_type, id_filename, id_mime_type, id_uploaded_at, kyc_status, kyc_rejection_reason
        FROM users WHERE id = ${id}::uuid LIMIT 1
      `);
      const rows = (rawRes as any)?.rows || (Array.isArray(rawRes) ? rawRes : []);
      return normalizeMetaRow(rows[0] || null);
    } catch (rawErr) {
      console.error("[users] id-document meta raw SQL query error:", rawErr);
      return null;
    }
  }
}

async function fetchUserMetaByEmail(email: string): Promise<ResolvedIdDocUser | null> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;

  try {
    const [u] = await db
      .select({
        id: users.id,
        idType: users.idType,
        idFilename: users.idFilename,
        idMimeType: users.idMimeType,
        idUploadedAt: users.idUploadedAt,
        kycStatus: users.kycStatus,
        kycRejectionReason: users.kycRejectionReason,
      })
      .from(users)
      .where(sql`LOWER(TRIM(${users.email})) = ${normalizedEmail}`)
      .limit(1);
    return normalizeMetaRow(u);
  } catch (drizzleErr) {
    console.error("[users] id-document email Drizzle select error, falling back to raw SQL:", drizzleErr);
    try {
      const rawRes = await db.execute(sql`
        SELECT
          id, id_type, id_filename, id_mime_type, id_uploaded_at, kyc_status, kyc_rejection_reason
        FROM users WHERE LOWER(TRIM(email)) = ${normalizedEmail} LIMIT 1
      `);
      const rows = (rawRes as any)?.rows || (Array.isArray(rawRes) ? rawRes : []);
      return normalizeMetaRow(rows[0] || null);
    } catch (rawErr) {
      console.error("[users] id-document email raw SQL query error:", rawErr);
      return null;
    }
  }
}

/**
 * Resolves a user for self-service ID document endpoints.
 * 1. Always checks by exact UUID first.
 * 2. If not found and the caller is accessing their own record (x-user-id === id),
 *    falls back to case-insensitive email match (handles auth-service vs user-service UUID drift).
 * 3. If still missing on a self-request, idempotently auto-provisions the profile row
 *    (eliminates Promise.all race condition on first login with GET /users/:id).
 */
async function resolveUserForIdDocument(
  id: string,
  req: Request
): Promise<ResolvedIdDocUser | null> {
  let user = await fetchUserMetaById(id);
  if (user) return user;

  const headerUserId = (req.headers["x-user-id"] as string | undefined)?.trim();
  const headerEmail = (req.headers["x-user-email"] as string | undefined)?.trim();
  const headerRole = ((req.headers["x-user-role"] as string | undefined) || "trainee").trim();
  const isSelfRequest = Boolean(headerUserId && headerUserId === id);

  if (!isSelfRequest || !headerEmail) {
    return null;
  }

  user = await fetchUserMetaByEmail(headerEmail);
  if (user) return user;

  // Auto-provision user row safely if it does not exist yet in user-service
  try {
    const safeRole = VALID_ROLES.has(headerRole) ? headerRole : "trainee";
    const [created] = await db
      .insert(users)
      .values({
        id,
        email: headerEmail.toLowerCase(),
        firstName: "Trainee",
        lastName: "User",
        role: safeRole,
        isActive: true,
      })
      .onConflictDoNothing()
      .returning({
        id: users.id,
        idType: users.idType,
        idFilename: users.idFilename,
        idMimeType: users.idMimeType,
        idUploadedAt: users.idUploadedAt,
        kycStatus: users.kycStatus,
        kycRejectionReason: users.kycRejectionReason,
      });

    if (created) {
      return normalizeMetaRow(created);
    }
  } catch (provisionErr) {
    console.error(`[users] id-document auto-provision failed for ${id}:`, provisionErr);
  }

  // Re-fetch in case a concurrent GET /users/:id request won the insert race
  return (await fetchUserMetaById(id)) || (await fetchUserMetaByEmail(headerEmail));
}

// ─────────────────────────────────────────────
// PATCH /users/:id/id-document
// Trainee uploads their ID document.
// Body: { idType, idDocument, idFilename, idMimeType }
// idDocument = full base64 data URI
// ─────────────────────────────────────────────
function normalizeIdType(raw: string): string {
  if (!raw) return "National ID (NIN)";
  const lower = raw.toLowerCase().trim();
  if (lower.includes("nin") || lower.includes("national")) return "National ID (NIN)";
  if (lower.includes("voter")) return "Voters Card";
  if (lower.includes("driver") || lower.includes("licence") || lower.includes("license")) return "Drivers Licence";
  if (lower.includes("passport")) return "International Passport";
  return raw;
}

// ─────────────────────────────────────────────
// PATCH /users/:id/id-document
// Trainee uploads their ID document.
// Body: { idType, idDocument, idDocumentUrl, idFilename, idMimeType }
// idDocument = base64 data URI or raw base64 string
// ─────────────────────────────────────────────
router.patch("/:id/id-document", async (req: Request, res: Response) => {
  const id = req.params.id;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!isUuid) {
    return res.status(400).json({ error: "Invalid user ID format" });
  }

  const headerUserId = (req.headers["x-user-id"] as string | undefined)?.trim();
  const headerRole = ((req.headers["x-user-role"] as string | undefined) || "").trim();
  if (headerUserId && headerUserId !== id && !["admin", "sub_admin"].includes(headerRole)) {
    return res.status(403).json({ error: "Forbidden — you can only upload your own ID document" });
  }

  const docPayload = req.body.idDocument || req.body.idDocumentUrl;
  const rawIdType = req.body.idType || req.body.id_type || "National ID (NIN)";
  const idType = normalizeIdType(rawIdType);
  const idFilename = req.body.idFilename || req.body.id_filename || "id-document";
  const idMimeType = req.body.idMimeType || req.body.id_mime_type || "image/jpeg";

  if (!docPayload || typeof docPayload !== "string") {
    return res.status(400).json({ error: "Missing or invalid ID document data" });
  }

  // Ensure data URI prefix if raw base64 string was sent
  let idDocument = docPayload;
  if (!idDocument.startsWith("data:") && !idDocument.startsWith("http")) {
    idDocument = `data:${idMimeType};base64,${idDocument}`;
  }

  if (idDocument.length > MAX_BASE64_LENGTH) {
    return res.status(400).json({ error: "File too large (max 18 MB)" });
  }

  try {
    const user = await resolveUserForIdDocument(id, req);
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
      .where(eq(users.id, user.id))
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
// Used by trainee dashboard and admin dashboard to check upload status.
// ─────────────────────────────────────────────
router.get("/:id/id-document/meta", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(400).json({ error: "Invalid user ID format" });
    }

    const user = await resolveUserForIdDocument(id, req);

    if (!user) return res.status(404).json({ error: "User not found" });

    const { idType, idFilename, idMimeType, idUploadedAt, kycStatus, kycRejectionReason } = user;

    return res.json({
      hasDocument:  !!(idType || idUploadedAt || idFilename),
      idType,
      idFilename,
      idMimeType,
      idUploadedAt,
      kycStatus,
      kycRejectionReason,
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
    const id = req.params.id;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(400).json({ error: "Invalid user ID format" });
    }

    let user: any = null;
    try {
      const [u] = await db
        .select({
          idDocument:  users.idDocument,
          idFilename:  users.idFilename,
          idMimeType:  users.idMimeType,
        })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      user = u;
    } catch (drizzleErr) {
      console.error("[users] id-document download Drizzle error, falling back to raw SQL:", drizzleErr);
      try {
        const rawRes = await db.execute(sql`
          SELECT id_document, id_filename, id_mime_type
          FROM users WHERE id = ${id}::uuid LIMIT 1
        `);
        const rows = (rawRes as any)?.rows || (Array.isArray(rawRes) ? rawRes : []);
        user = rows[0] || null;
      } catch (rawErr) {
        console.error("[users] id-document download raw SQL error:", rawErr);
      }
    }

    if (!user) return res.status(404).json({ error: "User not found" });
    const idDoc = user.idDocument || user.id_document;
    if (!idDoc) return res.status(404).json({ error: "No ID document uploaded yet" });

    const base64Data = idDoc.replace(/^data:[^;]+;base64,/, "");
    const buffer     = Buffer.from(base64Data, "base64");

    const mimeType = user.idMimeType || user.id_mime_type || "application/octet-stream";
    const filename = user.idFilename || user.id_filename || "id-document";

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
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
  const id = req.params.id;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!isUuid) {
    return res.status(400).json({ error: "Invalid user ID format" });
  }

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
      .where(eq(users.id, id))
      .limit(1);

    if (!user) return res.status(404).json({ error: "User not found" });

    const [updated] = await db
      .update(users)
      .set({
        kycStatus: status,
        kycRejectionReason: status === "rejected" ? rejectionReason || "ID details did not match or file was unreadable." : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
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