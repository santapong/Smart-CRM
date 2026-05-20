"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TierBadge } from "@/components/tier-badge";
import { toast } from "sonner";
import { upsertSlaPolicy } from "@/server/actions/sla-policies";
import type { AccountTier } from "@prisma/client";

type Policy = {
  tier: AccountTier;
  firstResponseMinutes: number;
  resolutionMinutes: number;
};

const TIERS: AccountTier[] = ["SMB", "MID_MARKET", "ENTERPRISE", "STRATEGIC"];

export function SlaPoliciesSection({ policies }: { policies: Policy[] }) {
  const byTier = new Map<AccountTier, Policy>();
  for (const p of policies) byTier.set(p.tier, p);

  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tier</TableHead>
            <TableHead>First response (min)</TableHead>
            <TableHead>Resolution (min)</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {TIERS.map((tier) => (
            <PolicyRow key={tier} tier={tier} initial={byTier.get(tier)} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PolicyRow({ tier, initial }: { tier: AccountTier; initial: Policy | undefined }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [firstResponse, setFirstResponse] = useState<string>(
    initial ? String(initial.firstResponseMinutes) : "",
  );
  const [resolution, setResolution] = useState<string>(
    initial ? String(initial.resolutionMinutes) : "",
  );

  async function save() {
    setBusy(true);
    const r = await upsertSlaPolicy({
      tier,
      firstResponseMinutes: firstResponse,
      resolutionMinutes: resolution,
    });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(`${tier} policy saved`);
    router.refresh();
  }

  return (
    <TableRow>
      <TableCell>
        <TierBadge tier={tier} />
      </TableCell>
      <TableCell>
        <Input
          aria-label={`${tier} first response minutes`}
          type="number"
          min={1}
          value={firstResponse}
          onChange={(e) => setFirstResponse(e.target.value)}
          className="w-32"
        />
      </TableCell>
      <TableCell>
        <Input
          aria-label={`${tier} resolution minutes`}
          type="number"
          min={1}
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          className="w-32"
        />
      </TableCell>
      <TableCell>
        <Button size="sm" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </TableCell>
    </TableRow>
  );
}
