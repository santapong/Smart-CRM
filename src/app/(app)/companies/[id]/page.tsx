import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { CompanyForm } from "../company-form";

export default async function CompanyDetail({ params }: { params: { id: string } }) {
  const { orgId } = await requireOrg();
  const company = await db.company.findFirst({
    where: { id: params.id, orgId },
    include: { contacts: { orderBy: { lastName: "asc" } }, deals: { include: { stage: true } } },
  });
  if (!company) notFound();

  return (
    <>
      <PageHeader title={company.name} description={company.domain ?? undefined} />
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <div className="rounded-lg border bg-card p-6">
            <CompanyForm
              initial={{
                id: company.id,
                name: company.name,
                domain: company.domain,
                industry: company.industry,
                size: company.size,
                notes: company.notes,
              }}
            />
          </div>
        </section>
        <aside className="space-y-4">
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
