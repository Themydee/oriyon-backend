import { Request } from "express";

/**
 * Returns the active frontend URL from HTTP request headers (Origin / Referer)
 * or falls back to process.env.FRONTEND_URL / https://oriyon.themydee.com.
 */
export function getClientFrontendUrl(req?: Request): string {
  if (req) {
    const origin = req.headers.origin;
    if (origin && typeof origin === "string" && (origin.startsWith("http://") || origin.startsWith("https://"))) {
      return origin.replace(/\/$/, "");
    }
    const referer = req.headers.referer;
    if (referer && typeof referer === "string") {
      try {
        const parsed = new URL(referer);
        return `${parsed.protocol}//${parsed.host}`;
      } catch {
        // ignore malformed referer
      }
    }
  }

  const fallback = process.env.FRONTEND_URL || "https://oriyon.themydee.com";
  return fallback.replace(/\/$/, "");
}
