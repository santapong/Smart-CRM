import { cn } from "@/lib/utils";
import type { AccountTier } from "@prisma/client";

const TIER_STYLES: Record<AccountTier, string> = {
  SMB: "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100",
  MID_MARKET: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100",
  ENTERPRISE: "bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100",
  STRATEGIC: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
};

const TIER_LABELS: Record<AccountTier, string> = {
  SMB: "SMB",
  MID_MARKET: "Mid-market",
  ENTERPRISE: "Enterprise",
  STRATEGIC: "Strategic",
};

export function TierBadge({ tier, className }: { tier: AccountTier; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        TIER_STYLES[tier],
        className,
      )}
    >
      {TIER_LABELS[tier]}
    </span>
  );
}
