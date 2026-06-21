/**
 * Org-scoped reporting aggregations (M11). Each runner returns chart-ready data
 * (a `rows` array plus light metadata) consumed by the /reports UI and the
 * report builder. All reads are scoped by `orgId`; the DealStageEvent log is the
 * source of truth for funnel/velocity/win-rate (see src/lib/stage-history.ts).
 *
 * Kept free of `next/*` imports so the runners are unit-testable against a real
 * Postgres without the server-action/runtime layer.
 */
import { db } from "@/lib/db";
import { weightedValue } from "@/lib/pipeline";
import type { DealStatus } from "@prisma/client";

export const REPORT_KINDS = [
  "funnel",
  "velocity",
  "win_loss",
  "lead_source",
  "pipeline_value",
  "activity",
] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export function isReportKind(v: string): v is ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(v);
}

/** JSON filter spec persisted on Report.spec and accepted by runReport. */
export type ReportSpec = {
  pipelineId?: string | null;
  since?: string | null; // ISO date
  until?: string | null; // ISO date
  byOwner?: boolean;
};

function parseDate(v?: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const num = (v: { toString(): string } | number | null | undefined): number =>
  v == null ? 0 : Number(typeof v === "number" ? v : v.toString());

// ---------- Funnel ----------

export type FunnelRow = {
  stageId: string;
  name: string;
  order: number;
  entries: number;
  /** Conversion from the previous stage (0–100); null for the first stage. */
  conversionFromPrev: number | null;
};

export type FunnelResult = { rows: FunnelRow[]; total: number };

/**
 * Number of deals that have *entered* each stage, ordered by stage.order, with
 * stage-to-stage conversion %. Counts distinct deals per stage from the
 * DealStageEvent log so a deal bouncing back and forth is counted once.
 */
export async function funnel(
  orgId: string,
  opts: { pipelineId?: string | null; since?: string | null } = {},
): Promise<FunnelResult> {
  const since = parseDate(opts.since);
  const stages = await db.pipelineStage.findMany({
    where: { orgId, ...(opts.pipelineId ? { pipelineId: opts.pipelineId } : {}) },
    orderBy: { order: "asc" },
    select: { id: true, name: true, order: true },
  });
  if (stages.length === 0) return { rows: [], total: 0 };

  const stageIds = stages.map((s) => s.id);
  const events = await db.dealStageEvent.findMany({
    where: {
      orgId,
      toStageId: { in: stageIds },
      ...(since ? { changedAt: { gte: since } } : {}),
    },
    select: { toStageId: true, dealId: true },
  });

  // Distinct deals that entered each stage.
  const dealsPerStage = new Map<string, Set<string>>();
  for (const e of events) {
    if (!e.toStageId) continue;
    let set = dealsPerStage.get(e.toStageId);
    if (!set) dealsPerStage.set(e.toStageId, (set = new Set()));
    set.add(e.dealId);
  }

  const rows: FunnelRow[] = stages.map((s, i) => {
    const entries = dealsPerStage.get(s.id)?.size ?? 0;
    let conversionFromPrev: number | null = null;
    if (i > 0) {
      const prev = dealsPerStage.get(stages[i - 1].id)?.size ?? 0;
      conversionFromPrev = prev === 0 ? 0 : Math.round((entries / prev) * 100);
    }
    return { stageId: s.id, name: s.name, order: s.order, entries, conversionFromPrev };
  });

  return { rows, total: rows[0]?.entries ?? 0 };
}

// ---------- Velocity ----------

export type VelocityRow = {
  stageId: string;
  name: string;
  order: number;
  /** Average days a deal spent in this stage before leaving it. */
  avgDays: number;
  samples: number;
};

export type VelocityResult = { rows: VelocityRow[] };

/**
 * Average time a deal spends in each stage. For every deal we walk its
 * DealStageEvent timeline ordered by changedAt; the gap between entering a stage
 * and the next transition is the dwell time attributed to the *from* stage.
 */
export async function velocity(
  orgId: string,
  opts: { pipelineId?: string | null } = {},
): Promise<VelocityResult> {
  const stages = await db.pipelineStage.findMany({
    where: { orgId, ...(opts.pipelineId ? { pipelineId: opts.pipelineId } : {}) },
    orderBy: { order: "asc" },
    select: { id: true, name: true, order: true },
  });
  const stageSet = new Set(stages.map((s) => s.id));

  const events = await db.dealStageEvent.findMany({
    where: { orgId },
    orderBy: { changedAt: "asc" },
    select: { dealId: true, toStageId: true, changedAt: true },
  });

  // Group events per deal (already globally time-ordered).
  const byDeal = new Map<string, Array<{ toStageId: string | null; at: Date }>>();
  for (const e of events) {
    let arr = byDeal.get(e.dealId);
    if (!arr) byDeal.set(e.dealId, (arr = []));
    arr.push({ toStageId: e.toStageId, at: e.changedAt });
  }

  const totals = new Map<string, { ms: number; samples: number }>();
  for (const arr of byDeal.values()) {
    for (let i = 0; i < arr.length - 1; i++) {
      const stageId = arr[i].toStageId;
      if (!stageId || !stageSet.has(stageId)) continue;
      const dwell = arr[i + 1].at.getTime() - arr[i].at.getTime();
      if (dwell < 0) continue;
      const t = totals.get(stageId) ?? { ms: 0, samples: 0 };
      t.ms += dwell;
      t.samples += 1;
      totals.set(stageId, t);
    }
  }

  const rows: VelocityRow[] = stages.map((s) => {
    const t = totals.get(s.id);
    const avgDays = t && t.samples > 0 ? +(t.ms / t.samples / 86_400_000).toFixed(1) : 0;
    return { stageId: s.id, name: s.name, order: s.order, avgDays, samples: t?.samples ?? 0 };
  });

  return { rows };
}

// ---------- Win / loss ----------

export type WinLossRow = {
  key: string; // "WON" | "LOST" | ownerId when byOwner
  label: string;
  won: number;
  lost: number;
  wonValue: number;
  lostValue: number;
  winRate: number; // 0–100
};

export type WinLossResult = {
  won: number;
  lost: number;
  wonValue: number;
  lostValue: number;
  winRate: number;
  rows: WinLossRow[];
};

/**
 * WON vs LOST counts/values and win-rate over closed deals. With
 * `byOwner: true`, also returns a per-owner breakdown. Uses the current Deal
 * status (terminal), filtered by createdAt when `since` is given.
 */
export async function winLoss(
  orgId: string,
  opts: { since?: string | null; byOwner?: boolean } = {},
): Promise<WinLossResult> {
  const since = parseDate(opts.since);
  const deals = await db.deal.findMany({
    where: {
      orgId,
      status: { in: ["WON", "LOST"] },
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: { status: true, value: true, ownerId: true, owner: { select: { name: true, email: true } } },
  });

  let won = 0,
    lost = 0,
    wonValue = 0,
    lostValue = 0;
  const owners = new Map<string, { label: string; won: number; lost: number; wonValue: number; lostValue: number }>();

  for (const d of deals) {
    const v = num(d.value);
    if (d.status === "WON") {
      won++;
      wonValue += v;
    } else {
      lost++;
      lostValue += v;
    }
    if (opts.byOwner) {
      const key = d.ownerId ?? "unassigned";
      const label = d.owner?.name ?? d.owner?.email ?? "Unassigned";
      const o = owners.get(key) ?? { label, won: 0, lost: 0, wonValue: 0, lostValue: 0 };
      if (d.status === "WON") {
        o.won++;
        o.wonValue += v;
      } else {
        o.lost++;
        o.lostValue += v;
      }
      owners.set(key, o);
    }
  }

  const rate = (w: number, l: number) => (w + l === 0 ? 0 : Math.round((w / (w + l)) * 100));

  const rows: WinLossRow[] = opts.byOwner
    ? Array.from(owners.entries())
        .map(([key, o]) => ({
          key,
          label: o.label,
          won: o.won,
          lost: o.lost,
          wonValue: o.wonValue,
          lostValue: o.lostValue,
          winRate: rate(o.won, o.lost),
        }))
        .sort((a, b) => b.won + b.lost - (a.won + a.lost))
    : [
        { key: "WON", label: "Won", won, lost: 0, wonValue, lostValue: 0, winRate: 100 },
        { key: "LOST", label: "Lost", won: 0, lost, wonValue: 0, lostValue, winRate: 0 },
      ];

  return { won, lost, wonValue, lostValue, winRate: rate(won, lost), rows };
}

// ---------- Lead source ----------

export type LeadSourceRow = {
  source: string;
  leads: number;
  converted: number;
  revenue: number; // value of deals converted from those leads
};

export type LeadSourceResult = { rows: LeadSourceRow[] };

/**
 * Leads grouped by `source` (falls back to sourceChannel, then "Unknown"), with
 * conversion counts and source→revenue from each lead's convertedDealId.
 */
export async function leadSource(
  orgId: string,
  opts: { since?: string | null } = {},
): Promise<LeadSourceResult> {
  const since = parseDate(opts.since);
  const leads = await db.lead.findMany({
    where: { orgId, ...(since ? { createdAt: { gte: since } } : {}) },
    select: { source: true, sourceChannel: true, convertedDealId: true },
  });

  const convertedIds = leads.map((l) => l.convertedDealId).filter((x): x is string => !!x);
  const dealValues = new Map<string, number>();
  if (convertedIds.length > 0) {
    const deals = await db.deal.findMany({
      where: { orgId, id: { in: convertedIds } },
      select: { id: true, value: true },
    });
    for (const d of deals) dealValues.set(d.id, num(d.value));
  }

  const groups = new Map<string, LeadSourceRow>();
  for (const l of leads) {
    const source = l.source || l.sourceChannel || "Unknown";
    const g = groups.get(source) ?? { source, leads: 0, converted: 0, revenue: 0 };
    g.leads++;
    if (l.convertedDealId) {
      g.converted++;
      g.revenue += dealValues.get(l.convertedDealId) ?? 0;
    }
    groups.set(source, g);
  }

  return { rows: Array.from(groups.values()).sort((a, b) => b.leads - a.leads) };
}

// ---------- Pipeline value ----------

export type PipelineValueRow = {
  stageId: string;
  name: string;
  order: number;
  color: string;
  value: number; // open value in stage
  weighted: number; // probability-weighted value
  count: number;
};

export type PipelineValueResult = { rows: PipelineValueRow[]; totalValue: number; totalWeighted: number };

/** Open + weighted value per stage (reuses src/lib/pipeline weightedValue). */
export async function pipelineValue(
  orgId: string,
  opts: { pipelineId?: string | null } = {},
): Promise<PipelineValueResult> {
  const [stages, deals] = await Promise.all([
    db.pipelineStage.findMany({
      where: { orgId, ...(opts.pipelineId ? { pipelineId: opts.pipelineId } : {}) },
      orderBy: { order: "asc" },
      select: { id: true, name: true, order: true, color: true, probability: true },
    }),
    db.deal.findMany({
      where: { orgId, status: "OPEN", ...(opts.pipelineId ? { pipelineId: opts.pipelineId } : {}) },
      select: { stageId: true, value: true, probability: true },
    }),
  ]);

  const stageById = new Map(stages.map((s) => [s.id, s]));
  const rows: PipelineValueRow[] = stages.map((s) => ({
    stageId: s.id,
    name: s.name,
    order: s.order,
    color: s.color,
    value: 0,
    weighted: 0,
    count: 0,
  }));
  const rowByStage = new Map(rows.map((r) => [r.stageId, r]));

  for (const d of deals) {
    const row = rowByStage.get(d.stageId);
    const stage = stageById.get(d.stageId);
    if (!row || !stage) continue;
    const v = num(d.value);
    row.value += v;
    row.weighted += weightedValue(v, d, stage);
    row.count += 1;
  }

  return {
    rows,
    totalValue: rows.reduce((s, r) => s + r.value, 0),
    totalWeighted: rows.reduce((s, r) => s + r.weighted, 0),
  };
}

// ---------- Activity ----------

export type ActivityRow = {
  key: string; // activity type or userId
  label: string;
  created: number;
  completed: number;
};

export type ActivityResult = { byType: ActivityRow[]; byUser: ActivityRow[] };

/** Activities created/completed grouped by type and by user. */
export async function activityReport(
  orgId: string,
  opts: { since?: string | null } = {},
): Promise<ActivityResult> {
  const since = parseDate(opts.since);
  const activities = await db.activity.findMany({
    where: { orgId, ...(since ? { createdAt: { gte: since } } : {}) },
    select: {
      type: true,
      completedAt: true,
      ownerId: true,
      owner: { select: { name: true, email: true } },
    },
  });

  const types = new Map<string, ActivityRow>();
  const users = new Map<string, ActivityRow>();
  for (const a of activities) {
    const t = types.get(a.type) ?? { key: a.type, label: a.type, created: 0, completed: 0 };
    t.created++;
    if (a.completedAt) t.completed++;
    types.set(a.type, t);

    const ukey = a.ownerId ?? "unassigned";
    const ulabel = a.owner?.name ?? a.owner?.email ?? "Unassigned";
    const u = users.get(ukey) ?? { key: ukey, label: ulabel, created: 0, completed: 0 };
    u.created++;
    if (a.completedAt) u.completed++;
    users.set(ukey, u);
  }

  return {
    byType: Array.from(types.values()).sort((a, b) => b.created - a.created),
    byUser: Array.from(users.values()).sort((a, b) => b.created - a.created),
  };
}

// ---------- Dispatcher ----------

export type ReportResult =
  | ({ kind: "funnel" } & FunnelResult)
  | ({ kind: "velocity" } & VelocityResult)
  | ({ kind: "win_loss" } & WinLossResult)
  | ({ kind: "lead_source" } & LeadSourceResult)
  | ({ kind: "pipeline_value" } & PipelineValueResult)
  | ({ kind: "activity" } & ActivityResult);

/** Run a report by kind, dispatching to the matching runner. */
export async function runReport(
  orgId: string,
  kind: ReportKind,
  spec: ReportSpec = {},
): Promise<ReportResult> {
  switch (kind) {
    case "funnel":
      return { kind, ...(await funnel(orgId, spec)) };
    case "velocity":
      return { kind, ...(await velocity(orgId, spec)) };
    case "win_loss":
      return { kind, ...(await winLoss(orgId, spec)) };
    case "lead_source":
      return { kind, ...(await leadSource(orgId, spec)) };
    case "pipeline_value":
      return { kind, ...(await pipelineValue(orgId, spec)) };
    case "activity":
      return { kind, ...(await activityReport(orgId, spec)) };
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown report kind: ${String(_exhaustive)}`);
    }
  }
}

export const _internal = { num, parseDate };
export type { DealStatus };
