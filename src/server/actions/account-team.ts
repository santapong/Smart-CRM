"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const teamRole = z.enum(["OWNER", "AE", "SE", "CSM", "EXEC_SPONSOR"]);

const assignSchema = z.object({
  companyId: z.string().min(1),
  userId: z.string().min(1),
  role: teamRole,
});

export async function addAccountTeamMember(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;

  // Both the account and the user must belong to the active org.
  const [company, membership] = await Promise.all([
    db.company.findFirst({ where: { id: d.companyId, orgId } }),
    db.membership.findFirst({ where: { userId: d.userId, orgId } }),
  ]);
  if (!company) return fail("Account not found");
  if (!membership) return fail("User is not a member of this organization");

  const exists = await db.accountAssignment.findFirst({
    where: { companyId: d.companyId, userId: d.userId, role: d.role },
  });
  if (exists) return fail("That role is already assigned to this user on this account");

  const created = await db.accountAssignment.create({
    data: { orgId, companyId: d.companyId, userId: d.userId, role: d.role },
  });

  revalidatePath(`/companies/${d.companyId}`);
  return ok({ id: created.id });
}

export async function removeAccountTeamMember(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const existing = await db.accountAssignment.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  await db.accountAssignment.delete({ where: { id } });
  revalidatePath(`/companies/${existing.companyId}`);
  return ok({ id });
}
