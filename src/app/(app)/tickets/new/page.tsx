import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { TicketForm } from "../ticket-form";

export const dynamic = "force-dynamic";

export default async function NewTicketPage() {
  const { orgId } = await requireOrg();
  const [companies, contacts, memberships] = await Promise.all([
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
  ]);

  if (companies.length === 0) {
    return (
      <>
        <PageHeader title="New ticket" />
        <div className="p-6">
          <EmptyState
            title="No accounts yet"
            description="Create an account first — tickets are always attached to one."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New ticket" />
      <div className="p-6">
        <div className="max-w-2xl rounded-lg border bg-card p-6">
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
          />
        </div>
      </div>
    </>
  );
}
