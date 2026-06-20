"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { withinLimit } from "@/lib/entitlements";
import { encryptSecret } from "@/lib/crypto";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import { nangoConfigured } from "@/lib/integrations/nango";
import { postSlack, SLACK_EVENTS, SLACK_WEBHOOK_SECRET, readConfigEvents } from "@/lib/integrations/slack";

/**
 * Integration management (M15). ADMIN-only. Slack connects via a stored
 * incoming-webhook URL: the URL is encrypted into the secrets vault (never
 * persisted in plaintext) and a Connection row records the selected events.
 * `listIntegrations` returns the provider registry joined with the org's
 * Connections and each provider's configured status.
 */

const slackEventEnum = z.enum(SLACK_EVENTS);

const connectSlackSchema = z.object({
  // Slack incoming webhooks live under hooks.slack.com; require https.
  webhookUrl: z
    .string()
    .url()
    .max(2000)
    .refine((u) => u.startsWith("https://"), { message: "Must be an https URL" }),
  events: z.array(slackEventEnum).min(1),
  label: z.string().max(120).optional(),
});

const updateSlackSchema = z.object({
  connectionId: z.string().min(1),
  webhookUrl: z
    .string()
    .url()
    .max(2000)
    .refine((u) => u.startsWith("https://"), { message: "Must be an https URL" })
    .optional(),
  events: z.array(slackEventEnum).min(1).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

async function requireAdminOrg(): Promise<string> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  return orgId;
}

export type IntegrationConnection = {
  id: string;
  provider: string;
  label: string | null;
  status: string;
  events: string[];
  createdAt: string;
};

export type IntegrationListing = {
  key: string;
  name: string;
  description: string;
  authType: string;
  status: string;
  configured: boolean;
  connections: IntegrationConnection[];
};

/** Registry × the org's Connections × configured status. ADMIN-only. */
export async function listIntegrations(): Promise<ActionResult<IntegrationListing[]>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const connections = await db.connection.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
  });
  const byProvider = new Map<string, IntegrationConnection[]>();
  for (const c of connections) {
    const list = byProvider.get(c.provider) ?? [];
    list.push({
      id: c.id,
      provider: c.provider,
      label: c.label,
      status: c.status,
      events: readConfigEvents(c.config),
      createdAt: c.createdAt.toISOString(),
    });
    byProvider.set(c.provider, list);
  }
  const listings = INTEGRATIONS.map((p) => ({
    key: p.key,
    name: p.name,
    description: p.description,
    authType: p.authType,
    status: p.status,
    configured: p.configured(process.env),
    connections: byProvider.get(p.key) ?? [],
  }));
  return ok(listings);
}

/** Count of an org's connections, used for the integrations limit. */
async function connectionCount(orgId: string): Promise<number> {
  return db.connection.count({ where: { orgId } });
}

/**
 * Connect Slack: validate the webhook URL, create a Connection, and store the
 * URL as an encrypted secret. Enforces the org's `integrations` limit.
 */
export async function connectSlack(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = connectSlackSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }

  if (!(await withinLimit(orgId, "integrations", await connectionCount(orgId)))) {
    return fail("Integration limit reached for your plan");
  }

  const enc = encryptSecret(parsed.data.webhookUrl);
  const created = await db.$transaction(async (tx) => {
    const connection = await tx.connection.create({
      data: {
        orgId,
        provider: "slack",
        label: parsed.data.label ?? "Slack",
        status: "active",
        config: { events: parsed.data.events } as Prisma.InputJsonValue,
      },
    });
    await tx.encryptedSecret.create({
      data: {
        orgId,
        connectionId: connection.id,
        name: SLACK_WEBHOOK_SECRET,
        keyId: enc.keyId,
        iv: enc.iv,
        authTag: enc.authTag,
        ciphertext: enc.ciphertext,
      },
    });
    return connection;
  });
  revalidatePath("/settings/integrations");
  return ok({ id: created.id });
}

/** Update a Slack connection's events/status, and optionally rotate its URL. */
export async function updateSlack(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = updateSlackSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const { connectionId, webhookUrl, events, status } = parsed.data;
  const existing = await db.connection.findFirst({
    where: { id: connectionId, orgId, provider: "slack" },
  });
  if (!existing) return fail("Not found");

  await db.$transaction(async (tx) => {
    await tx.connection.update({
      where: { id: connectionId },
      data: {
        ...(events !== undefined ? { config: { events } as Prisma.InputJsonValue } : {}),
        ...(status !== undefined ? { status } : {}),
      },
    });
    if (webhookUrl !== undefined) {
      const enc = encryptSecret(webhookUrl);
      // Replace the stored secret (delete + recreate keeps this simple).
      await tx.encryptedSecret.deleteMany({
        where: { connectionId, orgId, name: SLACK_WEBHOOK_SECRET },
      });
      await tx.encryptedSecret.create({
        data: {
          orgId,
          connectionId,
          name: SLACK_WEBHOOK_SECRET,
          keyId: enc.keyId,
          iv: enc.iv,
          authTag: enc.authTag,
          ciphertext: enc.ciphertext,
        },
      });
    }
  });
  revalidatePath("/settings/integrations");
  return ok({ id: connectionId });
}

/** Remove a connection (and its secrets cascade via the relation). */
export async function disconnect(connectionId: string): Promise<ActionResult<{ id: string }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const res = await db.connection.deleteMany({ where: { id: connectionId, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings/integrations");
  return ok({ id: connectionId });
}

/** Send a test message through a Slack connection's stored webhook. */
export async function testSlack(connectionId: string): Promise<ActionResult<{ sent: boolean }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const connection = await db.connection.findFirst({
    where: { id: connectionId, orgId, provider: "slack" },
  });
  if (!connection) return fail("Not found");
  const sent = await postSlack(orgId, ":wave: Test message from Smart CRM — your Slack integration works.");
  if (!sent) return fail("Could not deliver to Slack. Check the webhook URL.");
  return ok({ sent });
}

/** Whether Nango (managed OAuth) is configured — used to gate OAuth cards. */
export async function nangoStatus(): Promise<ActionResult<{ configured: boolean }>> {
  try {
    await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  return ok({ configured: nangoConfigured() });
}
