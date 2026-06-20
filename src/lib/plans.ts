/**
 * Code-defined plans (M4). Numeric limits use -1 to mean "unlimited".
 * Values are derived from docs/research/briefs/marketing/09-pricing-monetization.md
 * (Free 3-user wedge; Starter unlocks multi-pipeline + custom fields; Pro
 * unlimited custom fields; Business unlimited + SSO).
 *
 * Per-org overrides live in the Entitlement table and win over these defaults
 * (see src/lib/entitlements.ts).
 */

export const PLAN_KEYS = ["free", "starter", "pro", "business"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** -1 means unlimited. */
export type PlanLimits = {
  pipelines: number;
  customFields: number;
  savedViews: number;
  seats: number;
  leads: number;
  forms: number;
  workflows: number;
  reports: number;
  products: number;
  sequences: number;
  imports: number;
};

export type LimitKey = keyof PlanLimits;

export type Plan = {
  key: PlanKey;
  name: string;
  limits: PlanLimits;
  features: string[];
};

export const UNLIMITED = -1;

export const PLANS: Record<PlanKey, Plan> = {
  free: {
    key: "free",
    name: "Free",
    limits: { pipelines: 1, customFields: 0, savedViews: 2, seats: 3, leads: 100, forms: 1, workflows: 0, reports: 3, products: 10, sequences: 0, imports: 5 },
    features: ["contacts", "companies", "activities", "dashboard", "search", "leads", "forms"],
  },
  starter: {
    key: "starter",
    name: "Starter",
    limits: { pipelines: 3, customFields: 25, savedViews: 10, seats: 10, leads: 5000, forms: 10, workflows: 5, reports: 25, products: 100, sequences: 5, imports: 50 },
    features: [
      "contacts",
      "companies",
      "activities",
      "dashboard",
      "search",
      "leads",
      "forms",
      "multiple_pipelines",
      "custom_fields",
      "saved_views",
      "email",
      "csv_import",
      "automation",
      "workflows",
    ],
  },
  pro: {
    key: "pro",
    name: "Professional",
    limits: {
      pipelines: 15,
      customFields: UNLIMITED,
      savedViews: UNLIMITED,
      seats: 50,
      leads: UNLIMITED,
      forms: UNLIMITED,
      workflows: UNLIMITED,
      reports: UNLIMITED,
      products: UNLIMITED,
      sequences: UNLIMITED,
      imports: UNLIMITED,
    },
    features: [
      "contacts",
      "companies",
      "activities",
      "dashboard",
      "search",
      "leads",
      "forms",
      "multiple_pipelines",
      "custom_fields",
      "saved_views",
      "email",
      "csv_import",
      "automation",
      "workflows",
      "report_builder",
      "api",
      "webhooks",
      "ai",
    ],
  },
  business: {
    key: "business",
    name: "Business",
    limits: {
      pipelines: UNLIMITED,
      customFields: UNLIMITED,
      savedViews: UNLIMITED,
      seats: UNLIMITED,
      leads: UNLIMITED,
      forms: UNLIMITED,
      workflows: UNLIMITED,
      reports: UNLIMITED,
      products: UNLIMITED,
      sequences: UNLIMITED,
      imports: UNLIMITED,
    },
    features: [
      "contacts",
      "companies",
      "activities",
      "dashboard",
      "search",
      "leads",
      "forms",
      "multiple_pipelines",
      "custom_fields",
      "saved_views",
      "email",
      "csv_import",
      "automation",
      "workflows",
      "report_builder",
      "api",
      "webhooks",
      "ai",
      "teams",
      "sso",
      "recurring_revenue",
    ],
  },
};

export function isPlanKey(value: string): value is PlanKey {
  return (PLAN_KEYS as readonly string[]).includes(value);
}

/** Resolve a plan by key, falling back to free for unknown values. */
export function planByKey(key: string): Plan {
  return isPlanKey(key) ? PLANS[key] : PLANS.free;
}
