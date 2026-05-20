import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { SlaBadge } from "@/components/sla-badge";
import { TierBadge } from "@/components/tier-badge";
import { TicketForm } from "../ticket-form";
import { MarkFirstResponseButton } from "./mark-first-response-button";
import { computeSla } from "@/lib/sla";

export const dynamic = "force-dynamic";

export default async function TicketDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireOrg();
  const ticket = await db.ticket.findFirst({
    where: { id, orgId },
    include: {
      company: { select: { id: true, name: true, tier: true } },
      contact: { select: { id: true, firstName: true, lastName: true } },
      assignee: { select: { id: true, name: true, email: true } },
    },
  });
  if (!ticket) notFound();

  const [companies, contacts, memberships, policy] = await Promise.all([
    db.company.findMany({
      where: { orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.contact.findMany({
      where: { orgId },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, firstName: true, lastName: true, companyId: true },
    }),
    db.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.slaPolicy.findFirst({ where: { orgId, tier: ticket.company.tier } }),
  ]);

  const sla = computeSla(ticket, policy);

  return (
    <>
      <PageHeader
        title={ticket.subject}
        description={`${ticket.status} · ${ticket.priority}`}
      >
        <MarkFirstResponseButton
          ticketId={ticket.id}
          alreadyResponded={ticket.firstResponseAt != null}
        />
      </PageHeader>
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="space-y-6 lg:col-span-2">
          <div className="rounded-lg border bg-card p-6">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <SlaBadge breakdown={sla} />
            </div>
            {ticket.body ? (
              <p className="whitespace-pre-wrap text-sm">{ticket.body}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No description.</p>
            )}
            <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">Created</dt>
                <dd>{format(ticket.createdAt, "PPpp")}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">First response</dt>
                <dd>
                  {ticket.firstResponseAt ? format(ticket.firstResponseAt, "PPpp") : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">Resolved</dt>
                <dd>{ticket.resolvedAt ? format(ticket.resolvedAt, "PPpp") : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">Assignee</dt>
                <dd>{ticket.assignee ? ticket.assignee.name ?? ticket.assignee.email : "Unassigned"}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border bg-card p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Edit</h2>
            <TicketForm
              companies={companies}
              contacts={contacts.map((c) => ({
                id: c.id,
                name: `${c.firstName} ${c.lastName}`,
                companyId: c.companyId,
              }))}
              assignees={memberships.map((m) => ({
                id: m.user.id,
                name: m.user.name,
                email: m.user.email,
              }))}
              initial={{
                id: ticket.id,
                companyId: ticket.companyId,
                contactId: ticket.contactId,
                assigneeId: ticket.assigneeId,
                subject: ticket.subject,
                body: ticket.body,
                status: ticket.status,
                priority: ticket.priority,
              }}
            />
          </div>
        </section>
        <aside className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Account</h3>
            <div className="flex items-center justify-between">
              <Link href={`/companies/${ticket.company.id}`} className="text-sm font-medium hover:underline">
                {ticket.company.name}
              </Link>
              <TierBadge tier={ticket.company.tier} />
            </div>
          </div>
          {ticket.contact && (
            <div className="rounded-lg border bg-card p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contact</h3>
              <Link
                href={`/contacts/${ticket.contact.id}`}
                className="text-sm font-medium hover:underline"
              >
                {ticket.contact.firstName} {ticket.contact.lastName}
              </Link>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
