import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));

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

import { createDeal, moveDealToStage, setDealStatus } from "@/server/actions/deals";
import { getStageEntryCounts } from "@/lib/stage-history";

let orgId = "", userId = "", stage1 = "", stage2 = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const u = await db.user.create({ data: { email: `dse${ts}@t.io`, name: "DSE", passwordHash: pw } });
  const o = await db.organization.create({
    data: { name: `OrgDSE-${ts}`, slug: `orgdse-${ts}`, memberships: { create: { userId: u.id, role: "OWNER" } } },
  });
  const s1 = await db.pipelineStage.create({ data: { orgId: o.id, name: "Lead", order: 0 } });
  const s2 = await db.pipelineStage.create({ data: { orgId: o.id, name: "Won-ish", order: 1 } });
  orgId = o.id; userId = u.id; stage1 = s1.id; stage2 = s2.id;
  active = { userId, orgId, role: "OWNER" };
});

afterAll(async () => {
  await db.dealStageEvent.deleteMany({ where: { orgId } });
  await db.deal.deleteMany({ where: { orgId } });
  await db.pipelineStage.deleteMany({ where: { orgId } });
  await db.membership.deleteMany({ where: { orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe("deal stage event history (M5)", () => {
  it("records an entry event when a deal is created", async () => {
    const r = await createDeal({ title: "T", value: 100, stageId: stage1 });
    expect(r.ok).toBe(true);
    const dealId = (r as { data: { id: string } }).data.id;
    const events = await db.dealStageEvent.findMany({ where: { dealId } });
    expect(events.length).toBe(1);
    expect(events[0].toStageId).toBe(stage1);
    expect(events[0].fromStageId).toBeNull();
  });

  it("records a transition when a deal moves stage", async () => {
    const r = await createDeal({ title: "Mover", value: 50, stageId: stage1 });
    const dealId = (r as { data: { id: string } }).data.id;
    const mv = await moveDealToStage(dealId, stage2);
    expect(mv.ok).toBe(true);
    const events = await db.dealStageEvent.findMany({ where: { dealId }, orderBy: { changedAt: "asc" } });
    expect(events.length).toBe(2);
    expect(events[1].fromStageId).toBe(stage1);
    expect(events[1].toStageId).toBe(stage2);
  });

  it("records a status transition when a deal is won", async () => {
    const r = await createDeal({ title: "Winner", value: 10, stageId: stage1 });
    const dealId = (r as { data: { id: string } }).data.id;
    const won = await setDealStatus(dealId, "WON");
    expect(won.ok).toBe(true);
    const statusEvents = await db.dealStageEvent.findMany({ where: { dealId, toStatus: "WON" } });
    expect(statusEvents.length).toBe(1);
    expect(statusEvents[0].fromStatus).toBe("OPEN");
  });

  it("aggregates stage entry counts from the event log", async () => {
    const counts = await getStageEntryCounts(orgId);
    const s1 = counts.find((x) => x.stageId === stage1);
    expect(s1).toBeTruthy();
    expect(s1?.entries ?? 0).toBeGreaterThanOrEqual(3);
  });
});
