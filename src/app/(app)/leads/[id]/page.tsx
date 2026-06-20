import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { Comments } from "@/components/comments";
import { loadCommentsData } from "@/lib/comments-data";
import { EnrollInSequence } from "@/components/sequences/enroll-in-sequence";
import { LeadForm } from "../lead-form";
import { LabelPicker } from "./label-picker";
import { ConvertButton } from "./convert-button";

export default async function LeadDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId, userId, role } = await requireOrg();
  const [lead, contacts, companies, allLabels, commentsData, sequences] = await Promise.all([
    db.lead.findFirst({
      where: { id, orgId },
      include: { labels: { include: { label: true } } },
    }),
    db.contact.findMany({
      where: { orgId },
      orderBy: { lastName: "asc" },
      select: { id: true, firstName: true, lastName: true },
    }),
    db.company.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.leadLabel.findMany({ where: { orgId }, orderBy: { name: "asc" } }),
    loadCommentsData(orgId, userId, role, "lead", id),
    db.sequence.findMany({ where: { orgId, enabled: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!lead) notFound();

  return (
    <>
      <PageHeader
        title={lead.title}
        description={`${lead.status}${lead.source ? ` · ${lead.source}` : ""} · Score ${lead.score}`}
      >
        <ConvertButton id={lead.id} converted={lead.status === "CONVERTED" || !!lead.convertedDealId} />
      </PageHeader>
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2 rounded-lg border bg-card p-6">
          <LeadForm
            contacts={contacts.map((c) => ({ id: c.id, label: `${c.firstName} ${c.lastName}` }))}
            companies={companies.map((c) => ({ id: c.id, label: c.name }))}
            initial={{
              id: lead.id,
              title: lead.title,
              value: lead.value != null ? Number(lead.value) : null,
              currency: lead.currency,
              status: lead.status,
              contactId: lead.contactId,
              companyId: lead.companyId,
              source: lead.source,
              sourceChannel: lead.sourceChannel,
              notes: lead.notes,
            }}
          />
          <div className="mt-6 border-t pt-6">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Comments</h3>
            <Comments
              entityType="lead"
              entityId={lead.id}
              members={commentsData.members}
              initialComments={commentsData.comments}
            />
          </div>
        </section>
        <aside className="space-y-4">
          {lead.convertedDealId && (
            <div className="rounded-lg border bg-card p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Converted deal
              </h3>
              <Link href={`/deals/${lead.convertedDealId}`} className="text-sm hover:underline">
                View deal →
              </Link>
            </div>
          )}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Labels</h3>
            <LabelPicker
              leadId={lead.id}
              allLabels={allLabels.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
              assignedIds={lead.labels.map((ll) => ll.labelId)}
            />
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sequences</h3>
            <EnrollInSequence
              sequences={sequences}
              leadId={lead.id}
              disabled={!lead.contactId}
              hint={lead.contactId ? undefined : "Link a contact with an email to enroll."}
            />
          </div>
          {lead.notes && (
            <div className="rounded-lg border bg-card p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes</h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{lead.notes}</p>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
