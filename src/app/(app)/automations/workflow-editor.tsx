"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createWorkflow, updateWorkflow, deleteWorkflow } from "@/server/actions/workflows";
import { ACTION_TYPES, type ActionType } from "@/lib/workflows/types";

const TRIGGER_OPTIONS = [
  { value: "deal.created", label: "Deal created" },
  { value: "deal.stage_changed", label: "Deal stage changed" },
  { value: "deal.status_changed", label: "Deal status changed" },
  { value: "contact.created", label: "Contact created" },
  { value: "lead.created", label: "Lead created" },
  { value: "lead.converted", label: "Lead converted" },
  { value: "form.submitted", label: "Form submitted" },
  { value: "email.sent", label: "Email sent" },
] as const;

const OPERATORS = [
  { value: "==", label: "equals" },
  { value: "!=", label: "not equals" },
  { value: ">", label: "greater than" },
  { value: "<", label: "less than" },
] as const;

type ConditionRow = { field: string; op: string; value: string };
type Action = Record<string, unknown> & { type: ActionType };

// Compile simple AND-ed condition rows into a JSON-Logic rule (or null).
function rowsToLogic(rows: ConditionRow[]): unknown | null {
  const valid = rows.filter((r) => r.field.trim());
  if (valid.length === 0) return null;
  const clauses = valid.map((r) => {
    const num = Number(r.value);
    const value = r.value !== "" && !Number.isNaN(num) ? num : r.value;
    return { [r.op]: [{ var: r.field.trim() }, value] };
  });
  return clauses.length === 1 ? clauses[0] : { and: clauses };
}

// Best-effort decode of a stored JSON-Logic rule back into editable rows.
function logicToRows(logic: unknown): ConditionRow[] {
  if (!logic || typeof logic !== "object") return [];
  const obj = logic as Record<string, unknown>;
  const clauses = "and" in obj && Array.isArray(obj.and) ? obj.and : [obj];
  const rows: ConditionRow[] = [];
  for (const cl of clauses) {
    if (!cl || typeof cl !== "object") continue;
    const [op, args] = Object.entries(cl as Record<string, unknown>)[0] ?? [];
    if (!op || !Array.isArray(args) || args.length !== 2) continue;
    const left = args[0] as { var?: string };
    rows.push({ field: left?.var ?? "", op, value: String(args[1] ?? "") });
  }
  return rows;
}

