import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

let active: { userId: string; orgId: string; role: "OWNER" | "ADMIN" | "MEMBER" } | null = null;
vi.mock("@/lib/tenant", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant")>("@/lib/tenant");
  return {
    ...actual,
    requireOrg: async () => {
      if (!active) throw new Error("No active org for test");
      return active;
    },
  };
});

import {
  buildContext,
  evaluateConditions,
  runWorkflow,
  dispatchEvent,
  executeAction,
} from "@/lib/workflows/engine";
import type { WorkflowContext } from "@/lib/workflows/types";
import {
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  setWorkflowEnabled,
  cloneRecipe,
  listWorkflows,
} from "@/server/actions/workflows";

let orgA = "",
  orgB = "",
  userA = "",
  userB = "",
  stageId = "",
  pipelineId = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `wfa${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `wfb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `WfOrgA-${ts}`, slug: `wf-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `WfOrgB-${ts}`, slug: `wf-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id;
  orgB = ob.id;
  userA = ua.id;
  userB = ub.id;
  // Free plan allows 0 workflows — lift the cap for both orgs in the suite.
  await db.entitlement.create({ data: { orgId: orgA, key: "workflows", intValue: -1 } });
  await db.entitlement.create({ data: { orgId: orgB, key: "workflows", intValue: -1 } });
  // A default pipeline + first stage in org A (deals refer to a stage).
  const p = await db.pipeline.create({ data: { orgId: orgA, name: "Sales", isDefault: true, order: 0 } });
  pipelineId = p.id;
  const s = await db.pipelineStage.create({ data: { orgId: orgA, pipelineId: p.id, name: "Lead", order: 0 } });
  stageId = s.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.stepRun.deleteMany({ where: { run: { orgId: { in: orgs } } } });
  await db.workflowRun.deleteMany({ where: { orgId: { in: orgs } } });
  await db.workflow.deleteMany({ where: { orgId: { in: orgs } } });
  await db.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.activity.deleteMany({ where: { orgId: { in: orgs } } });
  await db.emailMessage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.contactTag.deleteMany({ where: { contact: { orgId: { in: orgs } } } });
  await db.tag.deleteMany({ where: { orgId: { in: orgs } } });
  await db.dealStageEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.deal.deleteMany({ where: { orgId: { in: orgs } } });
  await db.contact.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipelineStage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipeline.deleteMany({ where: { orgId: { in: orgs } } });
  await db.entitlement.deleteMany({ where: { orgId: { in: orgs } } });
  await db.subscription.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

function ctx(over: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    orgId: orgA,
    event: { name: "deal.status_changed", toStatus: "WON" },
    recordKind: "deal",
    recordId: null,
    record: null,
    ...over,
  };
}

describe("evaluateConditions (M9)", () => {
  it("empty / null conditions are always true", () => {
    expect(evaluateConditions(null, ctx())).toBe(true);
    expect(evaluateConditions(undefined, ctx())).toBe(true);
    expect(evaluateConditions({}, ctx())).toBe(true);
  });

  it("evaluates a JSON-Logic rule against the context (true and false)", () => {
    const rule = { "==": [{ var: "event.toStatus" }, "WON"] };
    expect(evaluateConditions(rule, ctx({ event: { name: "x", toStatus: "WON" } }))).toBe(true);
    expect(evaluateConditions(rule, ctx({ event: { name: "x", toStatus: "LOST" } }))).toBe(false);
  });

  it("a broken rule evaluates to false rather than throwing", () => {
    // var reference into a missing path → falsey, not an exception
    expect(evaluateConditions({ "==": [{ var: "record.nope.deep" }, 1] }, ctx())).toBe(false);
  });
});

