import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { ContactForm } from "../contact-form";
import { DeleteContactButton } from "./delete-button";
import type { DecisionRole } from "@prisma/client";

const DECISION_ROLE_LABEL: Record<DecisionRole, string> = {
  CHAMPION: "Champion",
  ECONOMIC_BUYER: "Economic Buyer",
  USER: "User",
  INFLUENCER: "Influencer",
  BLOCKER: "Blocker",
};

export default async function ContactDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireOrg();
  const [contact, companies] = await Promise.all([
    db.contact.findFirst({
      where: { id, orgId },
      include: {
        company: true,
        deals: { include: { stage: true }, orderBy: { createdAt: "desc" } },
        activities: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    }),
    db.company.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!contact) notFound();

  return (
    <>
      <PageHeader title={`${contact.firstName} ${contact.lastName}`} description={contact.email ?? undefined}>
        <div className="flex items-center gap-2">
          {contact.isPrimary && (
            <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900 dark:bg-blue-900/40 dark:text-blue-100">
              Primary
            </span>
          )}
          {contact.decisionRole && (
            <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              {DECISION_ROLE_LABEL[contact.decisionRole]}
            </span>
          )}
          <DeleteContactButton id={contact.id} />
        </div>
      </PageHeader>
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <div className="rounded-lg border bg-card p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Details</h2>
            <ContactForm
              companies={companies}
              initial={{
                id: contact.id,
                firstName: contact.firstName,
                lastName: contact.lastName,
                email: contact.email,
                phone: contact.phone,
                title: contact.title,
                companyId: contact.companyId,
                notes: contact.notes,
                isPrimary: contact.isPrimary,
                decisionRole: contact.decisionRole,
              }}
            />
          </div>
        </section>
        <aside className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Deals</h3>
            {contact.deals.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="space-y-2">
                {contact.deals.map((d) => (
                  <li key={d.id}>
                    <Link href={`/deals/${d.id}`} className="text-sm hover:underline">
                      {d.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">{d.stage.name}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent activity</h3>
            {contact.activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {contact.activities.map((a) => (
                  <li key={a.id} className="flex items-center justify-between">
                    <span className={a.completedAt ? "text-muted-foreground line-through" : ""}>{a.title}</span>
                    <span className="text-xs text-muted-foreground">{a.type}</span>
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
