import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * A Prisma client OR a `$transaction` callback client. Accepting both lets
 * callers write the audit row inside the same transaction as their mutation
 * (so it only persists if the write commits), exactly like {@link emit} and
 * {@link recordStageEvent}.
 */
type DbOrTx = Prisma.TransactionClient | typeof db;

/**
 * Append an entry to the AuditLog (M19a). Records who (`actorId`) did what
 * (`action`, e.g. "deal.updated") to which record (`entityType` + `entityId`),
 * with an optional human `summary` and structured `metadata`.
 *
 * Normally awaited inside the action's `$transaction` next to `emit(...)`, but
 * it is best-effort-friendly (a single insert with no further side effects), so
 * callers may also fire it on its own client.
 *
 * NOTE: this is wired into the deal lifecycle for M19a; other entities can adopt
 * recordAudit the same way (pass `db` or a `tx` as the first arg).
 */
export async function recordAudit(
  client: DbOrTx,
  input: {
    orgId: string;
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    summary?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await client.auditLog.create({
    data: {
      orgId: input.orgId,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      summary: input.summary ?? null,
      metadata: input.metadata,
    },
  });
}
