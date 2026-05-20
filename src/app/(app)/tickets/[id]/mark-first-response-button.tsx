"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { markTicketFirstResponse } from "@/server/actions/tickets";

export function MarkFirstResponseButton({
  ticketId,
  alreadyResponded,
}: {
  ticketId: string;
  alreadyResponded: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || alreadyResponded}
      onClick={async () => {
        setBusy(true);
        const r = await markTicketFirstResponse(ticketId);
        setBusy(false);
        if (!r.ok) return toast.error(r.error);
        toast.success("First response logged");
        router.refresh();
      }}
    >
      {alreadyResponded ? "First response logged" : busy ? "Saving…" : "Mark first response"}
    </Button>
  );
}
