"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { toggleActivityComplete } from "@/server/actions/activities";

/** Inline complete toggle for an activity, reused on the calendar agenda. */
export function CompleteToggle({ id, completed }: { id: string; completed: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      aria-label={completed ? "Mark incomplete" : "Mark complete"}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await toggleActivityComplete(id);
          if (!r.ok) toast.error(r.error);
          router.refresh();
        })
      }
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
        completed ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent"
      }`}
    >
      {completed && <Check className="h-3 w-3" />}
    </button>
  );
}
