import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { apiError } from "@/lib/api/respond";

/**
 * Public REST API authentication (M12).
 *
 * Keys are bearer tokens of the form `sk_<lookupPrefix>_<secret>`. We store only
 * the sha256 of `<secret>` (never the plaintext) plus a unique, non-secret
 * `lookupPrefix` to find the row, then constant-time compare the hashes. This
 * is the API-key equivalent of the session auth used elsewhere — routes call
 * {@link authenticateApiRequest}, then {@link requireScope} per operation.
 */

export const KEY_PREFIX = "sk";

/** sha256 hex of a secret — used for both storage and comparison. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Generate a fresh API key. Returns the components to persist (`lookupPrefix`,
 * `keyHash`) and the FULL plaintext key to show the caller exactly once.
 */
export function generateApiKey(): { fullKey: string; lookupPrefix: string; keyHash: string } {
  const lookupPrefix = randomBytes(6).toString("hex"); // 12 chars, non-secret
  const secret = randomBytes(24).toString("hex"); // 48 chars, secret
  const fullKey = `${KEY_PREFIX}_${lookupPrefix}_${secret}`;
  return { fullKey, lookupPrefix, keyHash: hashSecret(secret) };
}

/** Constant-time string compare that won't throw on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Parse `Authorization: Bearer sk_<prefix>_<secret>` into its parts. */
export function parseBearer(header: string | null): { lookupPrefix: string; secret: string } | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const token = m[1].trim();
  const parts = token.split("_");
  // Expect exactly: sk, <prefix>, <secret>
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return null;
  const [, lookupPrefix, secret] = parts;
  if (!lookupPrefix || !secret) return null;
  return { lookupPrefix, secret };
}

export type ApiAuth = { orgId: string; scopes: string[]; apiKeyId: string };

/**
 * Resolve an API key from a parsed Authorization header to its org + scopes, or
 * null when missing/invalid. Updates `lastUsedAt` best-effort (failures here
 * never block the request).
 */
export async function resolveApiKey(header: string | null): Promise<ApiAuth | null> {
  const parsed = parseBearer(header);
  if (!parsed) return null;

  const key = await db.apiKey.findUnique({ where: { lookupPrefix: parsed.lookupPrefix } });
  if (!key) return null;

  const candidate = hashSecret(parsed.secret);
  if (!safeEqual(candidate, key.keyHash)) return null;

  // Best-effort last-used stamp; do not await-block the caller on failure.
  void db.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { orgId: key.orgId, scopes: key.scopes, apiKeyId: key.id };
}

/** True when the key's scopes include `needed` (or the wildcard "*"). */
export function requireScope(scopes: string[], needed: string): boolean {
  return scopes.includes("*") || scopes.includes(needed);
}

/**
 * Full request gate for v1 routes: resolve the key (401 on failure) and apply
 * the per-key rate limit (429 + Retry-After when blocked). On success returns
 * `{ auth }`; on failure returns `{ response }` for the route to return directly.
 */
export async function authenticateApiRequest(
  req: Request,
): Promise<{ auth: ApiAuth; response?: undefined } | { auth?: undefined; response: Response }> {
  const auth = await resolveApiKey(req.headers.get("authorization"));
  if (!auth) {
    return { response: apiError("unauthorized", "Invalid or missing API key") };
  }

  const limited = await rateLimit("api:" + auth.apiKeyId);
  if (!limited.success) {
    return {
      response: apiError("rate_limited", "Rate limit exceeded", {
        headers: { "Retry-After": "60" },
      }),
    };
  }

  return { auth };
}

/** Convenience: 403 response for a missing scope. */
export function forbiddenScope(needed: string): Response {
  return apiError("forbidden", `Missing required scope: ${needed}`);
}