describe("runWorkflow (M9)", () => {
  it("executes a create_task action and writes a StepRun + WorkflowRun", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const contact = await db.contact.create({
      data: { orgId: orgA, firstName: "Run", lastName: "Task", email: "run@example.com" },
    });
    const wf = await db.workflow.create({
      data: {
        orgId: orgA,
        name: "create task wf",
        triggerEvent: "contact.created",
        definition: [{ type: "create_task", title: "Follow up", dueInDays: 1 }],
      },
    });
    const context = await buildContext(orgA, { name: "contact.created", payload: { contactId: contact.id } });
    const res = await runWorkflow(wf, context);

    expect(res.status).toBe("done");
    const run = await db.workflowRun.findUnique({ where: { id: res.runId } });
    expect(run?.status).toBe("done");
    expect(run?.finishedAt).not.toBeNull();

    const steps = await db.stepRun.findMany({ where: { runId: res.runId } });
    expect(steps.length).toBe(1);
    expect(steps[0].type).toBe("create_task");
    expect(steps[0].status).toBe("done");

    // The task was actually created and linked to the contact.
    const out = steps[0].output as { activityId?: string };
    const activity = await db.activity.findUnique({ where: { id: out.activityId! } });
    expect(activity?.orgId).toBe(orgA);
    expect(activity?.contactId).toBe(contact.id);
    expect(activity?.title).toBe("Follow up");

    // runCount incremented.
    const reloaded = await db.workflow.findUnique({ where: { id: wf.id } });
    expect(reloaded?.runCount).toBe(1);
  });

  it("skips the run cleanly when conditions do not match", async () => {
    const contact = await db.contact.create({
      data: { orgId: orgA, firstName: "Skip", lastName: "Me", email: "skip@example.com" },
    });
    const wf = await db.workflow.create({
      data: {
        orgId: orgA,
        name: "conditional wf",
        triggerEvent: "contact.created",
        conditions: { "==": [{ var: "record.firstName" }, "Nobody" ] },
        definition: [{ type: "create_task", title: "Never" }],
      },
    });
    const context = await buildContext(orgA, { name: "contact.created", payload: { contactId: contact.id } });
    const res = await runWorkflow(wf, context);
    expect(res.status).toBe("skipped");
    const steps = await db.stepRun.findMany({ where: { runId: res.runId } });
    expect(steps.length).toBe(0);
  });

  it("add_tag upserts a tag and links it to the contact", async () => {
    const contact = await db.contact.create({
      data: { orgId: orgA, firstName: "Tag", lastName: "Me", email: "tag@example.com" },
    });
    const context = await buildContext(orgA, { name: "contact.created", payload: { contactId: contact.id } });
    const out = (await executeAction({ type: "add_tag", tag: "VIP" }, context)) as { tagId?: string };
    expect(out.tagId).toBeTruthy();
    const link = await db.contactTag.findFirst({ where: { contactId: contact.id, tagId: out.tagId! } });
    expect(link).not.toBeNull();
  });
});

describe("dispatchEvent (M9)", () => {
  it("runs a matching enabled workflow and skips disabled / non-matching ones", async () => {
    const contact = await db.contact.create({
      data: { orgId: orgA, firstName: "Dispatch", lastName: "Test", email: "dispatch@example.com" },
    });
    // Matching + enabled
    const enabled = await db.workflow.create({
      data: {
        orgId: orgA,
        name: "enabled match",
        triggerEvent: "contact.created",
        definition: [{ type: "create_task", title: "Dispatched" }],
        enabled: true,
      },
    });
    // Matching but disabled
    const disabled = await db.workflow.create({
      data: {
        orgId: orgA,
        name: "disabled match",
        triggerEvent: "contact.created",
        definition: [{ type: "create_task", title: "Should not run" }],
        enabled: false,
      },
    });
    // Different trigger
    await db.workflow.create({
      data: {
        orgId: orgA,
        name: "other trigger",
        triggerEvent: "deal.created",
        definition: [{ type: "create_task", title: "Wrong event" }],
        enabled: true,
      },
    });

    const before = enabled.runCount;
    const result = await dispatchEvent(orgA, "contact.created", { contactId: contact.id });

    // Only the enabled, matching workflow ran.
    expect(result.runs.some((r) => r.workflowId === enabled.id && r.status === "done")).toBe(true);
    expect(result.runs.some((r) => r.workflowId === disabled.id)).toBe(false);

    const reEnabled = await db.workflow.findUnique({ where: { id: enabled.id } });
    expect(reEnabled?.runCount).toBe(before + 1);
    const reDisabled = await db.workflow.findUnique({ where: { id: disabled.id } });
    expect(reDisabled?.runCount).toBe(0);
  });

  it("no-ops with a null orgId", async () => {
    const result = await dispatchEvent(null, "contact.created", {});
    expect(result.matched).toBe(0);
    expect(result.runs.length).toBe(0);
  });
});

