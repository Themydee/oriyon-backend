/**
 * Nigerian Phone Number Normalization & Validation Utility
 *
 * Normalizes various Nigerian phone number formats to standard E.164 format:
 * - +2348012345678  -> +2348012345678
 * - 2348012345678   -> +2348012345678
 * - 08012345678     -> +2348012345678
 * - 8012345678      -> +2348012345678
 * - Spaces, dashes, parentheses stripped automatically
 */

export function normalizeNigerianPhone(raw: string | undefined | null): string | null {
  if (!raw) return null;

  // 1. Remove all whitespace, dashes, parentheses, dots
  let cleaned = String(raw).trim().replace(/[\s\-\(\)\.]/g, "");

  // 2. Handle leading +
  if (cleaned.startsWith("+")) {
    cleaned = cleaned.substring(1);
  }

  // 3. Match Nigerian prefixes
  // Format A: 234 followed by 10 digits (e.g. 2348012345678)
  if (/^234[789][01]\d{8}$/.test(cleaned)) {
    return `+${cleaned}`;
  }

  // Format B: 0 followed by 10 digits (e.g. 08012345678)
  if (/^0[789][01]\d{8}$/.test(cleaned)) {
    return `+234${cleaned.substring(1)}`;
  }

  // Format C: 10 digits without leading 0 or 234 (e.g. 8012345678)
  if (/^[789][01]\d{8}$/.test(cleaned)) {
    return `+234${cleaned}`;
  }

  // Generic international fallback: if at least 10 digits, prefix +
  if (/^\d{10,15}$/.test(cleaned)) {
    return `+${cleaned}`;
  }

  return null;
}

/**
 * Checks if two phone numbers represent the exact same telephone number,
 * regardless of formatting, spaces, or country code representation.
 */
export function arePhoneNumbersEqual(phoneA: string | undefined | null, phoneB: string | undefined | null): boolean {
  if (!phoneA || !phoneB) return false;
  const normA = normalizeNigerianPhone(phoneA);
  const normB = normalizeNigerianPhone(phoneB);
  if (!normA || !normB) return false;
  return normA === normB;
}

/**
 * Validates whether a string is a plausible Nigerian mobile number
 */
export function isValidNigerianPhone(phone: string | undefined | null): boolean {
  if (!phone) return false;
  const norm = normalizeNigerianPhone(phone);
  if (!norm) return false;
  return /^\+234[789][01]\d{8}$/.test(norm);
}

/**
 * Safe phone number masking for application logs (data protection / NDPA 2023)
 * Example: +2348012345678 -> +234****5678
 */
export function maskPhoneNumber(phone: string | undefined | null): string {
  if (!phone) return "[EMPTY]";
  const norm = normalizeNigerianPhone(phone) || phone;
  if (norm.length <= 7) return "***";
  const start = norm.slice(0, 4);
  const end = norm.slice(-4);
  return `${start}****${end}`;
}
