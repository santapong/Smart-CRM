import * as jsonLogic from "json-logic-js";
import type { Prisma, Workflow } from "@prisma/client";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import type {
  WorkflowAction,
  WorkflowContext,
  RecordKind,
  StepResult,
} from "@/lib/workflows/types";

/**
 * No-code workflow automation engine (M9).
 *
 * Flow: a domain event is drained from the outbox → {@link dispatchEvent} finds
 * enabled Workflows for that org + trigger → {@link runWorkflow} builds a
 * context, evaluates JSON-Logic conditions, then executes the ordered action
 * steps, recording a WorkflowRun + per-step StepRun rows.
 *
 * Everything is org-scoped and defensive: a single failing action records a
 * failed StepRun and stops the run (recording the error) rather than throwing.
 */

/** An Inngest-like step handle. Only `sleep` is used (for `delay` actions). */
export type StepLike = {
  sleep: (id: string, ms: number | string) => Promise<unknown>;
};

type ExecuteOpts = {
  tx?: Prisma.TransactionClient | typeof db;
  step?: StepLike;
};

/** Map an event name to the record kind + the id key in its payload. */
function recordRefFor(
  eventName: string,
  payload: Record<string, unknown>,
): { kind: RecordKind; id: string | null } {
  const asId = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  if (eventName.startsWith("deal.")) return { kind: "deal", id: asId(payload.dealId) };
  if (eventName.startsWith("contact.")) return { kind: "contact", id: asId(payload.contactId) };
  if (eventName.startsWith("lead.")) {
    // lead.converted also carries a dealId, but the subject record is the lead.
    return { kind: "lead", id: asId(payload.leadId) };
  }
  if (eventName === "form.submitted") return { kind: "lead", id: asId(payload.leadId) };
  return { kind: null, id: null };
}

/** Serialize Decimal/Date to JSON-friendly primitives for conditions/context. */
function serializeRecord(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (v && typeof v === "object" && typeof (v as { toNumber?: unknown }).toNumber === "function") {
      out[k] = (v as { toNumber: () => number }).toNumber();
    } else out[k] = v;
  }
  return out;
}

/**
 * Load the record an event refers to and assemble the context used by
 * conditions and actions. `record` is null when the event has no resolvable
 * subject (or the row was since deleted).
 */
export async function buildContext(
  orgId: string,
  event: { name: string; payload: unknown },
): Promise<WorkflowContext> {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  const { kind, id } = recordRefFor(event.name, payload);

  let record: Record<string, unknown> | null = null;
  if (id) {
    if (kind === "deal") {
      record = await db.deal.findFirst({ where: { id, orgId } });
    } else if (kind === "contact") {
      record = await db.contact.findFirst({ where: { id, orgId } });
    } else if (kind === "lead") {
      record = await db.lead.findFirst({ where: { id, orgId } });
    }
  }

  return {
    orgId,
    event: { ...payload, name: event.name },
    recordKind: kind,
    recordId: id,
    record: serializeRecord(record),
  };
}

/**
 * Evaluate a JSON-Logic condition against the context. Empty / null / undefined
 * conditions mean "always run" (true). Any evaluation error is treated as false
 * so a broken rule never blows up a run.
 */
export function evaluateConditions(conditions: unknown, context: WorkflowContext): boolean {
  if (conditions === null || conditions === undefined) return true;
  if (typeof conditions === "object" && Object.keys(conditions as object).length === 0) return true;
  try {
    const result = jsonLogic.apply(
      conditions as jsonLogic.RulesLogic,
      context as unknown as Record<string, unknown>,
    );
    return jsonLogic.truthy(result);
  } catch {
    return false;
  }
}

/** Resolve the email address for the context's record (contact/lead/deal). */
async function recordEmail(context: WorkflowContext): Promise<string | null> {
  const rec = context.record;
  if (!rec) return null;
  // Contacts and leads may carry an email directly.
  if (typeof rec.email === "string" && rec.email.includes("@")) return rec.email;
  // Deals link to a contact — resolve that contact's email.
  if (context.recordKind === "deal" && typeof rec.contactId === "string") {
    const contact = await db.contact.findFirst({
      where: { id: rec.contactId, orgId: context.orgId },
      select: { email: true },
    });
    if (contact?.email && contact.email.includes("@")) return contact.email;
  }
  if (context.recordKind === "lead" && typeof rec.contactId === "string") {
    const contact = await db.contact.findFirst({
      where: { id: rec.contactId, orgId: context.orgId },
      select: { email: true },
    });
    if (contact?.email && contact.email.includes("@")) return contact.email;
  }
  return null;
}

