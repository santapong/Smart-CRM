"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  createFieldDefinition,
  updateFieldDefinition,
  deleteFieldDefinition,
} from "@/server/actions/custom-fields";

const ENTITIES = ["contact", "company", "deal"] as const;
type Entity = (typeof ENTITIES)[number];
const FIELD_TYPES = ["text", "number", "date", "boolean", "select"] as const;
type FieldType = (typeof FIELD_TYPES)[number];

export type FieldDefRow = {
  id: string;
  entity: Entity;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
};

const inputClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

export function CustomFieldsSection({ definitions }: { definitions: FieldDefRow[] }) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [entity, setEntity] = useState<Entity>("contact");
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");

  function resetForm() {
    setKey("");
    setLabel("");
    setType("text");
    setRequired(false);
    setOptions("");
  }

  function parseOptions(raw: string): string[] {
    return raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  }

  function onCreate() {
    if (!key.trim() || !label.trim()) {
      toast.error("Key and label are required");
      return;
    }
    const payload: Record<string, unknown> = {
      entity,
      key: key.trim(),
      label: label.trim(),
      type,
      required,
    };
    if (type === "select") payload.config = { options: parseOptions(options) };
    start(async () => {
      const r = await createFieldDefinition(payload);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Field created");
      resetForm();
      router.refresh();
    });
  }

  function onToggleRequired(row: FieldDefRow) {
    start(async () => {
      const r = await updateFieldDefinition(row.id, { required: !row.required });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      router.refresh();
    });
  }

  function onEditOptions(row: FieldDefRow) {
    const next = prompt("Comma-separated options", row.options.join(", "));
    if (next === null) return;
    start(async () => {
      const r = await updateFieldDefinition(row.id, { config: { options: parseOptions(next) } });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Options updated");
      router.refresh();
    });
  }

  function onDelete(row: FieldDefRow) {
    if (!confirm(`Delete custom field "${row.label}"?`)) return;
    start(async () => {
      const r = await deleteFieldDefinition(row.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Field deleted");
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {ENTITIES.map((e) => {
        const rows = definitions.filter((d) => d.entity === e);
        return (
          <div key={e} className="space-y-2">
            <p className="text-xs font-semibold capitalize text-muted-foreground">{e}</p>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No fields.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {row.label}{" "}
                        <span className="text-xs text-muted-foreground">({row.key})</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {row.type}
                        {row.required ? " · required" : ""}
                        {row.type === "select" && row.options.length > 0
                          ? ` · ${row.options.join(", ")}`
                          : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {row.type === "select" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isPending}
                          onClick={() => onEditOptions(row)}
                        >
                          Options
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPending}
                        onClick={() => onToggleRequired(row)}
                      >
                        {row.required ? "Make optional" : "Make required"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPending}
                        aria-label={`Delete ${row.label}`}
                        onClick={() => onDelete(row)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      <div className="grid gap-3 border-t pt-6 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cf-entity">Entity</Label>
          <select
            id="cf-entity"
            value={entity}
            onChange={(e) => setEntity(e.target.value as Entity)}
            className={inputClass}
          >
            {ENTITIES.map((e) => (
              <option key={e} value={e} className="capitalize">
                {e}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cf-type">Type</Label>
          <select
            id="cf-type"
            value={type}
            onChange={(e) => setType(e.target.value as FieldType)}
            className={inputClass}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cf-key">Key</Label>
          <Input
            id="cf-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="lower_snake_case"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cf-label">Label</Label>
          <Input id="cf-label" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        {type === "select" && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="cf-options">Options (comma-separated)</Label>
            <Input
              id="cf-options"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              placeholder="gold, silver, bronze"
            />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          Required
        </label>
        <Button type="button" onClick={onCreate} disabled={isPending} className="sm:col-span-2">
          {isPending ? "Saving…" : "Add custom field"}
        </Button>
      </div>
    </div>
  );
}
