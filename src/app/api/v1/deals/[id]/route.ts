import { z } from "zod";
import { db } from "@/lib/db";
import { emit, EVENTS } from "@/lib/events";
import { recordStageEvent } from "@/lib/stage-history";
import { gate } from "@/lib/api/crud";
import { apiOk, apiError } from "@/lib/api/respond";
import { serializeDeal } from "@/lib/api/resources";

/**
 * Public REST API — single Deal (M12).
 *   GET / PATCH / DELETE /api/v1/deals/[id]
 * Org-scoped; PATCH emits stage/status-change events like the server action.
 */

export const runtime = "nodejs";

const patchSchema = z
  .object({
    title: z.string().min(1).max(160).optional(),
    value: z.coerce.number().min(0).max(1e12).optional(),
    currency: z.string().length(3).optional(),
    stageId: z.string().min(1).optional(),
    status: z.enum(["OPEN", "WON", "LOST"]).optional(),
    contactId: z.string().nullable().optional(),
    companyId: z.string().nullable().optional(),
    closeDate: z.string().nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
  })
  .strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const g = await gate(req, "deals:read");
  if (g.response) return g.response;
  const { id } = await params;
  const deal = await db.deal.findFirst({ where: { id, orgId: g.auth.orgId } });
  if (!deal) return apiError("not_found", "Deal not found");
  return apiOk(serializeDeal(deal));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const g = await gate(req, "deals:write");
  if (g.response) return g.response;
  const { id } = await params;
  const orgId = g.auth.orgId;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_request", "Request body must be valid JSON");
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return apiError("invalid_request", "Invalid deal payload");
  const d = parsed.data;

  const existing = await db.deal.findFirst({ where: { id, orgId } });
  if (!existing) return apiError("not_found", "Deal not found");

  let pipelineId = existing.pipelineId;
  if (d.stageId && d.stageId !== existing.stageId) {
    const stage = await db.pipelineStage.findFirst({ where: { id: d.stageId, orgId } });
    if (!stage) return apiError("invalid_request", "Stage not found");
    pipelineId = stage.pipelineId;
  }

  const stageChanged = d.stageId !== undefined && d.stageId !== existing.stageId;
  const statusChanged = d.status !== undefined && d.status !== existing.status;

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.deal.update({
      where: { id },
      data: {
        ...(d.title !== undefined ? { title: d.title } : {}),
        ...(d.value !== undefined ? { value: d.value } : {}),
        ...(d.currency !== undefined ? { currency: d.currency } : {}),
        ...(d.stageId !== undefined ? { stageId: d.stageId, pipelineId } : {}),
        ...(d.status !== undefined ? { status: d.status } : {}),
        ...(d.contactId !== undefined ? { contactId: d.contactId } : {}),
        ...(d.companyId !== undefined ? { companyId: d.companyId } : {}),
        ...(d.closeDate !== undefined ? { closeDate: d.closeDate ? new Date(d.closeDate) : null } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
        version: { increment: 1 },
      },
    });
    if (stageChanged || statusChanged) {
      await recordStageEvent(
        {
          orgId,
          dealId: id,
          fromStageId: existing.stageId,
          toStageId: row.stageId,
          fromStatus: existing.status,
          toStatus: row.status,
          value: row.value,
        },
        tx,
      );
    }
    if (stageChanged) {
      await emit(tx, {
        orgId,
        name: EVENTS.DEAL_STAGE_CHANGED,
        payload: { dealId: id, fromStageId: existing.stageId, toStageId: row.stageId },
      });
    }
    if (statusChanged) {
      await emit(tx, {
        orgId,
        name: EVENTS.DEAL_STATUS_CHANGED,
        payload: { dealId: id, fromStatus: existing.status, toStatus: row.status },
      });
    }
    return row;
  });

  return apiOk(serializeDeal(updated));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const g = await gate(req, "deals:write");
  if (g.response) return g.response;
  const { id } = await params;
  const res = await db.deal.deleteMany({ where: { id, orgId: g.auth.orgId } });
  if (res.count === 0) return apiError("not_found", "Deal not found");
  return apiOk({ id, deleted: true });
}
