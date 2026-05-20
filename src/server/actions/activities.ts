"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const activitySchema = z.object({
  type: z.enum(["TASK", "CALL", "MEETING", "NOTE"]).default("TASK"),
  title: z.string().min(1).max(160),
  body: z.string().max(4000).optional().or(z.literal("")),
  dueAt: z.string().optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  contactId: z.string().optional().or(z.literal("")),
  dealId: z.string().optional().or(z.literal("")),
});

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createActivity(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = activitySchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId } = await requireOrg();
  const d = parsed.data;
  const created = await db.activity.create({
    data: {
      orgId,
      type: d.type,
      title: d.title,
      body: c(d.body),
      dueAt: d.dueAt ? new Date(d.dueAt) : null,
      companyId: c(d.companyId),
      contactId: c(d.contactId),
      dealId: c(d.dealId),
      ownerId: userId,
    },
  });
  revalidatePath("/activities");
  if (created.companyId) revalidatePath(`/companies/${created.companyId}`);
  return ok({ id: created.id });
}

export async function toggleActivityComplete(id: string): Promise<ActionResult<{ id: string; completedAt: Date | null }>> {
  const { orgId } = await requireOrg();
  const existing = await db.activity.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const completedAt = existing.completedAt ? null : new Date();
  await db.activity.update({ where: { id }, data: { completedAt } });
  revalidatePath("/activities");
  return ok({ id, completedAt });
}

export async function deleteActivity(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const res = await db.activity.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/activities");
  return ok({ id });
}
