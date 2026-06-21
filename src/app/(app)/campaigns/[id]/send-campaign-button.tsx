"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { sendCampaign } from "@/server/actions/campaigns";

export function SendCampaignButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function onSend() {
    if (!confirm("Send this campaign to its audience now?")) return;
    start(async () => {
      const r = await sendCampaign(id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`Sending to ${r.data.recipients} recipient(s)`);
      router.refresh();
    });
  }

  return (
    <Button type="button" size="sm" onClick={onSend} disabled={pending}>
      {pending ? "Sending…" : "Send campaign"}
    </Button>
  );
}
