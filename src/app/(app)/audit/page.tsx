import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * Org-wide audit viewer (M19a) — ADMIN-gated, org-scoped, paginated. A minimal
 * read-only log of who did what; per-record history lives on each detail page's
 * Timeline. Keeps it simple: newest-first, page-by-page.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  const [logs, total, memberships] = await Promise.all([
    db.auditLog.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      skip,
      take: PAGE_SIZE,
    }),
    db.auditLog.count({ where: { orgId } }),
    db.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
  ]);

  const nameById = new Map(memberships.map((m) => [m.user.id, m.user.name ?? m.user.email ?? "Unknown"]));
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader title="Audit log" description="A record of changes across your organization." />
      <div className="p-6">
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No audit entries yet.</p>
        ) : (
          <>
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Summary</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(l.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm">
                        {l.actorId ? (nameById.get(l.actorId) ?? "Unknown") : "System"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{l.action}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {l.entityType}:{l.entityId.slice(0, 8)}
                      </TableCell>
                      <TableCell className="text-sm">{l.summary ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Page {page} of {totalPages} · {total} entr{total === 1 ? "y" : "ies"}
              </p>
              <div className="flex gap-2">
                {page <= 1 ? (
                  <Button variant="outline" size="sm" disabled>
                    Previous
                  </Button>
                ) : (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/audit?page=${page - 1}`}>Previous</Link>
                  </Button>
                )}
                {page >= totalPages ? (
                  <Button variant="outline" size="sm" disabled>
                    Next
                  </Button>
                ) : (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/audit?page=${page + 1}`}>Next</Link>
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
