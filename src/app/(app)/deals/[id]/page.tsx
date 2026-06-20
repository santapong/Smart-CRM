import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { getDefinitions, toFieldViews } from "@/lib/custom-fields";
import { PageHeader } from "@/components/page-header";
import { SendEmailDialog } from "@/components/email/send-email-dialog";
import { EmailList } from "@/components/email/email-list";
import { DealForm } from "../deal-form";
import { DealStatusActions } from "./status-actions";

export default async function DealDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireOrg();
  const [deal, stages, contacts, companies, defs, emails] = await Promise.all([
    db.deal.findFirst({
      where: { id, orgId },
      include: { activities: { orderBy: { createdAt: "desc" }, take: 20 }, contact: true, company: true, stage: true },
    }),
    db.pipelineStage.findMany({ where: { orgId }, orderBy: { order: "asc" } }),
    db.contact.findMany({ where: { orgId }, orderBy: { lastName: "asc" }, select: { id: true, firstName: true, lastName: true } }),
    db.company.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    getDefinitions(orgId, "deal"),
    db.emailMessage.findMany({ where: { orgId, dealId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
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
            customFieldDefs={toFieldViews(defs)}
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
              customFields: deal.customFields as Record<string, unknown> | null,
            }}
          />
        </section>
        <aside className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Emails</h3>
              <SendEmailDialog dealId={deal.id} disabled={!deal.contact?.email} />
            </div>
            <EmailList
              emails={emails}
              hint={deal.contact?.email ? undefined : "Link a contact with an email to send messages."}
            />
          </div>
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
