"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { hasFeature, withinLimit } from "@/lib/entitlements";
import { emit, EVENTS } from "@/lib/events";
import { inngest } from "@/lib/inngest";
import {
  materializeRecipients,
  runCampaignSend,
  campaignStats as computeCampaignStats,
  type AudienceFilter,
  type CampaignStats,
} from "@/lib/campaigns";

/**
 * Marketing campaign actions (M19b).
 *
 * Creation is plan-gated: an org needs either the "campaigns" feature OR
 * headroom under the per-plan "campaigns" limit (see src/lib/plans.ts). Drafts
 * are ADMIN-gated CRUD. sendCampaign materializes recipients, flips the campaign
 * to SENDING, and emits CAMPAIGN_SEND_REQUESTED — the thin Inngest wrapper
 * (src/inngest/functions.ts) then calls runCampaignSend for the actual fan-out.
 */

// Audience filter spec — simple + explicit. Mirrors lib/campaigns AudienceFilter.
const audienceSchema = z.union([
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("tag"), tagId: z.string().min(1) }),
  z.object({ type: z.literal("company"), companyId: z.string().min(1) }),
]);

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(160),
  subject: z.string().trim().min(1).max(200),
  bodyHtml: z.string().max(100_000),
  audience: audienceSchema.default({ type: "all" }),
});

async function requireAdminOrg(): Promise<{ orgId: string; userId: string }> {
  const { orgId, userId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  return { orgId, userId };
}

export async function createCampaign(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = campaignSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  let userId: string;
  try {
    ({ orgId, userId } = await requireAdminOrg());
  } catch {
    return fail("Forbidden");
  }

  // Plan gate: the campaigns feature OR headroom under the campaigns cap.
  const feature = await hasFeature(orgId, "campaigns");
  if (!feature) {
    const count = await db.campaign.count({ where: { orgId } });
    if (!(await withinLimit(orgId, "campaigns", count))) {
      return fail("Plan limit reached: upgrade your plan to create more campaigns");
    }
  }

  const created = await db.campaign.create({
    data: {
      orgId,
      name: parsed.data.name,
      subject: parsed.data.subject,
      bodyHtml: parsed.data.bodyHtml,
      audience: parsed.data.audience as Prisma.InputJsonValue,
      status: "DRAFT",
      createdById: userId,
    },
  });
  revalidatePath("/campaigns");
  return ok({ id: created.id });
}

export async function updateCampaign(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = campaignSchema.partial().safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    ({ orgId } = await requireAdminOrg());
  } catch {
    return fail("Forbidden");
  }
  const existing = await db.campaign.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  // Only editable while it's still a draft — sent/sending campaigns are locked.
  if (existing.status !== "DRAFT") return fail("Only draft campaigns can be edited");

  const { name, subject, bodyHtml, audience } = parsed.data;
  await db.campaign.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(bodyHtml !== undefined ? { bodyHtml } : {}),
      ...(audience !== undefined ? { audience: audience as Prisma.InputJsonValue } : {}),
    },
  });
  revalidatePath("/campaigns");
  revalidatePath(`/campaigns/${id}`);
  return ok({ id });
}

export async function deleteCampaign(id: string): Promise<ActionResult<{ id: string }>> {
  let orgId: string;
  try {
    ({ orgId } = await requireAdminOrg());
  } catch {
    return fail("Forbidden");
  }
  const res = await db.campaign.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/campaigns");
  return ok({ id });
}

/**
 * Kick off a campaign send. Materializes recipients from the resolved audience,
 * flips the campaign to SENDING, and emits CAMPAIGN_SEND_REQUESTED so the
 * Inngest wrapper runs the fan-out out-of-band. Returns the recipient count.
 */
export async function sendCampaign(id: string): Promise<ActionResult<{ id: string; recipients: number }>> {
  let orgId: string;
  try {
    ({ orgId } = await requireAdminOrg());
  } catch {
    return fail("Forbidden");
  }
  const campaign = await db.campaign.findFirst({ where: { id, orgId } });
  if (!campaign) return fail("Not found");
  if (campaign.status === "SENDING" || campaign.status === "SENT") {
    return fail("Campaign has already been sent");
  }

  await materializeRecipients(orgId, id);
  const recipients = await db.campaignRecipient.count({ where: { orgId, campaignId: id } });
  if (recipients === 0) return fail("No recipients match this audience");

  await db.$transaction(async (tx) => {
    await tx.campaign.update({ where: { id }, data: { status: "SENDING" } });
    // Record the request on the outbox for the domain fan-out / audit trail.
    await emit(tx, {
      orgId,
      name: EVENTS.CAMPAIGN_SEND_REQUESTED,
      payload: { campaignId: id },
    });
  });

  // Hand the fan-out to the dedicated Inngest job. Defensive (mirrors the CSV
  // import action): if the event bus is unavailable — e.g. no keys locally —
  // run the send inline so the campaign never gets stuck in SENDING.
  try {
    await inngest.send({ name: EVENTS.CAMPAIGN_SEND_REQUESTED, data: { campaignId: id, orgId } });
  } catch {
    await runCampaignSend(orgId, id);
  }

  revalidatePath("/campaigns");
  revalidatePath(`/campaigns/${id}`);
  return ok({ id, recipients });
}

/** Aggregate recipient counts + opens/clicks for a campaign. Org-scoped. */
export async function campaignStats(id: string): Promise<ActionResult<CampaignStats>> {
  const { orgId } = await requireOrg();
  const campaign = await db.campaign.findFirst({ where: { id, orgId }, select: { id: true } });
  if (!campaign) return fail("Not found");
  const stats = await computeCampaignStats(orgId, id);
  return ok(stats);
}

export type { AudienceFilter };
