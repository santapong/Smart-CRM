"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { createDeal, updateDeal } from "@/server/actions/deals";

type Stage = { id: string; name: string };
type Pick = { id: string; label: string };

export function DealForm({
  stages,
  contacts,
  companies,
  initial,
}: {
  stages: Stage[];
  contacts: Pick[];
  companies: Pick[];
  initial?: {
    id: string;
    title: string;
    value: number;
    currency: string;
    stageId: string;
    status: "OPEN" | "WON" | "LOST";
    contactId: string | null;
    companyId: string | null;
    closeDate: Date | null;
    notes: string | null;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const input = Object.fromEntries(form.entries());
    const r = initial ? await updateDeal(initial.id, input) : await createDeal(input);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(initial ? "Updated" : "Created");
    router.push(`/deals/${r.data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required defaultValue={initial?.title} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="value">Value</Label>
          <Input id="value" name="value" type="number" step="0.01" min={0} defaultValue={initial?.value ?? 0} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="currency">Currency</Label>
          <Input id="currency" name="currency" maxLength={3} defaultValue={initial?.currency ?? "USD"} required />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="stageId">Stage</Label>
          <select
            id="stageId"
            name="stageId"
            required
            defaultValue={initial?.stageId ?? stages[0]?.id}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="status">Status</Label>
          <select
            id="status"
            name="status"
            defaultValue={initial?.status ?? "OPEN"}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="OPEN">Open</option>
            <option value="WON">Won</option>
            <option value="LOST">Lost</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="contactId">Contact</Label>
          <select
            id="contactId"
            name="contactId"
            defaultValue={initial?.contactId ?? ""}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">— None —</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="companyId">Company</Label>
          <select
            id="companyId"
            name="companyId"
            defaultValue={initial?.companyId ?? ""}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">— None —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="closeDate">Close date</Label>
        <Input
          id="closeDate"
          name="closeDate"
          type="date"
          defaultValue={initial?.closeDate ? initial.closeDate.toISOString().slice(0, 10) : ""}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" defaultValue={initial?.notes ?? ""} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Create deal"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