/** Resolve the contactId an "add_tag" action should target. */
function contactIdFor(context: WorkflowContext): string | null {
  const rec = context.record;
  if (!rec) return null;
  if (context.recordKind === "contact") return context.recordId;
  const cid = rec.contactId;
  return typeof cid === "string" ? cid : null;
}

/**
 * Execute a single action against the context. Returns a serializable result
 * (never throws for the "soft" failures — only programmer errors propagate).
 * `tx` lets writes participate in a caller transaction; `step` enables a real
 * sleep for `delay` when running inside Inngest.
 */
export async function executeAction(
  action: WorkflowAction,
  context: WorkflowContext,
  opts: ExecuteOpts = {},
): Promise<unknown> {
  const client = opts.tx ?? db;
  switch (action.type) {
    case "update_field": {
      if (!context.recordId || !context.recordKind) return { skipped: "no_record" };
      let data: Record<string, unknown>;
      if (action.customField) {
        // Patch a single key inside the JSONB customFields column.
        const current = (context.record?.customFields as Record<string, unknown> | null) ?? {};
        data = {
          customFields: { ...current, [action.customField]: action.value ?? null } as Prisma.InputJsonValue,
        };
      } else if (action.field) {
        data = { [action.field]: action.value ?? null };
      } else {
        return { skipped: "no_field" };
      }
      const where = { id: context.recordId, orgId: context.orgId };
      // Branch per delegate so Prisma's per-model updateMany overloads apply.
      if (context.recordKind === "deal") {
        await client.deal.updateMany({ where, data });
      } else if (context.recordKind === "contact") {
        await client.contact.updateMany({ where, data });
      } else {
        await client.lead.updateMany({ where, data });
      }
      return { updated: action.customField ? { customField: action.customField } : { field: action.field } };
    }

    case "create_task": {
      const due =
        typeof action.dueInDays === "number"
          ? new Date(Date.now() + action.dueInDays * 86400000)
          : null;
      const rec = context.record;
      const activity = await client.activity.create({
        data: {
          orgId: context.orgId,
          type: "TASK",
          title: action.title?.slice(0, 160) || "Workflow task",
          body: action.body ?? null,
          dueAt: due,
          contactId: contactIdFor(context),
          dealId: context.recordKind === "deal" ? context.recordId : null,
          ownerId:
            rec && typeof rec.ownerId === "string" ? (rec.ownerId as string) : null,
        },
      });
      return { activityId: activity.id };
    }

    case "send_email": {
      const to = await recordEmail(context);
      if (!to) return { skipped: "no_email" };
      const res = await sendEmail({
        orgId: context.orgId,
        to,
        subject: action.subject?.slice(0, 200) || "Notification",
        html: action.body ?? "",
        contactId: contactIdFor(context),
        dealId: context.recordKind === "deal" ? context.recordId : null,
      });
      return { emailId: res.id, status: res.status };
    }

    case "add_tag": {
      const name = action.tag?.trim();
      if (!name) return { skipped: "no_tag" };
      const contactId = contactIdFor(context);
      if (!contactId) return { skipped: "no_contact" };
      // Upsert the org tag, then link it to the contact (idempotent).
      const tag = await client.tag.upsert({
        where: { orgId_name: { orgId: context.orgId, name } },
        update: {},
        create: { orgId: context.orgId, name },
      });
      await client.contactTag.upsert({
        where: { contactId_tagId: { contactId, tagId: tag.id } },
        update: {},
        create: { contactId, tagId: tag.id },
      });
      return { tagId: tag.id, contactId };
    }

    case "webhook": {
      const url = action.url;
      if (!url || !/^https?:\/\//.test(url)) return { skipped: "no_url" };
      // Best-effort, env-tolerant: never throw, short timeout.
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: context.event,
            recordKind: context.recordKind,
            recordId: context.recordId,
            record: context.record,
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        return { posted: true, status: resp.status };
      } catch (err) {
        return { posted: false, error: err instanceof Error ? err.message : "fetch_failed" };
      }
    }

    case "delay": {
      const seconds = typeof action.seconds === "number" ? action.seconds : 0;
      if (opts.step && seconds > 0) {
        await opts.step.sleep(`delay-${seconds}`, seconds * 1000);
        return { slept: seconds };
      }
      // Direct/test path: no real sleep.
      return { skippedSleep: seconds };
    }

    case "branch": {
      const pass = evaluateConditions(action.condition, context);
      const branch = pass ? action.then : action.else;
      const results: unknown[] = [];
      if (Array.isArray(branch)) {
        for (const sub of branch) {
          results.push(await executeAction(sub, context, opts));
        }
      }
      return { branch: pass ? "then" : "else", results };
    }

    default:
      return { skipped: "unknown_action" };
  }
}

