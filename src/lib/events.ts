import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Domain event names (M2). Written to the transactional outbox in the same
 * transaction as the mutation that produced them, then drained/fanned-out by
 * the Inngest worker (see src/inngest/functions.ts).
 */
export const EVENTS = {
  DEAL_CREATED: "deal.created",
  DEAL_STAGE_CHANGED: "deal.stage_changed",
  DEAL_STATUS_CHANGED: "deal.status_changed",
  CONTACT_CREATED: "contact.created",
  EMAIL_SENT: "email.sent",
  LEAD_CREATED: "lead.created",
  LEAD_CONVERTED: "lead.converted",
  FORM_SUBMITTED: "form.submitted",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * A Prisma client OR a `$transaction` callback client. Accepting both lets
 * callers `emit()` inside the same transaction as their write, so the event is
 * only persisted if the mutation commits.
 */
export type DbOrTx = Prisma.TransactionClient | typeof db;

/**
 * Append a domain event to the outbox (status PENDING). Pass a transaction
 * client to keep the event atomic with the originating mutation.
 */
export async function emit(
  client: DbOrTx,
  event: { orgId?: string | null; name: EventName; payload: Prisma.InputJsonValue },
): Promise<void> {
  await client.outboxEvent.create({
    data: {
      orgId: event.orgId ?? null,
      name: event.name,
      payload: event.payload,
    },
  });
}

/**
 * Drain a batch of PENDING outbox events oldest-first. Marks each PROCESSED on
 * success, or FAILED (incrementing attempts) on error. Returns counts.
 *
 * The worker (Inngest cron) calls this; it is intentionally db-only so it can
 * be unit-tested without HTTP.
 */
export async function processOutboxBatch(
  limit = 50,
): Promise<{ processed: number; failed: number }> {
  const pending = await db.outboxEvent.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let processed = 0;
  let failed = 0;

  for (const event of pending) {
    try {
      // Placeholder for real fan-out: this is where we would dispatch the event
      // to Inngest (`inngest.send`) or other subscribers/handlers. For now we
      // simply mark it processed so the outbox stays drained.
      await db.outboxEvent.update({
        where: { id: event.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      processed += 1;
    } catch {
      await db.outboxEvent.update({
        where: { id: event.id },
        data: { status: "FAILED", attempts: { increment: 1 } },
      });
      failed += 1;
    }
  }

  return { processed, failed };
}
