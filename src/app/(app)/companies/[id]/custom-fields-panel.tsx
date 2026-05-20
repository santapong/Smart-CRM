"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { setCustomFieldValue } from "@/server/actions/custom-fields";
import type { CustomFieldDefinition, CustomFieldValue, CustomFieldType } from "@prisma/client";

type EntityKind = "COMPANY" | "CONTACT" | "DEAL";

function valueToString(def: CustomFieldDefinition, v: CustomFieldValue | undefined): string {
  if (!v) return "";
  switch (def.type) {
    case "TEXT":
    case "URL":
    case "SELECT":
      return v.valueText ?? "";
    case "NUMBER":
      return v.valueNumber != null ? String(v.valueNumber) : "";
    case "DATE":
      return v.valueDate ? v.valueDate.toISOString().slice(0, 10) : "";
    case "BOOLEAN":
      return v.valueBoolean ? "true" : "false";
  }
}

function parseOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      // ignore
    }
  }
  return [];
}

export function CustomFieldsPanel({
  entityKind,
  entityId,
  definitions,
  values,
}: {
  entityKind: EntityKind;
  entityId: string;
  definitions: CustomFieldDefinition[];
  values: CustomFieldValue[];
}) {
  const valuesByDef = new Map<string, CustomFieldValue>();
  for (const v of values) valuesByDef.set(v.definitionId, v);

  if (definitions.length === 0) {
    return <p className="text-sm text-muted-foreground">No custom fields configured for {entityKind.toLowerCase()}s.</p>;
  }

  return (
    <div className="space-y-4">
      {definitions.map((def) => (
        <FieldRow
          key={def.id}
          def={def}
          entityId={entityId}
          initial={valueToString(def, valuesByDef.get(def.id))}
        />
      ))}
    </div>
  );
}

function FieldRow({
  def,
  entityId,
  initial,
}: {
  def: CustomFieldDefinition;
  entityId: string;
  initial: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState(initial);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const r = await setCustomFieldValue({ definitionId: def.id, entityId, raw: value });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(`${def.label} saved`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor={`cf-${def.id}`}>
          {def.label}
          {def.required && <span className="text-destructive"> *</span>}
        </Label>
        <FieldInput
          id={`cf-${def.id}`}
          type={def.type}
          options={parseOptions(def.options)}
          value={value}
          onChange={setValue}
        />
      </div>
      <Button type="submit" disabled={busy} size="sm">
        {busy ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

function FieldInput({
  id,
  type,
  options,
  value,
  onChange,
}: {
  id: string;
  type: CustomFieldType;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  switch (type) {
    case "TEXT":
      return <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />;
    case "URL":
      return <Input id={id} type="url" value={value} onChange={(e) => onChange(e.target.value)} />;
    case "NUMBER":
      return <Input id={id} type="number" step="any" value={value} onChange={(e) => onChange(e.target.value)} />;
    case "DATE":
      return <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
    case "BOOLEAN":
      return (
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            checked={value === "true"}
            onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          />
          Yes
        </label>
      );
    case "SELECT":
      return (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">—</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
  }
}
