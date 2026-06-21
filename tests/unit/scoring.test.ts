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

import { matchesRule, scoreWithRules, computeScore, recomputeAllLeadScores } from "@/lib/scoring";
import { createScoringRule } from "@/server/actions/scoring-rules";
import { createLead, updateLead } from "@/server/actions/leads";

let orgA = "", orgB = "", userA = "", userB = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `sca${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `scb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `ScoreOrgA-${ts}`, slug: `score-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `ScoreOrgB-${ts}`, slug: `score-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.scoringRule.deleteMany({ where: { orgId: { in: orgs } } });
  await db.lead.deleteMany({ where: { orgId: { in: orgs } } });
  await db.subscription.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("scoring predicates (M13a, pure)", () => {
  it("matches each operator correctly", () => {
    const rec = { source: "Website", value: 5000, customFields: { tier: "gold" } };
    expect(matchesRule({ field: "source", op: "eq", value: "Website" }, rec)).toBe(true);
    expect(matchesRule({ field: "source", op: "eq", value: "Other" }, rec)).toBe(false);
    expect(matchesRule({ field: "source", op: "neq", value: "Other" }, rec)).toBe(true);
    expect(matchesRule({ field: "source", op: "contains", value: "web" }, rec)).toBe(true);
    expect(matchesRule({ field: "value", op: "gt", value: "1000" }, rec)).toBe(true);
    expect(matchesRule({ field: "value", op: "lt", value: "1000" }, rec)).toBe(false);
    expect(matchesRule({ field: "source", op: "exists", value: null }, rec)).toBe(true);
    expect(matchesRule({ field: "missing", op: "exists", value: null }, rec)).toBe(false);
    // customFields.* path
    expect(matchesRule({ field: "customFields.tier", op: "eq", value: "gold" }, rec)).toBe(true);
  });

  it("sums points for matching rules only", () => {
    const rules = [
      { field: "source", op: "eq", value: "Website", points: 10 },
      { field: "value", op: "gt", value: "1000", points: 20 },
      { field: "source", op: "eq", value: "Cold call", points: 99 }, // no match
    ];
    expect(scoreWithRules(rules, { source: "Website", value: 5000 })).toBe(30);
  });
});

describe("computeScore + lead lifecycle (M13a)", () => {
  beforeAll(async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    await createScoringRule({ field: "source", op: "eq", value: "Website", points: 10 });
    await createScoringRule({ field: "value", op: "gt", value: "1000", points: 25 });
  });

  it("computeScore loads org rules and sums them", async () => {
    const s = await computeScore(orgA, "lead", { source: "Website", value: 2000 });
    expect(s).toBe(35);
    const s2 = await computeScore(orgA, "lead", { source: "Referral", value: 100 });
    expect(s2).toBe(0);
  });

  it("stamps score on lead create", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createLead({ title: "Hot lead", value: 5000, source: "Website" });
    expect(r.ok).toBe(true);
    const lead = await db.lead.findUnique({ where: { id: id(r) } });
    expect(lead?.score).toBe(35);
  });

  it("recomputes score on lead update", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createLead({ title: "Cool lead", value: 100, source: "Referral" });
    let lead = await db.lead.findUnique({ where: { id: id(r) } });
    expect(lead?.score).toBe(0);
    const u = await updateLead(id(r), { title: "Cool lead", value: 5000, source: "Website", status: "NEW" });
    expect(u.ok).toBe(true);
    lead = await db.lead.findUnique({ where: { id: id(r) } });
    expect(lead?.score).toBe(35);
  });

  it("recomputeAllLeadScores backfills existing leads", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    // Insert a lead with a stale 0 score directly, then add a matching rule.
    const lead = await db.lead.create({
      data: { orgId: orgA, title: "Backfill", value: 9999, source: "Website", score: 0 },
    });
    const updated = await recomputeAllLeadScores(orgA);
    expect(updated).toBeGreaterThan(0);
    const after = await db.lead.findUnique({ where: { id: lead.id } });
    expect(after?.score).toBe(35);
  });

  it("isolates rules across orgs", async () => {
    // org B has no rules, so an identical record scores 0.
    const s = await computeScore(orgB, "lead", { source: "Website", value: 5000 });
    expect(s).toBe(0);

    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const r = await createLead({ title: "Org B lead", value: 5000, source: "Website" });
    const lead = await db.lead.findUnique({ where: { id: id(r) } });
    expect(lead?.score).toBe(0);
  });
});
