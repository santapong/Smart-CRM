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

import { funnel, velocity, winLoss, leadSource, pipelineValue, runReport } from "@/lib/reports/runners";
import { goalProgress } from "@/lib/reports/goals";
import { createReport, runSavedReport, deleteReport } from "@/server/actions/reports";
import { createGoal, listGoalsWithProgress, deleteGoal } from "@/server/actions/goals";

let orgId = "",
  userId = "",
  pipelineId = "",
  s1 = "",
  s2 = "",
  s3 = "";

const day = 86_400_000;

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const u = await db.user.create({ data: { email: `rep${ts}@t.io`, name: "Rep", passwordHash: pw } });
  const o = await db.organization.create({
    data: { name: `OrgREP-${ts}`, slug: `orgrep-${ts}`, memberships: { create: { userId: u.id, role: "OWNER" } } },
  });
  orgId = o.id;
  userId = u.id;
  const p = await db.pipeline.create({ data: { orgId, name: "Sales", isDefault: true, order: 0 } });
  pipelineId = p.id;
  const st1 = await db.pipelineStage.create({ data: { orgId, pipelineId, name: "Lead", order: 0, probability: 10 } });
  const st2 = await db.pipelineStage.create({ data: { orgId, pipelineId, name: "Demo", order: 1, probability: 50 } });
  const st3 = await db.pipelineStage.create({ data: { orgId, pipelineId, name: "Closed", order: 2, probability: 90 } });
  s1 = st1.id;
  s2 = st2.id;
  s3 = st3.id;
  active = { userId, orgId, role: "OWNER" };

  const base = Date.now();
  // Helper to create a deal + its stage-event timeline directly (deterministic timestamps).
  async function makeDeal(opts: {
    title: string;
    value: number;
    status: "OPEN" | "WON" | "LOST";
    stageId: string;
    source?: string;
    timeline: Array<{ toStageId?: string; toStatus?: "OPEN" | "WON" | "LOST"; fromStageId?: string; dayOffset: number }>;
  }) {
    const deal = await db.deal.create({
      data: {
        orgId,
        title: opts.title,
        value: opts.value,
        status: opts.status,
        stageId: opts.stageId,
        pipelineId,
        ownerId: userId,
      },
    });
    for (const ev of opts.timeline) {
      await db.dealStageEvent.create({
        data: {
          orgId,
          dealId: deal.id,
          fromStageId: ev.fromStageId ?? null,
          toStageId: ev.toStageId ?? null,
          toStatus: ev.toStatus ?? null,
          value: opts.value,
          changedAt: new Date(base + ev.dayOffset * day),
        },
      });
    }
    return deal;
  }

  // Deal A: Lead -> Demo -> Closed, WON. Dwell: Lead 2d, Demo 3d.
  await makeDeal({
    title: "A",
    value: 1000,
    status: "WON",
    stageId: s3,
    source: "Website",
    timeline: [
      { toStageId: s1, toStatus: "OPEN", dayOffset: 0 },
      { fromStageId: s1, toStageId: s2, dayOffset: 2 },
      { fromStageId: s2, toStageId: s3, dayOffset: 5 },
      { toStatus: "WON", dayOffset: 6 },
    ],
  });

  // Deal B: Lead -> Demo, LOST. Dwell: Lead 4d.
  await makeDeal({
    title: "B",
    value: 500,
    status: "LOST",
    stageId: s2,
    timeline: [
      { toStageId: s1, toStatus: "OPEN", dayOffset: 0 },
      { fromStageId: s1, toStageId: s2, dayOffset: 4 },
      { toStatus: "LOST", dayOffset: 5 },
    ],
  });

  // Deal C: Lead only, OPEN.
  await makeDeal({
    title: "C",
    value: 2000,
    status: "OPEN",
    stageId: s1,
    timeline: [{ toStageId: s1, toStatus: "OPEN", dayOffset: 0 }],
  });

  // Leads for lead-source: 2 Website (1 converted -> Deal A), 1 Referral.
  const dealA = await db.deal.findFirst({ where: { orgId, title: "A" } });
  await db.lead.create({ data: { orgId, title: "L1", source: "Website", status: "CONVERTED", convertedDealId: dealA!.id } });
  await db.lead.create({ data: { orgId, title: "L2", source: "Website", status: "NEW" } });
  await db.lead.create({ data: { orgId, title: "L3", source: "Referral", status: "NEW" } });
});

