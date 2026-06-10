"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  KanbanSquare,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Search,
  Settings,
  Users,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { globalSearch, type SearchHit } from "@/server/actions/search";

const OPEN_EVENT = "smartcrm:open-search";

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const PAGES = [
  { href: "/dashboard", title: "Dashboard", Icon: LayoutDashboard },
  { href: "/contacts", title: "Contacts", Icon: Users },
  { href: "/companies", title: "Companies", Icon: Building2 },
  { href: "/deals", title: "Deals", Icon: KanbanSquare },
  { href: "/activities", title: "Activities", Icon: ListChecks },
  { href: "/settings", title: "Settings", Icon: Settings },
];

const TYPE_META = {
  contact: { label: "Contacts", Icon: Users },
  company: { label: "Companies", Icon: Building2 },
  deal: { label: "Deals", Icon: KanbanSquare },
} as const;

type Item = { href: string; title: string; subtitle?: string | null; type?: SearchHit["type"] };

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState(0);
  const seq = React.useRef(0);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
      setSelected(0);
      setLoading(false);
    }
  }, [open]);

  React.useEffect(() => {
    const q = query.trim();
    setSelected(0);
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const mySeq = ++seq.current;
    const t = setTimeout(async () => {
      const res = await globalSearch(q);
      if (seq.current !== mySeq) return;
      setLoading(false);
      setHits(res.ok ? res.data.hits : []);
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const showingPages = query.trim() === "";
  const items: Item[] = showingPages ? PAGES.map((p) => ({ href: p.href, title: p.title })) : hits;

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[selected];
      if (item) go(item.href);
    }
  }

  // Group hits by type for section headers, preserving flat index for selection.
  let flatIndex = -1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[15%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          {loading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search contacts, companies, deals…"
            className="h-12 w-full bg-transparent pr-8 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {showingPages ? (
            <>
              <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Go to
              </p>
              {PAGES.map((p, i) => (
                <Row
                  key={p.href}
                  Icon={p.Icon}
                  title={p.title}
                  active={i === selected}
                  onHover={() => setSelected(i)}
                  onClick={() => go(p.href)}
                />
              ))}
            </>
          ) : items.length === 0 && !loading ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No results.</p>
          ) : (
            (["contact", "company", "deal"] as const).map((type) => {
              const group = hits.filter((h) => h.type === type);
              if (group.length === 0) return null;
              const { label, Icon } = TYPE_META[type];
              return (
                <div key={type}>
                  <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {label}
                  </p>
                  {group.map((h) => {
                    flatIndex++;
                    const i = flatIndex;
                    return (
                      <Row
                        key={h.id}
                        Icon={Icon}
                        title={h.title}
                        subtitle={h.subtitle}
                        active={i === selected}
                        onHover={() => setSelected(i)}
                        onClick={() => go(h.href)}
                      />
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  Icon,
  title,
  subtitle,
  active,
  onHover,
  onClick,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string | null;
  active: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm",
        active ? "bg-accent text-accent-foreground" : "text-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium">{title}</span>
      {subtitle && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
    </button>
  );
}
