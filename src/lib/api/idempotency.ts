import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Lightweight idempotency for public-API POSTs (M12).
 *
 * When a request carries an `Idempotency-Key` header we record the (org, key) →
 * result mapping after a successful create. A retried request with the same key
 * returns the stored result instead of creating a duplicate. Keys are scoped
 * per-org so they can't leak across tenants.
 */

/** Read the Idempotency-Key header (trimmed) or null. */
export function idempotencyKeyFrom(req: Request): string | null {
  const v = req.headers.get("idempotency-key");
  return v && v.trim().length > 0 ? v.trim().slice(0, 200) : null;
}

/** Return a prior stored result for (orgId, key), or null if none. */
export async function getIdempotentResult(
  orgId: string,
  key: string,
): Promise<Prisma.JsonValue | null> {
  const row = await db.idempotencyKey.findUnique({
    where: { orgId_key: { orgId, key } },
  });
  return row ? row.result : null;
}

/** Store a result for (orgId, key). Ignores races (first writer wins). */
export async function saveIdempotentResult(
  orgId: string,
  key: string,
  result: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await db.idempotencyKey.create({ data: { orgId, key, result } });
  } catch {
    // Unique-constraint race → another concurrent request already stored it.
  }
}
