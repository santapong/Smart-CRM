"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { createActivity } from "@/server/actions/activities";

type Opt = { id: string; firstName?: string; lastName?: string; title?: string };

export function ActivityFormInline({
  contacts,
  deals,
  defaultContactId,
  defaultDealId,
}: {
  contacts: { id: string; firstName: string; lastName: string }[];
  deals: { id: string; title: string }[];
  defaultContactId?: string;
  defaultDealId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const input = Object.fromEntries(form.entries());
    const r = await createActivity(input);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Logged");
    (e.target as HTMLFormElement).reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="type">Type</Label>
        <select id="type" name="type" className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" defaultValue="TASK">
          <option value="TASK">Task</option>
          <option value="CALL">Call</option>
          <option value="MEETING">Meeting</option>
          <option value="NOTE">Note</option>
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="dueAt">Due</Label>
        <Input id="dueAt" name="dueAt" type="datetime-local" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="contactId">Contact</Label>
        <select
          id="contactId"
          name="contactId"
          defaultValue={defaultContactId ?? ""}
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">— None —</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.firstName} {c.lastName}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="dealId">Deal</Label>
        <select
          id="dealId"
          name="dealId"
          defaultValue={defaultDealId ?? ""}
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">— None —</option>
          {deals.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="body">Notes</Label>
        <Textarea id="body" name="body" />
      </div>
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? "Saving…" : "Log activity"}
      </Button>
    </form>
  );
}