export function WorkflowEditor({
  initial,
}: {
  initial?: {
    id: string;
    name: string;
    triggerEvent: string;
    conditions: unknown;
    definition: Action[];
    enabled: boolean;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(initial?.name ?? "");
  const [triggerEvent, setTriggerEvent] = useState(initial?.triggerEvent ?? "deal.created");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [conditions, setConditions] = useState<ConditionRow[]>(
    initial ? logicToRows(initial.conditions) : [],
  );
  const [actions, setActions] = useState<Action[]>(
    initial?.definition?.length ? initial.definition : [{ type: "create_task", title: "" }],
  );

  function patchAction(i: number, patch: Record<string, unknown>) {
    setActions((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function addAction() {
    setActions((prev) => [...prev, { type: "create_task", title: "" }]);
  }
  function removeAction(i: number) {
    setActions((prev) => prev.filter((_, idx) => idx !== i));
  }

  function patchCondition(i: number, patch: Partial<ConditionRow>) {
    setConditions((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function addCondition() {
    setConditions((prev) => [...prev, { field: "event.toStatus", op: "==", value: "" }]);
  }
  function removeCondition(i: number) {
    setConditions((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const input = {
      name,
      triggerEvent,
      enabled,
      conditions: rowsToLogic(conditions),
      definition: actions,
    };
    const r = initial ? await updateWorkflow(initial.id, input) : await createWorkflow(input);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(initial ? "Saved" : "Created");
    router.push(`/automations/${r.data.id}`);
    router.refresh();
  }

  async function onDelete() {
    if (!initial) return;
    if (!confirm("Delete this automation?")) return;
    setBusy(true);
    const r = await deleteWorkflow(initial.id);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Deleted");
    router.push("/automations");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="trigger">When this happens</Label>
          <select
            id="trigger"
            value={triggerEvent}
            onChange={(e) => setTriggerEvent(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {TRIGGER_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2 pb-1.5">
          <input
            id="enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor="enabled">Enabled</Label>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Only if (conditions)</Label>
        <div className="space-y-2">
          {conditions.map((cnd, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <Input
                placeholder="field e.g. event.toStatus"
                value={cnd.field}
                onChange={(e) => patchCondition(i, { field: e.target.value })}
                className="h-8 w-56 text-xs"
              />
              <select
                value={cnd.op}
                onChange={(e) => patchCondition(i, { op: e.target.value })}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                {OPERATORS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <Input
                placeholder="value"
                value={cnd.value}
                onChange={(e) => patchCondition(i, { value: e.target.value })}
                className="h-8 w-40 text-xs"
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => removeCondition(i)} className="ml-auto">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={addCondition}>
          <Plus className="h-3.5 w-3.5" /> Add condition
        </Button>
      </div>

      <div className="space-y-2">
        <Label>Do this (actions, in order)</Label>
        <div className="space-y-2">
          {actions.map((a, i) => (
            <div key={i} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">{i + 1}.</span>
                <select
                  value={a.type}
                  onChange={(e) => patchAction(i, { type: e.target.value as ActionType })}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  {ACTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <Button type="button" size="sm" variant="ghost" onClick={() => removeAction(i)} className="ml-auto">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ActionFields action={a} onChange={(patch) => patchAction(i, patch)} />
            </div>
          ))}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={addAction}>
          <Plus className="h-3.5 w-3.5" /> Add action
        </Button>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Create automation"}
        </Button>
        {initial && (
          <Button type="button" variant="outline" disabled={busy} onClick={onDelete}>
            Delete
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ActionFields({
  action,
  onChange,
}: {
  action: Action;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const str = (k: string) => (typeof action[k] === "string" ? (action[k] as string) : "");
  const num = (k: string) => (action[k] == null ? "" : String(action[k]));
  switch (action.type) {
    case "create_task":
      return (
        <div className="grid gap-2 sm:grid-cols-3">
          <Input placeholder="Task title" value={str("title")} onChange={(e) => onChange({ title: e.target.value })} className="h-8 text-xs" />
          <Input placeholder="Body (optional)" value={str("body")} onChange={(e) => onChange({ body: e.target.value })} className="h-8 text-xs" />
          <Input placeholder="Due in days" type="number" value={num("dueInDays")} onChange={(e) => onChange({ dueInDays: e.target.value === "" ? undefined : Number(e.target.value) })} className="h-8 text-xs" />
        </div>
      );
    case "send_email":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input placeholder="Subject" value={str("subject")} onChange={(e) => onChange({ subject: e.target.value })} className="h-8 text-xs" />
          <Input placeholder="HTML body" value={str("body")} onChange={(e) => onChange({ body: e.target.value })} className="h-8 text-xs" />
        </div>
      );
    case "add_tag":
      return (
        <Input placeholder="Tag name" value={str("tag")} onChange={(e) => onChange({ tag: e.target.value })} className="h-8 text-xs" />
      );
    case "update_field":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input placeholder="Field (e.g. status) or customField" value={str("field")} onChange={(e) => onChange({ field: e.target.value })} className="h-8 text-xs" />
          <Input placeholder="Value" value={str("value")} onChange={(e) => onChange({ value: e.target.value })} className="h-8 text-xs" />
        </div>
      );
    case "webhook":
      return (
        <Input placeholder="https://example.com/webhook" value={str("url")} onChange={(e) => onChange({ url: e.target.value })} className="h-8 text-xs" />
      );
    case "delay":
      return (
        <Input placeholder="Seconds" type="number" value={num("seconds")} onChange={(e) => onChange({ seconds: e.target.value === "" ? undefined : Number(e.target.value) })} className="h-8 w-40 text-xs" />
      );
    default:
      return <p className="text-xs text-muted-foreground">No parameters for this action.</p>;
  }
}
