"use client";
import { useRouter } from "next/navigation";
import { addMonths, format, parse } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Month navigator. Drives the page via the `?month=YYYY-MM` search param. */
export function MonthNav({ month }: { month: string }) {
  const router = useRouter();
  const current = parse(month, "yyyy-MM", new Date());

  function go(delta: number) {
    const next = format(addMonths(current, delta), "yyyy-MM");
    router.push(`/calendar?month=${next}`);
  }

  function today() {
    router.push(`/calendar?month=${format(new Date(), "yyyy-MM")}`);
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="icon" variant="outline" aria-label="Previous month" onClick={() => go(-1)}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="min-w-32 text-center text-sm font-medium">{format(current, "MMMM yyyy")}</span>
      <Button size="icon" variant="outline" aria-label="Next month" onClick={() => go(1)}>
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="ghost" onClick={today}>
        Today
      </Button>
    </div>
  );
}
