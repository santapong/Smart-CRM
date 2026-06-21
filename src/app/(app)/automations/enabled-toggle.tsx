"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setWorkflowEnabled } from "@/server/actions/workflows";

export function EnabledToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    startTransition(async () => {
      const r = await setWorkflowEnabled(id, next);
      if (!r.ok) {
        setOn(!next);
        toast.error(r.error);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={pending}
      onClick={toggle}
      className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        on ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
          on ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
