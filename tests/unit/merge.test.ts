import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

import { findDuplicates, mergeRecords, undoMerge } from "@/lib/merge";
import { mergeRecords as mergeAction, undoMerge as undoAction, listDuplicates } from "@/server/actions/merge";

let orgA = "",
  orgB = "",
  userA = "",
  stageA = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `mrg${ts}@t.io`, name: "A", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `MrgOrgA-${ts}`, slug: `mrg-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({ data: { name: `MrgOrgB-${ts}`, slug: `mrg-orgb-${ts}` } });
  orgA = oa.id;
  orgB = ob.id;
  userA = ua.id;
  const pipeline = await db.pipeline.create({ data: { orgId: orgA, name: "Default", isDefault: true } });
  const stage = await db.pipelineStage.create({ data: { orgId: orgA, pipelineId: pipeline.id, name: "New", order: 0 } });
  stageA = stage.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.mergeLog.deleteMany({ where: { orgId: { in: orgs } } });
  await db.activity.deleteMany({ where: { orgId: { in: orgs } } });
  await db.deal.deleteMany({ where: { orgId: { in: orgs } } });
  await db.contactTag.deleteMany({ where: { contact: { orgId: { in: orgs } } } });
  await db.tag.deleteMany({ where: { orgId: { in: orgs } } });
  await db.contact.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipelineStage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipeline.deleteMany({ where: { orgId: { in: orgs } } });
  await db.company.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA] } } });
  await db.$disconnect();
});

beforeEach(async () => {
  await db.mergeLog.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.activity.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.deal.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.contactTag.deleteMany({ where: { contact: { orgId: { in: [orgA, orgB] } } } });
  await db.contact.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.company.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
});

describe("findDuplicates (M13c)", () => {
  it("groups contacts by lowercased email", async () => {
    await db.contact.create({ data: { orgId: orgA, firstName: "A", lastName: "One", email: "dup@x.io" } });
    await db.contact.create({ data: { orgId: orgA, firstName: "B", lastName: "Two", email: "DUP@x.io" } });
    await db.contact.create({ data: { orgId: orgA, firstName: "C", lastName: "Solo", email: "solo@x.io" } });
    const groups = await findDuplicates(orgA, "contact");
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("dup@x.io");
    expect(groups[0].records).toHaveLength(2);
  });

  it("groups companies by domain then name", async () => {
    await db.company.create({ data: { orgId: orgA, name: "Acme Inc", domain: "acme.com" } });
    await db.company.create({ data: { orgId: orgA, name: "Acme Corporation", domain: "ACME.com" } });
    const groups = await findDuplicates(orgA, "company");
    expect(groups).toHaveLength(1);
    expect(groups[0].records).toHaveLength(2);
  });
});

describe("mergeRecords (M13c)", () => {
  it("relinks a deal + activity, applies survivorship, writes a MergeLog, deletes source", async () => {
    const target = await db.contact.create({ data: { orgId: orgA, firstName: "Keep", lastName: "Me", email: "keep@x.io" } });
    const source = await db.contact.create({
      data: { orgId: orgA, firstName: "Old", lastName: "Dupe", email: "keep@x.io", phone: "555-0000", title: "CTO" },
    });
    const deal = await db.deal.create({ data: { orgId: orgA, title: "D1", stageId: stageA, contactId: source.id } });
    const act = await db.activity.create({ data: { orgId: orgA, title: "Call", contactId: source.id } });

    const res = await mergeRecords(orgA, "contact", target.id, source.id);
    expect(res.relinked.deals).toBe(1);
    expect(res.relinked.activities).toBe(1);

    expect(await db.contact.findUnique({ where: { id: source.id } })).toBeNull();
    expect((await db.deal.findUnique({ where: { id: deal.id } }))?.contactId).toBe(target.id);
    expect((await db.activity.findUnique({ where: { id: act.id } }))?.contactId).toBe(target.id);

    // Survivorship: blank target phone/title filled from source.
    const merged = await db.contact.findUnique({ where: { id: target.id } });
    expect(merged?.phone).toBe("555-0000");
    expect(merged?.title).toBe("CTO");
    expect(merged?.firstName).toBe("Keep"); // non-blank target field preserved

    const log = await db.mergeLog.findUnique({ where: { id: res.mergeLogId } });
    expect(log?.orgId).toBe(orgA);
    expect(log?.sourceId).toBe(source.id);
  });

  it("undoMerge restores the source and moves children back", async () => {
    const target = await db.contact.create({ data: { orgId: orgA, firstName: "Keep", lastName: "Me", email: "u@x.io" } });
    const source = await db.contact.create({ data: { orgId: orgA, firstName: "Src", lastName: "Back", email: "u@x.io" } });
    const deal = await db.deal.create({ data: { orgId: orgA, title: "D", stageId: stageA, contactId: source.id } });

    const res = await mergeRecords(orgA, "contact", target.id, source.id);
    await undoMerge(orgA, res.mergeLogId);

    const restored = await db.contact.findUnique({ where: { id: source.id } });
    expect(restored).not.toBeNull();
    expect(restored?.firstName).toBe("Src");
    expect((await db.deal.findUnique({ where: { id: deal.id } }))?.contactId).toBe(source.id);
    expect(await db.mergeLog.findUnique({ where: { id: res.mergeLogId } })).toBeNull();
  });

  it("merges companies, relinking contacts + deals", async () => {
    const target = await db.company.create({ data: { orgId: orgA, name: "Keep Co", domain: "keep.com" } });
    const source = await db.company.create({ data: { orgId: orgA, name: "Old Co", domain: "keep.com", industry: "Tech" } });
    const contact = await db.contact.create({ data: { orgId: orgA, firstName: "X", lastName: "Y", companyId: source.id } });
    const deal = await db.deal.create({ data: { orgId: orgA, title: "CD", stageId: stageA, companyId: source.id } });

    const res = await mergeRecords(orgA, "company", target.id, source.id);
    expect(res.relinked.contacts).toBe(1);
    expect(res.relinked.deals).toBe(1);
    expect((await db.contact.findUnique({ where: { id: contact.id } }))?.companyId).toBe(target.id);
    expect((await db.deal.findUnique({ where: { id: deal.id } }))?.companyId).toBe(target.id);
    expect((await db.company.findUnique({ where: { id: target.id } }))?.industry).toBe("Tech");
    expect(await db.company.findUnique({ where: { id: source.id } })).toBeNull();
  });
});

describe("merge actions RBAC + isolation (M13c)", () => {
  it("rejects merge for non-admins", async () => {
    const t = await db.contact.create({ data: { orgId: orgA, firstName: "T", lastName: "T", email: "rb@x.io" } });
    const s = await db.contact.create({ data: { orgId: orgA, firstName: "S", lastName: "S", email: "rb@x.io" } });
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const res = await mergeAction({ entity: "contact", targetId: t.id, sourceId: s.id });
    expect(res.ok).toBe(false);
    expect(await db.contact.findUnique({ where: { id: s.id } })).not.toBeNull();
  });

  it("cannot merge records across orgs", async () => {
    const t = await db.contact.create({ data: { orgId: orgA, firstName: "T", lastName: "T", email: "x@x.io" } });
    const sB = await db.contact.create({ data: { orgId: orgB, firstName: "B", lastName: "B", email: "x@x.io" } });
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const res = await mergeAction({ entity: "contact", targetId: t.id, sourceId: sB.id });
    expect(res.ok).toBe(false); // source is in org B, not visible to org A
    expect(await db.contact.findUnique({ where: { id: sB.id } })).not.toBeNull();
  });

  it("listDuplicates + undo via actions (ADMIN)", async () => {
    await db.contact.create({ data: { orgId: orgA, firstName: "D1", lastName: "X", email: "list@x.io" } });
    await db.contact.create({ data: { orgId: orgA, firstName: "D2", lastName: "X", email: "list@x.io" } });
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const dups = await listDuplicates("contact");
    expect(dups.ok).toBe(true);
    if (!dups.ok) return;
    expect(dups.data.groups).toHaveLength(1);
    const [a, b] = dups.data.groups[0].records;
    const merged = await mergeAction({ entity: "contact", targetId: a.id, sourceId: b.id });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const undone = await undoAction(merged.data.mergeLogId);
    expect(undone.ok).toBe(true);
    expect(await db.contact.findUnique({ where: { id: b.id } })).not.toBeNull();
  });
});
