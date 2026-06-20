"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db, optimisticUpdate, OCC_CONFLICT_MESSAGE } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { recordStageEvent } from "@/lib/stage-history";
import { emit, EVENTS } from "@/lib/events";
import { withinLimit } from "@/lib/entitlements";

const LEAD_STATUSES = ["NEW", "WORKING", "QUALIFIED", "UNQUALIFIED", "CONVERTED"] as const;

const leadSchema = z.object({
  title: z.string().min(1).max(160),
  value: z.coerce.number().min(0).max(1e12).optional(),
  currency: z.string().length(3).default("USD"),
  status: z.enum(LEAD_STATUSES).default("NEW"),
  contactId: z.string().optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  source: z.string().max(120).optional().or(z.literal("")),
  sourceChannel: z.string().max(120).optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
  // Optimistic concurrency (M1) — optional; guards against concurrent writes.
  expectedVersion: z.number().int().min(0).optional(),
});

// Sentinel used to roll back the updateLead transaction on a version conflict.
class OccConflictError extends Error {}

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createLead(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = leadSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId } = await requireOrg();
  const count = await db.lead.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "leads", count))) {
    return fail("Plan limit reached: upgrade your plan to add more leads");
  }
  const d = parsed.data;
  const created = await db.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: {
        orgId,
        title: d.title,
        value: d.value ?? null,
        currency: d.currency,
        status: d.status,
        ownerId: userId,
        contactId: c(d.contactId),
        companyId: c(d.companyId),
        source: c(d.source),
        sourceChannel: c(d.sourceChannel),
        notes: c(d.notes),
      },
    });
    await emit(tx, {
      orgId,
      name: EVENTS.LEAD_CREATED,
      payload: { leadId: lead.id, status: lead.status, source: lead.source },
    });
    return lead;
  });
  revalidatePath("/leads");
  return ok({ id: created.id });
}

export async function updateLead(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = leadSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const existing = await db.lead.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const d = parsed.data;
  try {
    await db.$transaction(async (tx) => {
      const upd = await optimisticUpdate(tx.lead, {
        id,
        orgId,
        expectedVersion: d.expectedVersion,
        data: {
          title: d.title,
          value: d.value ?? null,
          currency: d.currency,
          status: d.status,
          contactId: c(d.contactId),
          companyId: c(d.companyId),
          source: c(d.source),
          sourceChannel: c(d.sourceChannel),
          notes: c(d.notes),
        },
      });
      if (!upd.ok) throw new OccConflictError();
    });
  } catch (err) {
    if (err instanceof OccConflictError) return fail(OCC_CONFLICT_MESSAGE);
    throw err;
  }
  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  return ok({ id });
}

export async function setLeadStatus(
  id: string,
  status: (typeof LEAD_STATUSES)[number],
): Promise<ActionResult<{ id: string }>> {
  if (!LEAD_STATUSES.includes(status)) return fail("Invalid status");
  const { orgId } = await requireOrg();
  const res = await db.lead.updateMany({ where: { id, orgId }, data: { status } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  return ok({ id });
}

export async function deleteLead(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const res = await db.lead.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/leads");
  return ok({ id });
}

export async function setLeadLabels(
  leadId: string,
  labelIds: string[],
): Promise<ActionResult<{ leadId: string }>> {
  const parsed = z.array(z.string().min(1)).max(50).safeParse(labelIds);
  if (!parsed.success) return fail("Invalid input");
  const { orgId } = await requireOrg();

  const lead = await db.lead.findFirst({ where: { id: leadId, orgId } });
  if (!lead) return fail("Not found");

  const ids = Array.from(new Set(parsed.data));
  if (ids.length > 0) {
    const owned = await db.leadLabel.count({ where: { id: { in: ids }, orgId } });
    if (owned !== ids.length) return fail("Not found");
  }

  await db.$transaction([
    db.leadLabelOnLead.deleteMany({ where: { leadId } }),
    ...(ids.length > 0
      ? [db.leadLabelOnLead.createMany({ data: ids.map((labelId) => ({ leadId, labelId })) })]
      : []),
  ]);

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  return ok({ leadId });
}

/**
 * Convert a lead into a Deal in the org's default pipeline's first stage.
 * Copies title/value/currency/contact/company/owner, marks the lead CONVERTED
 * and stamps convertedDealId, records a deal stage event, and emits
 * LEAD_CONVERTED — all atomically.
 */
export async function convertLeadToDeal(id: string): Promise<ActionResult<{ id: string; dealId: string }>> {
  const { orgId, userId } = await requireOrg();
  const lead = await db.lead.findFirst({ where: { id, orgId } });
  if (!lead) return fail("Not found");
  if (lead.status === "CONVERTED" || lead.convertedDealId) {
    return fail("Lead is already converted");
  }

  const pipeline = await db.pipeline.findFirst({ where: { orgId, isDefault: true } });
  if (!pipeline) return fail("No default pipeline — create one first");
  const stage = await db.pipelineStage.findFirst({
    where: { orgId, pipelineId: pipeline.id },
    orderBy: { order: "asc" },
  });
  if (!stage) return fail("Default pipeline has no stages");

  const deal = await db.$transaction(async (tx) => {
    const created = await tx.deal.create({
      data: {
        orgId,
        title: lead.title,
        value: lead.value ?? new Prisma.Decimal(0),
        currency: lead.currency,
        status: "OPEN",
        stageId: stage.id,
        pipelineId: pipeline.id,
        contactId: lead.contactId,
        companyId: lead.companyId,
        ownerId: lead.ownerId ?? userId,
      },
    });
    await tx.lead.update({
      where: { id: lead.id },
      data: { status: "CONVERTED", convertedDealId: created.id },
    });
    await recordStageEvent(
      {
        orgId,
        dealId: created.id,
        toStageId: created.stageId,
        toStatus: created.status,
        value: created.value,
        changedById: userId,
      },
      tx,
    );
    await emit(tx, {
      orgId,
      name: EVENTS.LEAD_CONVERTED,
      payload: { leadId: lead.id, dealId: created.id },
    });
    return created;
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  revalidatePath("/deals");
  return ok({ id, dealId: deal.id });
}
