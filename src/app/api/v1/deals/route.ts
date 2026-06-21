import { z } from "zod";
import { db } from "@/lib/db";
import { emit, EVENTS } from "@/lib/events";
import { recordStageEvent } from "@/lib/stage-history";
import { listCollection, createResource } from "@/lib/api/crud";
import { serializeDeal } from "@/lib/api/resources";

/**
 * Public REST API — Deals collection (M12).
 *   GET  /api/v1/deals    list (cursor-paginated, org-scoped)
 *   POST /api/v1/deals    create (idempotent via Idempotency-Key)
 * Scopes: `deals:read` / `deals:write`. Same shape as contacts/leads.
 */

export const runtime = "nodejs";

// Mirrors the server-action deal schema (src/server/actions/deals.ts).
const createSchema = z.object({
  title: z.string().min(1).max(160),
  value: z.coerce.number().min(0).max(1e12).default(0),
  currency: z.string().length(3).default("USD"),
  stageId: z.string().min(1),
  status: z.enum(["OPEN", "WON", "LOST"]).default("OPEN"),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  closeDate: z.string().optional(),
  notes: z.string().max(4000).optional(),
});

export async function GET(req: Request): Promise<Response> {
  return listCollection(
    req,
    "deals:read",
    ({ orgId, take, cursor, skip }) =>
      db.deal.findMany({ where: { orgId }, orderBy: { id: "asc" }, take, cursor, skip }),
    serializeDeal,
  );
}

export async function POST(req: Request): Promise<Response> {
  return createResource(
    req,
    "deals:write",
    async (auth, body) => {
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) return { ok: false as const, message: "Invalid deal payload" };
      const d = parsed.data;
      // Stage must belong to the key's org (tenant isolation).
      const stage = await db.pipelineStage.findFirst({ where: { id: d.stageId, orgId: auth.orgId } });
      if (!stage) return { ok: false as const, message: "Stage not found" };

      const deal = await db.$transaction(async (tx) => {
        const created = await tx.deal.create({
          data: {
            orgId: auth.orgId,
            title: d.title,
            value: d.value,
            currency: d.currency,
            status: d.status,
            stageId: d.stageId,
            pipelineId: stage.pipelineId,
            contactId: d.contactId ?? null,
            companyId: d.companyId ?? null,
            closeDate: d.closeDate ? new Date(d.closeDate) : null,
            notes: d.notes ?? null,
          },
        });
        await recordStageEvent(
          {
            orgId: auth.orgId,
            dealId: created.id,
            toStageId: created.stageId,
            toStatus: created.status,
            value: created.value,
          },
          tx,
        );
        await emit(tx, {
          orgId: auth.orgId,
          name: EVENTS.DEAL_CREATED,
          payload: { dealId: created.id, stageId: created.stageId, status: created.status },
        });
        return created;
      });
      return { ok: true as const, row: deal };
    },
    serializeDeal,
  );
}
