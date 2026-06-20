import { AbilityBuilder, createMongoAbility, type MongoAbility } from "@casl/ability";
import { ForbiddenError } from "@/lib/rbac";
import { db } from "@/lib/db";
import type { Role } from "@/lib/tenant";

/**
 * Central authorization choke-point (M1) — additive.
 *
 * A CASL ability that mirrors the role model already enforced by `requireRole`.
 * This is a reference/defense-in-depth layer: it does NOT replace `requireRole`,
 * which remains the primary gate in server actions.
 *
 * Rules (all implicitly scoped to the caller's org — callers still pass `orgId`
 * to every query):
 *  - OWNER / ADMIN: `manage` org settings & members.
 *  - MEMBER+ (everyone): `manage` CRM records (contact/company/deal/activity/pipeline).
 *
 * M16 extends this with custom roles: `defineAbilityFromPermissions` builds an
 * ability from "action:subject" strings and `abilityForMembership` combines a
 * member's base role with an optional CustomRole's extra grants.
 */

export type Action = "manage" | "create" | "read" | "write" | "update" | "delete";

export type Subject =
  | "org"
  | "member"
  | "team"
  | "role"
  | "contact"
  | "company"
  | "deal"
  | "activity"
  | "pipeline"
  | "all";

export type AppAbility = MongoAbility<[Action, Subject]>;

const CRM_SUBJECTS: Subject[] = ["contact", "company", "deal", "activity", "pipeline"];

/** Actions a custom-role permission string may grant. */
export const ALLOWED_ACTIONS: Action[] = ["manage", "read", "write"];

/** Subjects a custom-role permission string may target. */
export const ALLOWED_SUBJECTS: Subject[] = [
  "org",
  "member",
  "team",
  "role",
  "contact",
  "company",
  "deal",
  "activity",
  "pipeline",
  "all",
];

/** True when `perm` is a well-formed, allowed "action:subject" string. */
export function isValidPermission(perm: string): boolean {
  const [action, subject, ...rest] = perm.split(":");
  if (rest.length > 0) return false;
  return (
    ALLOWED_ACTIONS.includes(action as Action) &&
    ALLOWED_SUBJECTS.includes(subject as Subject)
  );
}

export function defineAbilityFor({ role }: { role: Role }): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  // Everyone with a membership (MEMBER and above) manages CRM records in their org.
  can("manage", CRM_SUBJECTS);

  // Org administration (settings + members + teams + roles) is ADMIN/OWNER only.
  if (role === "ADMIN" || role === "OWNER") {
    can("manage", "org");
    can("manage", "member");
    can("manage", "team");
    can("manage", "role");
  }

  return build();
}

/**
 * Build a CASL ability purely from a list of "action:subject" permission
 * strings (e.g. ["manage:deal", "read:contact", "manage:org"]). The special
 * subject "all" grants the action on every subject. Unknown/malformed strings
 * are ignored so a bad row can never crash an authorization check.
 */
export function defineAbilityFromPermissions(permissions: string[]): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const perm of permissions) {
    if (!isValidPermission(perm)) continue;
    const [action, subject] = perm.split(":") as [Action, Subject];
    if (subject === "all") {
      can(action, "all");
    } else {
      can(action, subject);
    }
  }
  return build();
}

/**
 * Load a membership and return the combined ability: its base `role` grants
 * (via {@link defineAbilityFor}) PLUS any grants from an attached CustomRole's
 * permissions. Custom roles only ADD grants — they never remove a base grant.
 * Throws {@link ForbiddenError} if the membership is not found in `orgId`.
 */
export async function abilityForMembership(orgId: string, userId: string): Promise<AppAbility> {
  const membership = await db.membership.findFirst({
    where: { orgId, userId },
    include: { customRole: true },
  });
  if (!membership) throw new ForbiddenError("No membership in this organization");

  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  // Base role grants (mirror defineAbilityFor).
  can("manage", CRM_SUBJECTS);
  if (membership.role === "ADMIN" || membership.role === "OWNER") {
    can("manage", "org");
    can("manage", "member");
    can("manage", "team");
    can("manage", "role");
  }

  // Custom role ADDS grants.
  for (const perm of membership.customRole?.permissions ?? []) {
    if (!isValidPermission(perm)) continue;
    const [action, subject] = perm.split(":") as [Action, Subject];
    if (subject === "all") {
      can(action, "all");
    } else {
      can(action, subject);
    }
  }

  return build();
}

/** Non-throwing permission check. */
export function can(ability: AppAbility, action: Action, subject: Subject): boolean {
  return ability.can(action, subject);
}

/** Throwing permission check — raises {@link ForbiddenError} when denied. */
export function authorize(ability: AppAbility, action: Action, subject: Subject): void {
  if (!ability.can(action, subject)) {
    throw new ForbiddenError(`Cannot ${action} ${subject}`);
  }
}
