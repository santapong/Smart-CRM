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

import { createTeam, renameTeam, deleteTeam, addTeamMember, removeTeamMember } from "@/server/actions/teams";
import { teamsForUser, teamMemberIds, teammateIds } from "@/lib/teams";

let orgA = "", orgB = "", userA = "", userB = "", user2A = "", user3A = "";

beforeAll(async () => {
  const ts = Date.now();
  const ua = await db.user.create({ data: { email: `tma${ts}@t.io`, name: "A" } });
  const ub = await db.user.create({ data: { email: `tmb${ts}@t.io`, name: "B" } });
  const u2 = await db.user.create({ data: { email: `tm2${ts}@t.io`, name: "A2" } });
  const u3 = await db.user.create({ data: { email: `tm3${ts}@t.io`, name: "A3" } });
  const oa = await db.organization.create({
    data: { name: `TeamA-${ts}`, slug: `team-a-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `TeamB-${ts}`, slug: `team-b-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id; user2A = u2.id; user3A = u3.id;
  await db.membership.create({ data: { orgId: orgA, userId: user2A, role: "MEMBER" } });
  await db.membership.create({ data: { orgId: orgA, userId: user3A, role: "MEMBER" } });
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.teamMember.deleteMany({ where: { team: { orgId: { in: orgs } } } });
  await db.team.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB, user2A, user3A] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("team CRUD (M16)", () => {
  it("forbids non-admins from creating teams", async () => {
    active = { userId: user2A, orgId: orgA, role: "MEMBER" };
    const r = await createTeam({ name: "Nope" });
    expect(r.ok).toBe(false);
  });

  it("ADMIN creates, renames and deletes a team; enforces unique name", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const a = await createTeam({ name: "West" });
    expect(a.ok).toBe(true);
    const dup = await createTeam({ name: "West" });
    expect(dup.ok).toBe(false);
    const ren = await renameTeam(id(a), { name: "West Region" });
    expect(ren.ok).toBe(true);
    const row = await db.team.findUnique({ where: { id: id(a) } });
    expect(row?.name).toBe("West Region");
    const del = await deleteTeam(id(a));
    expect(del.ok).toBe(true);
  });
});

describe("team membership (M16)", () => {
  it("adds and removes members; rejects non-org users", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const t = await createTeam({ name: "Sales" });
    const teamId = id(t);

    const add = await addTeamMember(teamId, user2A);
    expect(add.ok).toBe(true);
    // adding again is idempotent (ok)
    const again = await addTeamMember(teamId, user2A);
    expect(again.ok).toBe(true);

    // user from another org cannot be added (no membership in org A)
    const bad = await addTeamMember(teamId, userB);
    expect(bad.ok).toBe(false);

    const ids = await teamMemberIds(orgA, teamId);
    expect(ids).toContain(user2A);
    expect(ids).not.toContain(userB);

    const rm = await removeTeamMember(teamId, user2A);
    expect(rm.ok).toBe(true);
    const after = await teamMemberIds(orgA, teamId);
    expect(after).not.toContain(user2A);
  });

  it("teamsForUser returns the user's teams in this org only", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const t1 = await createTeam({ name: "Alpha" });
    const t2 = await createTeam({ name: "Beta" });
    await addTeamMember(id(t1), user3A);
    await addTeamMember(id(t2), user3A);

    const teams = await teamsForUser(orgA, user3A);
    const names = teams.map((t) => t.name).sort();
    expect(names).toContain("Alpha");
    expect(names).toContain("Beta");

    // Cross-org isolation: querying org B returns nothing for this user.
    const none = await teamsForUser(orgB, user3A);
    expect(none).toHaveLength(0);
  });

  it("teammateIds returns the union of teammates plus the user", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const t = await createTeam({ name: "Squad" });
    await addTeamMember(id(t), userA);
    await addTeamMember(id(t), user2A);

    const ids = await teammateIds(orgA, userA);
    expect(ids).toContain(userA);
    expect(ids).toContain(user2A);

    // A user with no team gets just themselves.
    const solo = await teammateIds(orgB, userB);
    expect(solo).toEqual([userB]);
  });
});

describe("cross-org isolation (M16)", () => {
  it("org B admin cannot delete or modify org A's team", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const t = await createTeam({ name: "OrgA only team" });
    const teamId = id(t);

    active = { userId: userB, orgId: orgB, role: "ADMIN" };
    const del = await deleteTeam(teamId);
    expect(del.ok).toBe(false);
    const ren = await renameTeam(teamId, { name: "hijack" });
    expect(ren.ok).toBe(false);
    const add = await addTeamMember(teamId, userB);
    expect(add.ok).toBe(false);

    const still = await db.team.findUnique({ where: { id: teamId } });
    expect(still?.orgId).toBe(orgA);
  });

  it("teamMemberIds returns [] for a team in another org", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const t = await createTeam({ name: "Hidden" });
    await addTeamMember(id(t), user2A);
    const ids = await teamMemberIds(orgB, id(t));
    expect(ids).toEqual([]);
  });
});
