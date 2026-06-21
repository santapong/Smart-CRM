"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  listMyNotifications,
  markNotificationRead,
  markAllRead,
} from "@/server/actions/notifications";

type Item = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
};

const PATH: Record<string, string> = {
  contact: "contacts",
  company: "companies",
  deal: "deals",
  lead: "leads",
};

export function NotificationBell({
  initialItems,
  initialUnread,
}: {
  initialItems: Item[];
  initialUnread: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>(initialItems);
  const [unread, setUnread] = useState(initialUnread);
  const [open, setOpen] = useState(false);

  async function refresh() {
    const res = await listMyNotifications(20);
    setItems(res.items as Item[]);
    setUnread(res.unread);
  }

  async function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) await refresh();
  }

  async function onItemClick(n: Item) {
    if (!n.readAt) {
      await markNotificationRead(n.id);
      setUnread((u) => Math.max(0, u - 1));
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date() } : x)));
    }
    if (n.entityType && n.entityId && PATH[n.entityType]) {
      setOpen(false);
      router.push(`/${PATH[n.entityType]}/${n.entityId}`);
    }
  }

  async function onMarkAll() {
    await markAllRead();
    setUnread(0);
    setItems((prev) => prev.map((x) => ({ ...x, readAt: x.readAt ?? new Date() })));
    router.refresh();
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
          {unread > 0 && (
            <button
              onClick={onMarkAll}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Mark all read
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">You&apos;re all caught up.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => onItemClick(n)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent",
                  !n.readAt && "bg-accent/40"
                )}
              >
                <span className="flex w-full items-center gap-2 font-medium">
                  {!n.readAt && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                  <span className="truncate">{n.title}</span>
                </span>
                {n.body && <span className="line-clamp-2 text-xs text-muted-foreground">{n.body}</span>}
              </button>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
