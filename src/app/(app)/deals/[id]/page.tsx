import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { DealForm } from "../deal-form";
import { DealStatusActions } from "./status-actions";

export default async function DealDetail({ params }: { params: { id: string } }) {
  const { orgId } = await requireOrg();
  const [deal, stages, contacts, companies] = await Promise.all([
    db.deal.findFirst({
      where: { id: params.id, orgId },
      include: { activities: { orderBy: { createdAt: "desc" }, take: 20 }, contact: true, company: true, stage: true },
    }),
    db.pipelineStage.findMany({ where: { orgId }, orderBy: { order: "asc" } }),
    db.contact.findMany({ where: { orgId }, orderBy: { lastName: "asc" }, select: { id: true, firstName: true, lastName: true } }),
    db.company.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!deal) notFound();

  return (
    <>
      <PageHeader title={deal.title} description={`${deal.stage.name} · ${deal.status}`}>
        <DealStatusActions id={deal.id} status={deal.status} />
      </PageHeader>
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2 rounded-lg border bg-card p-6">
          <DealForm
            stages={stages}
            contacts={contacts.map((c) => ({ id: c.id, label: `${c.firstName} ${c.lastName}` }))}
            companies={companies.map((c) => ({ id: c.id, label: c.name }))}
            initial={{
              id: deal.id,
              title: deal.title,
              value: Number(deal.value),
              currency: deal.currency,
              stageId: deal.stageId,
              status: deal.status,
              contactId: deal.contactId,
              companyId: deal.companyId,
              closeDate: deal.closeDate,
              notes: deal.notes,
            }}
          />
        </section>
        <aside>
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Activity</h3>
            {deal.activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {deal.activities.map((a) => (
                  <li key={a.id}>
                    <span className={a.completedAt ? "text-muted-foreground line-through" : ""}>{a.title}</span>
                    <p className="text-xs text-muted-foreground">{a.type}</p>
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
