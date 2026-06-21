"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { withinLimit } from "@/lib/entitlements";
import { Prisma, type SavedView } from "@prisma/client";

const SAVED_VIEW_ENTITIES = ["contact", "company", "deal", "activity"] as const;

const createSchema = z.object({
  entity: z.enum(SAVED_VIEW_ENTITIES),
  name: z.string().trim().min(1).max(80),
  filters: z.record(z.unknown()),
  shared: z.boolean().optional(),
});

// Partial update; entity is immutable once created.
const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  filters: z.record(z.unknown()).optional(),
  shared: z.boolean().optional(),
});

export async function createSavedView(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId } = await requireOrg();
  const d = parsed.data;
  // M4: enforce plan limits on the org's saved views.
  const count = await db.savedView.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "savedViews", count))) {
    return fail("Plan limit reached: upgrade your plan to add more saved views");
  }
  const created = await db.savedView.create({
    data: {
      orgId,
      ownerId: userId,
      entity: d.entity,
      name: d.name,
      filters: d.filters as Prisma.InputJsonValue,
      shared: d.shared ?? false,
    },
  });
  revalidatePath("/");
  return ok({ id: created.id });
}

export async function listSavedViews(entity?: string): Promise<ActionResult<SavedView[]>> {
  const { orgId, userId } = await requireOrg();
  const entityFilter =
    entity && (SAVED_VIEW_ENTITIES as readonly string[]).includes(entity) ? { entity } : {};
  const views = await db.savedView.findMany({
    where: {
      orgId,
      ...entityFilter,
      // Visible: the org's shared views plus the caller's own private ones.
      OR: [{ shared: true }, { ownerId: userId }],
    },
    orderBy: [{ createdAt: "asc" }],
  });
  return ok(views);
}

/** Only the owner or an ADMIN/OWNER may mutate a saved view. */
function canMutate(view: SavedView, userId: string, role: Parameters<typeof hasRole>[0]) {
  return view.ownerId === userId || hasRole(role, "ADMIN");
}

export async function updateSavedView(
  id: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId, role } = await requireOrg();
  const existing = await db.savedView.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  if (!canMutate(existing, userId, role)) return fail("You can only edit your own views");
  const d = parsed.data;
  await db.savedView.update({
    where: { id },
    data: {
      name: d.name,
      filters: d.filters as Prisma.InputJsonValue | undefined,
      shared: d.shared,
    },
  });
  revalidatePath("/");
  return ok({ id });
}

export async function deleteSavedView(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, userId, role } = await requireOrg();
  const existing = await db.savedView.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  if (!canMutate(existing, userId, role)) return fail("You can only delete your own views");
  await db.savedView.delete({ where: { id } });
  revalidatePath("/");
  return ok({ id });
}
