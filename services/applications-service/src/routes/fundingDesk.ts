import { Router, Request, Response } from "express";
import { eq, and, desc, sql, or } from "drizzle-orm";
import { db } from "../index";
import {
  fundingOpportunities,
  fundingMaterials,
  fundingSubscribers,
  fundingAuditLogs,
} from "../db/schema";

const router = Router();

function extractUser(req: Request): { email: string; role: string } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    const directEmail = req.headers["x-user-email"] as string;
    const directRole = req.headers["x-user-role"] as string;
    if (directEmail) {
      return { email: directEmail, role: directRole || "trainee" };
    }
    return null;
  }
  const token = authHeader.substring(7).trim();
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
    return {
      email: payload.email || "system-admin@oriyon.com",
      role: payload.role || "trainee",
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// 1. FUNDING OPPORTUNITIES ENDPOINTS
// ─────────────────────────────────────────────

/**
 * GET /funding-desk/opportunities
 */
router.get("/opportunities", async (req: Request, res: Response) => {
  try {
    const isAdmin = req.query.admin === "true";
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || (isAdmin ? 20 : 9)));
    const offset = (page - 1) * limit;

    const user = extractUser(req);
    const allowedRoles = ["admin", "sub_admin", "funding_researcher", "verifier"];
    const hasAdminAccess = Boolean(user && allowedRoles.includes(user.role));

    let rows: any[] = [];
    if (!isAdmin || !hasAdminAccess) {
      // Public: only published opportunities
      rows = await db
        .select()
        .from(fundingOpportunities)
        .where(eq(fundingOpportunities.status, "published"))
        .orderBy(desc(fundingOpportunities.updatedAt));
    } else {
      // Admin: all statuses or requested status
      const statusFilter = req.query.status as string;
      if (statusFilter && statusFilter !== "all") {
        rows = await db
          .select()
          .from(fundingOpportunities)
          .where(eq(fundingOpportunities.status, statusFilter))
          .orderBy(desc(fundingOpportunities.updatedAt));
      } else {
        rows = await db
          .select()
          .from(fundingOpportunities)
          .orderBy(desc(fundingOpportunities.updatedAt));
      }
    }

    // Client-side text & category filtering on rows
    const search = (req.query.search as string)?.toLowerCase().trim();
    const category = req.query.category as string;

    let filtered = rows;
    if (search) {
      filtered = filtered.filter(
        (o) =>
          o.title?.toLowerCase().includes(search) ||
          o.summary?.toLowerCase().includes(search) ||
          o.issuer?.name?.toLowerCase().includes(search) ||
          o.geography?.toLowerCase().includes(search)
      );
    }
    if (category && category !== "all") {
      filtered = filtered.filter((o) => o.category === category);
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const items = filtered.slice(offset, offset + limit);

    return res.json({
      items,
      total,
      page,
      totalPages,
      limit,
    });
  } catch (err: any) {
    console.error("[fundingDesk] GET /opportunities error:", err);
    return res.status(500).json({ error: "Failed to retrieve opportunities" });
  }
});

/**
 * GET /funding-desk/opportunities/:slugOrId
 */
router.get("/opportunities/:slugOrId", async (req: Request, res: Response) => {
  try {
    const { slugOrId } = req.params;
    const records = await db
      .select()
      .from(fundingOpportunities)
      .where(or(eq(fundingOpportunities.slug, slugOrId), eq(fundingOpportunities.id, slugOrId)));

    if (!records.length) {
      return res.status(404).json({ error: "Opportunity not found" });
    }

    const item = records[0];
    const user = extractUser(req);
    const allowedRoles = ["admin", "sub_admin", "funding_researcher", "verifier"];
    const hasAdminAccess = Boolean(user && allowedRoles.includes(user.role));

    if (item.status !== "published" && !hasAdminAccess) {
      return res.status(404).json({ error: "Opportunity not found" });
    }

    return res.json(item);
  } catch (err: any) {
    console.error("[fundingDesk] GET /opportunities/:id error:", err);
    return res.status(500).json({ error: "Failed to retrieve opportunity" });
  }
});

/**
 * POST /funding-desk/opportunities
 */
