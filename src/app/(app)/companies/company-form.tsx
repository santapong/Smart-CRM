"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { createCompany, updateCompany } from "@/server/actions/companies";
import type { AccountTier } from "@prisma/client";

type CompanyOption = { id: string; name: string };

const TIER_OPTIONS: { value: AccountTier; label: string }[] = [
  { value: "SMB", label: "SMB" },
  { value: "MID_MARKET", label: "Mid-market" },
  { value: "ENTERPRISE", label: "Enterprise" },
  { value: "STRATEGIC", label: "Strategic" },
];

export function CompanyForm({
  initial,
  companies = [],
}: {
  initial?: {
    id: string;
    name: string;
    domain: string | null;
    industry: string | null;
    size: string | null;
    notes: string | null;
    tier: AccountTier;
    parentCompanyId: string | null;
    arr: number | null;
  };
  companies?: CompanyOption[];
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
  const parentOptions = companies.filter((c) => !initial || c.id !== initial.id);
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
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="size">Size</Label>
          <Input id="size" name="size" placeholder="e.g. 1-10, 11-50, 201-500" defaultValue={initial?.size ?? ""} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tier">Tier</Label>
          <select
            id="tier"
            name="tier"
            defaultValue={initial?.tier ?? "SMB"}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {TIER_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="parentCompanyId">Parent account</Label>
          <select
            id="parentCompanyId"
            name="parentCompanyId"
            defaultValue={initial?.parentCompanyId ?? ""}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">— None —</option>
            {parentOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="arr">ARR (USD)</Label>
          <Input
            id="arr"
            name="arr"
            type="number"
            min={0}
            step="0.01"
            defaultValue={initial?.arr ?? ""}
            placeholder="0.00"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" defaultValue={initial?.notes ?? ""} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Create account"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
