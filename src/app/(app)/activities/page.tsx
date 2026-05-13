import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { ActivityRow } from "./activity-row";
import { ActivityFormInline } from "./activity-form";

export const dynamic = "force-dynamic";

export default async function ActivitiesPage() {
  const { orgId } = await requireOrg();
  const [items, contacts, deals] = await Promise.all([
    db.activity.findMany({
      where: { orgId },
      include: { contact: true, deal: true },
      orderBy: [{ completedAt: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
      take: 200,
    }),
    db.contact.findMany({ where: { orgId }, orderBy: { lastName: "asc" }, select: { id: true, firstName: true, lastName: true } }),
    db.deal.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, select: { id: true, title: true } }),
  ]);

  return (
    <>
      <PageHeader title="Activities" description="Tasks, calls, meetings, and notes." />
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          {items.length === 0 ? (
            <EmptyState title="No activities yet" description="Use the form to log your first task." />
          ) : (
            <ul className="space-y-2">
              {items.map((a) => (
                <ActivityRow key={a.id} a={a} />
              ))}
            </ul>
          )}
        </section>
        <aside>
          <div className="rounded-lg border bg-card p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Log activity</h2>
            <ActivityFormInline contacts={contacts} deals={deals} />
          </div>
        </aside>
      </div>
    </>
  );
}