describe("workflow CRUD + recipes (M9)", () => {
  it("creates, lists, updates, toggles and deletes a workflow (ADMIN)", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const r = await createWorkflow({
      name: "My automation",
      triggerEvent: "deal.created",
      definition: [{ type: "create_task", title: "x" }],
    });
    expect(r.ok).toBe(true);
    const wf = await db.workflow.findUnique({ where: { id: id(r) } });
    expect(wf?.orgId).toBe(orgA);
    expect(wf?.enabled).toBe(true);

    const list = await listWorkflows();
    expect(list.some((w) => w.id === id(r))).toBe(true);

    const upd = await updateWorkflow(id(r), {
      name: "Renamed",
      triggerEvent: "deal.created",
      definition: [{ type: "create_task", title: "y" }],
      enabled: true,
    });
    expect(upd.ok).toBe(true);
    const off = await setWorkflowEnabled(id(r), false);
    expect(off.ok).toBe(true);
    const after = await db.workflow.findUnique({ where: { id: id(r) } });
    expect(after?.name).toBe("Renamed");
    expect(after?.enabled).toBe(false);

    const del = await deleteWorkflow(id(r));
    expect(del.ok).toBe(true);
    expect(await db.workflow.findUnique({ where: { id: id(r) } })).toBeNull();
  });

  it("rejects an invalid trigger or unknown action type", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const bad = await createWorkflow({ name: "bad", triggerEvent: "not.an.event", definition: [] });
    expect(bad.ok).toBe(false);
    const badAction = await createWorkflow({
      name: "bad action",
      triggerEvent: "deal.created",
      definition: [{ type: "explode" }],
    });
    expect(badAction.ok).toBe(false);
  });

  it("rejects create for a MEMBER (RBAC)", async () => {
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    await expect(
      createWorkflow({ name: "Nope", triggerEvent: "deal.created", definition: [] }),
    ).rejects.toThrow();
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
  });

  it("cloneRecipe creates a usable workflow that can run", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const r = await cloneRecipe("contact_created_welcome");
    expect(r.ok).toBe(true);
    const wf = await db.workflow.findUnique({ where: { id: id(r) } });
    expect(wf?.triggerEvent).toBe("contact.created");
    expect(Array.isArray(wf?.definition)).toBe(true);
    expect((wf!.definition as unknown[]).length).toBeGreaterThan(0);

    // It actually runs end to end.
    const contact = await db.contact.create({
      data: { orgId: orgA, firstName: "Recipe", lastName: "Run", email: "recipe@example.com" },
    });
    const context = await buildContext(orgA, { name: "contact.created", payload: { contactId: contact.id } });
    const run = await runWorkflow(wf!, context);
    expect(run.status).toBe("done");

    const bad = await cloneRecipe("does_not_exist");
    expect(bad.ok).toBe(false);
  });
});

describe("cross-org isolation (M9)", () => {
  it("dispatchEvent for org A does not run org B's workflows and vice versa", async () => {
    const wfB = await db.workflow.create({
      data: {
        orgId: orgB,
        name: "org B wf",
        triggerEvent: "contact.created",
        definition: [{ type: "create_task", title: "B only" }],
        enabled: true,
      },
    });
    const contactA = await db.contact.create({
      data: { orgId: orgA, firstName: "Iso", lastName: "A", email: "isoa@example.com" },
    });

    const result = await dispatchEvent(orgA, "contact.created", { contactId: contactA.id });
    // None of the runs belong to org B's workflow.
    expect(result.runs.some((r) => r.workflowId === wfB.id)).toBe(false);
    const reB = await db.workflow.findUnique({ where: { id: wfB.id } });
    expect(reB?.runCount).toBe(0);
  });

  it("CRUD actions cannot touch another org's workflow", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const r = await createWorkflow({
      name: "A private",
      triggerEvent: "deal.created",
      definition: [],
    });
    const wfId = id(r);

    // Org B (ADMIN) cannot rename, toggle or delete org A's workflow.
    active = { userId: userB, orgId: orgB, role: "ADMIN" };
    const upd = await updateWorkflow(wfId, {
      name: "hijack",
      triggerEvent: "deal.created",
      definition: [],
      enabled: true,
    });
    expect(upd.ok).toBe(false);
    const toggle = await setWorkflowEnabled(wfId, false);
    expect(toggle.ok).toBe(false);
    const del = await deleteWorkflow(wfId);
    expect(del.ok).toBe(false);

    // Still intact in org A.
    const wf = await db.workflow.findUnique({ where: { id: wfId } });
    expect(wf?.orgId).toBe(orgA);
    expect(wf?.name).toBe("A private");
  });
});
