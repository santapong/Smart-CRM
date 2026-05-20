import type { Ticket, SlaPolicy } from "@prisma/client";

export type SlaState = "WITHIN" | "AT_RISK" | "BREACHED" | "MET" | "UNKNOWN";

export type SlaBreakdown = {
  firstResponse: { state: SlaState; dueAt: Date | null; minutesRemaining: number | null };
  resolution: { state: SlaState; dueAt: Date | null; minutesRemaining: number | null };
};

const AT_RISK_FRACTION = 0.2;

function classify(
  start: Date,
  totalMinutes: number,
  finishedAt: Date | null,
  now: Date,
): { state: SlaState; dueAt: Date; minutesRemaining: number } {
  const dueAt = new Date(start.getTime() + totalMinutes * 60_000);
  if (finishedAt) {
    return {
      state: finishedAt <= dueAt ? "MET" : "BREACHED",
      dueAt,
      minutesRemaining: 0,
    };
  }
  const remainingMs = dueAt.getTime() - now.getTime();
  const minutesRemaining = Math.round(remainingMs / 60_000);
  if (remainingMs <= 0) return { state: "BREACHED", dueAt, minutesRemaining };
  if (remainingMs <= totalMinutes * 60_000 * AT_RISK_FRACTION) {
    return { state: "AT_RISK", dueAt, minutesRemaining };
  }
  return { state: "WITHIN", dueAt, minutesRemaining };
}

export function computeSla(
  ticket: Pick<Ticket, "createdAt" | "firstResponseAt" | "resolvedAt" | "closedAt" | "status">,
  policy: Pick<SlaPolicy, "firstResponseMinutes" | "resolutionMinutes"> | null,
  now: Date = new Date(),
): SlaBreakdown {
  if (!policy) {
    return {
      firstResponse: { state: "UNKNOWN", dueAt: null, minutesRemaining: null },
      resolution: { state: "UNKNOWN", dueAt: null, minutesRemaining: null },
    };
  }

  const fr = classify(ticket.createdAt, policy.firstResponseMinutes, ticket.firstResponseAt, now);
  const finishedAt = ticket.resolvedAt ?? ticket.closedAt ?? null;
  const res = classify(ticket.createdAt, policy.resolutionMinutes, finishedAt, now);

  return {
    firstResponse: fr,
    resolution: res,
  };
}
