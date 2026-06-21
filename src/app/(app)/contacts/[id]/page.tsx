import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { getDefinitions, toFieldViews } from "@/lib/custom-fields";
import { PageHeader } from "@/components/page-header";
import { SendEmailDialog } from "@/components/email/send-email-dialog";
import { EmailList } from "@/components/email/email-list";
import { Comments } from "@/components/comments";
import { loadCommentsData } from "@/lib/comments-data";
import { EnrollInSequence } from "@/components/sequences/enroll-in-sequence";
import { ContactForm } from "../contact-form";
import { DeleteContactButton } from "./delete-button";
import { TagPicker } from "./tag-picker";

export default async function ContactDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId, userId, role } = await requireOrg();
  const [contact, companies, allTags, defs, emails, commentsData, sequences] = await Promise.all([
    db.contact.findFirst({
      where: { id, orgId },
      include: {
        company: true,
        deals: { include: { stage: true }, orderBy: { createdAt: "desc" } },
        activities: { orderBy: { createdAt: "desc" }, take: 10 },
        tags: { include: { tag: true } },
      },
    }),
    db.company.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.tag.findMany({ where: { orgId }, orderBy: { name: "asc" } }),
    getDefinitions(orgId, "contact"),
    db.emailMessage.findMany({ where: { orgId, contactId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
    loadCommentsData(orgId, userId, role, "contact", id),
    db.sequence.findMany({ where: { orgId, enabled: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!contact) notFound();

  return (
    <>
      <PageHeader title={`${contact.firstName} ${contact.lastName}`} description={contact.email ?? undefined}>
        <DeleteContactButton id={contact.id} />
      </PageHeader>
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <div className="rounded-lg border bg-card p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Details</h2>
            <ContactForm
              companies={companies}
              customFieldDefs={toFieldViews(defs)}
              initial={{
                id: contact.id,
                firstName: contact.firstName,
                lastName: contact.lastName,
                email: contact.email,
                phone: contact.phone,
                title: contact.title,
                companyId: contact.companyId,
                notes: contact.notes,
                customFields: contact.customFields as Record<string, unknown> | null,
              }}
            />
          </div>
          <div className="mt-6 rounded-lg border bg-card p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Comments</h2>
            <Comments
              entityType="contact"
              entityId={contact.id}
              members={commentsData.members}
              initialComments={commentsData.comments}
            />
          </div>
        </section>
        <aside className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Emails</h3>
              <SendEmailDialog contactId={contact.id} disabled={!contact.email} />
            </div>
            <EmailList emails={emails} hint={contact.email ? undefined : "Add an email address to send messages."} />
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sequences</h3>
            <EnrollInSequence
              sequences={sequences}
              contactId={contact.id}
              disabled={!contact.email}
              hint={contact.email ? undefined : "Add an email address to enroll."}
            />
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tags</h3>
            <TagPicker
              contactId={contact.id}
              allTags={allTags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
              assignedIds={contact.tags.map((ct) => ct.tagId)}
            />
          </div>
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
