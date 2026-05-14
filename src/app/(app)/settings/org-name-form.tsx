"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { updateOrgName } from "@/server/actions/org";

export function OrgNameForm({ name }: { name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const r = await updateOrgName(String(form.get("name") || ""));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Saved");
    router.refresh();
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" defaultValue={name} required />
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
