import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { dispatchEvent } from "@/lib/workflows/engine";
import { dispatchWebhooks } from "@/lib/webhooks";
import { dispatchSlack } from "@/lib/integrations/slack";
import { publish, orgChannel } from "@/lib/realtime";

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
  COMMENT_CREATED: "comment.created",
  DOCUMENT_GENERATED: "document.generated",
  SIGNATURE_REQUESTED: "signature.requested",
  CAMPAIGN_SEND_REQUESTED: "campaign.send_requested",
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
      // Fan-out (M9): run any enabled no-code workflows subscribed to this
      // org + event. dispatchEvent is defensive (per-run errors are captured),
      // so a misbehaving workflow won't fail outbox draining.
      await dispatchEvent(event.orgId, event.name, event.payload);
      // Fan-out (M12): deliver to the org's registered webhook endpoints.
      // dispatchWebhooks is env-tolerant — network failures are recorded on the
      // delivery row, never thrown, so they don't fail the drain.
      await dispatchWebhooks(event);
      // Fan-out (M15): notify the org's configured Slack connections. Also
      // env-tolerant — a missing/failed Slack webhook is swallowed, never
      // thrown, so it can't disrupt the drain.
      await dispatchSlack(event);
      // Fan-out (M17): broadcast to the org's realtime channel so live viewers
      // (e.g. the Kanban board, presence) update. Best-effort and env-gated —
      // publish() is a no-op without PUSHER_* and never throws on failure.
      if (event.orgId) await publish(orgChannel(event.orgId), event.name, event.payload);
      // updateMany guarded by status: a concurrent drainer (or a deleted row)
      // is a no-op (count 0) rather than a thrown "record not found".
      const upd = await db.outboxEvent.updateMany({
        where: { id: event.id, status: "PENDING" },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      if (upd.count > 0) processed += 1;
    } catch {
      const upd = await db.outboxEvent.updateMany({
        where: { id: event.id, status: "PENDING" },
        data: { status: "FAILED", attempts: { increment: 1 } },
      });
      if (upd.count > 0) failed += 1;
    }
  }

  return { processed, failed };
}
