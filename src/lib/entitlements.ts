import type { Subscription } from "@prisma/client";
import { db } from "@/lib/db";
import { planByKey, UNLIMITED, type LimitKey, type Plan } from "@/lib/plans";

/**
 * Entitlements & limits (M4). Resolves a plan from the org's Subscription and
 * layers per-org Entitlement overrides on top. All reads are org-scoped.
 */

/** Return the org's Subscription, creating a free/active one if absent. */
export async function getOrCreateSubscription(orgId: string): Promise<Subscription> {
  const existing = await db.subscription.findUnique({ where: { orgId } });
  if (existing) return existing;
  return db.subscription.create({
    data: { orgId, plan: "free", status: "active" },
  });
}

/** Resolve the org's Plan definition. */
export async function getPlan(orgId: string): Promise<Plan> {
  const sub = await getOrCreateSubscription(orgId);
  return planByKey(sub.plan);
}

/**
 * Whether the org has a feature. A boolean Entitlement override (boolValue)
 * wins over the plan's feature list.
 */
export async function hasFeature(orgId: string, key: string): Promise<boolean> {
  const override = await db.entitlement.findUnique({
    where: { orgId_key: { orgId, key } },
  });
  if (override && override.boolValue !== null) return override.boolValue;
  const plan = await getPlan(orgId);
  return plan.features.includes(key);
}

/**
 * Numeric limit for a key. An intValue Entitlement override wins over the
 * plan default. -1 means unlimited.
 */
export async function limitFor(orgId: string, key: LimitKey): Promise<number> {
  const override = await db.entitlement.findUnique({
    where: { orgId_key: { orgId, key } },
  });
  if (override && override.intValue !== null && override.intValue !== undefined) {
    return override.intValue;
  }
  const plan = await getPlan(orgId);
  return plan.limits[key];
}

/**
 * Whether creating one more of `key` stays within the org's limit, given the
 * current count. Unlimited (-1) is always within limit.
 */
export async function withinLimit(
  orgId: string,
  key: LimitKey,
  currentCount: number,
): Promise<boolean> {
  const limit = await limitFor(orgId, key);
  if (limit === UNLIMITED) return true;
  return currentCount < limit;
}
