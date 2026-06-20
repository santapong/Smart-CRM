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
  createLead,
  updateLead,
  setLeadStatus,
  setLeadLabels,
  convertLeadToDeal,
  deleteLead,
} from "@/server/actions/leads";
import { createLeadLabel } from "@/server/actions/lead-labels";

let orgA = "", orgB = "", userA = "", userB = "", stageId = "", pipelineId = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `lda${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `ldb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `LeadOrgA-${ts}`, slug: `lead-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `LeadOrgB-${ts}`, slug: `lead-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;
  // Default pipeline + first stage in org A for conversion.
  const p = await db.pipeline.create({ data: { orgId: orgA, name: "Sales", isDefault: true, order: 0 } });
  pipelineId = p.id;
  const s = await db.pipelineStage.create({ data: { orgId: orgA, pipelineId: p.id, name: "Qualified", order: 0 } });
  stageId = s.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.dealStageEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.deal.deleteMany({ where: { orgId: { in: orgs } } });
  await db.leadLabelOnLead.deleteMany({ where: { lead: { orgId: { in: orgs } } } });
  await db.leadLabel.deleteMany({ where: { orgId: { in: orgs } } });
  await db.lead.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipelineStage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipeline.deleteMany({ where: { orgId: { in: orgs } } });
  await db.subscription.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("leads (M8)", () => {
  it("creates a lead scoped to the active org and emits lead.created", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createLead({ title: "Acme inquiry", value: 5000, source: "Website" });
    expect(r.ok).toBe(true);
    const lead = await db.lead.findUnique({ where: { id: id(r) } });
    expect(lead?.orgId).toBe(orgA);
    expect(lead?.status).toBe("NEW");
    const events = await db.outboxEvent.count({ where: { orgId: orgA, name: "lead.created" } });
    expect(events).toBeGreaterThan(0);
  });

  it("updates status and fields", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createLead({ title: "Status lead" });
    const s = await setLeadStatus(id(r), "WORKING");
    expect(s.ok).toBe(true);
    const u = await updateLead(id(r), { title: "Renamed", status: "QUALIFIED" });
    expect(u.ok).toBe(true);
    const lead = await db.lead.findUnique({ where: { id: id(r) } });
    expect(lead?.title).toBe("Renamed");
    expect(lead?.status).toBe("QUALIFIED");
  });

  it("converts a lead into a deal in the default pipeline's first stage", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createLead({ title: "Convert me", value: 1234, currency: "USD" });
    const conv = await convertLeadToDeal(id(r));
    expect(conv.ok).toBe(true);
    const dealId = (conv as { data: { dealId: string } }).data.dealId;

    const deal = await db.deal.findUnique({ where: { id: dealId } });
    expect(deal?.orgId).toBe(orgA);
    expect(deal?.pipelineId).toBe(pipelineId);
    expect(deal?.stageId).toBe(stageId);
    expect(deal?.title).toBe("Convert me");
    expect(Number(deal?.value)).toBe(1234);

    const lead = await db.lead.findUnique({ where: { id: id(r) } });
    expect(lead?.status).toBe("CONVERTED");
    expect(lead?.convertedDealId).toBe(dealId);

    // A stage event + LEAD_CONVERTED event were recorded.
    const stageEvents = await db.dealStageEvent.count({ where: { orgId: orgA, dealId } });
    expect(stageEvents).toBeGreaterThan(0);
    const converted = await db.outboxEvent.count({ where: { orgId: orgA, name: "lead.converted" } });
    expect(converted).toBeGreaterThan(0);
  });

  it("does not convert an already-converted lead twice", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createLead({ title: "Once only" });
    const first = await convertLeadToDeal(id(r));
    expect(first.ok).toBe(true);
    const second = await convertLeadToDeal(id(r));
    expect(second.ok).toBe(false);
  });

  it("sets labels and rejects foreign-org labels (cross-org isolation)", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const labelA = await createLeadLabel({ name: "Hot", color: "#ef4444" });
    expect(labelA.ok).toBe(true);
    const lead = await createLead({ title: "Labeled" });
    const set = await setLeadLabels(id(lead), [id(labelA)]);
    expect(set.ok).toBe(true);
    const links = await db.leadLabelOnLead.findMany({ where: { leadId: id(lead) } });
    expect(links.map((l) => l.labelId)).toContain(id(labelA));

    // Foreign org B creates a label; org A cannot assign it.
    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const labelB = await createLeadLabel({ name: "Foreign", color: "#8b5cf6" });
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const bad = await setLeadLabels(id(lead), [id(labelB)]);
    expect(bad.ok).toBe(false);
  });

  it("isolates leads across orgs: org B cannot read/convert org A's lead", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createLead({ title: "A only" });

    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const conv = await convertLeadToDeal(id(r));
    expect(conv.ok).toBe(false);
    const del = await deleteLead(id(r));
    expect(del.ok).toBe(false);
    const status = await setLeadStatus(id(r), "WORKING");
    expect(status.ok).toBe(false);

    // Still present and untouched in org A.
    const lead = await db.lead.findUnique({ where: { id: id(r) } });
    expect(lead?.orgId).toBe(orgA);
    expect(lead?.status).toBe("NEW");
  });
});
