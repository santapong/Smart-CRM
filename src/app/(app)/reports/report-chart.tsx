"use client";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { formatCurrency } from "@/lib/utils";
import type { ReportResult } from "@/lib/reports/runners";

export type ChartType = "bar" | "line" | "area" | "pie";

const PIE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

const tooltipProps = {
  contentStyle: { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" },
  labelStyle: { color: "hsl(var(--foreground))" },
} as const;

const axisProps = { tick: { fontSize: 12 }, stroke: "hsl(var(--muted-foreground))" } as const;

/**
 * Renders any report result as a recharts chart. The series shown depend on the
 * report kind; `chartType` chooses the visualization where it makes sense
 * (counts use bar/line/area; pie is used for distribution-style reports).
 */
export function ReportChart({ result, chartType = "bar" }: { result: ReportResult; chartType?: ChartType }) {
  const { data, series, isCurrency } = toChartModel(result);

  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No data for this report yet.</p>;
  }

  const fmt = (v: number) => (isCurrency ? formatCurrency(v) : String(v));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        {chartType === "pie" ? (
          <PieChart>
            <Tooltip {...tooltipProps} formatter={(v: number) => fmt(Number(v))} />
            <Legend />
            <Pie
              data={data}
              dataKey={series[0].key}
              nameKey="name"
              cx="50%"
              cy="50%"
              outerRadius={100}
              label={(e: { name: string }) => e.name}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={data[i].color ?? PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        ) : chartType === "line" ? (
          <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <XAxis dataKey="name" {...axisProps} />
            <YAxis tickFormatter={fmt} width={isCurrency ? 80 : 40} {...axisProps} />
            <Tooltip {...tooltipProps} formatter={(v: number) => fmt(Number(v))} />
            <Legend />
            {series.map((s, i) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </LineChart>
        ) : chartType === "area" ? (
          <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <XAxis dataKey="name" {...axisProps} />
            <YAxis tickFormatter={fmt} width={isCurrency ? 80 : 40} {...axisProps} />
            <Tooltip {...tooltipProps} formatter={(v: number) => fmt(Number(v))} />
            <Legend />
            {series.map((s, i) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={PIE_COLORS[i % PIE_COLORS.length]}
                fill={PIE_COLORS[i % PIE_COLORS.length]}
                fillOpacity={0.25}
              />
            ))}
          </AreaChart>
        ) : (
          <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barGap={2}>
            <XAxis dataKey="name" {...axisProps} />
            <YAxis tickFormatter={fmt} width={isCurrency ? 80 : 40} {...axisProps} />
            <Tooltip cursor={{ fill: "hsl(var(--muted))" }} {...tooltipProps} formatter={(v: number) => fmt(Number(v))} />
            <Legend />
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} radius={[6, 6, 0, 0]} fillOpacity={s.faded ? 0.45 : 1}>
                {data.map((d, j) => (
                  <Cell key={j} fill={d.color ?? PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Bar>
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

type ChartDatum = { name: string; color?: string; [k: string]: string | number | undefined };
type Series = { key: string; label: string; faded?: boolean };

/** Normalize a ReportResult into a flat { name, ...series } model for recharts. */
function toChartModel(result: ReportResult): { data: ChartDatum[]; series: Series[]; isCurrency: boolean } {
  switch (result.kind) {
    case "funnel":
      return {
        data: result.rows.map((r) => ({ name: r.name, entries: r.entries })),
        series: [{ key: "entries", label: "Deals entered" }],
        isCurrency: false,
      };
    case "velocity":
      return {
        data: result.rows.map((r) => ({ name: r.name, avgDays: r.avgDays })),
        series: [{ key: "avgDays", label: "Avg days in stage" }],
        isCurrency: false,
      };
    case "win_loss":
      return {
        data: result.rows.map((r) => ({ name: r.label, won: r.won, lost: r.lost })),
        series: [
          { key: "won", label: "Won" },
          { key: "lost", label: "Lost" },
        ],
        isCurrency: false,
      };
    case "lead_source":
      return {
        data: result.rows.map((r) => ({ name: r.source, leads: r.leads, converted: r.converted })),
        series: [
          { key: "leads", label: "Leads" },
          { key: "converted", label: "Converted" },
        ],
        isCurrency: false,
      };
    case "pipeline_value":
      return {
        data: result.rows.map((r) => ({ name: r.name, value: r.value, weighted: r.weighted, color: r.color })),
        series: [
          { key: "value", label: "Open value" },
          { key: "weighted", label: "Weighted", faded: true },
        ],
        isCurrency: true,
      };
    case "activity":
      return {
        data: result.byType.map((r) => ({ name: r.label, created: r.created, completed: r.completed })),
        series: [
          { key: "created", label: "Created" },
          { key: "completed", label: "Completed" },
        ],
        isCurrency: false,
      };
    default:
      return { data: [], series: [], isCurrency: false };
  }
}
