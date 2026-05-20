import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDistanceToNowStrict } from "date-fns";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { TierBadge } from "@/components/tier-badge";
import { Button } from "@/components/ui/button";
import { CompanyForm } from "../company-form";
import { AccountTeamPanel } from "./account-team-panel";
import { CustomFieldsPanel } from "./custom-fields-panel";

export const dynamic = "force-dynamic";

export default async function CompanyDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireOrg();
  const company = await db.company.findFirst({
    where: { id, orgId },
    include: {
      contacts: { orderBy: { lastName: "asc" } },
      deals: { include: { stage: true } },
      parent: { select: { id: true, name: true } },
      children: { select: { id: true, name: true, tier: true }, orderBy: { name: "asc" } },
      team: {
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      },
      tickets: {
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { assignee: { select: { id: true, name: true, email: true } } },
      },
      customFieldValues: true,
    },
  });
  if (!company) notFound();

  const [companies, memberships, customFieldDefs] = await Promise.all([
    db.company.findMany({
      where: { orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.customFieldDefinition.findMany({
      where: { orgId, entity: "COMPANY" },
      orderBy: [{ order: "asc" }, { label: "asc" }],
    }),
  ]);

  // The schema permits one user to hold multiple roles on the same account
  // (the unique key is (companyId, userId, role)). Surface every org member
  // here; the server action rejects duplicate (user, role) pairs.
  const availableUsers = memberships.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
  }));

  const arr = company.arr ? Number(company.arr) : null;
  const arrLabel = arr != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(arr) : null;

  return (
    <>
      <PageHeader
        title={company.name}
        description={
          [
            company.domain,
            arrLabel ? `ARR ${arrLabel}` : null,
            company.parent ? `Subsidiary of ${company.parent.name}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        }
      >
        <TierBadge tier={company.tier} />
      </PageHeader>
      {company.parent && (
        <div className="border-b bg-card/30 px-6 py-2 text-xs text-muted-foreground">
          Parent:{" "}
          <Link href={`/companies/${company.parent.id}`} className="hover:underline">
            {company.parent.name}
          </Link>
        </div>
      )}
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="space-y-6 lg:col-span-2">
          <div className="rounded-lg border bg-card p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Details</h2>
            <CompanyForm
              companies={companies}
              initial={{
                id: company.id,
                name: company.name,
                domain: company.domain,
                industry: company.industry,
                size: company.size,
                notes: company.notes,
                tier: company.tier,
                parentCompanyId: company.parentCompanyId,
                arr,
              }}
            />
          </div>

          <div className="rounded-lg border bg-card p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Account team</h2>
            <AccountTeamPanel
              companyId={company.id}
              members={company.team.map((t) => ({ id: t.id, role: t.role, user: t.user }))}
              availableUsers={availableUsers}
            />
          </div>

          <div className="rounded-lg border bg-card p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Tickets</h2>
              <Button asChild size="sm" variant="outline">
                <Link href="/tickets/new">New ticket</Link>
              </Button>
            </div>
            {company.tickets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tickets for this account yet.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {company.tickets.map((t) => (
                  <li key={t.id} className="flex items-center justify-between p-3 text-sm">
                    <div>
                      <Link href={`/tickets/${t.id}`} className="font-medium hover:underline">
                        {t.subject}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {t.status} · {t.priority}
                        {t.assignee ? ` · ${t.assignee.name ?? t.assignee.email}` : ""}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNowStrict(t.createdAt, { addSuffix: true })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border bg-card p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Custom fields</h2>
            <CustomFieldsPanel
              entityKind="COMPANY"
              entityId={company.id}
              definitions={customFieldDefs}
              values={company.customFieldValues}
            />
          </div>
        </section>
        <aside className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Child accounts</h3>
            {company.children.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {company.children.map((c) => (
                  <li key={c.id} className="flex items-center justify-between">
                    <Link href={`/companies/${c.id}`} className="hover:underline">
                      {c.name}
                    </Link>
                    <TierBadge tier={c.tier} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contacts</h3>
            {company.contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {company.contacts.map((c) => (
                  <li key={c.id}>
                    <Link href={`/contacts/${c.id}`} className="hover:underline">
                      {c.firstName} {c.lastName}
                    </Link>
                    {c.isPrimary && (
                      <span className="ml-2 text-xs text-muted-foreground">(primary)</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Deals</h3>
            {company.deals.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {company.deals.map((d) => (
                  <li key={d.id}>
                    <Link href={`/deals/${d.id}`} className="hover:underline">
                      {d.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {d.stage.name} · {d.status}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
