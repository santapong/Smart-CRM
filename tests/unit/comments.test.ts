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

import { createComment, deleteComment, listComments } from "@/server/actions/comments";

let orgA = "", orgB = "",
  ownerA = "", memberA = "", nonMemberB = "",
  stageId = "", pipelineId = "",
  dealA = "", dealB = "", contactA = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const oa = await db.user.create({ data: { email: `cma${ts}@t.io`, name: "Owner A", passwordHash: pw } });
  const ma = await db.user.create({ data: { email: `cmm${ts}@t.io`, name: "Member A", passwordHash: pw } });
  const nb = await db.user.create({ data: { email: `cmb${ts}@t.io`, name: "Outsider B", passwordHash: pw } });
  const orgAA = await db.organization.create({
    data: {
      name: `CmOrgA-${ts}`,
      slug: `cm-orga-${ts}`,
      memberships: { create: [{ userId: oa.id, role: "OWNER" }, { userId: ma.id, role: "MEMBER" }] },
    },
  });
  const orgBB = await db.organization.create({
    data: { name: `CmOrgB-${ts}`, slug: `cm-orgb-${ts}`, memberships: { create: { userId: nb.id, role: "OWNER" } } },
  });
  orgA = orgAA.id; orgB = orgBB.id; ownerA = oa.id; memberA = ma.id; nonMemberB = nb.id;

  const p = await db.pipeline.create({ data: { orgId: orgA, name: "Sales", isDefault: true, order: 0 } });
  pipelineId = p.id;
  const s = await db.pipelineStage.create({ data: { orgId: orgA, pipelineId: p.id, name: "Lead", order: 0 } });
  stageId = s.id;
  const dA = await db.deal.create({ data: { orgId: orgA, title: "Deal A", stageId: s.id, pipelineId: p.id } });
  dealA = dA.id;
  const cA = await db.contact.create({ data: { orgId: orgA, firstName: "Con", lastName: "A" } });
  contactA = cA.id;

  // A deal owned by org B (for cross-org isolation checks).
  const pB = await db.pipeline.create({ data: { orgId: orgB, name: "Sales B", isDefault: true, order: 0 } });
  const sB = await db.pipelineStage.create({ data: { orgId: orgB, pipelineId: pB.id, name: "Lead", order: 0 } });
  const dB = await db.deal.create({ data: { orgId: orgB, title: "Deal B", stageId: sB.id, pipelineId: pB.id } });
  dealB = dB.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.notificationDelivery.deleteMany({ where: { notification: { orgId: { in: orgs } } } });
  await db.notification.deleteMany({ where: { orgId: { in: orgs } } });
  await db.comment.deleteMany({ where: { orgId: { in: orgs } } });
  await db.emailMessage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.deal.deleteMany({ where: { orgId: { in: orgs } } });
  await db.contact.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipelineStage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipeline.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [ownerA, memberA, nonMemberB] } } });
  await db.$disconnect();
});

