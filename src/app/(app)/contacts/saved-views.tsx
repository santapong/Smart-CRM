"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bookmark, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createSavedView, deleteSavedView } from "@/server/actions/saved-views";

type ContactFilters = { q?: string; tag?: string };
type View = { id: string; name: string; shared: boolean; filters: ContactFilters; canDelete: boolean };

function filtersToHref(filters: ContactFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.tag) params.set("tag", filters.tag);
  const s = params.toString();
  return s ? `/contacts?${s}` : "/contacts";
}

export function ContactSavedViews({
  views,
  current,
}: {
  views: View[];
  current: ContactFilters;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [isPending, startTransition] = useTransition();

  const hasFilter = Boolean(current.q || current.tag);

  function applyView(id: string) {
    const view = views.find((v) => v.id === id);
    if (view) router.push(filtersToHref(view.filters));
  }

  function onSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the view a name");
      return;
    }
    startTransition(async () => {
      const r = await createSavedView({
        entity: "contact",
        name: trimmed,
        filters: current as Record<string, unknown>,
        shared,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("View saved");
      setOpen(false);
      setName("");
      setShared(false);
      router.refresh();
    });
  }

  function onDelete(id: string) {
    startTransition(async () => {
      const r = await deleteSavedView(id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("View deleted");
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      {views.length > 0 && (
        <Select onValueChange={applyView}>
          <SelectTrigger className="h-9 w-48" aria-label="Apply a saved view">
            <span className="flex items-center gap-2 text-muted-foreground">
              <Bookmark className="h-4 w-4" />
              <SelectValue placeholder="Saved views" />
            </span>
          </SelectTrigger>
          <SelectContent>
            {views.map((v) => (
              <div key={v.id} className="flex items-center justify-between gap-1 pr-1">
                <SelectItem value={v.id} className="flex-1">
                  {v.name}
                  {v.shared ? " · shared" : ""}
                </SelectItem>
                {v.canDelete && (
                  <button
                    type="button"
                    aria-label={`Delete view ${v.name}`}
                    title="Delete view"
                    disabled={isPending}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onDelete(v.id);
                    }}
                    className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </SelectContent>
        </Select>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasFilter}
          title={hasFilter ? "Save the current filter" : "Apply a search or tag filter first"}
          onClick={() => setOpen(true)}
        >
          <Plus className="h-4 w-4" /> Save view
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save current view</DialogTitle>
            <DialogDescription>
              Save the current search and tag filter so you can reuse it later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="view-name">Name</Label>
              <Input
                id="view-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. VIPs at Acme"
                autoFocus
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              Share with the whole workspace
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" onClick={onSave} disabled={isPending}>
              {isPending ? "Saving…" : "Save view"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
