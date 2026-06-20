"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { MergeField } from "@/lib/documents";
import {
  createDocumentTemplate,
  updateDocumentTemplate,
  deleteDocumentTemplate,
} from "@/server/actions/documents";

export type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  body: string;
};

export function TemplatesSection({
  templates,
  mergeFields,
  isAdmin,
}: {
  templates: TemplateRow[];
  mergeFields: MergeField[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");

  function reset() {
    setEditingId(null);
    setName("");
    setDescription("");
    setBody("");
  }

  function startEdit(t: TemplateRow) {
    setEditingId(t.id);
    setName(t.name);
    setDescription(t.description ?? "");
    setBody(t.body);
  }

  function onSave() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    start(async () => {
      const payload = { name: name.trim(), description: description.trim(), body };
      const r = editingId
        ? await updateDocumentTemplate(editingId, payload)
        : await createDocumentTemplate(payload);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(editingId ? "Template updated" : "Template created");
      reset();
      router.refresh();
    });
  }

  function onDelete(id: string) {
    if (!confirm("Delete this template?")) return;
    start(async () => {
      const r = await deleteDocumentTemplate(id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Deleted");
        if (editingId === id) reset();
        router.refresh();
      }
    });
  }

  function insertToken(token: string) {
    setBody((b) => (b ? `${b}${token}` : token));
  }

  return (
    <div className="space-y-6">
      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No templates yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{t.name}</p>
                {t.description && <p className="truncate text-xs text-muted-foreground">{t.description}</p>}
              </div>
              {isAdmin && (
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => startEdit(t)}>
                    Edit
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={pending}
                    aria-label={`Delete ${t.name}`}
                    onClick={() => onDelete(t.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <div className="grid gap-3 border-t pt-6">
          <h3 className="text-sm font-semibold">{editingId ? "Edit template" : "New template"}</h3>
          <div className="space-y-1.5">
            <Label htmlFor="t-name">Name</Label>
            <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Proposal" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-desc">Description (optional)</Label>
            <Input
              id="t-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Standard sales proposal"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-body">Body</Label>
            <textarea
              id="t-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              placeholder={"Dear {{contact.fullName}},\n\nThank you for your interest in {{deal.title}}…"}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            />
          </div>
          <div className="rounded-md border border-dashed bg-muted/40 p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Merge fields (click to insert):
            </p>
            <div className="flex flex-wrap gap-1.5">
              {mergeFields.map((f) => (
                <button
                  key={f.token}
                  type="button"
                  title={f.label}
                  onClick={() => insertToken(f.token)}
                  className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {f.token}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={onSave} disabled={pending}>
              {pending ? "Saving…" : editingId ? "Update template" : "Create template"}
            </Button>
            {editingId && (
              <Button type="button" variant="ghost" disabled={pending} onClick={reset}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
