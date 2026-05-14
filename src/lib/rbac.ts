import type { Role } from "@/lib/tenant";

const RANK: Record<Role, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

export class ForbiddenError extends Error {}

export function hasRole(actual: Role | null | undefined, required: Role) {
  if (!actual) return false;
  return RANK[actual] >= RANK[required];
}

export function requireRole(actual: Role | null | undefined, required: Role) {
  if (!hasRole(actual, required)) throw new ForbiddenError(`Requires ${required}`);
}
