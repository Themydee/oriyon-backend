import crypto from "crypto";
import path from "path";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const ALLOWED_DOC_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const ALLOWED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".pdf",
  ".doc",
  ".docx",
  ".csv",
  ".xls",
  ".xlsx",
]);

export function getCloudinaryConfig() {
  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || "dpbba8033").trim();
  const apiKey = (process.env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = (process.env.CLOUDINARY_API_SECRET || "").trim();
  return {
    cloudName,
    apiKey,
    apiSecret,
    isConfigured: Boolean(cloudName && apiKey && apiSecret),
  };
}

export function validateAttachmentFile(
  mimetype: string,
  originalFilename: string,
  sizeBytes: number
): { valid: true; resourceType: "image" | "raw"; ext: string } | { valid: false; error: string } {
  if (!sizeBytes || sizeBytes <= 0) {
    return { valid: false, error: "Uploaded file is empty." };
  }
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    return { valid: false, error: "File size exceeds the maximum allowed limit of 10 MB." };
  }

  const normalizedMime = (mimetype || "").toLowerCase().trim();
  const ext = path.extname(originalFilename || "").toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: "Unsupported file extension. Allowed: JPG, PNG, WebP, PDF, DOC, DOCX, CSV, XLS, XLSX.",
    };
  }

  if (ALLOWED_IMAGE_MIMES.has(normalizedMime)) {
    return { valid: true, resourceType: "image", ext: ext.replace(".", "") };
  }
  if (ALLOWED_DOC_MIMES.has(normalizedMime)) {
    return { valid: true, resourceType: "raw", ext: ext.replace(".", "") };
  }

  return {
    valid: false,
    error: "Unsupported file type. Allowed: images (JPG, PNG, WebP) and documents (PDF, DOC, DOCX, CSV, XLSX).",
  };
}

export function signCloudinaryParams(params: Record<string, string | number>, apiSecret: string): string {
  const sortedKeys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort();

  const toSign = sortedKeys.map((k) => `${k}=${params[k]}`).join("&");
  return crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");
}

export interface CloudinaryUploadResult {
  publicId: string;
  resourceType: "image" | "raw";
  deliveryType: "authenticated";
  format: string;
  bytes: number;
  originalFilename: string;
}

export async function uploadReportAttachmentToCloudinary(params: {
  buffer: Buffer;
  mimetype: string;
  originalFilename: string;
  trainerId: string;
  reportId: string;
  uploadNonce?: string;
}): Promise<CloudinaryUploadResult> {
  const cfg = getCloudinaryConfig();
  if (!cfg.isConfigured) {
    throw new Error(
      "Cloudinary backend credentials (CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET) are not configured on lms-service."
    );
  }

  const validation = validateAttachmentFile(params.mimetype, params.originalFilename, params.buffer.length);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const resourceType = validation.resourceType;
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `eewyla-reports/${params.trainerId}/${params.reportId}`;

  const baseName = path
    .basename(params.originalFilename, path.extname(params.originalFilename))
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 60) || "evidence";

  // Deterministic suffix if uploadNonce is supplied so retries hit the same public_id without duplicating
  const suffix = params.uploadNonce
    ? crypto.createHash("sha256").update(params.uploadNonce).digest("hex").slice(0, 12)
    : `${timestamp}-${crypto.randomBytes(4).toString("hex")}`;

  const publicIdName = `${baseName}-${suffix}`;

  const signable: Record<string, string | number> = {
    folder,
    public_id: publicIdName,
    timestamp,
    type: "authenticated",
  };

  const signature = signCloudinaryParams(signable, cfg.apiSecret);

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(params.buffer)], { type: params.mimetype });
  formData.append("file", blob, params.originalFilename);
  formData.append("api_key", cfg.apiKey);
  formData.append("timestamp", String(timestamp));
  formData.append("folder", folder);
  formData.append("public_id", publicIdName);
  formData.append("type", "authenticated");
  formData.append("signature", signature);

  const uploadUrl = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType}/upload`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as any;
    throw new Error(errBody?.error?.message || `Cloudinary upload failed with HTTP ${res.status}`);
  }

  const data = (await res.json()) as any;
  return {
    publicId: data.public_id,
    resourceType,
    deliveryType: "authenticated",
    format: data.format || validation.ext,
    bytes: Number(data.bytes) || params.buffer.length,
    originalFilename: params.originalFilename,
  };
}

/**
 * Generates a short-lived (default 5 minutes) signed Cloudinary URL for an authenticated asset.
 * Never exposes permanent unrestricted URLs for sensitive attendance/session records.
 */
export function generateSignedAttachmentAccessUrl(params: {
  publicId: string;
  resourceType: "image" | "raw" | string;
  format?: string | null;
  download?: boolean;
  ttlSeconds?: number;
}): { url: string; expiresAt: string } {
  const cfg = getCloudinaryConfig();
  if (!cfg.isConfigured) {
    throw new Error(
      "Cloudinary backend credentials (CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET) are not configured on lms-service."
    );
  }

  const ttl = Math.min(Math.max(params.ttlSeconds || 300, 60), 900); // 1–15 minutes
  const expiresAtUnix = Math.floor(Date.now() / 1000) + ttl;
  const timestamp = Math.floor(Date.now() / 1000);

  // Use Cloudinary's private_download API so access is strictly time-bounded (expires_at) and signed
  const signable: Record<string, string | number> = {
    expires_at: expiresAtUnix,
    public_id: params.publicId,
    timestamp,
    type: "authenticated",
  };
  if (params.download) {
    signable.attachment = "true";
  }
  if (params.format) {
    signable.format = params.format;
  }

  const signature = signCloudinaryParams(signable, cfg.apiSecret);
  const query = new URLSearchParams({
    public_id: params.publicId,
    type: "authenticated",
    expires_at: String(expiresAtUnix),
    timestamp: String(timestamp),
    api_key: cfg.apiKey,
    signature,
  });
  if (params.download) query.set("attachment", "true");
  if (params.format) query.set("format", params.format);

  const resourceType = params.resourceType === "raw" ? "raw" : "image";
  return {
    url: `https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType}/download?${query.toString()}`,
    expiresAt: new Date(expiresAtUnix * 1000).toISOString(),
  };
}

export async function deleteCloudinaryAttachment(params: {
  publicId: string;
  resourceType: "image" | "raw" | string;
}): Promise<void> {
  const cfg = getCloudinaryConfig();
  if (!cfg.isConfigured) return;

  const timestamp = Math.floor(Date.now() / 1000);
  const signable: Record<string, string | number> = {
    public_id: params.publicId,
    timestamp,
    type: "authenticated",
  };
  const signature = signCloudinaryParams(signable, cfg.apiSecret);

  const formData = new FormData();
  formData.append("public_id", params.publicId);
  formData.append("type", "authenticated");
  formData.append("timestamp", String(timestamp));
  formData.append("api_key", cfg.apiKey);
  formData.append("signature", signature);

  const resourceType = params.resourceType === "raw" ? "raw" : "image";
  await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType}/destroy`, {
    method: "POST",
    body: formData,
  }).catch(() => {});
}
