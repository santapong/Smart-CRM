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

import { createTicket, deleteTicket, updateTicket } from "@/server/actions/tickets";
import { addAccountTeamMember, removeAccountTeamMember } from "@/server/actions/account-team";

let orgA = "", orgB = "", userA = "", userB = "", companyA = "", companyB = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `ent-a-${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `ent-b-${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `EntOrgA-${ts}`, slug: `ent-a-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `EntOrgB-${ts}`, slug: `ent-b-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  const ca = await db.company.create({ data: { orgId: oa.id, name: "AccountA", tier: "ENTERPRISE" } });
  const cb = await db.company.create({ data: { orgId: ob.id, name: "AccountB", tier: "ENTERPRISE" } });

  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id; companyA = ca.id; companyB = cb.id;
});

afterAll(async () => {
  const orgs = { in: [orgA, orgB] };
  await db.accountAssignment.deleteMany({ where: { orgId: orgs } });
  await db.ticket.deleteMany({ where: { orgId: orgs } });
  await db.company.deleteMany({ where: { orgId: orgs } });
  await db.membership.deleteMany({ where: { orgId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

describe("tenant isolation for tickets and account assignments", () => {
  it("a ticket created in org A is invisible to org B updates and deletes", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const created = await createTicket({ companyId: companyA, subject: "From A", priority: "NORMAL" });
    expect(created.ok).toBe(true);
    const tid = (created as Extract<typeof created, { ok: true }>).data.id;

    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const upd = await updateTicket(tid, {
      subject: "Hacked", status: "OPEN", priority: "NORMAL", body: "", assigneeId: "", contactId: "",
    });
    expect(upd.ok).toBe(false);

    const del = await deleteTicket(tid);
    expect(del.ok).toBe(false);

    const still = await db.ticket.findUnique({ where: { id: tid } });
    expect(still?.subject).toBe("From A");
  });

  it("createTicket on a foreign-org account is rejected", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await createTicket({ companyId: companyB, subject: "Cross-org", priority: "NORMAL" });
    expect(r.ok).toBe(false);
  });

  it("addAccountTeamMember rejects a user who is not a member of the active org", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await addAccountTeamMember({ companyId: companyA, userId: userB, role: "AE" });
    expect(r.ok).toBe(false);
  });

  it("removeAccountTeamMember scoped to active org", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const created = await addAccountTeamMember({ companyId: companyA, userId: userA, role: "AE" });
    expect(created.ok).toBe(true);
    const assignmentId = (created as Extract<typeof created, { ok: true }>).data.id;

    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const del = await removeAccountTeamMember(assignmentId);
    expect(del.ok).toBe(false);

    const still = await db.accountAssignment.findUnique({ where: { id: assignmentId } });
    expect(still).not.toBeNull();
  });
});
