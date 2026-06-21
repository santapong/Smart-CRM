"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createForm, updateForm, deleteForm } from "@/server/actions/forms";

const FIELD_TYPES = ["text", "email", "tel", "number", "textarea"] as const;

type Field = { key: string; label: string; type: (typeof FIELD_TYPES)[number]; required: boolean };

export function FormEditor({
  initial,
}: {
  initial?: {
    id: string;
    name: string;
    fields: Field[];
    target: string;
    active: boolean;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(initial?.name ?? "");
  const [target, setTarget] = useState(initial?.target ?? "lead");
  const [active, setActive] = useState(initial?.active ?? true);
  const [fields, setFields] = useState<Field[]>(
    initial?.fields?.length
      ? initial.fields
      : [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "email", label: "Email", type: "email", required: true },
        ],
  );

  function updateField(i: number, patch: Partial<Field>) {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function addField() {
    setFields((prev) => [...prev, { key: "", label: "", type: "text", required: false }]);
  }
  function removeField(i: number) {
    setFields((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const input = { name, target, active, fields };
    const r = initial ? await updateForm(initial.id, input) : await createForm(input);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(initial ? "Saved" : "Created");
    router.push(`/forms/${r.data.id}`);
    router.refresh();
  }

  async function onDelete() {
    if (!initial) return;
    if (!confirm("Delete this form?")) return;
    setBusy(true);
    const r = await deleteForm(initial.id);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Deleted");
    router.push("/forms");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="target">Target</Label>
          <select
            id="target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="lead">Lead</option>
            <option value="contact">Contact</option>
          </select>
        </div>
        <div className="flex items-end gap-2 pb-1.5">
          <input
            id="active"
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor="active">Active</Label>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Fields</Label>
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <Input
                placeholder="key"
                value={f.key}
                onChange={(e) => updateField(i, { key: e.target.value })}
                className="h-8 w-32 text-xs"
              />
              <Input
                placeholder="Label"
                value={f.label}
                onChange={(e) => updateField(i, { label: e.target.value })}
                className="h-8 w-40 text-xs"
              />
              <select
                value={f.type}
                onChange={(e) => updateField(i, { type: e.target.value as Field["type"] })}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => updateField(i, { required: e.target.checked })}
                />
                required
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => removeField(i)}
                className="ml-auto"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={addField}>
          <Plus className="h-3.5 w-3.5" /> Add field
        </Button>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Create form"}
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
