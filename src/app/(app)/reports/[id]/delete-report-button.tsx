"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { deleteReport } from "@/server/actions/reports";

/** Deletes a saved report (ADMIN-only on the server) and returns to /reports. */
export function DeleteReportButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm("Delete this report?")) return;
    setBusy(true);
    const r = await deleteReport(id);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Report deleted");
    router.push("/reports");
    router.refresh();
  }

  return (
    <Button variant="outline" size="sm" onClick={onDelete} disabled={busy}>
      <Trash2 className="h-4 w-4" /> Delete
    </Button>
  );
}
