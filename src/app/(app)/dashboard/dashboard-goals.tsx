import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, cn } from "@/lib/utils";
import type { GoalWithProgress } from "@/server/actions/goals";
import { Target } from "lucide-react";

const LABELS: Record<string, { label: string; currency?: boolean }> = {
  deals_won_value: { label: "Deals won (value)", currency: true },
  deals_won_count: { label: "Deals won (count)" },
  deals_created: { label: "Deals created" },
  activities_completed: { label: "Activities completed" },
};

function fmt(metric: string, n: number) {
  return LABELS[metric]?.currency ? formatCurrency(n) : n.toLocaleString();
}

/** Read-only goal progress widget for the dashboard. Manage goals on /reports. */
export function DashboardGoals({ goals }: { goals: GoalWithProgress[] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Target className="h-4 w-4" /> Goals
        </CardTitle>
        <Link href="/reports" className="text-xs text-muted-foreground hover:underline">
          Manage →
        </Link>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-4 md:grid-cols-2">
          {goals.slice(0, 6).map((g) => {
            const p = g.progress;
            return (
              <li key={g.id}>
                <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{LABELS[g.metric]?.label ?? g.metric}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {fmt(g.metric, p.current)} / {fmt(g.metric, p.target)}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", p.attained ? "bg-emerald-500" : "bg-primary")}
                    style={{ width: `${p.percent}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
