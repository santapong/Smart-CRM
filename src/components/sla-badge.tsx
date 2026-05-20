import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/utils";
import type { SlaBreakdown, SlaState } from "@/lib/sla";

const STATE_STYLES: Record<SlaState, string> = {
  WITHIN: "bg-secondary text-secondary-foreground",
  AT_RISK: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  BREACHED: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  MET: "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100",
  UNKNOWN: "bg-muted text-muted-foreground",
};

const STATE_LABELS: Record<SlaState, string> = {
  WITHIN: "On track",
  AT_RISK: "At risk",
  BREACHED: "Breached",
  MET: "Met",
  UNKNOWN: "No SLA",
};

function describe(state: SlaState, dueAt: Date | null): string {
  if (!dueAt) return STATE_LABELS[state];
  const now = new Date();
  if (state === "MET") return "Met";
  if (state === "BREACHED") {
    if (dueAt.getTime() > now.getTime()) return "Breached";
    return `breached ${formatDistanceToNowStrict(dueAt)} ago`;
  }
  return `due in ${formatDistanceToNowStrict(dueAt)}`;
}

function Pill({
  label,
  state,
  dueAt,
}: {
  label: string;
  state: SlaState;
  dueAt: Date | null;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        STATE_STYLES[state],
      )}
      title={dueAt ? dueAt.toISOString() : undefined}
    >
      <span className="font-semibold">{label}:</span>
      <span>{describe(state, dueAt)}</span>
    </span>
  );
}

export function SlaBadge({ breakdown }: { breakdown: SlaBreakdown }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Pill
        label="First response"
        state={breakdown.firstResponse.state}
        dueAt={breakdown.firstResponse.dueAt}
      />
      <Pill
        label="Resolution"
        state={breakdown.resolution.state}
        dueAt={breakdown.resolution.dueAt}
      />
    </div>
  );
}

export function SlaPill({
  kind,
  state,
  dueAt,
}: {
  kind: "first-response" | "resolution";
  state: SlaState;
  dueAt: Date | null;
}) {
  return (
    <Pill
      label={kind === "first-response" ? "First response" : "Resolution"}
      state={state}
      dueAt={dueAt}
    />
  );
}
