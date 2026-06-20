import { inngest } from "@/lib/inngest";
import { processOutboxBatch } from "@/lib/events";

/**
 * Drain the transactional outbox on a schedule (M2). Runs every minute and
 * fans out any PENDING events. Safe to run with no API keys locally.
 */
export const outboxDrain = inngest.createFunction(
  { id: "outbox-drain", triggers: [{ cron: "* * * * *" }] },
  async () => {
    const result = await processOutboxBatch();
    return result;
  },
);

export const functions = [outboxDrain];
