import { db } from "@/lib/db";
import type { DealStatus, Prisma } from "@prisma/client";

type DbOrTx = Prisma.TransactionClient | typeof db;

/**
 * Append a deal stage/status transition to the DealStageEvent log.
 * Foundation for funnel / velocity / win-rate analytics (M5).
 *
 * Pass a transaction client as the second arg to record the event atomically
 * with the originating deal mutation (M2 outbox integration).
 */
export async function recordStageEvent(
  input: {
    orgId: string;
    dealId: string;
    fromStageId?: string | null;
    toStageId?: string | null;
    fromStatus?: DealStatus | null;
    toStatus?: DealStatus | null;
    value?: Prisma.Decimal | number | string;
    changedById?: string | null;
  },
  client: DbOrTx = db,
): Promise<void> {
  await client.dealStageEvent.create({
    data: {
      orgId: input.orgId,
      dealId: input.dealId,
      fromStageId: input.fromStageId ?? null,
      toStageId: input.toStageId ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      value: input.value ?? 0,
      changedById: input.changedById ?? null,
    },
  });
}

/** Number of deals that have entered each stage (from the event log). */
export async function getStageEntryCounts(
  orgId: string,
): Promise<Array<{ stageId: string; entries: number }>> {
  const rows = await db.dealStageEvent.groupBy({
    by: ["toStageId"],
    where: { orgId, toStageId: { not: null } },
    _count: { _all: true },
  });
  return rows
    .filter((r) => r.toStageId)
    .map((r) => ({ stageId: r.toStageId as string, entries: r._count._all }));
}
