import { inngest } from "@/lib/inngest";
import { processOutboxBatch } from "@/lib/events";
import { db } from "@/lib/db";
import { buildContext, runWorkflow } from "@/lib/workflows/engine";

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

export const functions = [outboxDrain, runWorkflowJob];
