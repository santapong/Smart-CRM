import { db } from "@/lib/db";
import { getPlan, limitFor } from "@/lib/entitlements";
import { UNLIMITED, type LimitKey, type PlanKey } from "@/lib/plans";

/**
 * Billing / usage metering (M19b).
 *
 * {@link getUsage} reports, for every metered resource, the org's current count
 * against its effective plan limit (plan default + any Entitlement override).
 * Unlimited (-1) limits render as "Unlimited" and are never near/over. A
 * resource is `near` at >=80% of its limit and `over` once it reaches it. All
 * counts are org-scoped.
 *
 * This is the read-side that powers the Usage & Billing settings section.
 * Overage billing (reporting metered usage to Stripe) would hook in here.
 * TODO: report `emailsThisMonth` as a Stripe metered-usage record when billing
 * is wired for overages.
 */

/** A countable resource that maps to a per-plan limit key. */
const COUNTERS: { key: LimitKey; label: string; count: (orgId: string) => Promise<number> }[] = [
  { key: "pipelines", label: "Pipelines", count: (o) => db.pipeline.count({ where: { orgId: o } }) },
  { key: "customFields", label: "Custom fields", count: (o) => db.customFieldDefinition.count({ where: { orgId: o } }) },
  { key: "savedViews", label: "Saved views", count: (o) => db.savedView.count({ where: { orgId: o } }) },
  { key: "seats", label: "Seats", count: (o) => db.membership.count({ where: { orgId: o } }) },
  { key: "leads", label: "Leads", count: (o) => db.lead.count({ where: { orgId: o } }) },
  { key: "forms", label: "Forms", count: (o) => db.form.count({ where: { orgId: o } }) },
  { key: "workflows", label: "Workflows", count: (o) => db.workflow.count({ where: { orgId: o } }) },
  { key: "reports", label: "Reports", count: (o) => db.report.count({ where: { orgId: o } }) },
  { key: "products", label: "Products", count: (o) => db.product.count({ where: { orgId: o } }) },
  { key: "sequences", label: "Sequences", count: (o) => db.sequence.count({ where: { orgId: o } }) },
  { key: "imports", label: "Imports", count: (o) => db.importJob.count({ where: { orgId: o } }) },
  { key: "integrations", label: "Integrations", count: (o) => db.connection.count({ where: { orgId: o } }) },
  { key: "documentTemplates", label: "Document templates", count: (o) => db.documentTemplate.count({ where: { orgId: o } }) },
  { key: "campaigns", label: "Campaigns", count: (o) => db.campaign.count({ where: { orgId: o } }) },
];

export type UsageRow = {
  key: LimitKey;
  label: string;
  used: number;
  /** Effective limit; -1 means unlimited. */
  limit: number;
  unlimited: boolean;
  /** >=80% of the limit (and not unlimited). */
  near: boolean;
  /** Reached or exceeded the limit (and not unlimited). */
  over: boolean;
};

export type Usage = {
  plan: { key: PlanKey; name: string };
  rows: UsageRow[];
  /** Emails sent (recorded) so far this calendar month — informational. */
  emailsThisMonth: number;
};

function startOfMonth(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Compute current usage vs. plan limits for an org. */
export async function getUsage(orgId: string): Promise<Usage> {
  const plan = await getPlan(orgId);

  const rows: UsageRow[] = await Promise.all(
    COUNTERS.map(async ({ key, label }) => {
      const [used, limit] = await Promise.all([
        COUNTERS.find((c) => c.key === key)!.count(orgId),
        limitFor(orgId, key),
      ]);
      const unlimited = limit === UNLIMITED;
      const over = !unlimited && used >= limit;
      const near = !unlimited && !over && limit > 0 && used / limit >= 0.8;
      return { key, label, used, limit, unlimited, near, over };
    }),
  );

  const emailsThisMonth = await db.emailMessage.count({
    where: { orgId, createdAt: { gte: startOfMonth() } },
  });

  return {
    plan: { key: plan.key, name: plan.name },
    rows,
    emailsThisMonth,
  };
}