router.post("/opportunities", async (req: Request, res: Response) => {
  try {
    const user = extractUser(req);
    const allowedRoles = ["admin", "sub_admin", "funding_researcher", "verifier"];
    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(401).json({ error: "Unauthorized. Administrator credentials required." });
    }

    const data = req.body;
    if (!data.title || !data.officialApplicationUrl || !data.category) {
      return res.status(400).json({ error: "Title, Official Application URL, and Category are required." });
    }

    const id = `opp-${Date.now()}`;
    const slug = (data.title || "")
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const newOpp = {
      id,
      slug: slug || id,
      title: data.title.trim(),
      summary: data.summary || "",
      fullDescription: data.fullDescription || "",
      issuer: data.issuer || {
        id: `issuer-${Date.now()}`,
        name: "Verified Institution",
        website: "",
        country: "Pan-African",
        issuerType: "Government",
        isVerified: true,
      },
      category: data.category,
      geography: data.geography || "Sub-Saharan Africa",
      eligibleCountries: data.eligibleCountries || ["Nigeria"],
      targetBeneficiaries: data.targetBeneficiaries || ["Agribusinesses", "Livestock Producers"],
      currency: data.currency || "USD",
      fundingMin: data.fundingMin ? Number(data.fundingMin) : null,
      fundingMax: data.fundingMax ? Number(data.fundingMax) : null,
      fundingAmountDisclosed: data.fundingAmountDisclosed !== false,
      fundingAmountNotes: data.fundingAmountNotes || null,
      fundingType: data.fundingType || "Grant",
      eligibilityCriteria: data.eligibilityCriteria || [],
      applicationRequirements: data.applicationRequirements || [],
      practicalNextSteps: data.practicalNextSteps || [],
      openingDate: data.openingDate || null,
      closingDate: data.closingDate || null,
      hasUnknownDeadline: Boolean(data.hasUnknownDeadline),
      isRollingDeadline: Boolean(data.isRollingDeadline),
      officialApplicationUrl: data.officialApplicationUrl.trim(),
      sourceUrl: data.sourceUrl || data.officialApplicationUrl.trim(),
      status: data.status || "draft",
      verifiedBy: data.verifiedBy || null,
      verifiedAt: data.verifiedAt ? new Date(data.verifiedAt) : null,
      verificationNotes: data.verificationNotes || null,
      reVerificationDueDate: data.reVerificationDueDate || null,
      createdBy: user.email,
      updatedBy: user.email,
    };

    await db.insert(fundingOpportunities).values(newOpp);

    // Audit log
    await db.insert(fundingAuditLogs).values({
      id: `audit-${Date.now()}`,
      opportunityId: id,
      actorEmail: user.email,
      action: "CREATED",
      newStatus: newOpp.status,
      notes: `Created opportunity "${newOpp.title}"`,
    });

    return res.status(201).json({ opportunity: newOpp });
  } catch (err: any) {
    console.error("[fundingDesk] POST /opportunities error:", err);
    return res.status(500).json({ error: "Failed to create opportunity" });
  }
});

/**
 * PATCH /funding-desk/opportunities/:id
 */
router.patch("/opportunities/:id", async (req: Request, res: Response) => {
  try {
    const user = extractUser(req);
    const allowedRoles = ["admin", "sub_admin", "funding_researcher", "verifier"];
    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    const existing = await db
      .select()
      .from(fundingOpportunities)
      .where(eq(fundingOpportunities.id, id));

    if (!existing.length) {
      return res.status(404).json({ error: "Opportunity not found" });
    }

    const data = req.body;
    const updatePayload: any = {
      ...data,
      updatedBy: user.email,
      updatedAt: new Date(),
    };
    delete updatePayload.id;

    if (updatePayload.verifiedAt) {
      updatePayload.verifiedAt = new Date(updatePayload.verifiedAt);
    }

    await db
      .update(fundingOpportunities)
      .set(updatePayload)
      .where(eq(fundingOpportunities.id, id));

    // Audit log
    await db.insert(fundingAuditLogs).values({
      id: `audit-${Date.now()}`,
      opportunityId: id,
      actorEmail: user.email,
      action: data.status && data.status !== existing[0].status ? "STATUS_CHANGED" : "EDITED",
      previousStatus: existing[0].status,
      newStatus: data.status || existing[0].status,
      notes: `Updated opportunity "${existing[0].title}"`,
    });

    const updated = await db
      .select()
      .from(fundingOpportunities)
      .where(eq(fundingOpportunities.id, id));

    return res.json({ opportunity: updated[0] });
  } catch (err: any) {
    console.error("[fundingDesk] PATCH /opportunities/:id error:", err);
    return res.status(500).json({ error: "Failed to update opportunity" });
  }
});

/**
 * DELETE /funding-desk/opportunities/:id
 */
