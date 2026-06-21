/**
 * Pure revenue math for deal line items (M13a). Kept side-effect free so it's
 * usable in server actions, server components and unit tests alike.
 *
 * - One-time line items roll up into the persisted `Deal.value`.
 * - Recurring items (monthly | quarterly | annually) are normalised to a
 *   monthly run-rate (MRR) and an annual run-rate (ARR).
 */

export const BILLING_PERIODS = ["one_time", "monthly", "quarterly", "annually"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export function isBillingPeriod(v: string): v is BillingPeriod {
  return (BILLING_PERIODS as readonly string[]).includes(v);
}

/** A line item reduced to the numbers revenue math needs. */
export type LineItemLike = {
  quantity: number | string | { toString(): string };
  unitPrice: number | string | { toString(): string };
  discount?: number | string | { toString(): string } | null;
  billing: string;
};

const num = (v: LineItemLike["quantity"] | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

/** Net amount for one line: quantity * unitPrice - discount (never negative). */
export function lineTotal(item: LineItemLike): number {
  const gross = num(item.quantity) * num(item.unitPrice);
  const net = gross - num(item.discount);
  return net > 0 ? net : 0;
}

/** Monthly-equivalent contribution of a single recurring line (0 for one-time). */
function monthlyContribution(item: LineItemLike): number {
  const total = lineTotal(item);
  switch (item.billing) {
    case "monthly":
      return total;
    case "quarterly":
      return total / 3;
    case "annually":
      return total / 12;
    default:
      return 0;
  }
}

export type DealRevenue = {
  /** Sum of one-time line items — what we persist to Deal.value. */
  oneTime: number;
  /** Monthly recurring revenue. */
  mrr: number;
  /** Annual recurring revenue (mrr * 12). */
  arr: number;
};

/**
 * Compute revenue figures from a deal's line items. `oneTime` becomes the
 * stored Deal.value; `mrr`/`arr` are derived for display.
 */
export function dealRevenue(lineItems: LineItemLike[]): DealRevenue {
  let oneTime = 0;
  let mrr = 0;
  for (const item of lineItems) {
    if (item.billing === "one_time") oneTime += lineTotal(item);
    else mrr += monthlyContribution(item);
  }
  // Round to cents to avoid binary-float drift before persisting/displaying.
  const round = (n: number) => Math.round(n * 100) / 100;
  return { oneTime: round(oneTime), mrr: round(mrr), arr: round(mrr * 12) };
}
