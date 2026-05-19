import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { ContactForm } from "../contact-form";
import { DeleteContactButton } from "./delete-button";
import { SendMessagePanel } from "./send-message";
import { env } from "@/env";

function formatChannel(channel: string) {
  return channel.charAt(0) + channel.slice(1).toLowerCase();
}

export default async function ContactDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireOrg();
  const [contact, companies, messages] = await Promise.all([
    db.contact.findFirst({
      where: { id, orgId },
      include: {
        company: true,
        deals: { include: { stage: true }, orderBy: { createdAt: "desc" } },
        activities: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    }),
    db.company.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.messageLog.findMany({
      where: { orgId, contactId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  if (!contact) notFound();

  const channelConfigured = {
    EMAIL: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
    TELEGRAM: Boolean(env.TELEGRAM_BOT_TOKEN),
    LINE: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_CHANNEL_SECRET),
  };

  const availability = {
    EMAIL: channelConfigured.EMAIL && contact.emailOptIn && Boolean(contact.email),
    TELEGRAM: channelConfigured.TELEGRAM && contact.telegramOptIn && Boolean(contact.telegramChatId),
    LINE: channelConfigured.LINE && contact.lineOptIn && Boolean(contact.lineUserId),
  };

  const defaultChannel =
    (contact.preferredChannel && availability[contact.preferredChannel])
      ? contact.preferredChannel
      : (["EMAIL", "TELEGRAM", "LINE"] as const).find((c) => availability[c]) ?? "EMAIL";

  return (
    <>
      <PageHeader title={`${contact.firstName} ${contact.lastName}`} description={contact.email ?? undefined}>
        <DeleteContactButton id={contact.id} />
      </PageHeader>
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2 space-y-6">
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
                telegramChatId: contact.telegramChatId,
                lineUserId: contact.lineUserId,
                preferredChannel: contact.preferredChannel,
                emailOptIn: contact.emailOptIn,
                telegramOptIn: contact.telegramOptIn,
                lineOptIn: contact.lineOptIn,
              }}
            />
          </div>

          <div className="rounded-lg border bg-card p-6">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Messages
            </h2>
            <p className="mb-4 text-xs text-muted-foreground">
              Recent inbound and outbound messages with this contact.
            </p>
            {messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No messages yet.</p>
            ) : (
              <ul className="divide-y">
                {messages.map((m) => (
                  <li key={m.id} className="flex flex-col gap-1 py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">
                        {m.direction === "OUTBOUND" ? "→" : "←"} {formatChannel(m.channel)}
                        {m.subject ? ` · ${m.subject}` : ""}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {m.status}
                        {m.sentAt ? ` · ${new Date(m.sentAt).toLocaleString()}` : ""}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-muted-foreground">{m.body}</p>
                    {m.error && <p className="text-xs text-destructive">Error: {m.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <aside className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Send message</h3>
            <SendMessagePanel
              contactId={contact.id}
              availability={availability}
              defaultChannel={defaultChannel}
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
