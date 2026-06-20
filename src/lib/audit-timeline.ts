import { db } from "@/lib/db";

/** A single merged history entry for a record's timeline (M19a). */
export type TimelineEntry = {
  id: string;
  /** Discriminates the source so the UI can pick an icon/style. */
  kind: "audit" | "stage";
  /** Dotted action verb for audit rows; a synthetic verb for stage events. */
  action: string;
  /** Human-readable one-liner. */
  summary: string;
  /** Acting user's display name, when known. */
  actorName: string | null;
  at: Date;
};

/**
 * Load and chronologically merge a deal's history (M19a): AuditLog rows plus the
 * DealStageEvent log, newest first. Both sources are org-scoped. Actor names are
 * resolved from the org's memberships in one round-trip (mirrors
 * loadCommentsData). Stage/status ids are mapped to stage names for readability.
 */
export async function loadDealTimeline(
  orgId: string,
  dealId: string,
  limit = 50,
): Promise<TimelineEntry[]> {
  const [audits, stageEvents, memberships, stages] = await Promise.all([
    db.auditLog.findMany({
      where: { orgId, entityType: "deal", entityId: dealId },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    db.dealStageEvent.findMany({
      where: { orgId, dealId },
      orderBy: { changedAt: "desc" },
      take: limit,
    }),
    db.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    db.pipelineStage.findMany({ where: { orgId }, select: { id: true, name: true } }),
  ]);

  const nameById = new Map(memberships.map((m) => [m.user.id, m.user.name ?? m.user.email ?? "Unknown"]));
  const stageName = (id: string | null | undefined) => (id ? (stages.find((s) => s.id === id)?.name ?? "a stage") : null);

  const auditEntries: TimelineEntry[] = audits.map((a) => ({
    id: `audit:${a.id}`,
    kind: "audit",
    action: a.action,
    summary: a.summary ?? a.action,
    actorName: a.actorId ? (nameById.get(a.actorId) ?? null) : null,
    at: a.createdAt,
  }));

  const stageEntries: TimelineEntry[] = stageEvents.map((e) => {
    const movedStage = e.fromStageId !== e.toStageId;
    const changedStatus = e.fromStatus !== e.toStatus;
    let summary: string;
    if (!e.fromStageId && !e.fromStatus) {
      summary = `Entered ${stageName(e.toStageId) ?? "the pipeline"}`;
    } else if (changedStatus) {
      summary = `Status ${e.fromStatus ?? "—"} → ${e.toStatus ?? "—"}`;
    } else if (movedStage) {
      summary = `Moved ${stageName(e.fromStageId) ?? "—"} → ${stageName(e.toStageId) ?? "—"}`;
    } else {
      summary = "Stage event";
    }
    return {
      id: `stage:${e.id}`,
      kind: "stage",
      action: "stage.event",
      summary,
      actorName: e.changedById ? (nameById.get(e.changedById) ?? null) : null,
      at: e.changedAt,
    };
  });

  return [...auditEntries, ...stageEntries]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit);
}
