import { AbilityBuilder, createMongoAbility, type MongoAbility } from "@casl/ability";
import { ForbiddenError } from "@/lib/rbac";
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
 */

export type Action = "manage" | "create" | "read" | "update" | "delete";

export type Subject =
  | "org"
  | "member"
  | "contact"
  | "company"
  | "deal"
  | "activity"
  | "pipeline"
  | "all";

export type AppAbility = MongoAbility<[Action, Subject]>;

const CRM_SUBJECTS: Subject[] = ["contact", "company", "deal", "activity", "pipeline"];

export function defineAbilityFor({ role }: { role: Role }): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  // Everyone with a membership (MEMBER and above) manages CRM records in their org.
  can("manage", CRM_SUBJECTS);

  // Org administration (settings + members) is restricted to ADMIN/OWNER.
  if (role === "ADMIN" || role === "OWNER") {
    can("manage", "org");
    can("manage", "member");
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
