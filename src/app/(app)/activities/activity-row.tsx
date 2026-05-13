"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import { Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { deleteActivity, toggleActivityComplete } from "@/server/actions/activities";

type Item = {
  id: string;
  type: "TASK" | "CALL" | "MEETING" | "NOTE";
  title: string;
  dueAt: Date | null;
  completedAt: Date | null;
  contact: { id: string; firstName: string; lastName: string } | null;
  deal: { id: string; title: string } | null;
};

export function ActivityRow({ a }: { a: Item }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const completed = !!a.completedAt;
  return (
    <li className="flex items-center gap-3 rounded-md border bg-card p-3">
      <button
        aria-label={completed ? "Mark incomplete" : "Mark complete"}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await toggleActivityComplete(a.id);
            if (!r.ok) toast.error(r.error);
            router.refresh();
          })
        }
        className={`flex h-6 w-6 items-center justify-center rounded-full border ${
          completed ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent"
        }`}
      >
        {completed && <Check className="h-3.5 w-3.5" />}
      </button>
      <div className="flex flex-1 flex-col">
        <div className="flex items-center gap-2">
          <p className={`text-sm font-medium ${completed ? "text-muted-foreground line-through" : ""}`}>{a.title}</p>
          <Badge variant="outline" className="text-[10px]">
            {a.type}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {a.dueAt && <span>Due {format(a.dueAt, "PP")}</span>}
          {a.contact && (
            <>
              {a.dueAt && " · "}
              <Link href={`/contacts/${a.contact.id}`} className="hover:underline">
                {a.contact.firstName} {a.contact.lastName}
              </Link>
            </>
          )}
          {a.deal && (
            <>
              {(a.dueAt || a.contact) && " · "}
              <Link href={`/deals/${a.deal.id}`} className="hover:underline">
                {a.deal.title}
              </Link>
            </>
          )}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        disabled={pending}
        onClick={() =>
          start(async () => {
            if (!confirm("Delete activity?")) return;
            const r = await deleteActivity(a.id);
            if (!r.ok) toast.error(r.error);
            else toast.success("Deleted");
            router.refresh();
          })
        }
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}
