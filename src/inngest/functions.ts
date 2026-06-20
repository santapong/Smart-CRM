import { inngest } from "@/lib/inngest";
import { processOutboxBatch } from "@/lib/events";
import { db } from "@/lib/db";
import { buildContext, runWorkflow } from "@/lib/workflows/engine";
import { sendNotificationDigests } from "@/lib/notification-digest";
import { retryPendingWebhooks } from "@/lib/webhooks";
import { processDueEnrollments } from "@/lib/sequences/runner";

/**
 * Drain the transactional outbox on a schedule (M2). Runs every minute and
 * fans out any PENDING events — which in turn dispatches enabled no-code
 * workflows (M9). Safe to run with no API keys locally.
 */
export const outboxDrain = inngest.createFunction(
  { id: "outbox-drain", triggers: [{ cron: "* * * * *" }] },
  async () => {
    const result = await processOutboxBatch();
    return result;
  },
);

/**
 * Run a single workflow as an Inngest job (M9). This is the path that supports
 * real `delay` steps via `step.sleep` — pass the step handle through so the
 * engine sleeps between actions instead of no-op'ing (as the direct/outbox path
 * does). Triggered by sending the `workflow/run` event.
 */
export const runWorkflowJob = inngest.createFunction(
  { id: "workflow-run", triggers: [{ event: "workflow/run" }] },
  async ({ event, step }) => {
    const { orgId, workflowId, eventName, payload } = (event.data ?? {}) as {
      orgId: string;
      workflowId: string;
      eventName: string;
      payload: unknown;
    };
    const workflow = await db.workflow.findFirst({ where: { id: workflowId, orgId, enabled: true } });
    if (!workflow) return { skipped: "not_found_or_disabled" };
    const context = await buildContext(orgId, { name: eventName, payload });
    const res = await runWorkflow(workflow, context, { step });
    return { runId: res.runId, status: res.status };
  },
);

/**
 * Daily email digest of unread notifications (M10). For each user with unread
 * notifications in an org, sends a single summary via sendEmail — fully
 * env-gated, so it's a no-op (recorded + skipped) without a RESEND_API_KEY.
 */
export const notificationDigest = inngest.createFunction(
  { id: "notification-digest", triggers: [{ cron: "0 13 * * *" }] },
  async () => {
    return sendNotificationDigests();
  },
);

/**
 * Retry failed/pending outbound webhook deliveries (M12). Runs every minute and
 * re-attempts deliveries whose `nextAttemptAt` is due, with exponential backoff
 * up to the attempt cap (see src/lib/webhooks.ts). Env-tolerant — never throws.
 */
export const webhookRetry = inngest.createFunction(
  { id: "webhook-retry", triggers: [{ cron: "* * * * *" }] },
  async () => {
    return retryPendingWebhooks();
  },
);

/**
 * Advance due sales-sequence enrollments (M13b). Runs every few minutes and
 * executes each active enrollment's current step (email/task/wait), then
 * advances it — see src/lib/sequences/runner.ts. Env-tolerant: email sends are
 * recorded-and-skipped without a RESEND_API_KEY, and a failing step never
 * breaks the batch.
 */
export const sequenceTick = inngest.createFunction(
  { id: "sequence-tick", triggers: [{ cron: "*/5 * * * *" }] },
  async () => {
    return processDueEnrollments();
  },
);

export const functions = [outboxDrain, runWorkflowJob, notificationDigest, webhookRetry, sequenceTick];
