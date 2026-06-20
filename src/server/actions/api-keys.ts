"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { generateApiKey } from "@/lib/api/auth";

/**
 * API key management (M12). ADMIN-only. The plaintext key is generated and
 * returned exactly once on creation — only its hash + a non-secret lookup
 * prefix are persisted (see src/lib/api/auth.ts), so it can never be recovered.
 */

// Scopes a key may be granted. `<resource>:read|write` plus the "*" wildcard.
export const API_SCOPES = [
  "contacts:read",
  "contacts:write",
  "deals:read",
  "deals:write",
  "leads:read",
  "leads:write",
  "*",
] as const;

const createSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
});

export async function listApiKeys(): Promise<
  ActionResult<
    Array<{ id: string; name: string; lookupPrefix: string; scopes: string[]; lastUsedAt: Date | null; createdAt: Date }>
  >
> {
  const { orgId, role } = await requireOrg();
  try {
    requireRole(role, "ADMIN");
  } catch {
    return fail("Forbidden");
  }
  const keys = await db.apiKey.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, lookupPrefix: true, scopes: true, lastUsedAt: true, createdAt: true },
  });
  return ok(keys);
}

/**
 * Create an API key. Returns the FULL plaintext key once (`key`) plus the new
 * row's id — the caller must surface the key immediately; it is never stored.
 */
export async function createApiKey(
  input: unknown,
): Promise<ActionResult<{ id: string; key: string; lookupPrefix: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role, userId } = await requireOrg();
  try {
    requireRole(role, "ADMIN");
  } catch {
    return fail("Forbidden");
  }

  const { fullKey, lookupPrefix, keyHash } = generateApiKey();
  const created = await db.apiKey.create({
    data: {
      orgId,
      name: parsed.data.name,
      lookupPrefix,
      keyHash,
      scopes: parsed.data.scopes,
      createdById: userId,
    },
  });
  revalidatePath("/settings");
  return ok({ id: created.id, key: fullKey, lookupPrefix });
}

export async function revokeApiKey(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  try {
    requireRole(role, "ADMIN");
  } catch {
    return fail("Forbidden");
  }
  const res = await db.apiKey.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings");
  return ok({ id });
}
