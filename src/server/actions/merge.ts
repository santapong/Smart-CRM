"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole, ForbiddenError } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { findDuplicates, mergeRecords as mergeRecordsLib, undoMerge as undoMergeLib, type DuplicateGroup } from "@/lib/merge";

/**
 * Duplicate listing + record merge actions (M13c). Listing duplicates is
 * available to any member; merging and undoing are ADMIN-only. Org-scoped.
 */

const ENTITIES = ["contact", "company"] as const;

export async function listDuplicates(entity: unknown): Promise<ActionResult<{ groups: DuplicateGroup[] }>> {
  const parsed = z.enum(ENTITIES).safeParse(entity);
  if (!parsed.success) return fail("Invalid entity");
  const { orgId } = await requireOrg();
  const groups = await findDuplicates(orgId, parsed.data);
  return ok({ groups });
}

const mergeSchema = z.object({
  entity: z.enum(ENTITIES),
  targetId: z.string().min(1),
  sourceId: z.string().min(1),
});

export async function mergeRecords(input: unknown): Promise<ActionResult<{ mergeLogId: string }>> {
  const parsed = mergeSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  try {
    requireRole(role, "ADMIN");
  } catch (err) {
    if (err instanceof ForbiddenError) return fail("Admins only");
    throw err;
  }
  const { entity, targetId, sourceId } = parsed.data;
  try {
    const res = await mergeRecordsLib(orgId, entity, targetId, sourceId);
    revalidatePath("/contacts");
    revalidatePath("/companies");
    revalidatePath("/settings/duplicates");
    return ok({ mergeLogId: res.mergeLogId });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Merge failed");
  }
}

export async function undoMerge(mergeLogId: string): Promise<ActionResult<{ sourceId: string }>> {
  if (typeof mergeLogId !== "string" || mergeLogId.length === 0) return fail("Invalid id");
  const { orgId, role } = await requireOrg();
  try {
    requireRole(role, "ADMIN");
  } catch (err) {
    if (err instanceof ForbiddenError) return fail("Admins only");
    throw err;
  }
  try {
    const res = await undoMergeLib(orgId, mergeLogId);
    revalidatePath("/contacts");
    revalidatePath("/companies");
    revalidatePath("/settings/duplicates");
    return ok({ sourceId: res.sourceId });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Undo failed");
  }
}

/** Recent merges (for the undo list). Org-scoped, newest first. */
export async function listRecentMerges(): Promise<
  ActionResult<{ merges: { id: string; entity: string; createdAt: string }[] }>
> {
  const { orgId } = await requireOrg();
  const merges = await db.mergeLog.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, entity: true, createdAt: true },
  });
  return ok({ merges: merges.map((m) => ({ id: m.id, entity: m.entity, createdAt: m.createdAt.toISOString() })) });
}
