"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { createContact, updateContact } from "@/server/actions/contacts";

type Company = { id: string; name: string };
type Channel = "EMAIL" | "TELEGRAM" | "LINE";

export function ContactForm({
  companies,
  initial,
}: {
  companies: Company[];
  initial?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    title: string | null;
    companyId: string | null;
    notes: string | null;
    telegramChatId?: string | null;
    lineUserId?: string | null;
    preferredChannel?: Channel | null;
    emailOptIn?: boolean;
    telegramOptIn?: boolean;
    lineOptIn?: boolean;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const input = Object.fromEntries(form.entries());
    const res = initial ? await updateContact(initial.id, input) : await createContact(input);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(initial ? "Updated" : "Created");
    router.push(`/contacts/${res.data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="_channelsForm" value="1" />
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="firstName">First name</Label>
          <Input id="firstName" name="firstName" required defaultValue={initial?.firstName} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lastName">Last name</Label>
          <Input id="lastName" name="lastName" required defaultValue={initial?.lastName} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" defaultValue={initial?.email ?? ""} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" defaultValue={initial?.phone ?? ""} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" defaultValue={initial?.title ?? ""} />
        </div>
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
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="space-y-3 rounded-md border p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Messaging channels
        </legend>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="telegramChatId">Telegram chat ID</Label>
            <Input
              id="telegramChatId"
              name="telegramChatId"
              placeholder="e.g. 123456789"
              defaultValue={initial?.telegramChatId ?? ""}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lineUserId">LINE user ID</Label>
            <Input
              id="lineUserId"
              name="lineUserId"
              placeholder="e.g. U1234abcd…"
              defaultValue={initial?.lineUserId ?? ""}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="preferredChannel">Preferred channel</Label>
          <select
            id="preferredChannel"
            name="preferredChannel"
            defaultValue={initial?.preferredChannel ?? ""}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">— None —</option>
            <option value="EMAIL">Email</option>
            <option value="TELEGRAM">Telegram</option>
            <option value="LINE">LINE</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="emailOptIn"
              defaultChecked={initial?.emailOptIn ?? true}
            />
            Email opt-in
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="telegramOptIn"
              defaultChecked={initial?.telegramOptIn ?? true}
            />
            Telegram opt-in
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="lineOptIn"
              defaultChecked={initial?.lineOptIn ?? true}
            />
            LINE opt-in
          </label>
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" defaultValue={initial?.notes ?? ""} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Create contact"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
