"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useDroppable, useDraggable } from "@dnd-kit/core";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { moveDealToStage } from "@/server/actions/deals";

type Stage = { id: string; name: string; color: string };
type Deal = {
  id: string;
  title: string;
  value: number;
  currency: string;
  stageId: string;
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
};

export function KanbanBoard({ stages, deals: initialDeals }: { stages: Stage[]; deals: Deal[] }) {
  const router = useRouter();
  const [deals, setDeals] = useState<Deal[]>(initialDeals);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor));

  const byStage = useMemo(() => {
    const m: Record<string, Deal[]> = {};
    stages.forEach((s) => (m[s.id] = []));
    deals.forEach((d) => {
      if (m[d.stageId]) m[d.stageId].push(d);
    });
    return m;
  }, [deals, stages]);

  const totals = useMemo(
    () =>
      Object.fromEntries(
        stages.map((s) => [s.id, (byStage[s.id] ?? []).reduce((sum, d) => sum + d.value, 0)])
      ) as Record<string, number>,
    [byStage, stages]
  );

  const active = activeId ? deals.find((d) => d.id === activeId) ?? null : null;

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }
  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const dealId = String(e.active.id);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    const targetStageId = overId.startsWith("stage:") ? overId.slice(6) : deals.find((d) => d.id === overId)?.stageId;
    if (!targetStageId) return;
    const current = deals.find((d) => d.id === dealId);
    if (!current || current.stageId === targetStageId) return;

    setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, stageId: targetStageId } : d)));
    startTransition(async () => {
      const r = await moveDealToStage(dealId, targetStageId);
      if (!r.ok) {
        toast.error(r.error);
        setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, stageId: current.stageId } : d)));
      }
      router.refresh();
    });
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((s) => (
          <StageColumn
            key={s.id}
            stage={s}
            total={totals[s.id] ?? 0}
            currency={(byStage[s.id]?.[0]?.currency) ?? "USD"}
            count={byStage[s.id]?.length ?? 0}
          >
            {byStage[s.id]?.map((d) => <DealCard key={d.id} deal={d} />) ?? null}
          </StageColumn>
        ))}
      </div>
      <DragOverlay>{active ? <DealCard deal={active} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}

function StageColumn({
  stage,
  total,
  currency,
  count,
  children,
}: {
  stage: Stage;
  total: number;
  currency: string;
  count: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage:${stage.id}` });
  return (
    <div
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-lg border bg-card ${isOver ? "ring-2 ring-primary" : ""}`}
    >
      <div className="flex items-center justify-between border-b p-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
          <p className="text-sm font-semibold">{stage.name}</p>
          <span className="text-xs text-muted-foreground">({count})</span>
        </div>
        <p className="text-xs text-muted-foreground">{formatCurrency(total, currency)}</p>
      </div>
      <div className="flex min-h-[120px] flex-col gap-2 p-2">{children}</div>
    </div>
  );
}

function DealCard({ deal, dragging }: { deal: Deal; dragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: deal.id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={style}
      className={`select-none rounded-md border bg-background p-3 shadow-sm hover:shadow ${
        isDragging || dragging ? "opacity-80" : ""
      }`}
    >
      <Link href={`/deals/${deal.id}`} className="block text-sm font-medium hover:underline" onMouseDown={(e) => e.stopPropagation()}>
        {deal.title}
      </Link>
      <p className="mt-1 text-xs text-muted-foreground">
        {formatCurrency(deal.value, deal.currency)}
        {deal.company && <> · {deal.company.name}</>}
      </p>
      {deal.contact && <p className="text-xs text-muted-foreground">{deal.contact.name}</p>}
    </div>
  );
}
