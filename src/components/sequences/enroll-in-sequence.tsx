"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { enroll } from "@/server/actions/enrollments";

type SequenceOption = { id: string; name: string };

/**
 * "Enroll in sequence" control for a contact or lead detail page (M13b). Pass
 * exactly one of `contactId` / `leadId`. Renders nothing useful when there are
 * no sequences to enroll into.
 */
export function EnrollInSequence({
  sequences,
  contactId,
  leadId,
  disabled,
  hint,
}: {
  sequences: SequenceOption[];
  contactId?: string;
  leadId?: string;
  disabled?: boolean;
  hint?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sequenceId, setSequenceId] = useState("");

  if (sequences.length === 0) {
    return <p className="text-sm text-muted-foreground">No enabled sequences yet.</p>;
  }

  function onEnroll() {
    if (!sequenceId) {
      toast.error("Pick a sequence");
      return;
    }
    start(async () => {
      const r = await enroll({ sequenceId, contactId, leadId });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Enrolled in sequence");
      setSequenceId("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <select
        value={sequenceId}
        onChange={(e) => setSequenceId(e.target.value)}
        disabled={disabled || pending}
        className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        aria-label="Sequence"
      >
        <option value="">Select a sequence…</option>
        {sequences.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <Button size="sm" className="w-full" disabled={disabled || pending} onClick={onEnroll}>
        {pending ? "Enrolling…" : "Enroll"}
      </Button>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
