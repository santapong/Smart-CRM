"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";

/**
 * Team management (M16). ADMIN/OWNER only. Teams group users within an org;
 * membership is org-scoped (a user must belong to the org to be added). Helpers
 * for reading team membership live in src/lib/teams.ts.
 */

async function requireAdminOrg(): Promise<string> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  return orgId;
}

const nameSchema = z.object({ name: z.string().trim().min(2).max(60) });

export async function createTeam(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = nameSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const exists = await db.team.findUnique({ where: { orgId_name: { orgId, name: parsed.data.name } } });
  if (exists) return fail("A team with that name already exists");
  const created = await db.team.create({ data: { orgId, name: parsed.data.name } });
  revalidatePath("/settings");
  return ok({ id: created.id });
}

export async function renameTeam(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = nameSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const existing = await db.team.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  if (parsed.data.name !== existing.name) {
    const clash = await db.team.findUnique({ where: { orgId_name: { orgId, name: parsed.data.name } } });
    if (clash) return fail("A team with that name already exists");
  }
  await db.team.update({ where: { id }, data: { name: parsed.data.name } });
  revalidatePath("/settings");
  return ok({ id });
}

export async function deleteTeam(id: string): Promise<ActionResult<{ id: string }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const res = await db.team.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings");
  return ok({ id });
}

export async function addTeamMember(teamId: string, userId: string): Promise<ActionResult<{ teamId: string; userId: string }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const team = await db.team.findFirst({ where: { id: teamId, orgId } });
  if (!team) return fail("Not found");
  // The user must be a member of this org.
  const membership = await db.membership.findFirst({ where: { orgId, userId } });
  if (!membership) return fail("User is not a member of this organization");
  const existing = await db.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
  if (existing) return ok({ teamId, userId });
  await db.teamMember.create({ data: { teamId, userId } });
  revalidatePath("/settings");
  return ok({ teamId, userId });
}

export async function removeTeamMember(teamId: string, userId: string): Promise<ActionResult<{ teamId: string; userId: string }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const team = await db.team.findFirst({ where: { id: teamId, orgId } });
  if (!team) return fail("Not found");
  const res = await db.teamMember.deleteMany({ where: { teamId, userId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings");
  return ok({ teamId, userId });
}
