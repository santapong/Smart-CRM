"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";

export async function updateOrgName(name: string): Promise<ActionResult<{ id: string }>> {
  const v = z.string().min(2).max(80).safeParse(name);
  if (!v.success) return fail("Invalid name");
  const { orgId, role } = await requireOrg();
  try {
    requireRole(role, "ADMIN");
  } catch {
    return fail("Forbidden");
  }
  await db.organization.update({ where: { id: orgId }, data: { name: v.data } });
  revalidatePath("/settings");
  return ok({ id: orgId });
}

const inviteSchema = z.object({
  email: z.string().email().toLowerCase(),
  name: z.string().min(1).max(80),
  password: z.string().min(6).max(100),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
});

export async function inviteMember(input: unknown): Promise<ActionResult<{ userId: string }>> {
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role: actorRole } = await requireOrg();
  try {
    requireRole(actorRole, "ADMIN");
  } catch {
    return fail("Forbidden");
  }

  const { email, name, password, role } = parsed.data;
  const result = await db.$transaction(async (tx) => {
    let user = await tx.user.findUnique({ where: { email } });
    if (!user) {
      const passwordHash = await bcrypt.hash(password, 10);
      user = await tx.user.create({ data: { email, name, passwordHash, emailVerified: new Date() } });
    }
    const existing = await tx.membership.findUnique({ where: { userId_orgId: { userId: user.id, orgId } } });
    if (existing) return { userId: user.id };
    await tx.membership.create({ data: { userId: user.id, orgId, role } });
    return { userId: user.id };
  });

  revalidatePath("/settings");
  return ok(result);
}

export async function changeMemberRole(membershipId: string, role: "OWNER" | "ADMIN" | "MEMBER"): Promise<ActionResult<{ id: string }>> {
  const { orgId, role: actorRole } = await requireOrg();
  try {
    requireRole(actorRole, "ADMIN");
  } catch {
    return fail("Forbidden");
  }
  const existing = await db.membership.findFirst({ where: { id: membershipId, orgId } });
  if (!existing) return fail("Not found");

  if (existing.role === "OWNER" && role !== "OWNER") {
    const owners = await db.membership.count({ where: { orgId, role: "OWNER" } });
    if (owners <= 1) return fail("Cannot demote the last owner");
  }

  await db.membership.update({ where: { id: membershipId }, data: { role } });
  revalidatePath("/settings");
  return ok({ id: membershipId });
}

export async function removeMember(membershipId: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role: actorRole, userId } = await requireOrg();
  try {
    requireRole(actorRole, "ADMIN");
  } catch {
    return fail("Forbidden");
  }
  const existing = await db.membership.findFirst({ where: { id: membershipId, orgId } });
  if (!existing) return fail("Not found");
  if (existing.userId === userId) return fail("Cannot remove yourself");
  if (existing.role === "OWNER") {
    const owners = await db.membership.count({ where: { orgId, role: "OWNER" } });
    if (owners <= 1) return fail("Cannot remove the last owner");
  }
  await db.membership.delete({ where: { id: membershipId } });
  revalidatePath("/settings");
  return ok({ id: membershipId });
}
