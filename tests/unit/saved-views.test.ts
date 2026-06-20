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
  createSavedView,
  listSavedViews,
  updateSavedView,
  deleteSavedView,
} from "@/server/actions/saved-views";

// org A has an owner + two members; org B is a separate tenant.
let orgA = "", orgB = "";
let owner = "", member1 = "", member2 = "", userB = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const uo = await db.user.create({ data: { email: `svo${ts}@t.io`, name: "O", passwordHash: pw } });
  const u1 = await db.user.create({ data: { email: `sv1${ts}@t.io`, name: "M1", passwordHash: pw } });
  const u2 = await db.user.create({ data: { email: `sv2${ts}@t.io`, name: "M2", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `svb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: {
      name: `SvOrgA-${ts}`,
      slug: `sv-orga-${ts}`,
      memberships: {
        create: [
          { userId: uo.id, role: "OWNER" },
          { userId: u1.id, role: "MEMBER" },
          { userId: u2.id, role: "MEMBER" },
        ],
      },
    },
  });
  const ob = await db.organization.create({
    data: { name: `SvOrgB-${ts}`, slug: `sv-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id;
  owner = uo.id; member1 = u1.id; member2 = u2.id; userB = ub.id;
  // M4: the free plan caps savedViews at 2; this suite creates more, so lift
  // the cap for both orgs (the over-limit gate is covered in custom-fields.test).
  await db.entitlement.createMany({
    data: [
      { orgId: orgA, key: "savedViews", intValue: -1 },
      { orgId: orgB, key: "savedViews", intValue: -1 },
    ],
  });
});

afterAll(async () => {
  await db.savedView.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.entitlement.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.subscription.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.membership.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await db.user.deleteMany({ where: { id: { in: [owner, member1, member2, userB] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("saved views (M6b)", () => {
  it("validates entity, name, and filters object", async () => {
    active = { userId: member1, orgId: orgA, role: "MEMBER" };
    expect((await createSavedView({ entity: "nope", name: "X", filters: {} })).ok).toBe(false);
    expect((await createSavedView({ entity: "contact", name: "", filters: {} })).ok).toBe(false);
    expect(
      (await createSavedView({ entity: "contact", name: "Y", filters: "notobj" })).ok,
    ).toBe(false);
  });

  it("any member can create their own view", async () => {
    active = { userId: member1, orgId: orgA, role: "MEMBER" };
    const r = await createSavedView({
      entity: "contact",
      name: "M1 Private",
      filters: { status: "active" },
    });
    expect(r.ok).toBe(true);
    const saved = await db.savedView.findUnique({ where: { id: id(r) } });
    expect(saved?.orgId).toBe(orgA);
    expect(saved?.ownerId).toBe(member1);
  });

  it("list shows own + shared but not other members' private views", async () => {
    active = { userId: member1, orgId: orgA, role: "MEMBER" };
    const priv1 = await createSavedView({ entity: "deal", name: "M1 only", filters: {} });

    active = { userId: member2, orgId: orgA, role: "MEMBER" };
    const priv2 = await createSavedView({ entity: "deal", name: "M2 only", filters: {} });
    const shared2 = await createSavedView({
      entity: "deal",
      name: "M2 shared",
      filters: {},
      shared: true,
    });

    active = { userId: member1, orgId: orgA, role: "MEMBER" };
    const listed = await listSavedViews("deal");
    expect(listed.ok).toBe(true);
    const ids = (listed as { data: { id: string }[] }).data.map((v) => v.id);
    expect(ids).toContain(id(priv1)); // own private
    expect(ids).toContain(id(shared2)); // someone else's shared
    expect(ids).not.toContain(id(priv2)); // someone else's private
  });

  it("owner of a view may update it; a non-owner member may not", async () => {
    active = { userId: member1, orgId: orgA, role: "MEMBER" };
    const v = await createSavedView({ entity: "company", name: "Editable", filters: {} });

    // non-owner member cannot update
    active = { userId: member2, orgId: orgA, role: "MEMBER" };
    const denied = await updateSavedView(id(v), { name: "Hijacked" });
    expect(denied.ok).toBe(false);

    // owner can update
    active = { userId: member1, orgId: orgA, role: "MEMBER" };
    const okUpd = await updateSavedView(id(v), { name: "Renamed", shared: true });
    expect(okUpd.ok).toBe(true);
    const after = await db.savedView.findUnique({ where: { id: id(v) } });
    expect(after?.name).toBe("Renamed");
    expect(after?.shared).toBe(true);
  });

  it("an ADMIN/OWNER may update or delete another member's view", async () => {
    active = { userId: member1, orgId: orgA, role: "MEMBER" };
    const v = await createSavedView({ entity: "activity", name: "Member owned", filters: {} });

    active = { userId: owner, orgId: orgA, role: "OWNER" };
    const upd = await updateSavedView(id(v), { name: "Admin edited" });
    expect(upd.ok).toBe(true);
    const del = await deleteSavedView(id(v));
    expect(del.ok).toBe(true);
    const gone = await db.savedView.findUnique({ where: { id: id(v) } });
    expect(gone).toBeNull();
  });

  it("a non-owner member cannot delete another member's view", async () => {
    active = { userId: member1, orgId: orgA, role: "MEMBER" };
    const v = await createSavedView({ entity: "contact", name: "Protected", filters: {} });

    active = { userId: member2, orgId: orgA, role: "MEMBER" };
    const del = await deleteSavedView(id(v));
    expect(del.ok).toBe(false);
    const still = await db.savedView.findUnique({ where: { id: id(v) } });
    expect(still?.id).toBe(id(v));
  });

  it("cross-org isolation: org B cannot see, update, or delete org A's views", async () => {
    active = { userId: member2, orgId: orgA, role: "MEMBER" };
    const sharedA = await createSavedView({
      entity: "contact",
      name: "A shared",
      filters: {},
      shared: true,
    });

    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const listed = await listSavedViews("contact");
    const ids = (listed as { data: { id: string }[] }).data.map((v) => v.id);
    expect(ids).not.toContain(id(sharedA));

    const upd = await updateSavedView(id(sharedA), { name: "Cross hijack" });
    expect(upd.ok).toBe(false);
    const del = await deleteSavedView(id(sharedA));
    expect(del.ok).toBe(false);

    const still = await db.savedView.findUnique({ where: { id: id(sharedA) } });
    expect(still?.name).toBe("A shared");
  });
});
