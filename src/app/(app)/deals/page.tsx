import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { KanbanBoard } from "./kanban";
import { PipelineSelector } from "./pipeline-selector";

export const dynamic = "force-dynamic";

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string }>;
}) {
  const { orgId } = await requireOrg();
  const { pipeline: pipelineParam } = await searchParams;

  const pipelines = await db.pipeline.findMany({
    where: { orgId },
    orderBy: [{ isDefault: "desc" }, { order: "asc" }, { createdAt: "asc" }],
  });

  if (pipelines.length === 0) {
    return (
      <>
        <PageHeader title="Deals" description="Drag to move between stages." />
        <div className="p-6">
          <EmptyState
            title="No pipelines yet"
            description="A default pipeline with stages is created automatically when you sign up."
          />
        </div>
      </>
    );
  }

  // Resolve the selected pipeline, falling back to the default/first one.
  const selected =
    pipelines.find((p) => p.id === pipelineParam) ?? pipelines[0];

  const [stages, deals] = await Promise.all([
    db.pipelineStage.findMany({
      where: { orgId, pipelineId: selected.id },
      orderBy: { order: "asc" },
    }),
    db.deal.findMany({
      where: { orgId, pipelineId: selected.id, status: "OPEN" },
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
      <div className="space-y-4 p-6">
        <PipelineSelector
          pipelines={pipelines.map((p) => ({ id: p.id, name: p.name }))}
          selectedId={selected.id}
        />
        {stages.length === 0 ? (
          <EmptyState
            title="No stages in this pipeline"
            description="Add stages to this pipeline in Settings to start tracking deals."
          />
        ) : (
          <KanbanBoard
            stages={stages.map((s) => ({
              id: s.id,
              name: s.name,
              color: s.color,
              rottenDays: s.rottenDays,
              probability: s.probability,
            }))}
            deals={deals.map((d) => ({
              id: d.id,
              title: d.title,
              value: Number(d.value),
              currency: d.currency,
              stageId: d.stageId,
              status: d.status,
              probability: d.probability,
              updatedAt: d.updatedAt.toISOString(),
              contact: d.contact ? { id: d.contact.id, name: `${d.contact.firstName} ${d.contact.lastName}` } : null,
              company: d.company ? { id: d.company.id, name: d.company.name } : null,
            }))}
          />
        )}
      </div>
    </>
  );
}
