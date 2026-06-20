import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

import {
  getAnthropic,
  complete,
  resolveModel,
  DEFAULT_AI_MODEL,
  AI_NOT_CONFIGURED,
  _resetAnthropicForTests,
} from "@/lib/ai";
import {
  buildDealContext,
  buildContactContext,
  buildLeadContext,
  buildEmailPrompt,
  buildDealSummaryPrompt,
  buildLeadQualifyPrompt,
  buildPipelineAnswerPrompt,
  parseDraftedEmail,
} from "@/lib/ai-prompts";
import { aiDraftEmail, aiSummarizeDeal, aiQualifyLead, aiSearch } from "@/server/actions/ai";

let orgId = "",
  userId = "",
  pipelineId = "",
  stageId = "",
  dealId = "",
  contactId = "",
  leadId = "";

beforeAll(async () => {
  // Ensure the offline branch is exercised: no key in the environment.
  delete process.env.ANTHROPIC_API_KEY;
  _resetAnthropicForTests();

  const ts = Date.now();
  const u = await db.user.create({ data: { email: `ai${ts}@t.io`, name: "AI Tester" } });
  const o = await db.organization.create({
    data: { name: `OrgAI-${ts}`, slug: `orgai-${ts}`, memberships: { create: { userId: u.id, role: "OWNER" } } },
  });
  orgId = o.id;
  userId = u.id;
  // Unlock the `ai` feature for this org so actions reach the env-gated branch.
  await db.entitlement.create({ data: { orgId, key: "ai", boolValue: true } });

  const p = await db.pipeline.create({ data: { orgId, name: "Sales", isDefault: true, order: 0 } });
  pipelineId = p.id;
  const st = await db.pipelineStage.create({ data: { orgId, pipelineId, name: "Demo", order: 0, probability: 50 } });
  stageId = st.id;
  const contact = await db.contact.create({ data: { orgId, firstName: "Ada", lastName: "Lovelace", email: "ada@x.io" } });
  contactId = contact.id;
  const deal = await db.deal.create({
    data: { orgId, title: "Acme renewal", value: 5000, status: "OPEN", stageId, pipelineId, contactId, ownerId: userId },
  });
  dealId = deal.id;
  await db.dealStageEvent.create({ data: { orgId, dealId, toStageId: stageId, toStatus: "OPEN", value: 5000 } });
  const lead = await db.lead.create({ data: { orgId, title: "Inbound from site", status: "NEW", score: 42, source: "Website" } });
  leadId = lead.id;

  active = { userId, orgId, role: "OWNER" };
});

