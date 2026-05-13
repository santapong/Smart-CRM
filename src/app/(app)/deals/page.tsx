import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { KanbanBoard } from "./kanban";

export const dynamic = "force-dynamic";

export default async function DealsPage() {
  const { orgId } = await requireOrg();
  const [stages, deals] = await Promise.all([
    db.pipelineStage.findMany({ where: { orgId }, orderBy: { order: "asc" } }),
    db.deal.findMany({
      where: { orgId, status: "OPEN" },
      include: { contact: true, company: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <>
      <PageHeader title="Deals" description="Drag to move between stages.">
        <Button asChild>
          <Link href="/deals/new">
            <Plus className="h-4 w-4" /> New deal
          </Link>
        </Button>
      </PageHeader>
      <div className="p-6">
        {stages.length === 0 ? (
          <EmptyState title="No pipeline stages" description="Stages are created automatically when you sign up." />
        ) : (
          <KanbanBoard
            stages={stages.map((s) => ({ id: s.id, name: s.name, color: s.color }))}
            deals={deals.map((d) => ({
              id: d.id,
              title: d.title,
              value: Number(d.value),
              currency: d.currency,
              stageId: d.stageId,
              contact: d.contact ? { id: d.contact.id, name: `${d.contact.firstName} ${d.contact.lastName}` } : null,
              company: d.company ? { id: d.company.id, name: d.company.name } : null,
            }))}
          />
        )}
      </div>
    </>
  );
}
