"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { createCompany, updateCompany } from "@/server/actions/companies";

export function CompanyForm({
  initial,
}: {
  initial?: { id: string; name: string; domain: string | null; industry: string | null; size: string | null; notes: string | null };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const input = Object.fromEntries(form.entries());
    const res = initial ? await updateCompany(initial.id, input) : await createCompany(input);
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(initial ? "Updated" : "Created");
    router.push(`/companies/${res.data.id}`);
    router.refresh();
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required defaultValue={initial?.name} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="domain">Domain</Label>
          <Input id="domain" name="domain" defaultValue={initial?.domain ?? ""} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="industry">Industry</Label>
          <Input id="industry" name="industry" defaultValue={initial?.industry ?? ""} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="size">Size</Label>
        <Input id="size" name="size" placeholder="e.g. 1-10, 11-50, 201-500" defaultValue={initial?.size ?? ""} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" defaultValue={initial?.notes ?? ""} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Create company"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
