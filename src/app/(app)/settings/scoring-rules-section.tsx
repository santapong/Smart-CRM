"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createScoringRule, deleteScoringRule } from "@/server/actions/scoring-rules";

const OPS = ["eq", "neq", "contains", "gt", "lt", "exists"] as const;
type Op = (typeof OPS)[number];

const OP_LABELS: Record<Op, string> = {
  eq: "equals",
  neq: "not equals",
  contains: "contains",
  gt: "greater than",
  lt: "less than",
  exists: "is present",
};

export type ScoringRuleRow = {
  id: string;
  field: string;
  op: string;
  value: string | null;
  points: number;
};

const inputClass = "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

export function ScoringRulesSection({ rules }: { rules: ScoringRuleRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [field, setField] = useState("");
  const [op, setOp] = useState<Op>("eq");
  const [value, setValue] = useState("");
  const [points, setPoints] = useState("10");

  function onCreate() {
    if (!field.trim()) {
      toast.error("Field is required");
      return;
    }
    start(async () => {
      const r = await createScoringRule({
        entity: "lead",
        field: field.trim(),
        op,
        value: op === "exists" ? undefined : value,
        points: points || "0",
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Rule added");
      setField("");
      setOp("eq");
      setValue("");
      setPoints("10");
      router.refresh();
    });
  }

  function onDelete(row: ScoringRuleRow) {
    if (!confirm("Delete scoring rule?")) return;
    start(async () => {
      const r = await deleteScoringRule(row.id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Deleted");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Leads are scored by summing the points of every matching rule. Use a field name (e.g.{" "}
        <code>source</code>, <code>value</code>) or a <code>customFields.key</code> path.
      </p>
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No scoring rules.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rules.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 p-3">
              <p className="text-sm">
                <span className="font-medium">{row.field}</span>{" "}
                <span className="text-muted-foreground">{OP_LABELS[row.op as Op] ?? row.op}</span>{" "}
                {row.op !== "exists" && <span className="font-medium">{row.value}</span>}
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums">
                  {row.points > 0 ? `+${row.points}` : row.points}
                </span>
              </p>
              <Button
                size="icon"
                variant="ghost"
                disabled={pending}
                aria-label="Delete rule"
                onClick={() => onDelete(row)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 border-t pt-6 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="sr-field">Field</Label>
          <Input id="sr-field" value={field} onChange={(e) => setField(e.target.value)} placeholder="source" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sr-op">Operator</Label>
          <select id="sr-op" value={op} onChange={(e) => setOp(e.target.value as Op)} className={inputClass}>
            {OPS.map((o) => (
              <option key={o} value={o}>
                {OP_LABELS[o]}
              </option>
            ))}
          </select>
        </div>
        {op !== "exists" && (
          <div className="space-y-1.5">
            <Label htmlFor="sr-value">Value</Label>
            <Input id="sr-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Website" />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="sr-points">Points</Label>
          <Input id="sr-points" type="number" step="1" value={points} onChange={(e) => setPoints(e.target.value)} />
        </div>
        <Button type="button" onClick={onCreate} disabled={pending} className="sm:col-span-2">
          {pending ? "Saving…" : "Add scoring rule"}
        </Button>
      </div>
    </div>
  );
}
