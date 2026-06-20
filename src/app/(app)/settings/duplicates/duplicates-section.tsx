"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { mergeRecords, undoMerge } from "@/server/actions/merge";

type Entity = "contact" | "company";

type DuplicateGroup = {
  key: string;
  records: { id: string; label: string; subtitle: string | null }[];
};

type RecentMerge = { id: string; entity: string; createdAt: string };

const inputClass = "flex h-9 rounded-md border border-input bg-background px-3 text-sm";

function GroupList({ entity, groups }: { entity: Entity; groups: DuplicateGroup[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Per-group: which record id to keep (defaults to the first/oldest).
  const [keep, setKeep] = useState<Record<string, string>>({});

  function onMerge(group: DuplicateGroup) {
    const targetId = keep[group.key] ?? group.records[0].id;
    const sources = group.records.filter((r) => r.id !== targetId);
    if (sources.length === 0) return;
    if (!confirm(`Merge ${sources.length} record(s) into "${group.records.find((r) => r.id === targetId)?.label}"? This deletes the others.`)) {
      return;
    }
    start(async () => {
      for (const s of sources) {
        const r = await mergeRecords({ entity, targetId, sourceId: s.id });
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
      }
      toast.success("Merged");
      router.refresh();
    });
  }

  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No duplicate {entity === "contact" ? "contacts" : "companies"} found.</p>;
  }

  return (
    <ul className="space-y-3">
      {groups.map((group) => {
        const targetId = keep[group.key] ?? group.records[0].id;
        return (
          <li key={group.key} className="rounded-md border p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Matched on <code>{group.key}</code> — {group.records.length} records
            </p>
            <div className="space-y-1.5">
              {group.records.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`keep-${group.key}`}
                    checked={targetId === r.id}
                    onChange={() => setKeep((k) => ({ ...k, [group.key]: r.id }))}
                  />
                  <span className="font-medium">{r.label}</span>
                  {r.subtitle && <span className="text-muted-foreground">{r.subtitle}</span>}
                </label>
              ))}
            </div>
            <Button type="button" size="sm" className="mt-3" disabled={pending} onClick={() => onMerge(group)}>
              {pending ? "Merging…" : "Merge — keep selected"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function DuplicatesSection({
  contactGroups,
  companyGroups,
  recentMerges,
}: {
  contactGroups: DuplicateGroup[];
  companyGroups: DuplicateGroup[];
  recentMerges: RecentMerge[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [tab, setTab] = useState<Entity>("contact");

  function onUndo(id: string) {
    if (!confirm("Undo this merge? The source record will be restored.")) return;
    start(async () => {
      const r = await undoMerge(id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Merge undone");
        router.refresh();
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="flex items-center gap-2">
          <select value={tab} onChange={(e) => setTab(e.target.value as Entity)} className={inputClass}>
            <option value="contact">Contacts</option>
            <option value="company">Companies</option>
          </select>
        </div>
        {tab === "contact" ? (
          <GroupList entity="contact" groups={contactGroups} />
        ) : (
          <GroupList entity="company" groups={companyGroups} />
        )}
      </div>

      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Recent merges</h2>
        {recentMerges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No merges yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {recentMerges.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <span className="capitalize">{m.entity}</span>{" "}
                  <span className="text-xs text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</span>
                </span>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => onUndo(m.id)}>
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
