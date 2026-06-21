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

import { createContact, updateContact } from "@/server/actions/contacts";
import { createDeal, updateDeal } from "@/server/actions/deals";
import { OCC_CONFLICT_MESSAGE } from "@/lib/db";

let orgId = "", userId = "", stageId = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const u = await db.user.create({ data: { email: `occ${ts}@t.io`, name: "OCC", passwordHash: pw } });
  const o = await db.organization.create({
    data: { name: `OrgOCC-${ts}`, slug: `orgocc-${ts}`, memberships: { create: { userId: u.id, role: "OWNER" } } },
  });
  orgId = o.id;
  userId = u.id;
  active = { userId, orgId, role: "OWNER" };
  const pipeline = await db.pipeline.create({ data: { orgId, name: "Sales", isDefault: true, order: 0 } });
  const stage = await db.pipelineStage.create({ data: { orgId, pipelineId: pipeline.id, name: "Lead", order: 0 } });
  stageId = stage.id;
});

afterAll(async () => {
  await db.outboxEvent.deleteMany({ where: { orgId } });
  await db.dealStageEvent.deleteMany({ where: { orgId } });
  await db.deal.deleteMany({ where: { orgId } });
  await db.contact.deleteMany({ where: { orgId } });
  await db.pipelineStage.deleteMany({ where: { orgId } });
  await db.pipeline.deleteMany({ where: { orgId } });
  await db.membership.deleteMany({ where: { orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("optimistic concurrency control (M1)", () => {
  it("contact: a stale expectedVersion makes the second update fail with the conflict message", async () => {
    const created = await createContact({ firstName: "Occ", lastName: "Contact" });
    expect(created.ok).toBe(true);
    const cid = id(created);

    const before = await db.contact.findUnique({ where: { id: cid } });
    expect(before?.version).toBe(0);

    // First update with the current version succeeds and bumps version to 1.
    const first = await updateContact(cid, { firstName: "Occ", lastName: "First", expectedVersion: 0 });
    expect(first.ok).toBe(true);
    const afterFirst = await db.contact.findUnique({ where: { id: cid } });
    expect(afterFirst?.version).toBe(1);
    expect(afterFirst?.lastName).toBe("First");

    // Second update reuses the now-stale version 0 → conflict, no write.
    const second = await updateContact(cid, { firstName: "Occ", lastName: "Second", expectedVersion: 0 });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toBe(OCC_CONFLICT_MESSAGE);
    const afterSecond = await db.contact.findUnique({ where: { id: cid } });
    expect(afterSecond?.version).toBe(1);
    expect(afterSecond?.lastName).toBe("First");
  });

  it("contact: omitting expectedVersion always succeeds and still bumps version", async () => {
    const created = await createContact({ firstName: "No", lastName: "Version" });
    const cid = id(created);

    const r1 = await updateContact(cid, { firstName: "No", lastName: "V1" });
    expect(r1.ok).toBe(true);
    const r2 = await updateContact(cid, { firstName: "No", lastName: "V2" });
    expect(r2.ok).toBe(true);

    const saved = await db.contact.findUnique({ where: { id: cid } });
    expect(saved?.version).toBe(2);
    expect(saved?.lastName).toBe("V2");
  });

  it("deal: a stale expectedVersion makes the second update fail with the conflict message", async () => {
    const created = await createDeal({ title: "Occ Deal", value: 100, stageId });
    expect(created.ok).toBe(true);
    const did = id(created);

    const before = await db.deal.findUnique({ where: { id: did } });
    expect(before?.version).toBe(0);

    const first = await updateDeal(did, { title: "First", value: 200, stageId, expectedVersion: 0 });
    expect(first.ok).toBe(true);
    const afterFirst = await db.deal.findUnique({ where: { id: did } });
    expect(afterFirst?.version).toBe(1);

    const second = await updateDeal(did, { title: "Second", value: 300, stageId, expectedVersion: 0 });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toBe(OCC_CONFLICT_MESSAGE);
    const afterSecond = await db.deal.findUnique({ where: { id: did } });
    expect(afterSecond?.version).toBe(1);
    expect(afterSecond?.title).toBe("First");
  });

  it("deal: omitting expectedVersion succeeds and bumps version", async () => {
    const created = await createDeal({ title: "Deal NV", value: 10, stageId });
    const did = id(created);
    const r = await updateDeal(did, { title: "Deal NV2", value: 20, stageId });
    expect(r.ok).toBe(true);
    const saved = await db.deal.findUnique({ where: { id: did } });
    expect(saved?.version).toBe(1);
    expect(saved?.title).toBe("Deal NV2");
  });
});
