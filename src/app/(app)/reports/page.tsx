import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import {
  funnel,
  velocity,
  winLoss,
  leadSource,
  pipelineValue,
  type ReportResult,
} from "@/lib/reports/runners";
import { listReports } from "@/server/actions/reports";
import { listGoalsWithProgress } from "@/server/actions/goals";
import { ReportChart } from "./report-chart";
import { ReportFilters } from "./report-filters";
import { SaveReportButton } from "./save-report-button";
import { GoalsSection } from "./goals-section";
import { Plus, FileText } from "lucide-react";

export const dynamic = "force-dynamic";

function sinceFromRange(range: string): string | null {
  const days = Number(range);
  if (!days || Number.isNaN(days)) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string; range?: string }>;
}) {
  const { orgId } = await requireOrg();
  const sp = await searchParams;
  const pipelineId = sp.pipeline ?? "";
  const range = sp.range ?? "";
  const since = sinceFromRange(range);
  const pipeFilter = { pipelineId: pipelineId || null };
  const spec = { pipelineId: pipelineId || null, since };

  const [pipelines, members, savedReports, goals, funnelR, velocityR, winLossR, leadSourceR, pipelineValueR] =
    await Promise.all([
      db.pipeline.findMany({ where: { orgId }, orderBy: { order: "asc" }, select: { id: true, name: true } }),
      db.membership.findMany({
        where: { orgId },
        select: { user: { select: { id: true, name: true, email: true } } },
      }),
      listReports(),
      listGoalsWithProgress(),
      funnel(orgId, { ...pipeFilter, since }),
      velocity(orgId, pipeFilter),
      winLoss(orgId, { since }),
      leadSource(orgId, { since }),
      pipelineValue(orgId, pipeFilter),
    ]);

  const built: Array<{ kind: ReportResult["kind"]; title: string; description: string; result: ReportResult; chartType: "bar" | "line" | "area" | "pie" }> = [
    { kind: "pipeline_value", title: "Pipeline value by stage", description: "Open and weighted value per stage.", result: { kind: "pipeline_value", ...pipelineValueR }, chartType: "bar" },
    { kind: "funnel", title: "Funnel", description: "Deals entered per stage with conversion.", result: { kind: "funnel", ...funnelR }, chartType: "bar" },
    { kind: "win_loss", title: "Win / loss", description: `Win rate ${winLossR.winRate}% over ${winLossR.won + winLossR.lost} closed deals.`, result: { kind: "win_loss", ...winLossR }, chartType: "bar" },
    { kind: "velocity", title: "Stage velocity", description: "Average days a deal spends in each stage.", result: { kind: "velocity", ...velocityR }, chartType: "bar" },
    { kind: "lead_source", title: "Lead source", description: "Leads, conversions and revenue by source.", result: { kind: "lead_source", ...leadSourceR }, chartType: "bar" },
  ];

  const memberOpts = members.map((m) => ({
    id: m.user.id,
    label: m.user.name ?? m.user.email ?? "Unknown",
  }));

  return (
    <>
      <PageHeader title="Reports" description="Funnel, velocity, win-rate, sources and goals.">
        <Button asChild variant="outline">
          <Link href="/reports/new">
            <Plus className="h-4 w-4" /> New report
          </Link>
        </Button>
      </PageHeader>

      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ReportFilters pipelines={pipelines} pipelineId={pipelineId} range={range} />
          {savedReports.length > 0 && (
            <p className="text-sm text-muted-foreground">{savedReports.length} saved</p>
          )}
        </div>

        {/* KPI strip */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Kpi label="Open pipeline" value={formatCurrency(pipelineValueR.totalValue)} sub="Total open value" />
          <Kpi label="Weighted pipeline" value={formatCurrency(pipelineValueR.totalWeighted)} sub="Probability-adjusted" />
          <Kpi label="Won" value={formatCurrency(winLossR.wonValue)} sub={`${winLossR.won} deals`} />
          <Kpi label="Win rate" value={`${winLossR.winRate}%`} sub={`${winLossR.won + winLossR.lost} closed`} />
        </div>

        {/* Saved reports */}
        {savedReports.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Saved reports</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {savedReports.map((r) => (
                  <Link
                    key={r.id}
                    href={`/reports/${r.id}`}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    {r.name}
                    <span className="text-xs text-muted-foreground">· {r.kind}</span>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Built-in reports */}
        <div className="grid gap-4 lg:grid-cols-2">
          {built.map((b) => (
            <Card key={b.kind}>
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle>{b.title}</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">{b.description}</p>
                </div>
                <SaveReportButton kind={b.kind} label={b.title} spec={spec} defaultChartType={b.chartType} />
              </CardHeader>
              <CardContent>
                <ReportChart result={b.result} chartType={b.chartType} />
                {b.kind === "funnel" && funnelR.rows.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {funnelR.rows
                      .filter((r) => r.conversionFromPrev != null)
                      .map((r) => `${r.name}: ${r.conversionFromPrev}%`)
                      .join(" · ")}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Goals */}
        <GoalsSection goals={goals} members={memberOpts} />
      </div>
    </>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
