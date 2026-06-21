import { db } from "@/lib/db";

/**
 * Team helpers (M16). Teams group users within an org; these helpers are the
 * building blocks for future visibility/territory scoping. They are org-scoped:
 * every query joins through the team's `orgId` so a caller can never read a team
 * from another tenant.
 */

/** Teams (id + name) the given user belongs to within `orgId`. */
export async function teamsForUser(
  orgId: string,
  userId: string,
): Promise<{ id: string; name: string }[]> {
  const memberships = await db.teamMember.findMany({
    where: { userId, team: { orgId } },
    include: { team: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => ({ id: m.team.id, name: m.team.name }));
}

/** User ids on a team — scoped to `orgId` so cross-org teams return []. */
export async function teamMemberIds(orgId: string, teamId: string): Promise<string[]> {
  const team = await db.team.findFirst({ where: { id: teamId, orgId }, select: { id: true } });
  if (!team) return [];
  const members = await db.teamMember.findMany({
    where: { teamId },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

/**
 * The set of user ids visible to `userId` through shared team membership in
 * `orgId` (the union of every teammate across all of the user's teams, plus the
 * user themselves). A building block for a "my team's records" filter — callers
 * can use `{ ownerId: { in: await teammateIds(orgId, userId) } }`. Returns just
 * the user when they belong to no team.
 */
export async function teammateIds(orgId: string, userId: string): Promise<string[]> {
  const teams = await teamsForUser(orgId, userId);
  if (teams.length === 0) return [userId];
  const members = await db.teamMember.findMany({
    where: { teamId: { in: teams.map((t) => t.id) } },
    select: { userId: true },
  });
  return Array.from(new Set([userId, ...members.map((m) => m.userId)]));
}
