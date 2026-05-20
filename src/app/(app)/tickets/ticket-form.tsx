"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { createTicket, updateTicket } from "@/server/actions/tickets";
import type { TicketPriority, TicketStatus } from "@prisma/client";

type CompanyOption = { id: string; name: string };
type ContactOption = { id: string; name: string; companyId: string | null };
type AssigneeOption = { id: string; name: string | null; email: string };

const PRIORITY_OPTIONS: { value: TicketPriority; label: string }[] = [
  { value: "LOW", label: "Low" },
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
];

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "WAITING_CUSTOMER", label: "Waiting on customer" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
];

export function TicketForm({
  companies,
  contacts,
  assignees,
  initial,
}: {
  companies: CompanyOption[];
  contacts: ContactOption[];
  assignees: AssigneeOption[];
  initial?: {
    id: string;
    companyId: string;
    contactId: string | null;
    assigneeId: string | null;
    subject: string;
    body: string | null;
    status: TicketStatus;
    priority: TicketPriority;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [companyId, setCompanyId] = useState<string>(initial?.companyId ?? companies[0]?.id ?? "");

  const filteredContacts = useMemo(() => {
    if (!companyId) return contacts;
    return contacts.filter((c) => c.companyId === companyId || c.companyId == null);
  }, [companyId, contacts]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const input = Object.fromEntries(form.entries());
    const res = initial ? await updateTicket(initial.id, input) : await createTicket(input);
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(initial ? "Updated" : "Created");
    router.push(`/tickets/${res.data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="companyId">Account</Label>
          <select
            id="companyId"
            name="companyId"
            required
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="" disabled>
              Select an account
            </option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contactId">Contact</Label>
          <select
            id="contactId"
            name="contactId"
            defaultValue={initial?.contactId ?? ""}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">— None —</option>
            {filteredContacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="assigneeId">Assignee</Label>
          <select
            id="assigneeId"
            name="assigneeId"
            defaultValue={initial?.assigneeId ?? ""}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">— Unassigned —</option>
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ? `${a.name} (${a.email})` : a.email}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="priority">Priority</Label>
          <select
            id="priority"
            name="priority"
            defaultValue={initial?.priority ?? "NORMAL"}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {initial && (
        <div className="space-y-1.5">
          <Label htmlFor="status">Status</Label>
          <select
            id="status"
            name="status"
            defaultValue={initial.status}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="subject">Subject</Label>
        <Input id="subject" name="subject" required defaultValue={initial?.subject} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="body">Description</Label>
        <Textarea id="body" name="body" rows={6} defaultValue={initial?.body ?? ""} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Create ticket"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
