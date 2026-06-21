import { cn } from "@/lib/utils";
import type { Usage } from "@/lib/usage";

/**
 * Usage & Billing section (M19b). Shows the org's current plan and, per metered
 * resource, usage vs. limit with a progress bar (amber when near, red when
 * over). Unlimited resources render an ∞ and no bar.
 */
export function UsageSection({ usage }: { usage: Usage }) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Current plan: <span className="font-semibold">{usage.plan.name}</span>
      </p>
      <div className="space-y-3">
        {usage.rows.map((r) => {
          const pct = r.unlimited
            ? 0
            : r.limit > 0
              ? Math.min(100, Math.round((r.used / r.limit) * 100))
              : r.over
                ? 100
                : 0;
          const barColor = r.over ? "bg-destructive" : r.near ? "bg-amber-500" : "bg-primary";
          return (
            <div key={r.key}>
              <div className="flex items-center justify-between text-sm">
                <span>{r.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {r.used} / {r.unlimited ? "∞" : r.limit}
                  {r.over && !r.unlimited ? " · limit reached" : r.near ? " · near limit" : ""}
                </span>
              </div>
              {!r.unlimited && (
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full", barColor)} style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Emails sent this month: <span className="tabular-nums">{usage.emailsThisMonth}</span>. Need more headroom?
        Upgrade your plan to lift these limits.
      </p>
    </div>
  );
}
