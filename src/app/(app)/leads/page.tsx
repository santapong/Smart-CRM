import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { TagBadge } from "@/components/tag-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";

export const dynamic = "force-dynamic";

const STATUSES = ["NEW", "WORKING", "QUALIFIED", "UNQUALIFIED", "CONVERTED"] as const;

function isStatus(v: string): v is (typeof STATUSES)[number] {
  return (STATUSES as readonly string[]).includes(v);
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; sort?: string }>;
}) {
  const { orgId } = await requireOrg();
  const { status: statusParam, sort } = await searchParams;
  const status = statusParam && isStatus(statusParam) ? statusParam : "";
  const sortByScore = sort === "score";

  const leads = await db.lead.findMany({
    where: { orgId, ...(status ? { status } : {}) },
    include: { labels: { include: { label: true } } },
    orderBy: sortByScore ? [{ score: "desc" }, { createdAt: "desc" }] : { createdAt: "desc" },
    take: 200,
  });

  const params = (over: { status?: string; sort?: string }) => {
    const next = new URLSearchParams();
    const s = over.status ?? status;
    const so = over.sort ?? (sortByScore ? "score" : "");
    if (s) next.set("status", s);
    if (so) next.set("sort", so);
    const qs = next.toString();
    return qs ? `/leads?${qs}` : "/leads";
  };
  const filterHref = (s: string) => params({ status: s });

  return (
    <>
      <PageHeader title="Leads" description="Inbound prospects waiting to be qualified.">
        <Button asChild>
          <Link href="/leads/new">
            <Plus className="h-4 w-4" /> New lead
          </Link>
        </Button>
      </PageHeader>
      <div className="p-6">
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <Link
            href={filterHref("")}
            className={cn(
              "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
              status === "" ? "" : "text-muted-foreground opacity-60 hover:opacity-100",
            )}
          >
            All
          </Link>
          {STATUSES.map((s) => (
            <Link
              key={s}
              href={filterHref(s)}
              className={cn(
                "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                s === status ? "" : "text-muted-foreground opacity-60 hover:opacity-100",
              )}
            >
              {s}
            </Link>
          ))}
        </div>

        {leads.length === 0 ? (
          <EmptyState
            title={status ? "No matching leads" : "No leads yet"}
            description={
              status
                ? "Try a different status filter."
                : "Capture leads via a web form or add one manually."
            }
            action={
              <Button asChild>
                <Link href="/leads/new">New lead</Link>
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <Link href={params({ sort: sortByScore ? "" : "score" })} className="inline-flex items-center gap-1 hover:underline">
                      Score {sortByScore ? "↓" : ""}
                    </Link>
                  </TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Labels</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <Link href={`/leads/${l.id}`} className="font-medium hover:underline">
                        {l.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{l.status}</TableCell>
                    <TableCell className="tabular-nums font-medium">{l.score}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {l.value != null ? `${l.currency} ${Number(l.value).toLocaleString()}` : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{l.source ?? "—"}</TableCell>
                    <TableCell>
                      {l.labels.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {l.labels.map((ll) => (
                            <TagBadge key={ll.labelId} name={ll.label.name} color={ll.label.color} />
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
}