router.delete("/opportunities/:id", async (req: Request, res: Response) => {
  try {
    const user = extractUser(req);
    const allowedRoles = ["admin", "sub_admin"];
    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    const existing = await db
      .select()
      .from(fundingOpportunities)
      .where(eq(fundingOpportunities.id, id));

    if (!existing.length) {
      return res.status(404).json({ error: "Opportunity not found" });
    }

    await db.delete(fundingOpportunities).where(eq(fundingOpportunities.id, id));

    // Audit log
    await db.insert(fundingAuditLogs).values({
      id: `audit-${Date.now()}`,
      opportunityId: id,
      actorEmail: user.email,
      action: "ARCHIVED",
      previousStatus: existing[0].status,
      notes: `Deleted opportunity "${existing[0].title}"`,
    });

    return res.json({ success: true });
  } catch (err: any) {
    console.error("[fundingDesk] DELETE /opportunities/:id error:", err);
    return res.status(500).json({ error: "Failed to delete opportunity" });
  }
});

/**
 * POST /funding-desk/verify
 */
router.post("/verify", async (req: Request, res: Response) => {
  try {
    const user = extractUser(req);
    const allowedRoles = ["admin", "sub_admin", "verifier"];
    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { opportunityId, verificationNotes, publishImmediately } = req.body;
    if (!opportunityId) {
      return res.status(400).json({ error: "opportunityId is required" });
    }

    const existing = await db
      .select()
      .from(fundingOpportunities)
      .where(eq(fundingOpportunities.id, opportunityId));

    if (!existing.length) {
      return res.status(404).json({ error: "Opportunity not found" });
    }

    const targetStatus = publishImmediately ? "published" : "verified";
    await db
      .update(fundingOpportunities)
      .set({
        status: targetStatus,
        verifiedBy: user.email,
        verifiedAt: new Date(),
        verificationNotes: verificationNotes || "Fact-checked and approved by editorial team",
        updatedBy: user.email,
        updatedAt: new Date(),
      })
      .where(eq(fundingOpportunities.id, opportunityId));

    await db.insert(fundingAuditLogs).values({
      id: `audit-${Date.now()}`,
      opportunityId,
      actorEmail: user.email,
      action: publishImmediately ? "PUBLISHED" : "VERIFIED",
      previousStatus: existing[0].status,
      newStatus: targetStatus,
      notes: verificationNotes || "Fact-checked and approved",
    });

    return res.json({ success: true, status: targetStatus });
  } catch (err: any) {
    console.error("[fundingDesk] POST /verify error:", err);
    return res.status(500).json({ error: "Failed to verify opportunity" });
  }
});

// ─────────────────────────────────────────────
// 2. FUNDING MATERIALS ENDPOINTS
// ─────────────────────────────────────────────

/**
 * GET /funding-desk/materials
 */
router.get("/materials", async (req: Request, res: Response) => {
  try {
    const isAdmin = req.query.admin === "true";
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || (isAdmin ? 20 : 9)));
    const offset = (page - 1) * limit;

    const user = extractUser(req);
    const allowedRoles = ["admin", "sub_admin", "funding_researcher", "verifier"];
    const hasAdminAccess = Boolean(user && allowedRoles.includes(user.role));

    let rows: any[] = [];
    if (!isAdmin || !hasAdminAccess) {
      rows = await db
        .select()
        .from(fundingMaterials)
        .where(eq(fundingMaterials.status, "published"))
        .orderBy(desc(fundingMaterials.isFeatured), desc(fundingMaterials.updatedAt));
    } else {
      const statusFilter = req.query.status as string;
      if (statusFilter && statusFilter !== "all") {
        rows = await db
          .select()
          .from(fundingMaterials)
          .where(eq(fundingMaterials.status, statusFilter))
          .orderBy(desc(fundingMaterials.updatedAt));
      } else {
        rows = await db
          .select()
          .from(fundingMaterials)
          .orderBy(desc(fundingMaterials.updatedAt));
      }
    }

    const search = (req.query.search as string)?.toLowerCase().trim();
    const category = req.query.category as string;

    let filtered = rows;
    if (search) {
      filtered = filtered.filter(
        (m) =>
          m.title?.toLowerCase().includes(search) ||
          m.description?.toLowerCase().includes(search) ||
          (Array.isArray(m.tags) && m.tags.some((t: string) => t.toLowerCase().includes(search)))
      );
    }
    if (category && category !== "all") {
      filtered = filtered.filter((m) => m.category === category);
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const items = filtered.slice(offset, offset + limit);

    return res.json({
      items,
      total,
      page,
      totalPages,
      limit,
    });
  } catch (err: any) {
    console.error("[fundingDesk] GET /materials error:", err);
    return res.status(500).json({ error: "Failed to retrieve materials" });
  }
});

/**
 * GET /funding-desk/materials/:slugOrId
 */
