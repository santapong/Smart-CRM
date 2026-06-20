"use client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Serializable shape of a custom-field definition passed from a server
 * component into a form. Mirrors the columns of CustomFieldDefinition that the
 * inputs need, dropping non-serializable fields (e.g. createdAt).
 */
export type CustomFieldDef = {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "boolean" | "select";
  required: boolean;
  options: string[];
};

/** Prefix for custom-field form inputs so they don't collide with core fields. */
const PREFIX = "cf_";

/**
 * Read the custom-field values out of a submitted form into a plain record that
 * can be sent as `customFields` to the server actions. Empty/optional values
 * are omitted so they don't trip "required"/validation rules; booleans map to
 * the checkbox state.
 */
export function collectCustomFields(
  form: FormData,
  defs: CustomFieldDef[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const name = PREFIX + def.key;
    if (def.type === "boolean") {
      out[def.key] = form.get(name) === "on";
      continue;
    }
    const raw = form.get(name);
    const value = typeof raw === "string" ? raw : "";
    if (value === "") continue; // let the server enforce "required"
    out[def.key] = value;
  }
  return out;
}

export function CustomFieldInputs({
  defs,
  initial,
}: {
  defs: CustomFieldDef[];
  initial?: Record<string, unknown> | null;
}) {
  if (defs.length === 0) return null;
  const values = initial ?? {};

  return (
    <div className="space-y-4 border-t pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Custom fields
      </h3>
      {defs.map((def) => {
        const name = PREFIX + def.key;
        const current = values[def.key];
        if (def.type === "boolean") {
          return (
            <label key={def.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={name}
                defaultChecked={current === true}
                className="h-4 w-4 rounded border-input"
              />
              {def.label}
            </label>
          );
        }
        return (
          <div key={def.key} className="space-y-1.5">
            <Label htmlFor={name}>
              {def.label}
              {def.required ? " *" : ""}
            </Label>
            {def.type === "select" ? (
              <select
                id={name}
                name={name}
                required={def.required}
                defaultValue={typeof current === "string" ? current : ""}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">— None —</option>
                {def.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={name}
                name={name}
                type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
                step={def.type === "number" ? "any" : undefined}
                required={def.required}
                defaultValue={
                  current === undefined || current === null ? "" : String(current)
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