afterAll(async () => {
  await db.dealStageEvent.deleteMany({ where: { orgId } });
  await db.deal.deleteMany({ where: { orgId } });
  await db.lead.deleteMany({ where: { orgId } });
  await db.contact.deleteMany({ where: { orgId } });
  await db.pipelineStage.deleteMany({ where: { orgId } });
  await db.pipeline.deleteMany({ where: { orgId } });
  await db.entitlement.deleteMany({ where: { orgId } });
  await db.subscription.deleteMany({ where: { orgId } });
  await db.membership.deleteMany({ where: { orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  _resetAnthropicForTests();
});

describe("ai client (M14) — env gating", () => {
  it("getAnthropic() is null when no key is set", () => {
    expect(getAnthropic()).toBeNull();
  });

  it("getAnthropic() returns a client when a key is present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
    _resetAnthropicForTests();
    expect(getAnthropic()).not.toBeNull();
  });

  it("complete() returns the graceful not-configured result with no key (never throws)", async () => {
    const res = await complete({ system: "s", prompt: "p" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(AI_NOT_CONFIGURED);
  });

  it("resolveModel() falls back to the default model when AI_MODEL is unset", () => {
    delete process.env.AI_MODEL;
    expect(resolveModel()).toBe(DEFAULT_AI_MODEL);
    expect(DEFAULT_AI_MODEL).toBe("claude-sonnet-4-6");
  });

  it("resolveModel() honors the AI_MODEL override", () => {
    process.env.AI_MODEL = "claude-opus-4-8";
    expect(resolveModel()).toBe("claude-opus-4-8");
    delete process.env.AI_MODEL;
  });
});

describe("ai prompt builders (M14) — pure", () => {
  it("buildDealContext produces a deterministic context string", () => {
    const ctx = buildDealContext({
      title: "Acme renewal",
      value: 5000,
      currency: "USD",
      status: "OPEN",
      stageName: "Demo",
      contactName: "Ada Lovelace",
      companyName: "Acme",
      notes: "Champion is the VP Eng.",
      recentActivities: [{ type: "CALL", title: "Intro call", completedAt: new Date() }],
      stageHistory: [{ toStageName: "Lead", changedAt: new Date("2026-01-01") }],
    });
    expect(ctx).toContain("Deal: Acme renewal");
    expect(ctx).toContain("Value: USD 5,000");
    expect(ctx).toContain("Status: OPEN");
    expect(ctx).toContain("Stage: Demo");
    expect(ctx).toContain("Primary contact: Ada Lovelace");
    expect(ctx).toContain("Company: Acme");
    expect(ctx).toContain("Champion is the VP Eng.");
    expect(ctx).toContain("CALL: Intro call (done)");
    expect(ctx).toContain("Stage history: 2026-01-01: Lead");
  });

  it("buildContactContext and buildLeadContext include the key fields", () => {
    expect(buildContactContext({ name: "Ada Lovelace", email: "ada@x.io", title: "CTO" })).toContain(
      "Contact: Ada Lovelace",
    );
    const lead = buildLeadContext({ title: "Inbound", status: "NEW", score: 42, source: "Website" });
    expect(lead).toContain("Lead: Inbound");
    expect(lead).toContain("Score: 42");
    expect(lead).toContain("Source: Website");
  });

  it("buildEmailPrompt embeds context + instructions and asks for JSON", () => {
    const p = buildEmailPrompt("Deal: X", "Be brief");
    expect(p).toContain("Deal: X");
    expect(p).toContain("INSTRUCTIONS: Be brief");
    expect(p).toContain('"subject"');
    expect(p).toContain('"body"');
  });

  it("buildDealSummaryPrompt / buildLeadQualifyPrompt / buildPipelineAnswerPrompt wrap their inputs", () => {
    expect(buildDealSummaryPrompt("CTX")).toContain("CTX");
    expect(buildDealSummaryPrompt("CTX")).toContain("Next step:");
    expect(buildLeadQualifyPrompt("LCTX")).toContain("LCTX");
    expect(buildPipelineAnswerPrompt("How many open deals?", "STATS")).toContain("How many open deals?");
    expect(buildPipelineAnswerPrompt("q", "STATS")).toContain("STATS");
  });

  it("parseDraftedEmail extracts JSON, tolerates code fences, and falls back to plain text", () => {
    expect(parseDraftedEmail('{"subject":"Hi","body":"Hello there"}')).toEqual({
      subject: "Hi",
      body: "Hello there",
    });
    expect(parseDraftedEmail('```json\n{"subject":"S","body":"B"}\n```')).toEqual({ subject: "S", body: "B" });
    const fallback = parseDraftedEmail("just some prose");
    expect(fallback.body).toBe("just some prose");
    expect(typeof fallback.subject).toBe("string");
  });
});

describe("ai actions (M14) — graceful when AI is not configured", () => {
  it("aiDraftEmail (deal) returns the not-configured failure, no throw", async () => {
    const res = await aiDraftEmail({ dealId, instructions: "follow up" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(AI_NOT_CONFIGURED);
  });

  it("aiDraftEmail (contact) returns the not-configured failure, no throw", async () => {
    const res = await aiDraftEmail({ contactId, instructions: "intro" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(AI_NOT_CONFIGURED);
  });

  it("aiDraftEmail validates input (needs a contactId or dealId)", async () => {
    const res = await aiDraftEmail({ instructions: "hi" });
    expect(res.ok).toBe(false);
  });

  it("aiSummarizeDeal returns the not-configured failure, no throw", async () => {
    const res = await aiSummarizeDeal(dealId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(AI_NOT_CONFIGURED);
  });

  it("aiQualifyLead returns the not-configured failure, no throw", async () => {
    const res = await aiQualifyLead(leadId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(AI_NOT_CONFIGURED);
  });

  it("aiSearch still runs the bounded search and reports not-configured in the answer", async () => {
    const res = await aiSearch({ query: "Acme" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The keyword search runs regardless of the AI key.
      expect(res.data.deals.some((d) => d.title === "Acme renewal")).toBe(true);
      expect(res.data.answer).toBe(AI_NOT_CONFIGURED);
    }
  });

  it("actions are gated by the `ai` feature (fail when the org lacks it)", async () => {
    const ts = Date.now();
    const o2 = await db.organization.create({ data: { name: `OrgNoAI-${ts}`, slug: `orgnoai-${ts}` } });
    active = { userId, orgId: o2.id, role: "OWNER" };
    const res = await aiSummarizeDeal(dealId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toBe(AI_NOT_CONFIGURED); // gated before reaching the client
    // cleanup + restore
    await db.subscription.deleteMany({ where: { orgId: o2.id } });
    await db.organization.deleteMany({ where: { id: o2.id } });
    active = { userId, orgId, role: "OWNER" };
  });
});
