"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { convertLeadToDeal, deleteLead } from "@/server/actions/leads";

export function ConvertButton({ id, converted }: { id: string; converted: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        disabled={pending || converted}
        onClick={() =>
          start(async () => {
            const r = await convertLeadToDeal(id);
            if (!r.ok) {
              toast.error(r.error);
              return;
            }
            toast.success("Converted to deal");
            router.push(`/deals/${r.data.dealId}`);
            router.refresh();
          })
        }
      >
        {converted ? "Converted" : "Convert to deal"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            if (!confirm("Delete this lead?")) return;
            const r = await deleteLead(id);
            if (!r.ok) {
              toast.error(r.error);
              return;
            }
            toast.success("Deleted");
            router.push("/leads");
            router.refresh();
          })
        }
      >
        Delete
      </Button>
    </div>
  );
}
