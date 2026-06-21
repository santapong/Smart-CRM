"use client";
import { useRouter, usePathname } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type PipelineOption = { id: string; name: string };

export function PipelineSelector({
  pipelines,
  selectedId,
}: {
  pipelines: PipelineOption[];
  selectedId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // A single pipeline needs no selector.
  if (pipelines.length <= 1) return null;

  function onChange(id: string) {
    const params = new URLSearchParams();
    params.set("pipeline", id);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="pipeline-select" className="text-sm font-medium text-muted-foreground">
        Pipeline
      </label>
      <Select value={selectedId} onValueChange={onChange}>
        <SelectTrigger id="pipeline-select" className="w-56" aria-label="Select pipeline">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {pipelines.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
