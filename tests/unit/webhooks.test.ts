import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  signPayload,
  endpointMatchesEvent,
  dispatchWebhooks,
  retryPendingWebhooks,
  MAX_ATTEMPTS,
} from "@/lib/webhooks";

let orgA = "", orgB = "";
let epAll = "", epDealOnly = "", epOtherOrg = "";

beforeAll(async () => {
  const ts = Date.now();
  const oa = await db.organization.create({ data: { name: `WhA-${ts}`, slug: `wh-a-${ts}` } });
  const ob = await db.organization.create({ data: { name: `WhB-${ts}`, slug: `wh-b-${ts}` } });
  orgA = oa.id;
  orgB = ob.id;

  // Endpoints point at an unroutable address so the real fetch fails fast and
  // the delivery is recorded as "failed" — we only assert on row creation here.
  const all = await db.webhookEndpoint.create({
    data: { orgId: orgA, url: "http://127.0.0.1:9/all", secret: "secretA", enabledEvents: ["*"] },
  });
  const dealOnly = await db.webhookEndpoint.create({
    data: { orgId: orgA, url: "http://127.0.0.1:9/deal", secret: "secretA2", enabledEvents: ["deal.created"] },
  });
  const other = await db.webhookEndpoint.create({
    data: { orgId: orgB, url: "http://127.0.0.1:9/other", secret: "secretB", enabledEvents: ["*"] },
  });
  epAll = all.id;
  epDealOnly = dealOnly.id;
  epOtherOrg = other.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.webhookDelivery.deleteMany({ where: { endpoint: { orgId: { in: orgs } } } });
  await db.webhookEndpoint.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.$disconnect();
});

describe("signature HMAC (M12)", () => {
  it("signPayload produces sha256=<hex HMAC>", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = signPayload("topsecret", body);
    const expected = "sha256=" + createHmac("sha256", "topsecret").update(body).digest("hex");
    expect(sig).toBe(expected);
  });

  it("signature changes with the secret (verifiable by a receiver)", () => {
    const body = "{}";
    expect(signPayload("a", body)).not.toBe(signPayload("b", body));
  });
});

describe("endpoint event matching (M12)", () => {
  it("matches an explicit event and the wildcard, but not others", () => {
    expect(endpointMatchesEvent({ enabledEvents: ["deal.created"] }, "deal.created")).toBe(true);
    expect(endpointMatchesEvent({ enabledEvents: ["deal.created"] }, "contact.created")).toBe(false);
    expect(endpointMatchesEvent({ enabledEvents: ["*"] }, "anything.happened")).toBe(true);
  });
});

describe("dispatchWebhooks creates deliveries for matching endpoints (M12)", () => {
  it("creates a delivery for a matching endpoint (wildcard + explicit)", async () => {
    const created = await dispatchWebhooks({
      orgId: orgA,
      name: "deal.created",
      payload: { dealId: "d1" },
    });
    // Both the wildcard endpoint and the deal-only endpoint match.
    expect(created).toBe(2);

    const all = await db.webhookDelivery.findMany({
      where: { endpointId: { in: [epAll, epDealOnly] }, eventName: "deal.created" },
    });
    expect(all.length).toBe(2);
    // Real fetch to an unroutable host fails → recorded as failed, attempt counted.
    expect(all.every((d) => d.status === "failed")).toBe(true);
    expect(all.every((d) => d.attempts === 1)).toBe(true);
    expect(all.every((d) => (d.payload as { dealId?: string }).dealId === "d1")).toBe(true);
  });

  it("skips endpoints not subscribed to the event", async () => {
    const created = await dispatchWebhooks({
      orgId: orgA,
      name: "contact.created",
      payload: { contactId: "c1" },
    });
    // Only the wildcard endpoint matches; the deal-only endpoint is skipped.
    expect(created).toBe(1);

    const dealOnlyDeliveries = await db.webhookDelivery.count({
      where: { endpointId: epDealOnly, eventName: "contact.created" },
    });
    expect(dealOnlyDeliveries).toBe(0);
  });

  it("is cross-org isolated — org A events never reach org B endpoints", async () => {
    await dispatchWebhooks({ orgId: orgA, name: "deal.created", payload: { dealId: "d2" } });
    const otherOrgDeliveries = await db.webhookDelivery.count({ where: { endpointId: epOtherOrg } });
    expect(otherOrgDeliveries).toBe(0);
  });

  it("ignores events with no orgId (returns 0)", async () => {
    const created = await dispatchWebhooks({ orgId: null, name: "deal.created", payload: {} });
    expect(created).toBe(0);
  });
});

describe("retryPendingWebhooks backoff + cap (M12)", () => {
  it("retries due failed deliveries and caps attempts", async () => {
    // Create a delivery that is due now and already near the cap.
    const delivery = await db.webhookDelivery.create({
      data: {
        endpointId: epAll,
        eventName: "deal.created",
        payload: { dealId: "retry" },
        status: "failed",
        attempts: MAX_ATTEMPTS - 1,
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });

    const res = await retryPendingWebhooks();
    expect(res.retried).toBeGreaterThanOrEqual(1);

    const after = await db.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(after!.attempts).toBe(MAX_ATTEMPTS);
    // Hit the cap → no further attempt scheduled.
    expect(after!.nextAttemptAt).toBeNull();
  });

  it("does not retry deliveries whose endpoint is disabled", async () => {
    const disabled = await db.webhookEndpoint.create({
      data: { orgId: orgA, url: "http://127.0.0.1:9/x", secret: "s", enabledEvents: ["*"], status: "disabled" },
    });
    const delivery = await db.webhookDelivery.create({
      data: {
        endpointId: disabled.id,
        eventName: "deal.created",
        payload: {},
        status: "failed",
        attempts: 1,
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });
    await retryPendingWebhooks();
    const after = await db.webhookDelivery.findUnique({ where: { id: delivery.id } });
    // Attempts unchanged; nextAttemptAt cleared so it won't be picked up again.
    expect(after!.attempts).toBe(1);
    expect(after!.nextAttemptAt).toBeNull();
  });
});
