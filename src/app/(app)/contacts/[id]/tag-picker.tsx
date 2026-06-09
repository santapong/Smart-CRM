"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createTag, deleteTag, setContactTags } from "@/server/actions/tags";

type Tag = { id: string; name: string; color: string };

export function TagPicker({
  contactId,
  allTags,
  assignedIds,
}: {
  contactId: string;
  allTags: Tag[];
  assignedIds: string[];
}) {
  const router = useRouter();
  const [assigned, setAssigned] = useState<Set<string>>(new Set(assignedIds));
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#3b82f6");

  async function persist(next: Set<string>) {
    const prev = assigned;
    setAssigned(next);
    setBusy(true);
    const res = await setContactTags(contactId, Array.from(next));
    setBusy(false);
    if (!res.ok) {
      setAssigned(prev);
      toast.error(res.error);
      return;
    }
    router.refresh();
  }

  function toggle(tagId: string) {
    if (busy || managing) return;
    const next = new Set(assigned);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    void persist(next);
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    const res = await createTag({ name: newName.trim(), color: newColor });
    if (!res.ok) {
      setBusy(false);
      toast.error(res.error);
      return;
    }
    const next = new Set(assigned);
    next.add(res.data.id);
    const assign = await setContactTags(contactId, Array.from(next));
    setBusy(false);
    if (!assign.ok) {
      toast.error(assign.error);
    } else {
      setAssigned(next);
      setNewName("");
    }
    router.refresh();
  }

  async function onDelete(tag: Tag) {
    if (!window.confirm(`Delete tag "${tag.name}" for the whole workspace?`)) return;
    setBusy(true);
    const res = await deleteTag(tag.id);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    const next = new Set(assigned);
    next.delete(tag.id);
    setAssigned(next);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {allTags.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tags yet — create one below.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {allTags.map((t) => {
            const on = assigned.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                disabled={busy}
                onClick={() => (managing ? void onDelete(t) : toggle(t.id))}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                  on ? "" : "text-muted-foreground opacity-60 hover:opacity-100"
                )}
                style={
                  on
                    ? { borderColor: t.color, color: t.color, backgroundColor: `${t.color}1a` }
                    : { borderColor: "hsl(var(--border))" }
                }
                title={managing ? `Delete "${t.name}"` : on ? "Remove from contact" : "Add to contact"}
              >
                {t.name}
                {managing && <X className="h-3 w-3" />}
              </button>
            );
          })}
        </div>
      )}

      <form onSubmit={onCreate} className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New tag…"
          className="h-8 text-xs"
          maxLength={40}
        />
        <input
          type="color"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
          className="h-8 w-9 shrink-0 cursor-pointer rounded-md border bg-background p-1"
          aria-label="Tag color"
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !newName.trim()}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </form>

      {allTags.length > 0 && (
        <button
          type="button"
          onClick={() => setManaging((m) => !m)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
          {managing ? "Done" : "Manage tags"}
        </button>
      )}
    </div>
  );
}
