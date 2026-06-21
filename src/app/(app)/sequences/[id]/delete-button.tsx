"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { deleteSequence } from "@/server/actions/sequences";

export function DeleteSequenceButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function onDelete() {
    if (!confirm("Delete this sequence? Active enrollments will stop.")) return;
    start(async () => {
      const r = await deleteSequence(id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Sequence deleted");
      router.push("/sequences");
    });
  }

  return (
    <Button size="sm" variant="destructive" disabled={pending} onClick={onDelete}>
      Delete
    </Button>
  );
}
