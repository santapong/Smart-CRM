import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

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
  defineAbilityFromPermissions,
  abilityForMembership,
  defineAbilityFor,
  can,
  isValidPermission,
} from "@/lib/authz";
import { createCustomRole, updateCustomRole, deleteCustomRole, assignRole } from "@/server/actions/roles";

let orgA = "", orgB = "", userA = "", userB = "", memberUserA = "";
let memberMembershipA = "";

beforeAll(async () => {
  const ts = Date.now();
  const ua = await db.user.create({ data: { email: `rolea${ts}@t.io`, name: "A" } });
  const ub = await db.user.create({ data: { email: `roleb${ts}@t.io`, name: "B" } });
  const um = await db.user.create({ data: { email: `rolem${ts}@t.io`, name: "M" } });
  const oa = await db.organization.create({
    data: { name: `RoleA-${ts}`, slug: `role-a-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `RoleB-${ts}`, slug: `role-b-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id; memberUserA = um.id;
  const m = await db.membership.create({ data: { orgId: orgA, userId: memberUserA, role: "MEMBER" } });
  memberMembershipA = m.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.customRole.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB, memberUserA] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("defineAbilityFromPermissions (M16, pure)", () => {
  it("grants exactly the listed actions and nothing else", () => {
    const ability = defineAbilityFromPermissions(["manage:deal", "read:contact"]);
    expect(can(ability, "manage", "deal")).toBe(true);
    expect(can(ability, "read", "contact")).toBe(true);
    // Not granted:
    expect(can(ability, "manage", "contact")).toBe(false);
    expect(can(ability, "manage", "org")).toBe(false);
    expect(can(ability, "read", "deal")).toBe(true); // manage implies read in CASL
  });

  it("supports the 'all' subject", () => {
    const ability = defineAbilityFromPermissions(["read:all"]);
    expect(can(ability, "read", "contact")).toBe(true);
    expect(can(ability, "read", "deal")).toBe(true);
    expect(can(ability, "manage", "deal")).toBe(false);
  });

  it("ignores malformed/unknown permission strings", () => {
    const ability = defineAbilityFromPermissions(["bogus", "delete:contact", "manage:nope", "manage:deal"]);
    expect(can(ability, "manage", "deal")).toBe(true);
    expect(can(ability, "delete", "contact")).toBe(false); // delete not in allowed actions
  });
});

describe("isValidPermission (M16)", () => {
  it("accepts allowed action:subject pairs", () => {
    expect(isValidPermission("manage:org")).toBe(true);
    expect(isValidPermission("read:contact")).toBe(true);
    expect(isValidPermission("write:deal")).toBe(true);
  });
  it("rejects bad strings", () => {
    expect(isValidPermission("delete:contact")).toBe(false);
    expect(isValidPermission("manage:unknown")).toBe(false);
    expect(isValidPermission("manage")).toBe(false);
    expect(isValidPermission("manage:org:extra")).toBe(false);
  });
});

describe("abilityForMembership (M16)", () => {
  it("a plain MEMBER cannot manage org", async () => {
    const ability = await abilityForMembership(orgA, memberUserA);
    expect(can(ability, "manage", "org")).toBe(false);
    expect(can(ability, "manage", "deal")).toBe(true); // base member grant
  });

  it("a MEMBER with a custom role granting manage:org CAN manage org", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const role = await createCustomRole({ name: "Org admin add-on", permissions: ["manage:org"] });
    expect(role.ok).toBe(true);
    const assigned = await assignRole(memberMembershipA, id(role));
    expect(assigned.ok).toBe(true);

    const ability = await abilityForMembership(orgA, memberUserA);
    expect(can(ability, "manage", "org")).toBe(true);
    // Base member grant still applies (custom role only adds).
    expect(can(ability, "manage", "deal")).toBe(true);

    // Unassigning removes the extra grant.
    const cleared = await assignRole(memberMembershipA, null);
    expect(cleared.ok).toBe(true);
    const after = await abilityForMembership(orgA, memberUserA);
    expect(can(after, "manage", "org")).toBe(false);
  });

  it("OWNER keeps base grants regardless of custom role", async () => {
    const ability = await abilityForMembership(orgA, userA);
    expect(can(ability, "manage", "org")).toBe(true);
    expect(can(ability, "manage", "member")).toBe(true);
  });

  it("throws for a user with no membership in the org", async () => {
    await expect(abilityForMembership(orgB, memberUserA)).rejects.toThrow();
  });
});

describe("defineAbilityFor still works (M1 regression)", () => {
  it("MEMBER cannot manage org; ADMIN can", () => {
    expect(can(defineAbilityFor({ role: "MEMBER" }), "manage", "org")).toBe(false);
    expect(can(defineAbilityFor({ role: "ADMIN" }), "manage", "org")).toBe(true);
  });
});

describe("custom role server actions (M16)", () => {
  it("createCustomRole validates permission strings", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const bad = await createCustomRole({ name: "Bad role", permissions: ["delete:contact"] });
    expect(bad.ok).toBe(false);
    const good = await createCustomRole({ name: "Good role", permissions: ["read:contact", "manage:deal"] });
    expect(good.ok).toBe(true);
    const row = await db.customRole.findUnique({ where: { id: id(good) } });
    expect(row?.permissions).toEqual(["read:contact", "manage:deal"]);
  });

  it("forbids non-admins from creating roles", async () => {
    active = { userId: memberUserA, orgId: orgA, role: "MEMBER" };
    const r = await createCustomRole({ name: "Nope", permissions: [] });
    expect(r.ok).toBe(false);
  });

  it("updates and deletes a role; enforces unique name", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const a = await createCustomRole({ name: "RoleOne", permissions: [] });
    const b = await createCustomRole({ name: "RoleTwo", permissions: [] });
    expect(a.ok && b.ok).toBe(true);
    // rename B to A's name → clash
    const clash = await updateCustomRole(id(b), { name: "RoleOne" });
    expect(clash.ok).toBe(false);
    // valid update
    const upd = await updateCustomRole(id(b), { permissions: ["manage:org"] });
    expect(upd.ok).toBe(true);
    const row = await db.customRole.findUnique({ where: { id: id(b) } });
    expect(row?.permissions).toEqual(["manage:org"]);
    const del = await deleteCustomRole(id(a));
    expect(del.ok).toBe(true);
  });

  it("isolates roles across orgs (cannot delete or assign cross-org)", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const roleA = await createCustomRole({ name: "OrgA secret role", permissions: ["manage:deal"] });
    expect(roleA.ok).toBe(true);

    // Org B admin cannot delete org A's role.
    active = { userId: userB, orgId: orgB, role: "ADMIN" };
    const del = await deleteCustomRole(id(roleA));
    expect(del.ok).toBe(false);
    const still = await db.customRole.findUnique({ where: { id: id(roleA) } });
    expect(still?.orgId).toBe(orgA);

    // Org A admin cannot assign a role to a membership that isn't in org A.
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const bMembership = await db.membership.findFirst({ where: { orgId: orgB, userId: userB } });
    const assign = await assignRole(bMembership!.id, id(roleA));
    expect(assign.ok).toBe(false);
  });

  it("rejects assigning a cross-org custom role to a valid membership", async () => {
    active = { userId: userB, orgId: orgB, role: "ADMIN" };
    const roleB = await createCustomRole({ name: "OrgB role", permissions: ["manage:deal"] });
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const assign = await assignRole(memberMembershipA, id(roleB));
    expect(assign.ok).toBe(false);
  });
});
