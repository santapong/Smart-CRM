"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Plus, Target, Trash2 } from "lucide-react";
import { formatCurrency, cn } from "@/lib/utils";
import { createGoal, deleteGoal, type GoalWithProgress } from "@/server/actions/goals";

const METRICS: Array<{ value: string; label: string; currency?: boolean }> = [
  { value: "deals_won_value", label: "Deals won (value)", currency: true },
  { value: "deals_won_count", label: "Deals won (count)" },
  { value: "deals_created", label: "Deals created" },
  { value: "activities_completed", label: "Activities completed" },
];

const PERIODS = ["weekly", "monthly", "quarterly", "yearly", "custom"] as const;

const metricLabel = (m: string) => METRICS.find((x) => x.value === m)?.label ?? m;
const metricIsCurrency = (m: string) => !!METRICS.find((x) => x.value === m)?.currency;

function fmtMetric(metric: string, n: number) {
  return metricIsCurrency(metric) ? formatCurrency(n) : n.toLocaleString();
}

/** Default [start, end) for a period, used to prefill the create form. */
function defaultWindow(period: string): { startsAt: string; endsAt: string } {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (period === "weekly") end.setDate(end.getDate() + 7);
  else if (period === "quarterly") end.setMonth(end.getMonth() + 3);
  else if (period === "yearly") end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1); // monthly / custom default
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { startsAt: iso(start), endsAt: iso(end) };
}

export function GoalsSection({
  goals,
  members,
}: {
  goals: GoalWithProgress[];
  members: Array<{ id: string; label: string }>;
}) {
  const memberLabel = (id: string | null) => (id ? members.find((m) => m.id === id)?.label ?? "—" : "Whole team");

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Target className="h-4 w-4" /> Goals
        </CardTitle>
        <CreateGoalDialog members={members} />
      </CardHeader>
      <CardContent>
        {goals.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No goals yet. Set a target to track progress.
          </p>
        ) : (
          <ul className="space-y-4">
            {goals.map((g) => (
              <GoalRow key={g.id} goal={g} ownerLabel={memberLabel(g.ownerId)} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function GoalRow({ goal, ownerLabel }: { goal: GoalWithProgress; ownerLabel: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const p = goal.progress;

  async function onDelete() {
    setBusy(true);
    const r = await deleteGoal(goal.id);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Goal removed");
    router.refresh();
  }

  return (
    <li>
      <div className="mb-1 flex items-center justify-between gap-2 text-sm">
        <div>
          <span className="font-medium">{metricLabel(goal.metric)}</span>
          <span className="text-muted-foreground">
            {" · "}
            {ownerLabel} · {goal.period}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="tabular-nums text-muted-foreground">
            {fmtMetric(goal.metric, p.current)} / {fmtMetric(goal.metric, p.target)}
          </span>
          <button
            onClick={onDelete}
            disabled={busy}
            aria-label="Delete goal"
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", p.attained ? "bg-emerald-500" : "bg-primary")}
          style={{ width: `${p.percent}%` }}
        />
      </div>
    </li>
  );
}

function CreateGoalDialog({ members }: { members: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState("monthly");
  const initial = defaultWindow("monthly");
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  const [endsAt, setEndsAt] = useState(initial.endsAt);

  function onPeriodChange(value: string) {
    setPeriod(value);
    if (value !== "custom") {
      const w = defaultWindow(value);
      setStartsAt(w.startsAt);
      setEndsAt(w.endsAt);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const input = { ...Object.fromEntries(form.entries()), period, startsAt, endsAt };
    const r = await createGoal(input);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Goal created");
    setOpen(false);
    router.refresh();
  }

  const selectClass = "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" /> New goal
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New goal</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="metric">Metric</Label>
            <select id="metric" name="metric" defaultValue="deals_won_value" className={selectClass}>
              {METRICS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="target">Target</Label>
              <Input id="target" name="target" type="number" step="0.01" min={0} required defaultValue={1000} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="period">Period</Label>
              <select
                id="period"
                value={period}
                onChange={(e) => onPeriodChange(e.target.value)}
                className={selectClass}
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="startsAt">Starts</Label>
              <Input id="startsAt" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="endsAt">Ends</Label>
              <Input id="endsAt" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ownerId">Owner (optional)</Label>
            <select id="ownerId" name="ownerId" defaultValue="" className={selectClass}>
              <option value="">Whole team</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Create goal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
