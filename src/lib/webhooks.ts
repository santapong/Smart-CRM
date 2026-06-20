import { createHmac } from "node:crypto";
import type { OutboxEvent, WebhookEndpoint } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Outbound webhooks (M12).
 *
 * When a domain event is drained from the outbox, {@link dispatchWebhooks} finds
 * the org's active {@link WebhookEndpoint}s subscribed to that event (or "*"),
 * creates a {@link WebhookDelivery} per endpoint, and POSTs the signed payload.
 * Everything here is env-tolerant: network/DB failures are caught and recorded,
 * never thrown — so a flaky receiver can't break outbox draining.
 *
 * A separate Inngest job ({@link retryPendingWebhooks}) re-attempts failed
 * deliveries with exponential backoff up to {@link MAX_ATTEMPTS}.
 */

export const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 5000;

/** Compute the `X-SmartCRM-Signature` value: `sha256=<hex HMAC(secret, body)>`. */
export function signPayload(secret: string, body: string): string {
  const mac = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${mac}`;
}

/** True when an endpoint is subscribed to `eventName` (explicitly or via "*"). */
export function endpointMatchesEvent(endpoint: Pick<WebhookEndpoint, "enabledEvents">, eventName: string): boolean {
  return endpoint.enabledEvents.includes("*") || endpoint.enabledEvents.includes(eventName);
}

/** Exponential backoff (seconds) for a given attempt count: 1m, 5m, 15m, 1h, … */
function backoffSeconds(attempts: number): number {
  const schedule = [60, 300, 900, 3600, 21600];
  return schedule[Math.min(attempts, schedule.length - 1)];
}

/**
 * POST a delivery's payload to its endpoint and update its row with the outcome.
 * Returns true on a 2xx response. Never throws — failures set status="failed"
 * and schedule the next attempt (until the cap), success sets status="success".
 */
async function attemptDelivery(delivery: {
  id: string;
  endpointId: string;
  eventName: string;
  payload: unknown;
  attempts: number;
  endpoint: Pick<WebhookEndpoint, "url" | "secret">;
}): Promise<boolean> {
  const body = JSON.stringify({
    event: delivery.eventName,
    data: delivery.payload,
    delivery_id: delivery.id,
  });
  const signature = signPayload(delivery.endpoint.secret, body);
  const attempts = delivery.attempts + 1;

  let responseStatus: number | null = null;
  let ok = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const resp = await fetch(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-SmartCRM-Signature": signature,
        "X-SmartCRM-Event": delivery.eventName,
      },
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    responseStatus = resp.status;
    ok = resp.status >= 200 && resp.status < 300;
  } catch {
    ok = false;
  }

  if (ok) {
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: "success", attempts, responseStatus, nextAttemptAt: null },
    });
    return true;
  }

  const exhausted = attempts >= MAX_ATTEMPTS;
  await db.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: "failed",
      attempts,
      responseStatus,
      nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffSeconds(attempts) * 1000),
    },
  });
  return false;
}

/**
 * Fan a single drained outbox event out to the org's matching webhook endpoints.
 * Creates a WebhookDelivery per endpoint and attempts each immediately. Returns
 * the number of deliveries created. Defensive: any error is swallowed so the
 * outbox drain is never disrupted.
 */
export async function dispatchWebhooks(event: Pick<OutboxEvent, "orgId" | "name" | "payload">): Promise<number> {
  try {
    if (!event.orgId) return 0;
    const endpoints = await db.webhookEndpoint.findMany({
      where: { orgId: event.orgId, status: "active" },
    });
    const matching = endpoints.filter((e) => endpointMatchesEvent(e, event.name));
    if (matching.length === 0) return 0;

    let created = 0;
    for (const endpoint of matching) {
      try {
        const delivery = await db.webhookDelivery.create({
          data: {
            endpointId: endpoint.id,
            eventName: event.name,
            payload: event.payload as object,
            status: "pending",
          },
        });
        created += 1;
        await attemptDelivery({
          id: delivery.id,
          endpointId: endpoint.id,
          eventName: event.name,
          payload: event.payload,
          attempts: 0,
          endpoint,
        });
      } catch {
        // Per-endpoint failure shouldn't drop the others.
      }
    }
    return created;
  } catch {
    return 0;
  }
}

/**
 * Re-attempt pending/failed deliveries whose `nextAttemptAt` is due (and which
 * haven't hit the attempt cap). Driven by an Inngest cron. Returns counts.
 */
export async function retryPendingWebhooks(limit = 50): Promise<{ retried: number; succeeded: number }> {
  const due = await db.webhookDelivery.findMany({
    where: {
      status: { in: ["pending", "failed"] },
      attempts: { lt: MAX_ATTEMPTS },
      nextAttemptAt: { not: null, lte: new Date() },
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    include: { endpoint: true },
  });

  let succeeded = 0;
  for (const d of due) {
    // Skip deliveries whose endpoint was disabled in the meantime.
    if (d.endpoint.status !== "active") {
      await db.webhookDelivery.update({ where: { id: d.id }, data: { nextAttemptAt: null } });
      continue;
    }
    const ok = await attemptDelivery({
      id: d.id,
      endpointId: d.endpointId,
      eventName: d.eventName,
      payload: d.payload,
      attempts: d.attempts,
      endpoint: d.endpoint,
    });
    if (ok) succeeded += 1;
  }

  return { retried: due.length, succeeded };
}
