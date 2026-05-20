"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const tierEnum = z.enum(["SMB", "MID_MARKET", "ENTERPRISE", "STRATEGIC"]);

const policySchema = z.object({
  tier: tierEnum,
  firstResponseMinutes: z.coerce.number().int().min(1).max(60 * 24 * 30),
  resolutionMinutes: z.coerce.number().int().min(1).max(60 * 24 * 365),
});

export async function upsertSlaPolicy(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const d = parsed.data;

  if (d.firstResponseMinutes > d.resolutionMinutes) {
    return fail("First response cannot be slower than full resolution");
  }

  const upserted = await db.slaPolicy.upsert({
    where: { orgId_tier: { orgId, tier: d.tier } },
    create: {
      orgId,
      tier: d.tier,
      firstResponseMinutes: d.firstResponseMinutes,
      resolutionMinutes: d.resolutionMinutes,
    },
    update: {
      firstResponseMinutes: d.firstResponseMinutes,
      resolutionMinutes: d.resolutionMinutes,
    },
  });
  revalidatePath("/settings");
  return ok({ id: upserted.id });
}

export async function deleteSlaPolicy(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const res = await db.slaPolicy.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings");
  return ok({ id });
}
