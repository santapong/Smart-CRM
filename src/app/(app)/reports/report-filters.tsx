"use client";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

type PipelineOpt = { id: string; name: string };

const RANGES = [
  { value: "", label: "All time" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
];

/** Pipeline + date-range filter that drives the /reports page via search params. */
export function ReportFilters({
  pipelines,
  pipelineId,
  range,
}: {
  pipelines: PipelineOpt[];
  pipelineId: string;
  range: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`${pathname}?${next.toString()}`);
  }

  const selectClass = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Pipeline"
        className={selectClass}
        value={pipelineId}
        onChange={(e) => setParam("pipeline", e.target.value)}
      >
        <option value="">All pipelines</option>
        {pipelines.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Date range"
        className={selectClass}
        value={range}
        onChange={(e) => setParam("range", e.target.value)}
      >
        {RANGES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
    </div>
  );
}
