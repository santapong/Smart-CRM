"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  createCustomFieldDefinition,
  deleteCustomFieldDefinition,
} from "@/server/actions/custom-fields";
import type { CustomFieldDefinition, CustomFieldEntity, CustomFieldType } from "@prisma/client";

const ENTITY_LABEL: Record<CustomFieldEntity, string> = {
  COMPANY: "Account",
  CONTACT: "Contact",
  DEAL: "Deal",
};

const ENTITY_OPTIONS: { value: CustomFieldEntity; label: string }[] = [
  { value: "COMPANY", label: "Account" },
  { value: "CONTACT", label: "Contact" },
  { value: "DEAL", label: "Deal" },
];

const TYPE_OPTIONS: { value: CustomFieldType; label: string }[] = [
  { value: "TEXT", label: "Text" },
  { value: "NUMBER", label: "Number" },
  { value: "DATE", label: "Date" },
  { value: "BOOLEAN", label: "Boolean" },
  { value: "SELECT", label: "Select" },
  { value: "URL", label: "URL" },
];

export function CustomFieldsSection({ definitions }: { definitions: CustomFieldDefinition[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  const [type, setType] = useState<CustomFieldType>("TEXT");

  const grouped = new Map<CustomFieldEntity, CustomFieldDefinition[]>();
  for (const d of definitions) {
    if (!grouped.has(d.entity)) grouped.set(d.entity, []);
    grouped.get(d.entity)!.push(d);
  }

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const input = Object.fromEntries(form.entries());
    const r = await createCustomFieldDefinition(input);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Custom field added");
    (e.target as HTMLFormElement).reset();
    setType("TEXT");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {(["COMPANY", "CONTACT", "DEAL"] as CustomFieldEntity[]).map((entity) => {
        const defs = grouped.get(entity) ?? [];
        return (
          <div key={entity}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {ENTITY_LABEL[entity]} fields
            </h3>
            {defs.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {defs.map((d) => (
                  <li key={d.id} className="flex items-center justify-between p-3">
                    <div>
                      <p className="text-sm font-medium">{d.label}</p>
                      <p className="text-xs text-muted-foreground">
                        <code>{d.key}</code> · {d.type}
                        {d.required ? " · required" : ""}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        start(async () => {
                          if (!confirm(`Delete custom field "${d.label}"? Existing values will be lost.`)) return;
                          const r = await deleteCustomFieldDefinition(d.id);
                          if (!r.ok) {
                            toast.error(r.error);
                            return;
                          }
                          toast.success("Deleted");
                          router.refresh();
                        })
                      }
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      <form onSubmit={onCreate} className="grid gap-3 border-t pt-6 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="entity">Entity</Label>
          <select
            id="entity"
            name="entity"
            required
            defaultValue="COMPANY"
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {ENTITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="type">Type</Label>
          <select
            id="type"
            name="type"
            required
            value={type}
            onChange={(e) => setType(e.target.value as CustomFieldType)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="key">Key</Label>
          <Input id="key" name="key" required placeholder="e.g. contract_value" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="label">Label</Label>
          <Input id="label" name="label" required placeholder="Display label" />
        </div>
        {type === "SELECT" && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="options">Options</Label>
            <Textarea
              id="options"
              name="options"
              placeholder="One option per line"
              rows={4}
            />
          </div>
        )}
        <div className="space-y-1.5 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="required" />
            Required
          </label>
        </div>
        <Button type="submit" disabled={busy} className="sm:col-span-2">
          {busy ? "Adding…" : "Add custom field"}
        </Button>
      </form>
    </div>
  );
}
