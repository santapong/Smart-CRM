"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { runAdHocReport, createReport } from "@/server/actions/reports";
import { REPORT_KINDS, type ReportKind, type ReportResult } from "@/lib/reports/runners";
import { ReportChart, type ChartType } from "../report-chart";

const KIND_LABELS: Record<ReportKind, string> = {
  funnel: "Funnel",
  velocity: "Stage velocity",
  win_loss: "Win / loss",
  lead_source: "Lead source",
  pipeline_value: "Pipeline value",
  activity: "Activity",
};

const CHART_TYPES: ChartType[] = ["bar", "line", "area", "pie"];

const RANGES = [
  { value: "", label: "All time" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
];

function sinceFromRange(range: string): string | null {
  const days = Number(range);
  if (!days || Number.isNaN(days)) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Interactive builder: pick kind + filters + chart type, preview, then save. */
export function ReportBuilder({ pipelines }: { pipelines: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [kind, setKind] = useState<ReportKind>("funnel");
  const [pipelineId, setPipelineId] = useState("");
  const [range, setRange] = useState("");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [name, setName] = useState("");
  const [result, setResult] = useState<ReportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  const spec = () => ({ pipelineId: pipelineId || null, since: sinceFromRange(range) });

  function preview() {
    startTransition(async () => {
      const r = await runAdHocReport({ kind, spec: spec() });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setResult(r.data);
    });
  }

  async function save() {
    setBusy(true);
    const r = await createReport({ name: name || KIND_LABELS[kind], kind, spec: spec(), chartType });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Report saved");
    router.push(`/reports/${r.data.id}`);
    router.refresh();
  }

  const selectClass = "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Configure</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={KIND_LABELS[kind]} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="kind">Report type</Label>
            <select
              id="kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as ReportKind);
                setResult(null);
              }}
              className={selectClass}
            >
              {REPORT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pipeline">Pipeline</Label>
            <select id="pipeline" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className={selectClass}>
              <option value="">All pipelines</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="range">Date range</Label>
            <select id="range" value={range} onChange={(e) => setRange(e.target.value)} className={selectClass}>
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="chartType">Chart type</Label>
            <select
              id="chartType"
              value={chartType}
              onChange={(e) => setChartType(e.target.value as ChartType)}
              className={selectClass}
            >
              {CHART_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 pt-2">
            <Button type="button" variant="outline" onClick={preview} disabled={pending}>
              {pending ? "Running…" : "Preview"}
            </Button>
            <Button type="button" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save report"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{name || KIND_LABELS[kind]}</CardTitle>
        </CardHeader>
        <CardContent>
          {result ? (
            <ReportChart result={result} chartType={chartType} />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Choose options and press Preview to see the chart.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
