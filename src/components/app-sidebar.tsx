"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, Building2, KanbanSquare, ListChecks, Settings, LogOut, Search, Inbox, FileInput, Workflow, BarChart3, CalendarDays, Package, Send, Upload, Sparkles, Plug, FileText, History } from "lucide-react";
import { signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import { openCommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";

const NAV = [
  { href: "/dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/contacts", label: "Contacts", Icon: Users },
  { href: "/companies", label: "Companies", Icon: Building2 },
  { href: "/leads", label: "Leads", Icon: Inbox },
  { href: "/deals", label: "Deals", Icon: KanbanSquare },
  { href: "/products", label: "Products", Icon: Package },
  { href: "/documents", label: "Documents", Icon: FileText },
  { href: "/activities", label: "Activities", Icon: ListChecks },
  { href: "/calendar", label: "Calendar", Icon: CalendarDays },
  { href: "/reports", label: "Reports", Icon: BarChart3 },
  { href: "/assistant", label: "Assistant", Icon: Sparkles },
  { href: "/forms", label: "Forms", Icon: FileInput },
  { href: "/sequences", label: "Sequences", Icon: Send },
  { href: "/automations", label: "Automations", Icon: Workflow },
  { href: "/import", label: "Import", Icon: Upload },
  { href: "/settings/integrations", label: "Integrations", Icon: Plug },
  { href: "/audit", label: "Audit log", Icon: History },
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
      <div className="p-2 pb-0">
        <button
          onClick={openCommandPalette}
          className="flex w-full items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Search className="h-4 w-4" />
          Search…
          <kbd className="ml-auto rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
        </button>
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
        <ThemeToggle />
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
