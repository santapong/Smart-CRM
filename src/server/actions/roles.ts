"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { isValidPermission } from "@/lib/authz";

/**
 * Custom role management (M16). ADMIN/OWNER only. A CustomRole is a per-org
 * named bundle of "action:subject" permission strings that ADD grants on top of
 * a member's base Role (see src/lib/authz.ts). Permission strings are validated
 * against the allowed action/subject set; assignRole attaches/detaches a role to
 * a membership.
 */

async function requireAdminOrg(): Promise<string> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  return orgId;
}

const permissionsSchema = z
  .array(z.string())
  .max(50)
  .refine((perms) => perms.every(isValidPermission), {
    message: "Invalid permission string",
  });

const createSchema = z.object({
  name: z.string().trim().min(2).max(60),
  permissions: permissionsSchema.default([]),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  permissions: permissionsSchema.optional(),
});

export async function createCustomRole(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const exists = await db.customRole.findUnique({
    where: { orgId_name: { orgId, name: parsed.data.name } },
  });
  if (exists) return fail("A role with that name already exists");
  const created = await db.customRole.create({
    data: { orgId, name: parsed.data.name, permissions: parsed.data.permissions },
  });
  revalidatePath("/settings");
  return ok({ id: created.id });
}

export async function updateCustomRole(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const existing = await db.customRole.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const { name, permissions } = parsed.data;
  if (name !== undefined && name !== existing.name) {
    const clash = await db.customRole.findUnique({ where: { orgId_name: { orgId, name } } });
    if (clash) return fail("A role with that name already exists");
  }
  await db.customRole.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
    },
  });
  revalidatePath("/settings");
  return ok({ id });
}

export async function deleteCustomRole(id: string): Promise<ActionResult<{ id: string }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const res = await db.customRole.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings");
  return ok({ id });
}

/** Attach (or, with null, detach) a custom role to a membership in this org. */
export async function assignRole(
  membershipId: string,
  customRoleId: string | null,
): Promise<ActionResult<{ id: string }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const membership = await db.membership.findFirst({ where: { id: membershipId, orgId } });
  if (!membership) return fail("Not found");
  if (customRoleId) {
    const role = await db.customRole.findFirst({ where: { id: customRoleId, orgId } });
    if (!role) return fail("Role not found");
  }
  await db.membership.update({ where: { id: membershipId }, data: { customRoleId } });
  revalidatePath("/settings");
  return ok({ id: membershipId });
}
