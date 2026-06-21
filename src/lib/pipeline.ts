/**
 * Pure helpers for pipeline UX (M6): stale-deal ("rotting") detection and
 * weighted pipeline value. Kept side-effect free so they're trivially testable
 * and usable in both server and client components.
 */

export function isRotten(
  deal: { updatedAt: Date | string; status: string },
  stage: { rottenDays?: number | null },
  now: number = Date.now(),
): boolean {
  if (!stage.rottenDays || deal.status !== "OPEN") return false;
  const updated = new Date(deal.updatedAt).getTime();
  return now - updated > stage.rottenDays * 86_400_000;
}

/** Probability used for weighting: per-deal override, else stage, else 100%. */
export function effectiveProbability(
  deal: { probability?: number | null },
  stage: { probability?: number | null },
): number {
  return deal.probability ?? stage.probability ?? 100;
}

export function weightedValue(
  value: number,
  deal: { probability?: number | null },
  stage: { probability?: number | null },
): number {
  return (value * effectiveProbability(deal, stage)) / 100;
}
