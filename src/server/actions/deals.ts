"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const dealSchema = z.object({
  title: z.string().min(1).max(160),
  value: z.coerce.number().min(0).max(1e12),
  currency: z.string().length(3).default("USD"),
  stageId: z.string().min(1),
  status: z.enum(["OPEN", "WON", "LOST"]).default("OPEN"),
  contactId: z.string().optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  closeDate: z.string().optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
});

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createDeal(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = dealSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId } = await requireOrg();
  const stage = await db.pipelineStage.findFirst({ where: { id: parsed.data.stageId, orgId } });
  if (!stage) return fail("Stage not found");
  const d = parsed.data;
  const created = await db.deal.create({
    data: {
      orgId,
      title: d.title,
      value: d.value,
      currency: d.currency,
      status: d.status,
      stageId: d.stageId,
      contactId: c(d.contactId),
      companyId: c(d.companyId),
      ownerId: userId,
      closeDate: d.closeDate ? new Date(d.closeDate) : null,
      notes: c(d.notes),
    },
  });
  revalidatePath("/deals");
  return ok({ id: created.id });
}

export async function updateDeal(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = dealSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const existing = await db.deal.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const stage = await db.pipelineStage.findFirst({ where: { id: parsed.data.stageId, orgId } });
  if (!stage) return fail("Stage not found");
  const d = parsed.data;
  await db.deal.update({
    where: { id },
    data: {
      title: d.title,
      value: d.value,
      currency: d.currency,
      status: d.status,
      stageId: d.stageId,
      contactId: c(d.contactId),
      companyId: c(d.companyId),
      closeDate: d.closeDate ? new Date(d.closeDate) : null,
      notes: c(d.notes),
    },
  });
  revalidatePath("/deals");
  revalidatePath(`/deals/${id}`);
  return ok({ id });
}

export async function moveDealToStage(id: string, stageId: string): Promise<ActionResult<{ id: string; stageId: string }>> {
  const { orgId } = await requireOrg();
  const [deal, stage] = await Promise.all([
    db.deal.findFirst({ where: { id, orgId } }),
    db.pipelineStage.findFirst({ where: { id: stageId, orgId } }),
  ]);
  if (!deal) return fail("Deal not found");
  if (!stage) return fail("Stage not found");
  await db.deal.update({ where: { id }, data: { stageId } });
  revalidatePath("/deals");
  return ok({ id, stageId });
}

export async function setDealStatus(id: string, status: "OPEN" | "WON" | "LOST"): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const res = await db.deal.updateMany({ where: { id, orgId }, data: { status } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/deals");
  revalidatePath(`/deals/${id}`);
  return ok({ id });
}

export async function deleteDeal(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const res = await db.deal.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/deals");
  return ok({ id });
}
