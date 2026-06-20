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

import { createPipeline, createStage } from "@/server/actions/pipelines";
import { createDeal, moveDealToStage } from "@/server/actions/deals";
import { isRotten, weightedValue, effectiveProbability } from "@/lib/pipeline";

let orgId = "", userId = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const u = await db.user.create({ data: { email: `pl${ts}@t.io`, name: "PL", passwordHash: pw } });
  const o = await db.organization.create({
    data: { name: `OrgPL-${ts}`, slug: `orgpl-${ts}`, memberships: { create: { userId: u.id, role: "OWNER" } } },
  });
  orgId = o.id; userId = u.id;
  active = { userId, orgId, role: "OWNER" };
  // M4: this suite creates many pipelines; lift the plan cap for this org.
  await db.entitlement.create({ data: { orgId, key: "pipelines", intValue: -1 } });
});

afterAll(async () => {
  await db.outboxEvent.deleteMany({ where: { orgId } });
  await db.entitlement.deleteMany({ where: { orgId } });
  await db.dealStageEvent.deleteMany({ where: { orgId } });
  await db.deal.deleteMany({ where: { orgId } });
  await db.pipelineStage.deleteMany({ where: { orgId } });
  await db.pipeline.deleteMany({ where: { orgId } });
  await db.subscription.deleteMany({ where: { orgId } });
  await db.membership.deleteMany({ where: { orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("multiple pipelines (M6)", () => {
  it("creates pipelines and per-pipeline stages; same stage name allowed across pipelines", async () => {
    const p1 = await createPipeline({ name: "New Business" });
    const p2 = await createPipeline({ name: "Renewals" });
    expect(p1.ok && p2.ok).toBe(true);
    const s1 = await createStage({ pipelineId: id(p1), name: "Lead", order: 0, probability: 20 });
    const s2 = await createStage({ pipelineId: id(p2), name: "Lead", order: 0, probability: 40 }); // same name, different pipeline
    expect(s1.ok).toBe(true);
    expect(s2.ok).toBe(true);
  });

  it("a created deal inherits its stage's pipelineId", async () => {
    const p = await createPipeline({ name: `P-${Date.now()}` });
    const s = await createStage({ pipelineId: id(p), name: "Intake", order: 0 });
    const d = await createDeal({ title: "Deal", value: 100, stageId: id(s) });
    expect(d.ok).toBe(true);
    const deal = await db.deal.findUnique({ where: { id: id(d) } });
    expect(deal?.pipelineId).toBe(id(p));
  });

  it("moving a deal to a stage in another pipeline updates its pipelineId", async () => {
    const pa = await createPipeline({ name: `PA-${Date.now()}` });
    const pb = await createPipeline({ name: `PB-${Date.now()}` });
    const sa = await createStage({ pipelineId: id(pa), name: "A0", order: 0 });
    const sb = await createStage({ pipelineId: id(pb), name: "B0", order: 0 });
    const d = await createDeal({ title: "Crosser", value: 10, stageId: id(sa) });
    const mv = await moveDealToStage(id(d), id(sb));
    expect(mv.ok).toBe(true);
    const deal = await db.deal.findUnique({ where: { id: id(d) } });
    expect(deal?.pipelineId).toBe(id(pb));
  });

  it("duplicate stage name within the same pipeline is rejected", async () => {
    const p = await createPipeline({ name: `Dup-${Date.now()}` });
    const a = await createStage({ pipelineId: id(p), name: "Only", order: 0 });
    const b = await createStage({ pipelineId: id(p), name: "Only", order: 1 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
  });
});

describe("rotting & weighted pipeline helpers (M6)", () => {
  it("isRotten flags stale OPEN deals past the stage threshold", () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    expect(isRotten({ updatedAt: old, status: "OPEN" }, { rottenDays: 30 })).toBe(true);
    expect(isRotten({ updatedAt: new Date(), status: "OPEN" }, { rottenDays: 30 })).toBe(false);
    expect(isRotten({ updatedAt: old, status: "WON" }, { rottenDays: 30 })).toBe(false);
    expect(isRotten({ updatedAt: old, status: "OPEN" }, { rottenDays: null })).toBe(false);
  });

  it("weightedValue uses deal override, then stage, then 100%", () => {
    expect(weightedValue(1000, { probability: null }, { probability: 50 })).toBe(500);
    expect(weightedValue(1000, { probability: 25 }, { probability: 50 })).toBe(250);
    expect(weightedValue(1000, { probability: null }, { probability: null })).toBe(1000);
    expect(effectiveProbability({ probability: null }, { probability: 70 })).toBe(70);
  });
});
