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

import { recordAudit } from "@/lib/audit";
import { loadDealTimeline } from "@/lib/audit-timeline";
import { createDeal, updateDeal, moveDealToStage, setDealStatus, deleteDeal } from "@/server/actions/deals";

let orgA = "", orgB = "", userA = "", userB = "", stage1 = "", stage2 = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `audit-a-${ts}@t.io`, name: "Audit A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `audit-b-${ts}@t.io`, name: "Audit B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `AuditA-${ts}`, slug: `audit-a-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `AuditB-${ts}`, slug: `audit-b-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;
  const s1 = await db.pipelineStage.create({ data: { orgId: orgA, name: "Lead", order: 0 } });
  const s2 = await db.pipelineStage.create({ data: { orgId: orgA, name: "Won-ish", order: 1 } });
  stage1 = s1.id; stage2 = s2.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
  await db.dealStageEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.deal.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipelineStage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("recordAudit (M19a)", () => {
  it("writes a row with the action / entity / actor fields persisted", async () => {
    await recordAudit(db, {
      orgId: orgA,
      actorId: userA,
      action: "test.custom",
      entityType: "deal",
      entityId: "deal-xyz",
      summary: "A custom audit line",
      metadata: { foo: "bar" },
    });
    const row = await db.auditLog.findFirst({
      where: { orgId: orgA, action: "test.custom", entityId: "deal-xyz" },
    });
    expect(row).toBeTruthy();
    expect(row?.actorId).toBe(userA);
    expect(row?.entityType).toBe("deal");
    expect(row?.summary).toBe("A custom audit line");
    expect((row?.metadata as { foo?: string })?.foo).toBe("bar");
  });

  it("defaults a null actor when none is given", async () => {
    await recordAudit(db, { orgId: orgA, action: "system.event", entityType: "deal", entityId: "deal-sys" });
    const row = await db.auditLog.findFirst({ where: { orgId: orgA, action: "system.event" } });
    expect(row?.actorId).toBeNull();
  });
});

describe("deal lifecycle writes audit rows (M19a)", () => {
  it("records deal.created with the acting user", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createDeal({ title: "Audited deal", value: 100, stageId: stage1 });
    expect(r.ok).toBe(true);
    const dealId = id(r);
    const audit = await db.auditLog.findFirst({ where: { orgId: orgA, entityId: dealId, action: "deal.created" } });
    expect(audit).toBeTruthy();
    expect(audit?.actorId).toBe(userA);
    expect(audit?.entityType).toBe("deal");
  });

  it("records deal.updated / deal.moved / deal.status_changed / deal.deleted", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createDeal({ title: "Lifecycle", value: 50, stageId: stage1 });
    const dealId = id(r);

    const upd = await updateDeal(dealId, { title: "Lifecycle v2", value: 75, stageId: stage1 });
    expect(upd.ok).toBe(true);
    const mv = await moveDealToStage(dealId, stage2);
    expect(mv.ok).toBe(true);
    const st = await setDealStatus(dealId, "WON");
    expect(st.ok).toBe(true);
    const del = await deleteDeal(dealId);
    expect(del.ok).toBe(true);

    const actions = (
      await db.auditLog.findMany({ where: { orgId: orgA, entityId: dealId }, orderBy: { createdAt: "asc" } })
    ).map((a) => a.action);
    expect(actions).toContain("deal.created");
    expect(actions).toContain("deal.updated");
    expect(actions).toContain("deal.moved");
    expect(actions).toContain("deal.status_changed");
    // The delete audit row survives the deal deletion (no FK to Deal).
    expect(actions).toContain("deal.deleted");
  });
});

describe("loadDealTimeline (M19a)", () => {
  it("merges AuditLog + DealStageEvent newest-first and resolves actor names", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createDeal({ title: "Timeline deal", value: 10, stageId: stage1 });
    const dealId = id(r);
    await moveDealToStage(dealId, stage2);

    const entries = await loadDealTimeline(orgA, dealId);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // Contains both kinds (audit from create/move, stage from the event log).
    expect(entries.some((e) => e.kind === "audit")).toBe(true);
    expect(entries.some((e) => e.kind === "stage")).toBe(true);
    // Newest-first ordering.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].at.getTime()).toBeGreaterThanOrEqual(entries[i].at.getTime());
    }
    // Actor name resolved from membership.
    expect(entries.some((e) => e.actorName === "Audit A")).toBe(true);
  });

  it("is org-scoped — org B cannot see org A's deal history", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createDeal({ title: "Private to A", value: 1, stageId: stage1 });
    const dealId = id(r);

    // Same deal id, but scoped to org B → no entries leak.
    const leaked = await loadDealTimeline(orgB, dealId);
    expect(leaked.length).toBe(0);

    // And the AuditLog query itself is org-scoped.
    const crossOrg = await db.auditLog.findMany({ where: { orgId: orgB, entityId: dealId } });
    expect(crossOrg.length).toBe(0);
  });
});