router.get("/materials/:slugOrId", async (req: Request, res: Response) => {
  try {
    const { slugOrId } = req.params;
    const records = await db
      .select()
      .from(fundingMaterials)
      .where(or(eq(fundingMaterials.slug, slugOrId), eq(fundingMaterials.id, slugOrId)));

    if (!records.length) {
      return res.status(404).json({ error: "Material not found" });
    }

    const item = records[0];
    const user = extractUser(req);
    const allowedRoles = ["admin", "sub_admin", "funding_researcher", "verifier"];
    const hasAdminAccess = Boolean(user && allowedRoles.includes(user.role));

    if (item.status !== "published" && !hasAdminAccess) {
      return res.status(404).json({ error: "Material not found" });
    }

    // Increment download count
    await db
      .update(fundingMaterials)
      .set({ downloadCount: (item.downloadCount || 0) + 1 })
      .where(eq(fundingMaterials.id, item.id));

    return res.json(item);
  } catch (err: any) {
    console.error("[fundingDesk] GET /materials/:id error:", err);
    return res.status(500).json({ error: "Failed to retrieve material" });
  }
});

/**
 * POST /funding-desk/materials
 */
router.post("/materials", async (req: Request, res: Response) => {
  try {
    const user = extractUser(req);
    const allowedRoles = ["admin", "sub_admin", "funding_researcher", "verifier"];
    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const data = req.body;
    if (!data.title || !data.downloadUrl || !data.category) {
      return res.status(400).json({ error: "Title, Download URL, and Category are required." });
    }

    const id = `mat-${Date.now()}`;
    const slug = (data.title || "")
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const newMaterial = {
      id,
      slug: slug || id,
      title: data.title.trim(),
      description: data.description?.trim() || "",
      category: data.category,
      fileType: data.fileType || "PDF",
      fileSize: data.fileSize || "1.0 MB",
      downloadUrl: data.downloadUrl.trim(),
      targetAudience: data.targetAudience?.trim() || "Agribusiness Founders & Cooperatives",
      tags: Array.isArray(data.tags) ? data.tags : [],
      isFeatured: Boolean(data.isFeatured),
      status: data.status || "published",
      downloadCount: 0,
    };

    await db.insert(fundingMaterials).values(newMaterial);

    await db.insert(fundingAuditLogs).values({
      id: `audit-${Date.now()}`,
      opportunityId: id,
      actorEmail: user.email,
      action: "CREATED",
      newStatus: newMaterial.status,
      notes: `Created funding material "${newMaterial.title}"`,
    });

    return res.status(201).json({ material: newMaterial });
  } catch (err: any) {
    console.error("[fundingDesk] POST /materials error:", err);
    return res.status(500).json({ error: "Failed to create material" });
  }
});

/**
 * DELETE /funding-desk/materials/:id
 */
router.delete("/materials/:id", async (req: Request, res: Response) => {
  try {
    const user = extractUser(req);
    const allowedRoles = ["admin", "sub_admin"];
    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    const existing = await db
      .select()
      .from(fundingMaterials)
      .where(eq(fundingMaterials.id, id));

    if (!existing.length) {
      return res.status(404).json({ error: "Material not found" });
    }

    await db.delete(fundingMaterials).where(eq(fundingMaterials.id, id));

    await db.insert(fundingAuditLogs).values({
      id: `audit-${Date.now()}`,
      opportunityId: id,
      actorEmail: user.email,
      action: "ARCHIVED",
      previousStatus: existing[0].status,
      notes: `Deleted funding material "${existing[0].title}"`,
    });

    return res.json({ success: true });
  } catch (err: any) {
    console.error("[fundingDesk] DELETE /materials/:id error:", err);
    return res.status(500).json({ error: "Failed to delete material" });
  }
});

// ─────────────────────────────────────────────
// 3. NEWSLETTER SUBSCRIPTION ENDPOINT
// ─────────────────────────────────────────────

/**
 * POST /funding-desk/newsletter
 */
router.post("/newsletter", async (req: Request, res: Response) => {
  try {
    const { email, fullName, source = "Funding Desk Library" } = req.body;
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email address is required" });
    }

    const normalized = email.toLowerCase().trim();
    const existing = await db
      .select()
      .from(fundingSubscribers)
      .where(eq(fundingSubscribers.email, normalized));

    if (existing.length > 0) {
      return res.json({ success: true, alreadySubscribed: true });
    }

    await db.insert(fundingSubscribers).values({
      id: `sub-${Date.now()}`,
      email: normalized,
      fullName: fullName?.trim() || null,
      source,
    });

    return res.json({ success: true, alreadySubscribed: false });
  } catch (err: any) {
    console.error("[fundingDesk] POST /newsletter error:", err);
    return res.status(500).json({ error: "Failed to subscribe to newsletter" });
  }
});

export default router;
