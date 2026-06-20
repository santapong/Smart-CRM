import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

import { emit, EVENTS, processOutboxBatch } from "@/lib/events";

let orgId = "";

beforeAll(async () => {
  const ts = Date.now();
  const o = await db.organization.create({
    data: { name: `OrgEV-${ts}`, slug: `orgev-${ts}` },
  });
  orgId = o.id;
});

afterAll(async () => {
  await db.outboxEvent.deleteMany({ where: { orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.$disconnect();
});

describe("transactional outbox (M2)", () => {
  it("emit writes a PENDING OutboxEvent", async () => {
    await emit(db, {
      orgId,
      name: EVENTS.CONTACT_CREATED,
      payload: { contactId: "abc" },
    });
    const rows = await db.outboxEvent.findMany({ where: { orgId, name: "contact.created" } });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].payload).toEqual({ contactId: "abc" });
  });

  it("emit can run inside a $transaction with the tx client", async () => {
    await db.$transaction(async (tx) => {
      await emit(tx, { orgId, name: EVENTS.DEAL_CREATED, payload: { dealId: "tx-1" } });
    });
    const rows = await db.outboxEvent.findMany({
      where: { orgId, name: "deal.created" },
    });
    expect(rows.length).toBe(1);
  });

  it("processOutboxBatch moves PENDING -> PROCESSED and returns counts", async () => {
    const before = await db.outboxEvent.count({ where: { orgId, status: "PENDING" } });
    expect(before).toBeGreaterThanOrEqual(2);

    const result = await processOutboxBatch();
    expect(result.processed).toBeGreaterThanOrEqual(before);
    expect(result.failed).toBe(0);

    const stillPending = await db.outboxEvent.count({ where: { orgId, status: "PENDING" } });
    expect(stillPending).toBe(0);

    const processed = await db.outboxEvent.findMany({ where: { orgId } });
    expect(processed.every((e) => e.status === "PROCESSED")).toBe(true);
    expect(processed.every((e) => e.processedAt !== null)).toBe(true);
  });
});