afterAll(async () => {
  await db.goal.deleteMany({ where: { orgId } });
  await db.report.deleteMany({ where: { orgId } });
  await db.dashboard.deleteMany({ where: { orgId } });
  await db.dealStageEvent.deleteMany({ where: { orgId } });
  await db.lead.deleteMany({ where: { orgId } });
  await db.deal.deleteMany({ where: { orgId } });
  await db.pipelineStage.deleteMany({ where: { orgId } });
  await db.pipeline.deleteMany({ where: { orgId } });
  await db.subscription.deleteMany({ where: { orgId } });
  await db.membership.deleteMany({ where: { orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe("report runners (M11)", () => {
  it("funnel: entry counts per stage ordered by stage.order with conversion %", async () => {
    const r = await funnel(orgId, { pipelineId });
    expect(r.rows.map((x) => x.name)).toEqual(["Lead", "Demo", "Closed"]);
    // All three deals entered Lead; A+B entered Demo; A entered Closed.
    expect(r.rows[0].entries).toBe(3);
    expect(r.rows[1].entries).toBe(2);
    expect(r.rows[2].entries).toBe(1);
    expect(r.rows[0].conversionFromPrev).toBeNull();
    expect(r.rows[1].conversionFromPrev).toBe(67); // 2/3
    expect(r.rows[2].conversionFromPrev).toBe(50); // 1/2
    expect(r.total).toBe(3);
  });

  it("velocity: per-stage average dwell days from consecutive events", async () => {
    const r = await velocity(orgId, { pipelineId });
    const lead = r.rows.find((x) => x.stageId === s1)!;
    const demo = r.rows.find((x) => x.stageId === s2)!;
    // Lead dwell: A=2d, B=4d -> avg 3. Demo dwell: A=3d, B=1d (Demo->LOST) -> avg 2.
    expect(lead.avgDays).toBe(3);
    expect(lead.samples).toBe(2);
    expect(demo.avgDays).toBe(2);
  });

  it("winLoss: counts/values and win-rate over closed deals", async () => {
    const r = await winLoss(orgId);
    expect(r.won).toBe(1);
    expect(r.lost).toBe(1);
    expect(r.wonValue).toBe(1000);
    expect(r.lostValue).toBe(500);
    expect(r.winRate).toBe(50);
  });

  it("winLoss: byOwner breakdown", async () => {
    const r = await winLoss(orgId, { byOwner: true });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].won).toBe(1);
    expect(r.rows[0].lost).toBe(1);
    expect(r.rows[0].winRate).toBe(50);
  });

  it("leadSource: groups leads by source with conversion + revenue", async () => {
    const r = await leadSource(orgId);
    const web = r.rows.find((x) => x.source === "Website")!;
    const ref = r.rows.find((x) => x.source === "Referral")!;
    expect(web.leads).toBe(2);
    expect(web.converted).toBe(1);
    expect(web.revenue).toBe(1000);
    expect(ref.leads).toBe(1);
    expect(ref.converted).toBe(0);
  });

  it("pipelineValue: open + weighted value per stage", async () => {
    const r = await pipelineValue(orgId, { pipelineId });
    const lead = r.rows.find((x) => x.stageId === s1)!;
    // Only Deal C is OPEN (in Lead): value 2000, weighted 2000*10% = 200.
    expect(lead.value).toBe(2000);
    expect(lead.weighted).toBe(200);
    expect(r.totalValue).toBe(2000);
  });

  it("runReport dispatcher returns the kind-tagged result", async () => {
    const r = await runReport(orgId, "funnel", { pipelineId });
    expect(r.kind).toBe("funnel");
    if (r.kind === "funnel") expect(r.rows.length).toBe(3);
  });

  it("goalProgress: deals_won_value computes current vs target", async () => {
    const goal = await db.goal.create({
      data: {
        orgId,
        metric: "deals_won_value",
        target: 2000,
        period: "monthly",
        startsAt: new Date(Date.now() - 30 * day),
        endsAt: new Date(Date.now() + 30 * day),
      },
    });
    const p = await goalProgress(orgId, goal);
    expect(p.target).toBe(2000);
    expect(p.current).toBe(1000); // Deal A won, value 1000
    expect(p.percent).toBe(50);
    expect(p.attained).toBe(false);
    await db.goal.delete({ where: { id: goal.id } });
  });

  it("goalProgress: deals_won_count counts won deals in window", async () => {
    const goal = await db.goal.create({
      data: {
        orgId,
        metric: "deals_won_count",
        target: 1,
        period: "monthly",
        startsAt: new Date(Date.now() - 30 * day),
        endsAt: new Date(Date.now() + 30 * day),
      },
    });
    const p = await goalProgress(orgId, goal);
    expect(p.current).toBe(1);
    expect(p.attained).toBe(true);
    await db.goal.delete({ where: { id: goal.id } });
  });
});

describe("report & goal actions (M11)", () => {
  it("creates, runs and deletes a saved report (RBAC: ADMIN delete)", async () => {
    active = { userId, orgId, role: "OWNER" };
    const created = await createReport({ name: "My funnel", kind: "funnel", spec: { pipelineId }, chartType: "bar" });
    expect(created.ok).toBe(true);
    const id = (created as { data: { id: string } }).data.id;

    const run = await runSavedReport(id);
    expect(run.ok).toBe(true);
    const res = (run as { data: { kind: string } }).data;
    expect(res.kind).toBe("funnel");

    // MEMBER cannot delete.
    active = { userId, orgId, role: "MEMBER" };
    const denied = await deleteReport(id);
    expect(denied.ok).toBe(false);

    active = { userId, orgId, role: "OWNER" };
    const del = await deleteReport(id);
    expect(del.ok).toBe(true);
  });

  it("createGoal + listGoalsWithProgress returns computed progress", async () => {
    active = { userId, orgId, role: "OWNER" };
    const created = await createGoal({
      metric: "deals_won_value",
      target: 4000,
      period: "monthly",
      startsAt: new Date(Date.now() - 30 * day).toISOString(),
      endsAt: new Date(Date.now() + 30 * day).toISOString(),
    });
    expect(created.ok).toBe(true);
    const id = (created as { data: { id: string } }).data.id;

    const list = await listGoalsWithProgress();
    const g = list.find((x) => x.id === id)!;
    expect(g.progress.current).toBe(1000);
    expect(g.progress.percent).toBe(25);

    const del = await deleteGoal(id);
    expect(del.ok).toBe(true);
  });
});
