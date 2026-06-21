"use server";
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { EVENTS } from "@/lib/events";

/**
 * Webhook endpoint management (M12). ADMIN-only CRUD. A signing secret is
 * generated on create and used to HMAC-sign every delivery (see
 * src/lib/webhooks.ts). `enabledEvents` accepts any domain event name or "*".
 */

// The set of event names an endpoint may subscribe to, plus the "*" wildcard.
const EVENT_NAMES = [...Object.values(EVENTS), "*"] as const;

const createSchema = z.object({
  url: z.string().url().max(2000),
  enabledEvents: z.array(z.enum(EVENT_NAMES as unknown as [string, ...string[]])).min(1),
});

const updateSchema = z.object({
  url: z.string().url().max(2000).optional(),
  enabledEvents: z.array(z.enum(EVENT_NAMES as unknown as [string, ...string[]])).min(1).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

async function requireAdminOrg() {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  return orgId;
}

export async function listWebhookEndpoints(): Promise<
  ActionResult<
    Array<{
      id: string;
      url: string;
      secret: string;
      enabledEvents: string[];
      status: string;
      createdAt: Date;
    }>
  >
> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const endpoints = await db.webhookEndpoint.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    select: { id: true, url: true, secret: true, enabledEvents: true, status: true, createdAt: true },
  });
  return ok(endpoints);
}

export async function createWebhookEndpoint(
  input: unknown,
): Promise<ActionResult<{ id: string; secret: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const created = await db.webhookEndpoint.create({
    data: {
      orgId,
      url: parsed.data.url,
      secret,
      enabledEvents: parsed.data.enabledEvents,
    },
  });
  revalidatePath("/settings");
  return ok({ id: created.id, secret });
}

export async function updateWebhookEndpoint(
  id: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const existing = await db.webhookEndpoint.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  await db.webhookEndpoint.update({
    where: { id },
    data: {
      ...(parsed.data.url !== undefined ? { url: parsed.data.url } : {}),
      ...(parsed.data.enabledEvents !== undefined ? { enabledEvents: parsed.data.enabledEvents } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    },
  });
  revalidatePath("/settings");
  return ok({ id });
}

export async function deleteWebhookEndpoint(id: string): Promise<ActionResult<{ id: string }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const res = await db.webhookEndpoint.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings");
  return ok({ id });
}
