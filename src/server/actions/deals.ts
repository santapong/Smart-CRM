"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, optimisticUpdate, OCC_CONFLICT_MESSAGE } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { recordStageEvent } from "@/lib/stage-history";
import { emit, EVENTS } from "@/lib/events";

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
  // Optimistic concurrency (M1) — optional; guards against concurrent writes.
  expectedVersion: z.number().int().min(0).optional(),
});

// Sentinel used to roll back the updateDeal transaction on a version conflict.
class OccConflictError extends Error {}

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createDeal(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = dealSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId } = await requireOrg();
  const stage = await db.pipelineStage.findFirst({ where: { id: parsed.data.stageId, orgId } });
  if (!stage) return fail("Stage not found");
  const d = parsed.data;
  const created = await db.$transaction(async (tx) => {
    const deal = await tx.deal.create({
      data: {
        orgId,
        title: d.title,
        value: d.value,
        currency: d.currency,
        status: d.status,
        stageId: d.stageId,
        pipelineId: stage.pipelineId,
        contactId: c(d.contactId),
        companyId: c(d.companyId),
        ownerId: userId,
        closeDate: d.closeDate ? new Date(d.closeDate) : null,
        notes: c(d.notes),
      },
    });
    await recordStageEvent(
      {
        orgId,
        dealId: deal.id,
        toStageId: deal.stageId,
        toStatus: deal.status,
        value: deal.value,
        changedById: userId,
      },
      tx,
    );
    await emit(tx, {
      orgId,
      name: EVENTS.DEAL_CREATED,
      payload: { dealId: deal.id, stageId: deal.stageId, status: deal.status },
    });
    return deal;
  });
  revalidatePath("/deals");
  return ok({ id: created.id });
}

export async function updateDeal(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = dealSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId } = await requireOrg();
  const existing = await db.deal.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const stage = await db.pipelineStage.findFirst({ where: { id: parsed.data.stageId, orgId } });
  if (!stage) return fail("Stage not found");
  const d = parsed.data;
  const stageChanged = existing.stageId !== d.stageId;
  const statusChanged = existing.status !== d.status;
  try {
    await db.$transaction(async (tx) => {
      const upd = await optimisticUpdate(tx.deal, {
        id,
        orgId,
        expectedVersion: d.expectedVersion,
        data: {
          title: d.title,
          value: d.value,
          currency: d.currency,
          status: d.status,
          stageId: d.stageId,
          pipelineId: stage.pipelineId,
          contactId: c(d.contactId),
          companyId: c(d.companyId),
          closeDate: d.closeDate ? new Date(d.closeDate) : null,
          notes: c(d.notes),
        },
      });
      if (!upd.ok) throw new OccConflictError();
      if (stageChanged || statusChanged) {
        await recordStageEvent(
          {
            orgId,
            dealId: id,
            fromStageId: existing.stageId,
            toStageId: d.stageId,
            fromStatus: existing.status,
            toStatus: d.status,
            value: d.value,
            changedById: userId,
          },
          tx,
        );
      }
      if (stageChanged) {
        await emit(tx, {
          orgId,
          name: EVENTS.DEAL_STAGE_CHANGED,
          payload: { dealId: id, fromStageId: existing.stageId, toStageId: d.stageId },
        });
      }
      if (statusChanged) {
        await emit(tx, {
          orgId,
          name: EVENTS.DEAL_STATUS_CHANGED,
          payload: { dealId: id, fromStatus: existing.status, toStatus: d.status },
        });
      }
    });
  } catch (err) {
    if (err instanceof OccConflictError) return fail(OCC_CONFLICT_MESSAGE);
    throw err;
  }
  revalidatePath("/deals");
  revalidatePath(`/deals/${id}`);
  return ok({ id });
}

export async function moveDealToStage(id: string, stageId: string): Promise<ActionResult<{ id: string; stageId: string }>> {
  const { orgId, userId } = await requireOrg();
  const [deal, stage] = await Promise.all([
    db.deal.findFirst({ where: { id, orgId } }),
    db.pipelineStage.findFirst({ where: { id: stageId, orgId } }),
  ]);
  if (!deal) return fail("Deal not found");
  if (!stage) return fail("Stage not found");
  if (deal.stageId !== stageId) {
    await db.$transaction(async (tx) => {
      await tx.deal.update({ where: { id }, data: { stageId, pipelineId: stage.pipelineId } });
      await recordStageEvent(
        {
          orgId,
          dealId: id,
          fromStageId: deal.stageId,
          toStageId: stageId,
          fromStatus: deal.status,
          toStatus: deal.status,
          value: deal.value,
          changedById: userId,
        },
        tx,
      );
      await emit(tx, {
        orgId,
        name: EVENTS.DEAL_STAGE_CHANGED,
        payload: { dealId: id, fromStageId: deal.stageId, toStageId: stageId },
      });
    });
  }
  revalidatePath("/deals");
  return ok({ id, stageId });
}

export async function setDealStatus(id: string, status: "OPEN" | "WON" | "LOST"): Promise<ActionResult<{ id: string }>> {
  const { orgId, userId } = await requireOrg();
  const deal = await db.deal.findFirst({ where: { id, orgId } });
  if (!deal) return fail("Not found");
  if (deal.status !== status) {
    await db.$transaction(async (tx) => {
      await tx.deal.update({ where: { id }, data: { status } });
      await recordStageEvent(
        {
          orgId,
          dealId: id,
          fromStageId: deal.stageId,
          toStageId: deal.stageId,
          fromStatus: deal.status,
          toStatus: status,
          value: deal.value,
          changedById: userId,
        },
        tx,
      );
      await emit(tx, {
        orgId,
        name: EVENTS.DEAL_STATUS_CHANGED,
        payload: { dealId: id, fromStatus: deal.status, toStatus: status },
      });
    });
  }
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
