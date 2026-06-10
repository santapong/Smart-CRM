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

import { createTag, deleteTag, setContactTags } from "@/server/actions/tags";

let orgA = "", orgB = "", userA = "", userB = "", contactA = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `ta${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `tb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `TagOrgA-${ts}`, slug: `tag-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `TagOrgB-${ts}`, slug: `tag-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;
  const c = await db.contact.create({ data: { orgId: orgA, firstName: "Taggy", lastName: "McTag" } });
  contactA = c.id;
});

afterAll(async () => {
  await db.contact.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.tag.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.membership.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

describe("tenant isolation for tags", () => {
  it("created tag is scoped to active org", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createTag({ name: "Hot lead", color: "#ef4444" });
    expect(r.ok).toBe(true);
    const got = await db.tag.findUnique({ where: { id: (r as any).data.id } });
    expect(got?.orgId).toBe(orgA);
  });

  it("rejects duplicate tag names within an org", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const first = await createTag({ name: "Dupe", color: "#3b82f6" });
    expect(first.ok).toBe(true);
    const second = await createTag({ name: "Dupe", color: "#10b981" });
    expect(second.ok).toBe(false);
  });

  it("assigning a foreign org's tag to a contact is rejected", async () => {
    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const foreign = await createTag({ name: "Foreign", color: "#8b5cf6" });
    expect(foreign.ok).toBe(true);
    const foreignTagId = (foreign as any).data.id;

    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await setContactTags(contactA, [foreignTagId]);
    expect(r.ok).toBe(false);
    const links = await db.contactTag.findMany({ where: { contactId: contactA } });
    expect(links.map((l) => l.tagId)).not.toContain(foreignTagId);
  });

  it("user from org B cannot tag or delete tags in org A", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const mine = await createTag({ name: "Mine", color: "#0ea5e9" });
    expect(mine.ok).toBe(true);
    const mineId = (mine as any).data.id;
    const assigned = await setContactTags(contactA, [mineId]);
    expect(assigned.ok).toBe(true);

    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const tagAttempt = await setContactTags(contactA, []);
    expect(tagAttempt.ok).toBe(false);
    const delAttempt = await deleteTag(mineId);
    expect(delAttempt.ok).toBe(false);

    const still = await db.contactTag.findMany({ where: { contactId: contactA } });
    expect(still.map((l) => l.tagId)).toContain(mineId);
  });

  it("setContactTags replaces the assignment set", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const t1 = await createTag({ name: "Set1", color: "#64748b" });
    const t2 = await createTag({ name: "Set2", color: "#64748b" });
    const id1 = (t1 as any).data.id;
    const id2 = (t2 as any).data.id;

    await setContactTags(contactA, [id1]);
    let links = await db.contactTag.findMany({ where: { contactId: contactA } });
    expect(links.map((l) => l.tagId)).toContain(id1);

    await setContactTags(contactA, [id2]);
    links = await db.contactTag.findMany({ where: { contactId: contactA } });
    expect(links.map((l) => l.tagId)).toContain(id2);
    expect(links.map((l) => l.tagId)).not.toContain(id1);
  });
});
