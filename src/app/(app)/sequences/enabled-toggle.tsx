"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { updateSequence } from "@/server/actions/sequences";

export function SequenceEnabledToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function onToggle() {
    start(async () => {
      const r = await updateSequence(id, { enabled: !enabled });
      if (!r.ok) toast.error(r.error);
      else router.refresh();
    });
  }

  return (
    <Button size="sm" variant={enabled ? "outline" : "secondary"} disabled={pending} onClick={onToggle}>
      {enabled ? "Enabled" : "Disabled"}
    </Button>
  );
}
