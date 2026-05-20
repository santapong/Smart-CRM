import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SlaPill } from "@/components/sla-badge";
import { Plus } from "lucide-react";
import { computeSla } from "@/lib/sla";
import type { AccountTier } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function TicketsPage() {
  const { orgId } = await requireOrg();
  const [tickets, slaPolicies] = await Promise.all([
    db.ticket.findMany({
      where: { orgId },
      include: {
        company: { select: { id: true, name: true, tier: true } },
        assignee: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    db.slaPolicy.findMany({ where: { orgId } }),
  ]);

  const policyByTier = new Map<AccountTier, (typeof slaPolicies)[number]>();
  for (const p of slaPolicies) policyByTier.set(p.tier, p);

  return (
    <>
      <PageHeader title="Tickets" description="Customer support tickets and SLA tracking.">
        <Button asChild>
          <Link href="/tickets/new">
            <Plus className="h-4 w-4" /> New ticket
          </Link>
        </Button>
      </PageHeader>
      <div className="p-6">
        {tickets.length === 0 ? (
          <EmptyState
            title="No tickets yet"
            description="Create your first ticket to start tracking SLA against tiered accounts."
            action={
              <Button asChild>
                <Link href="/tickets/new">New ticket</Link>
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Assignee</TableHead>
                  <TableHead>First response</TableHead>
                  <TableHead>Resolution</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((t) => {
                  const policy = policyByTier.get(t.company.tier) ?? null;
                  const sla = computeSla(t, policy);
                  return (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Link href={`/tickets/${t.id}`} className="font-medium hover:underline">
                          {t.subject}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link href={`/companies/${t.company.id}`} className="hover:underline">
                          {t.company.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{t.status}</TableCell>
                      <TableCell className="text-muted-foreground">{t.priority}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {t.assignee ? t.assignee.name ?? t.assignee.email : "—"}
                      </TableCell>
                      <TableCell>
                        <SlaPill
                          kind="first-response"
                          state={sla.firstResponse.state}
                          dueAt={sla.firstResponse.dueAt}
                        />
                      </TableCell>
                      <TableCell>
                        <SlaPill
                          kind="resolution"
                          state={sla.resolution.state}
                          dueAt={sla.resolution.dueAt}
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDistanceToNowStrict(t.createdAt, { addSuffix: true })}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
}