describe("createComment (M10)", () => {
  it("creates a comment on the org's deal and emits comment.created", async () => {
    active = { userId: ownerA, orgId: orgA, role: "OWNER" };
    const r = await createComment({ entityType: "deal", entityId: dealA, body: "First comment" });
    expect(r.ok).toBe(true);
    const list = await listComments("deal", dealA);
    expect(list.some((c) => c.body === "First comment")).toBe(true);

    const events = await db.outboxEvent.count({ where: { orgId: orgA, name: "comment.created" } });
    expect(events).toBeGreaterThan(0);
  });

  it("notifies a mentioned member of the org", async () => {
    active = { userId: ownerA, orgId: orgA, role: "OWNER" };
    const r = await createComment({
      entityType: "deal",
      entityId: dealA,
      body: "Hey @Member A take a look",
      mentionedUserIds: [memberA],
    });
    expect(r.ok).toBe(true);
    const notifs = await db.notification.findMany({
      where: { orgId: orgA, recipientId: memberA, type: "mention" },
    });
    expect(notifs.length).toBeGreaterThan(0);
    expect(notifs[0].entityType).toBe("deal");
    expect(notifs[0].entityId).toBe(dealA);
    expect(notifs[0].actorId).toBe(ownerA);
  });

  it("ignores a mention of a non-member (no notification)", async () => {
    active = { userId: ownerA, orgId: orgA, role: "OWNER" };
    const before = await db.notification.count({ where: { orgId: orgA, recipientId: nonMemberB } });
    const r = await createComment({
      entityType: "deal",
      entityId: dealA,
      body: "Mentioning an outsider @Outsider B",
      mentionedUserIds: [nonMemberB],
    });
    expect(r.ok).toBe(true);
    const after = await db.notification.count({ where: { orgId: orgA, recipientId: nonMemberB } });
    expect(after).toBe(before);
  });

  it("does not notify the author when they mention themselves", async () => {
    active = { userId: ownerA, orgId: orgA, role: "OWNER" };
    const before = await db.notification.count({ where: { orgId: orgA, recipientId: ownerA } });
    await createComment({
      entityType: "deal",
      entityId: dealA,
      body: "Note to self @Owner A",
      mentionedUserIds: [ownerA],
    });
    const after = await db.notification.count({ where: { orgId: orgA, recipientId: ownerA } });
    expect(after).toBe(before);
  });

  it("works on contacts too and rejects an unknown entityType", async () => {
    active = { userId: ownerA, orgId: orgA, role: "OWNER" };
    const ok = await createComment({ entityType: "contact", entityId: contactA, body: "On a contact" });
    expect(ok.ok).toBe(true);
    const bad = await createComment({ entityType: "invoice", entityId: contactA, body: "nope" });
    expect(bad.ok).toBe(false);
  });
});

describe("cross-org isolation (M10)", () => {
  it("cannot comment on another org's record", async () => {
    // Org A user tries to comment on org B's deal.
    active = { userId: ownerA, orgId: orgA, role: "OWNER" };
    const r = await createComment({ entityType: "deal", entityId: dealB, body: "sneaky" });
    expect(r.ok).toBe(false);
    const list = await listComments("deal", dealB);
    expect(list.length).toBe(0);
  });

  it("cannot comment on a non-existent record", async () => {
    active = { userId: ownerA, orgId: orgA, role: "OWNER" };
    const r = await createComment({ entityType: "deal", entityId: "does-not-exist", body: "x" });
    expect(r.ok).toBe(false);
  });
});

describe("deleteComment (M10)", () => {
  it("author can delete their own; a non-author MEMBER cannot; ADMIN can", async () => {
    active = { userId: memberA, orgId: orgA, role: "MEMBER" };
    const mine = await createComment({ entityType: "deal", entityId: dealA, body: "member's comment" });
    expect(mine.ok).toBe(true);
    const mineId = (mine as { data: { id: string } }).data.id;

    // Author (member) deletes their own — allowed.
    const delOwn = await deleteComment(mineId);
    expect(delOwn.ok).toBe(true);

    // Owner A creates a comment; member (non-author) cannot delete it.
    active = { userId: ownerA, orgId: orgA, role: "OWNER" };
    const ownersComment = await createComment({ entityType: "deal", entityId: dealA, body: "owner's comment" });
    const ownersId = (ownersComment as { data: { id: string } }).data.id;

    active = { userId: memberA, orgId: orgA, role: "MEMBER" };
    const forbidden = await deleteComment(ownersId);
    expect(forbidden.ok).toBe(false);

    // An ADMIN can delete someone else's comment.
    active = { userId: memberA, orgId: orgA, role: "ADMIN" };
    const adminDel = await deleteComment(ownersId);
    expect(adminDel.ok).toBe(true);
  });

  it("cannot delete a comment in another org", async () => {
    active = { userId: ownerA, orgId: orgA, role: "OWNER" };
    const r = await createComment({ entityType: "deal", entityId: dealA, body: "org A only" });
    const cid = (r as { data: { id: string } }).data.id;

    active = { userId: nonMemberB, orgId: orgB, role: "OWNER" };
    const del = await deleteComment(cid);
    expect(del.ok).toBe(false);
    expect(await db.comment.findUnique({ where: { id: cid } })).not.toBeNull();
  });
});
