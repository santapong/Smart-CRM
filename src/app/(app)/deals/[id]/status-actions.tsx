"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { setDealStatus, deleteDeal } from "@/server/actions/deals";

export function DealStatusActions({ id, status }: { id: string; status: "OPEN" | "WON" | "LOST" }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function set(next: "WON" | "LOST" | "OPEN") {
    start(async () => {
      const r = await setDealStatus(id, next);
      if (!r.ok) toast.error(r.error);
      else toast.success("Updated");
      router.refresh();
    });
  }

  return (
    <div className="flex gap-2">
      {status !== "WON" && (
        <Button size="sm" disabled={pending} onClick={() => set("WON")}>
          Mark Won
        </Button>
      )}
      {status !== "LOST" && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => set("LOST")}>
          Mark Lost
        </Button>
      )}
      {status !== "OPEN" && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => set("OPEN")}>
          Re-open
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            if (!confirm("Delete this deal?")) return;
            const r = await deleteDeal(id);
            if (!r.ok) {
              toast.error(r.error);
              return;
            }
            toast.success("Deleted");
            router.push("/deals");
            router.refresh();
          })
        }
      >
        Delete
      </Button>
    </div>
  );
}
