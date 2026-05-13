import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

// `revalidatePath` throws outside a Next request scope — stub it.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));

// Mock requireOrg to swap the active org per test.
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

import { createContact, deleteContact, updateContact } from "@/server/actions/contacts";

let orgA = "", orgB = "", userA = "", userB = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `a${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `b${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `OrgA-${ts}`, slug: `orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `OrgB-${ts}`, slug: `orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;
});

afterAll(async () => {
  await db.contact.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.membership.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

describe("tenant isolation for contacts", () => {
  it("created contact is scoped to active org", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createContact({ firstName: "Iso", lastName: "Lation" });
    expect(r.ok).toBe(true);
    const got = await db.contact.findUnique({ where: { id: (r as any).data.id } });
    expect(got?.orgId).toBe(orgA);
  });

  it("user from org B cannot update or delete a contact in org A", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const created = await createContact({ firstName: "Iso2", lastName: "L" });
    expect(created.ok).toBe(true);
    const id = (created as any).data.id;

    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const upd = await updateContact(id, { firstName: "Hacked", lastName: "Hacked" });
    expect(upd.ok).toBe(false);

    const del = await deleteContact(id);
    expect(del.ok).toBe(false);

    const still = await db.contact.findUnique({ where: { id } });
    expect(still?.firstName).toBe("Iso2");
  });
});
