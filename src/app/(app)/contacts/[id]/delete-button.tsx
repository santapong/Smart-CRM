"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteContact } from "@/server/actions/contacts";

export function DeleteContactButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        if (!confirm("Delete this contact?")) return;
        setBusy(true);
        const r = await deleteContact(id);
        setBusy(false);
        if (!r.ok) return toast.error(r.error);
        toast.success("Deleted");
        router.push("/contacts");
        router.refresh();
      }}
    >
      <Trash2 className="h-4 w-4" /> Delete
    </Button>
  );
}
