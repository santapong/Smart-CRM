"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { createReport } from "@/server/actions/reports";
import type { ReportKind } from "@/lib/reports/runners";

const CHART_TYPES = ["bar", "line", "area", "pie"] as const;

/** Saves the given report kind + current filters as a named Report. */
export function SaveReportButton({
  kind,
  label,
  spec,
  defaultChartType = "bar",
}: {
  kind: ReportKind;
  label: string;
  spec: { pipelineId?: string | null; since?: string | null };
  defaultChartType?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(label);
  const [chartType, setChartType] = useState(defaultChartType);

  async function onSave() {
    setBusy(true);
    const r = await createReport({ name, kind, spec, chartType });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Report saved");
    setOpen(false);
    router.push(`/reports/${r.data.id}`);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Save className="h-4 w-4" /> Save
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save report</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="report-name">Name</Label>
            <Input id="report-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-chart">Chart type</Label>
            <select
              id="report-chart"
              value={chartType}
              onChange={(e) => setChartType(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {CHART_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onSave} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
