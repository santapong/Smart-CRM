import { History, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TimelineEntry } from "@/lib/audit-timeline";

/**
 * History timeline (M19a). Renders a chronological (newest-first) merge of
 * AuditLog + DealStageEvent entries for a record. Presentational — the caller
 * loads the data via loadDealTimeline so the page can fetch it alongside its
 * other queries.
 */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No history yet.</p>;
  }

  return (
    <ol className="space-y-3">
      {entries.map((e) => {
        const Icon = e.kind === "stage" ? GitBranch : History;
        return (
          <li key={e.id} className="flex gap-3">
            <span
              className={cn(
                "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-background",
                e.kind === "stage" ? "text-sky-600" : "text-muted-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm">{e.summary}</p>
              <p className="text-xs text-muted-foreground">
                {e.actorName ? `${e.actorName} · ` : ""}
                {new Date(e.at).toLocaleString()}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
