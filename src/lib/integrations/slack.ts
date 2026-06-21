import type { OutboxEvent } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { EVENTS } from "@/lib/events";

/**
 * Slack integration (M15). LIVE via a per-org stored incoming-webhook URL.
 *
 * {@link postSlack} finds the org's active Slack {@link Connection}, decrypts its
 * webhook URL from the secrets vault, and POSTs a `{ text }` message. It is
 * env-tolerant: a missing connection/secret or a network failure is swallowed
 * (returns false) so it can run inside the outbox drain without ever throwing.
 *
 * {@link dispatchSlack} is hooked into processOutboxBatch next to dispatchWebhooks:
 * for each drained domain event it notifies every configured Slack connection
 * whose `config.events` includes the corresponding alert.
 */

const REQUEST_TIMEOUT_MS = 5000;

/** Name we store secrets under for a Slack connection. */
export const SLACK_WEBHOOK_SECRET = "slack_webhook_url";

/**
 * Logical Slack alert events a connection can subscribe to (Connection.config.
 * events). These map onto raw domain events: deal.won is a deal.status_changed
 * to WON; the others are 1:1.
 */
export const SLACK_EVENTS = ["deal.won", "deal.stage_changed", "lead.created"] as const;
export type SlackEvent = (typeof SLACK_EVENTS)[number];

/** Map a drained outbox event to its logical Slack alert, or null if N/A. */
export function slackEventFor(event: Pick<OutboxEvent, "name" | "payload">): SlackEvent | null {
  if (event.name === EVENTS.LEAD_CREATED) return "lead.created";
  if (event.name === EVENTS.DEAL_STAGE_CHANGED) return "deal.stage_changed";
  if (event.name === EVENTS.DEAL_STATUS_CHANGED) {
    const toStatus = (event.payload as { toStatus?: string } | null)?.toStatus;
    if (toStatus === "WON") return "deal.won";
  }
  return null;
}

/** POST raw text to a Slack incoming-webhook URL. Never throws; returns ok. */
async function postToWebhook(url: string, text: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    return resp.status >= 200 && resp.status < 300;
  } catch {
    return false;
  }
}

/**
 * Send `text` to the org's active Slack connection. Returns false (never throws)
 * when there is no active connection, no decryptable secret, or the POST fails.
 */
export async function postSlack(orgId: string, text: string): Promise<boolean> {
  try {
    const connection = await db.connection.findFirst({
      where: { orgId, provider: "slack", status: "active" },
      orderBy: { createdAt: "desc" },
    });
    if (!connection) return false;
    const url = await resolveWebhookUrl(connection.id, orgId);
    if (!url) return false;
    return await postToWebhook(url, text);
  } catch {
    return false;
  }
}

/** Decrypt the stored incoming-webhook URL for a Slack connection. */
async function resolveWebhookUrl(connectionId: string, orgId: string): Promise<string | null> {
  const secret = await db.encryptedSecret.findFirst({
    where: { connectionId, orgId, name: SLACK_WEBHOOK_SECRET },
    orderBy: { createdAt: "desc" },
  });
  if (!secret) return null;
  return decryptSecret(secret);
}

/** Best-effort human label for money. */
function money(value: unknown, currency: unknown): string {
  const n = typeof value === "object" && value !== null ? Number(value.toString()) : Number(value);
  if (!Number.isFinite(n)) return "";
  const cur = typeof currency === "string" ? currency : "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
}

/**
 * Format a Slack message for a domain event by loading a little context from the
 * DB (best-effort). Returns null if the event isn't a Slack-worthy alert.
 */
export async function formatDealMessage(
  orgId: string,
  event: Pick<OutboxEvent, "name" | "payload">,
): Promise<string | null> {
  const kind = slackEventFor(event);
  if (!kind) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  if (kind === "lead.created") {
    const leadId = typeof payload.leadId === "string" ? payload.leadId : null;
    const lead = leadId ? await db.lead.findFirst({ where: { id: leadId, orgId } }) : null;
    const title = lead?.title ?? "New lead";
    const amount = lead ? money(lead.value, lead.currency) : "";
    return `:sparkles: New lead created: *${title}*${amount ? ` (${amount})` : ""}`;
  }

  const dealId = typeof payload.dealId === "string" ? payload.dealId : null;
  const deal = dealId ? await db.deal.findFirst({ where: { id: dealId, orgId } }) : null;
  const title = deal?.title ?? "Deal";
  const amount = deal ? money(deal.value, deal.currency) : "";

  if (kind === "deal.won") {
    return `:tada: Deal won: *${title}*${amount ? ` (${amount})` : ""}`;
  }

  // deal.stage_changed
  const toStageId = typeof payload.toStageId === "string" ? payload.toStageId : null;
  const stage = toStageId ? await db.pipelineStage.findFirst({ where: { id: toStageId, orgId } }) : null;
  const stageName = stage?.name ? ` → *${stage.name}*` : "";
  return `:arrow_right: Deal moved: *${title}*${stageName}${amount ? ` (${amount})` : ""}`;
}

/**
 * Format a message for a domain event and post it to the org's Slack connection.
 * Thin wrapper used by callers that already know the org + event (e.g. tests).
 * Returns false (never throws) when the event isn't a Slack alert or Slack isn't
 * configured. Note: unlike {@link dispatchSlack}, this does not filter on the
 * connection's subscribed events — it posts whenever the event is alert-worthy.
 */
export async function notifyDeal(
  orgId: string,
  event: Pick<OutboxEvent, "name" | "payload">,
): Promise<boolean> {
  const text = await formatDealMessage(orgId, event);
  if (!text) return false;
  return postSlack(orgId, text);
}

/**
 * Fan a single drained outbox event out to the org's configured Slack
 * connections. For each active Slack connection whose `config.events` includes
 * the event's logical alert, decrypt its webhook and POST the formatted message.
 * Returns the number of messages sent. Defensive: never throws, so it can sit in
 * the outbox drain next to dispatchWebhooks.
 */
export async function dispatchSlack(
  event: Pick<OutboxEvent, "orgId" | "name" | "payload">,
): Promise<number> {
  try {
    if (!event.orgId) return 0;
    const kind = slackEventFor(event);
    if (!kind) return 0;

    const connections = await db.connection.findMany({
      where: { orgId: event.orgId, provider: "slack", status: "active" },
    });
    if (connections.length === 0) return 0;

    const text = await formatDealMessage(event.orgId, event);
    if (!text) return 0;

    let sent = 0;
    for (const connection of connections) {
      try {
        const events = readConfigEvents(connection.config);
        if (!events.includes(kind)) continue;
        const url = await resolveWebhookUrl(connection.id, event.orgId);
        if (!url) continue;
        if (await postToWebhook(url, text)) sent += 1;
      } catch {
        // Per-connection failure shouldn't drop the others.
      }
    }
    return sent;
  } catch {
    return 0;
  }
}

/** Read the subscribed-events array out of a Connection.config JSON blob. */
export function readConfigEvents(config: unknown): string[] {
  if (config && typeof config === "object" && "events" in config) {
    const events = (config as { events?: unknown }).events;
    if (Array.isArray(events)) return events.filter((e): e is string => typeof e === "string");
  }
  return [];
}