/**
 * Run one workflow against a context: create a WorkflowRun, evaluate conditions,
 * execute the ordered actions (recording a StepRun each), then finalize. A
 * failing action stops the run and records the error. Increments runCount on a
 * completed (not skipped-by-condition) run.
 */
export async function runWorkflow(
  workflow: Pick<
    Workflow,
    "id" | "orgId" | "triggerEvent" | "conditions" | "definition"
  >,
  context: WorkflowContext,
  opts: ExecuteOpts = {},
): Promise<{ runId: string; status: string; steps: StepResult[] }> {
  const run = await db.workflowRun.create({
    data: {
      orgId: workflow.orgId,
      workflowId: workflow.id,
      triggerEvent: workflow.triggerEvent,
      context: context as unknown as Prisma.InputJsonValue,
      status: "running",
    },
  });

  // Conditions gate the whole run. A non-match is a clean "skipped" run.
  if (!evaluateConditions(workflow.conditions, context)) {
    await db.workflowRun.update({
      where: { id: run.id },
      data: { status: "skipped", finishedAt: new Date() },
    });
    return { runId: run.id, status: "skipped", steps: [] };
  }

  const actions = Array.isArray(workflow.definition)
    ? (workflow.definition as unknown as WorkflowAction[])
    : [];

  const steps: StepResult[] = [];
  let failed = false;
  let errorMsg: string | null = null;

  for (let idx = 0; idx < actions.length; idx++) {
    const action = actions[idx];
    try {
      const output = await executeAction(action, context, opts);
      await db.stepRun.create({
        data: {
          runId: run.id,
          idx,
          type: action.type,
          status: "done",
          output: (output ?? null) as Prisma.InputJsonValue,
        },
      });
      steps.push({ idx, type: action.type, status: "done", output });
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      await db.stepRun.create({
        data: {
          runId: run.id,
          idx,
          type: action.type,
          status: "failed",
          output: { error: errorMsg } as Prisma.InputJsonValue,
        },
      });
      steps.push({ idx, type: action.type, status: "failed", output: { error: errorMsg } });
      failed = true;
      break; // simple policy: stop on first failure
    }
  }

  const status = failed ? "failed" : "done";
  await db.workflowRun.update({
    where: { id: run.id },
    data: { status, error: errorMsg, finishedAt: new Date() },
  });
  await db.workflow.update({
    where: { id: workflow.id },
    data: { runCount: { increment: 1 } },
  });

  return { runId: run.id, status, steps };
}

/**
 * Find enabled workflows for the org + trigger and run each. Called from the
 * outbox drain when an event is processed. Returns the run summaries. Never
 * throws — a single failing workflow does not stop the others (errors are
 * captured per-run).
 */
export async function dispatchEvent(
  orgId: string | null | undefined,
  eventName: string,
  payload: unknown,
): Promise<{ matched: number; runs: Array<{ workflowId: string; runId: string; status: string }> }> {
  if (!orgId) return { matched: 0, runs: [] };

  const workflows = await db.workflow.findMany({
    where: { orgId, triggerEvent: eventName, enabled: true },
  });
  if (workflows.length === 0) return { matched: 0, runs: [] };

  const context = await buildContext(orgId, { name: eventName, payload });

  const runs: Array<{ workflowId: string; runId: string; status: string }> = [];
  for (const wf of workflows) {
    try {
      const res = await runWorkflow(wf, context);
      runs.push({ workflowId: wf.id, runId: res.runId, status: res.status });
    } catch (err) {
      // Defensive: a thrown run (e.g. DB hiccup) shouldn't drop sibling workflows.
      runs.push({
        workflowId: wf.id,
        runId: "",
        status: err instanceof Error ? `error:${err.message}` : "error",
      });
    }
  }

  return { matched: workflows.length, runs };
}
