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

import { globalSearch } from "@/server/actions/search";

let orgA = "", orgB = "", userA = "", userB = "";
const NEEDLE = `Zebrafish${Date.now()}`;

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `sa${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `sb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `SearchOrgA-${ts}`, slug: `s-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `SearchOrgB-${ts}`, slug: `s-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;

  // Same needle in both orgs, across all three entity types.
  const stageA = await db.pipelineStage.create({ data: { orgId: orgA, name: "Lead", order: 0 } });
  const stageB = await db.pipelineStage.create({ data: { orgId: orgB, name: "Lead", order: 0 } });
  await db.contact.create({ data: { orgId: orgA, firstName: NEEDLE, lastName: "InOrgA" } });
  await db.contact.create({ data: { orgId: orgB, firstName: NEEDLE, lastName: "InOrgB" } });
  await db.company.create({ data: { orgId: orgA, name: `${NEEDLE} Co A` } });
  await db.company.create({ data: { orgId: orgB, name: `${NEEDLE} Co B` } });
  await db.deal.create({ data: { orgId: orgA, title: `${NEEDLE} Deal A`, stageId: stageA.id } });
  await db.deal.create({ data: { orgId: orgB, title: `${NEEDLE} Deal B`, stageId: stageB.id } });
});

afterAll(async () => {
  await db.deal.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.contact.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.company.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.pipelineStage.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.membership.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

describe("globalSearch", () => {
  it("finds contacts, companies, and deals in the active org only", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await globalSearch(NEEDLE);
    expect(r.ok).toBe(true);
    const hits = (r as any).data.hits as { type: string; title: string }[];

    expect(hits.some((h) => h.type === "contact" && h.title.includes("InOrgA"))).toBe(true);
    expect(hits.some((h) => h.type === "company" && h.title.includes("Co A"))).toBe(true);
    expect(hits.some((h) => h.type === "deal" && h.title.includes("Deal A"))).toBe(true);

    // Nothing from org B may leak.
    expect(hits.some((h) => h.title.includes("InOrgB") || h.title.includes("Co B") || h.title.includes("Deal B"))).toBe(
      false
    );
  });

  it("rejects empty queries", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await globalSearch("   ");
    expect(r.ok).toBe(false);
  });
});
