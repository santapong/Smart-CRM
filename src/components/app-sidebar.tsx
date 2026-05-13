"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, Building2, KanbanSquare, ListChecks, Settings, LogOut } from "lucide-react";
import { signOut } from "next-auth/react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/contacts", label: "Contacts", Icon: Users },
  { href: "/companies", label: "Companies", Icon: Building2 },
  { href: "/deals", label: "Deals", Icon: KanbanSquare },
  { href: "/activities", label: "Activities", Icon: ListChecks },
  { href: "/settings", label: "Settings", Icon: Settings },
];

export function AppSidebar({ orgName, userEmail }: { orgName: string; userEmail: string }) {
  const path = usePathname();
  return (
    <aside className="hidden md:flex md:w-60 md:shrink-0 md:flex-col md:border-r md:bg-card">
      <div className="border-b p-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Workspace</p>
        <p className="truncate text-sm font-semibold">{orgName}</p>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {NAV.map(({ href, label, Icon }) => {
          const active = path === href || path.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
                active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t p-3">
        <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
