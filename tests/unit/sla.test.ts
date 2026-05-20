import { describe, it, expect } from "vitest";
import { computeSla } from "@/lib/sla";

const policy = { firstResponseMinutes: 60, resolutionMinutes: 240 };

function ticket(over: Partial<Parameters<typeof computeSla>[0]> = {}) {
  return {
    createdAt: new Date("2026-05-19T10:00:00Z"),
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    status: "OPEN" as const,
    ...over,
  };
}

describe("computeSla", () => {
  it("returns UNKNOWN states when no policy is configured", () => {
    const out = computeSla(ticket(), null);
    expect(out.firstResponse.state).toBe("UNKNOWN");
    expect(out.resolution.state).toBe("UNKNOWN");
  });

  it("flags first-response WITHIN when there's lots of headroom", () => {
    const now = new Date("2026-05-19T10:10:00Z"); // 10 min elapsed of 60
    const out = computeSla(ticket(), policy, now);
    expect(out.firstResponse.state).toBe("WITHIN");
    expect(out.firstResponse.minutesRemaining).toBe(50);
  });

  it("flags AT_RISK when the remaining time crosses 20% of the budget", () => {
    const now = new Date("2026-05-19T10:50:00Z"); // 10 min left of 60 = ~16%
    const out = computeSla(ticket(), policy, now);
    expect(out.firstResponse.state).toBe("AT_RISK");
  });

  it("flags BREACHED when the deadline has passed without a response", () => {
    const now = new Date("2026-05-19T11:30:00Z"); // 30 min past due
    const out = computeSla(ticket(), policy, now);
    expect(out.firstResponse.state).toBe("BREACHED");
    expect(out.firstResponse.minutesRemaining).toBeLessThanOrEqual(0);
  });

  it("returns MET when first-response landed before the deadline", () => {
    const out = computeSla(
      ticket({ firstResponseAt: new Date("2026-05-19T10:30:00Z") }),
      policy,
      new Date("2026-05-19T12:00:00Z"),
    );
    expect(out.firstResponse.state).toBe("MET");
  });

  it("returns BREACHED for first-response that landed after the deadline", () => {
    const out = computeSla(
      ticket({ firstResponseAt: new Date("2026-05-19T11:30:00Z") }),
      policy,
      new Date("2026-05-19T12:00:00Z"),
    );
    expect(out.firstResponse.state).toBe("BREACHED");
  });

  it("uses resolvedAt for the resolution leg, falling back to closedAt", () => {
    const resolved = computeSla(
      ticket({ resolvedAt: new Date("2026-05-19T13:00:00Z") }),
      policy,
      new Date("2026-05-19T15:00:00Z"),
    );
    expect(resolved.resolution.state).toBe("MET"); // 3h of 4h budget

    const closed = computeSla(
      ticket({ closedAt: new Date("2026-05-19T15:00:00Z") }),
      policy,
      new Date("2026-05-19T15:30:00Z"),
    );
    expect(closed.resolution.state).toBe("BREACHED"); // 5h of 4h budget
  });
});
