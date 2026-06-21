import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

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

import { connectSlack, updateSlack, disconnect, testSlack, listIntegrations } from "@/server/actions/integrations";
import { decryptSecret } from "@/lib/crypto";
import { dispatchSlack, notifyDeal, SLACK_WEBHOOK_SECRET } from "@/lib/integrations/slack";
import { EVENTS } from "@/lib/events";

let orgA = "", orgB = "", userA = "", userB = "", stageWon = "";

const WEBHOOK_A = "https://hooks.slack.com/services/AAA/BBB/orgAtoken";
const WEBHOOK_B = "https://hooks.slack.com/services/CCC/DDD/orgBtoken";

beforeAll(async () => {
  // No ENCRYPTION_KEY → dev fallback key is used by the vault.
  delete process.env.ENCRYPTION_KEY;
  const ts = Date.now();
  const ua = await db.user.create({ data: { email: `inta${ts}@t.io`, name: "A" } });
  const ub = await db.user.create({ data: { email: `intb${ts}@t.io`, name: "B" } });
  const oa = await db.organization.create({
    data: { name: `IntA-${ts}`, slug: `int-a-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `IntB-${ts}`, slug: `int-b-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;
  // Lift the integrations limit so multiple connections can be created in tests.
  await db.entitlement.create({ data: { orgId: orgA, key: "integrations", intValue: -1 } });
  await db.entitlement.create({ data: { orgId: orgB, key: "integrations", intValue: -1 } });

  const p = await db.pipeline.create({ data: { orgId: orgA, name: "Sales", isDefault: true, order: 0 } });
  const s = await db.pipelineStage.create({ data: { orgId: orgA, pipelineId: p.id, name: "Closed Won", order: 0 } });
  stageWon = s.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.encryptedSecret.deleteMany({ where: { orgId: { in: orgs } } });
  await db.connection.deleteMany({ where: { orgId: { in: orgs } } });
  await db.deal.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipelineStage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipeline.deleteMany({ where: { orgId: { in: orgs } } });
  await db.lead.deleteMany({ where: { orgId: { in: orgs } } });
  await db.entitlement.deleteMany({ where: { orgId: { in: orgs } } });
  await db.subscription.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

beforeEach(async () => {
  await db.encryptedSecret.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.connection.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  active = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A captured-call fetch stub that always returns 200. */
function stubFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return { status: 200, ok: true } as Response;
    }),
  );
  return calls;
}

describe("connectSlack (M15)", () => {
  it("is ADMIN-only", async () => {
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const r = await connectSlack({ webhookUrl: WEBHOOK_A, events: ["deal.won"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Forbidden");
  });

  it("rejects a non-https URL", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const r = await connectSlack({ webhookUrl: "http://hooks.slack.com/x", events: ["deal.won"] });
    expect(r.ok).toBe(false);
  });

  it("creates a Connection and stores the webhook URL encrypted (recoverable)", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const r = await connectSlack({ webhookUrl: WEBHOOK_A, events: ["deal.won", "lead.created"] });
    expect(r.ok).toBe(true);

    const conn = await db.connection.findFirst({ where: { orgId: orgA, provider: "slack" } });
    expect(conn).not.toBeNull();
    expect((conn!.config as { events: string[] }).events).toEqual(["deal.won", "lead.created"]);

    const secret = await db.encryptedSecret.findFirst({
      where: { orgId: orgA, connectionId: conn!.id, name: SLACK_WEBHOOK_SECRET },
    });
    expect(secret).not.toBeNull();
    // Ciphertext must not leak the plaintext, but must decrypt back to it.
    expect(secret!.ciphertext).not.toContain("hooks.slack.com");
    expect(decryptSecret(secret!)).toBe(WEBHOOK_A);
  });
});

describe("listIntegrations (M15)", () => {
  it("returns the registry joined with the org's connections (ADMIN)", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    await connectSlack({ webhookUrl: WEBHOOK_A, events: ["deal.won"] });
    const r = await listIntegrations();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const slack = r.data.find((p) => p.key === "slack");
    expect(slack?.configured).toBe(true);
    expect(slack?.connections.length).toBe(1);
    // Nango-backed providers are not configured without NANGO_SECRET_KEY.
    const gmail = r.data.find((p) => p.key === "gmail");
    expect(gmail?.configured).toBe(false);
  });
});

describe("dispatchSlack honors configured events + org (M15)", () => {
  it("posts for a subscribed event (deal.won) only", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    // Subscribe to deal.won only.
    await connectSlack({ webhookUrl: WEBHOOK_A, events: ["deal.won"] });
    const deal = await db.deal.create({
      data: { orgId: orgA, title: "Acme", value: 1000, status: "WON", stageId: stageWon },
    });

    const calls = stubFetch();
    // A WON status change → mapped to deal.won, which is subscribed.
    const sentWon = await dispatchSlack({
      orgId: orgA,
      name: EVENTS.DEAL_STATUS_CHANGED,
      payload: { dealId: deal.id, toStatus: "WON" },
    });
    expect(sentWon).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(WEBHOOK_A);
    expect(String((calls[0].body as { text: string }).text)).toContain("Acme");

    // A stage change is NOT subscribed → no post.
    const sentStage = await dispatchSlack({
      orgId: orgA,
      name: EVENTS.DEAL_STAGE_CHANGED,
      payload: { dealId: deal.id, toStageId: stageWon },
    });
    expect(sentStage).toBe(0);
    expect(calls.length).toBe(1);
  });

  it("does not post for a LOST status change (not a Slack alert)", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    await connectSlack({ webhookUrl: WEBHOOK_A, events: ["deal.won"] });
    const deal = await db.deal.create({
      data: { orgId: orgA, title: "Lost one", value: 1, status: "LOST", stageId: stageWon },
    });
    const calls = stubFetch();
    const sent = await dispatchSlack({
      orgId: orgA,
      name: EVENTS.DEAL_STATUS_CHANGED,
      payload: { dealId: deal.id, toStatus: "LOST" },
    });
    expect(sent).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("is cross-org isolated — org A's event never reaches org B's Slack", async () => {
    // org B connects Slack and subscribes to deal.won.
    active = { userId: userB, orgId: orgB, role: "ADMIN" };
    await connectSlack({ webhookUrl: WEBHOOK_B, events: ["deal.won"] });

    const deal = await db.deal.create({
      data: { orgId: orgA, title: "OrgA deal", value: 1, status: "WON", stageId: stageWon },
    });
    const calls = stubFetch();
    // Dispatch an org A event; org B's connection must not be touched.
    const sent = await dispatchSlack({
      orgId: orgA,
      name: EVENTS.DEAL_STATUS_CHANGED,
      payload: { dealId: deal.id, toStatus: "WON" },
    });
    expect(sent).toBe(0); // org A has no Slack connection here
    expect(calls.find((c) => c.url === WEBHOOK_B)).toBeUndefined();
  });

  it("posts a lead.created alert when subscribed", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    await connectSlack({ webhookUrl: WEBHOOK_A, events: ["lead.created"] });
    const lead = await db.lead.create({ data: { orgId: orgA, title: "Inbound lead", value: 500 } });
    const calls = stubFetch();
    const sent = await dispatchSlack({
      orgId: orgA,
      name: EVENTS.LEAD_CREATED,
      payload: { leadId: lead.id },
    });
    expect(sent).toBe(1);
    expect(String((calls[0].body as { text: string }).text)).toContain("Inbound lead");
  });
});

describe("notifyDeal + testSlack + disconnect (M15)", () => {
  it("notifyDeal posts to the org's active connection", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    await connectSlack({ webhookUrl: WEBHOOK_A, events: ["deal.won"] });
    const deal = await db.deal.create({
      data: { orgId: orgA, title: "Notify deal", value: 42, status: "WON", stageId: stageWon },
    });
    const calls = stubFetch();
    const ok = await notifyDeal(orgA, {
      name: EVENTS.DEAL_STATUS_CHANGED,
      payload: { dealId: deal.id, toStatus: "WON" },
    });
    expect(ok).toBe(true);
    expect(calls[0].url).toBe(WEBHOOK_A);
  });

  it("testSlack sends a message; disconnect removes the connection + secret", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const created = await connectSlack({ webhookUrl: WEBHOOK_A, events: ["deal.won"] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const calls = stubFetch();
    const test = await testSlack(created.data.id);
    expect(test.ok).toBe(true);
    expect(calls.length).toBe(1);

    const dis = await disconnect(created.data.id);
    expect(dis.ok).toBe(true);
    const remaining = await db.connection.count({ where: { id: created.data.id } });
    expect(remaining).toBe(0);
    const secrets = await db.encryptedSecret.count({ where: { connectionId: created.data.id } });
    expect(secrets).toBe(0);
  });

  it("updateSlack rotates the webhook URL", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const created = await connectSlack({ webhookUrl: WEBHOOK_A, events: ["deal.won"] });
    if (!created.ok) throw new Error("setup failed");
    const upd = await updateSlack({ connectionId: created.data.id, webhookUrl: WEBHOOK_B, events: ["lead.created"] });
    expect(upd.ok).toBe(true);

    const secret = await db.encryptedSecret.findFirst({
      where: { connectionId: created.data.id, name: SLACK_WEBHOOK_SECRET },
    });
    expect(decryptSecret(secret!)).toBe(WEBHOOK_B);
    const conn = await db.connection.findUnique({ where: { id: created.data.id } });
    expect((conn!.config as { events: string[] }).events).toEqual(["lead.created"]);
  });
});
