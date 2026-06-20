/**
 * Goal progress (M11). Computes the current value of a Goal's metric over its
 * [startsAt, endsAt) window, optionally scoped to a single owner, and derives a
 * percentage against the target. Org-scoped; uses Deal/Activity tables and the
 * deal stage event log for won-deal timing.
 */
import { db } from "@/lib/db";
import type { Goal } from "@prisma/client";

export const GOAL_METRICS = [
  "deals_won_value",
  "deals_won_count",
  "deals_created",
  "activities_completed",
] as const;

export type GoalMetric = (typeof GOAL_METRICS)[number];

export function isGoalMetric(v: string): v is GoalMetric {
  return (GOAL_METRICS as readonly string[]).includes(v);
}

export const GOAL_PERIODS = ["weekly", "monthly", "quarterly", "yearly", "custom"] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];

export type GoalProgress = {
  goalId: string;
  metric: string;
  target: number;
  current: number;
  /** 0–100, capped at 100 for display; see `ratio` for the raw fraction. */
  percent: number;
  ratio: number;
  remaining: number;
  attained: boolean;
};

const num = (v: { toString(): string } | number | null | undefined): number =>
  v == null ? 0 : Number(typeof v === "number" ? v : v.toString());

/**
 * Compute the current value of `goal.metric` within its window. Won-deal metrics
 * are timed by the WON transition in the DealStageEvent log (falling back to
 * none if a deal has no recorded WON event in-window).
 */
export async function currentMetricValue(orgId: string, goal: Goal): Promise<number> {
  const window = { gte: goal.startsAt, lt: goal.endsAt };
  const owner = goal.ownerId ? { ownerId: goal.ownerId } : {};

  switch (goal.metric) {
    case "deals_won_value":
    case "deals_won_count": {
      // Deals that recorded a WON status transition within the window.
      const events = await db.dealStageEvent.findMany({
        where: { orgId, toStatus: "WON", changedAt: window },
        select: { dealId: true },
      });
      const dealIds = Array.from(new Set(events.map((e) => e.dealId)));
      if (dealIds.length === 0) return 0;
      const deals = await db.deal.findMany({
        where: { orgId, id: { in: dealIds }, status: "WON", ...owner },
        select: { value: true },
      });
      if (goal.metric === "deals_won_count") return deals.length;
      return deals.reduce((s, d) => s + num(d.value), 0);
    }
    case "deals_created": {
      return db.deal.count({ where: { orgId, createdAt: window, ...owner } });
    }
    case "activities_completed": {
      return db.activity.count({ where: { orgId, completedAt: window, ...owner } });
    }
    default:
      return 0;
  }
}

/** Current value vs target for a goal, with a capped display percentage. */
export async function goalProgress(orgId: string, goal: Goal): Promise<GoalProgress> {
  const current = await currentMetricValue(orgId, goal);
  const target = num(goal.target);
  const ratio = target <= 0 ? 0 : current / target;
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return {
    goalId: goal.id,
    metric: goal.metric,
    target,
    current,
    percent,
    ratio,
    remaining: Math.max(0, target - current),
    attained: target > 0 && current >= target,
  };
}
