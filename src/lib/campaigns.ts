import type { Contact } from "@prisma/client";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";

/**
 * Marketing campaigns (M19b) — built on the M7 email pipeline.
 *
 * The audience filter is intentionally SIMPLE and explicit so it's easy to
 * resolve, test, and reason about:
 *
 *   { type: "all" }                — every contact in the org with an email
 *   { type: "tag", tagId }         — contacts carrying a given Tag
 *   { type: "company", companyId } — contacts at a given Company
 *
 * {@link resolveAudience} returns the matching org-scoped contacts deduped by
 * (lower-cased) email and EXCLUDING any address on the org's Suppression list.
 * {@link materializeRecipients} persists those as CampaignRecipient rows, and
 * {@link runCampaignSend} fans them out through {@link sendEmail} (env-gated, so
 * it records an EmailMessage and is a no-op send offline) and flips the
 * recipient + campaign status.
 */

export type AudienceFilter =
  | { type: "all" }
  | { type: "tag"; tagId: string }
  | { type: "company"; companyId: string };

/** A resolved audience entry — a contact id paired with a normalized email. */
export type AudienceContact = { contactId: string; email: string };

/**
 * Parse/validate an unknown JSON value into an AudienceFilter. Falls back to
 * `{ type: "all" }` for missing/unrecognized specs so a campaign always has a
 * well-defined audience.
 */
export function parseAudience(value: unknown): AudienceFilter {
  if (value && typeof value === "object" && "type" in value) {
    const v = value as Record<string, unknown>;
    if (v.type === "tag" && typeof v.tagId === "string" && v.tagId) {
      return { type: "tag", tagId: v.tagId };
    }
    if (v.type === "company" && typeof v.companyId === "string" && v.companyId) {
      return { type: "company", companyId: v.companyId };
    }
  }
  return { type: "all" };
}

/** Load the org-scoped contacts matching a filter (before email dedupe/suppression). */
async function loadContactsForFilter(orgId: string, filter: AudienceFilter): Promise<Contact[]> {
  if (filter.type === "company") {
    return db.contact.findMany({ where: { orgId, companyId: filter.companyId } });
  }
  if (filter.type === "tag") {
    return db.contact.findMany({
      where: { orgId, tags: { some: { tagId: filter.tagId } } },
    });
  }
  return db.contact.findMany({ where: { orgId } });
}

/**
 * Resolve a campaign audience to a deduped, suppression-filtered list of
 * contacts. Org-scoped. Contacts without an email are excluded; emails are
 * lower-cased and deduped (first contact wins); addresses on the org's
 * Suppression list are removed.
 */
export async function resolveAudience(
  orgId: string,
  filter: AudienceFilter,
): Promise<AudienceContact[]> {
  const contacts = await loadContactsForFilter(orgId, filter);

  const suppressed = await db.suppression.findMany({
    where: { orgId },
    select: { email: true },
  });
  const blocked = new Set(suppressed.map((s) => s.email.toLowerCase()));

  const seen = new Set<string>();
  const out: AudienceContact[] = [];
  for (const c of contacts) {
    const email = c.email?.trim().toLowerCase();
    if (!email) continue;
    if (blocked.has(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ contactId: c.id, email });
  }
  return out;
}

/**
 * Resolve a campaign's audience and write CampaignRecipient rows (status
 * PENDING). Idempotent via the @@unique([campaignId, email]) constraint —
 * re-running skips duplicates. Returns the number of rows created.
 */
export async function materializeRecipients(orgId: string, campaignId: string): Promise<number> {
  const campaign = await db.campaign.findFirst({ where: { id: campaignId, orgId } });
  if (!campaign) return 0;

  const audience = await resolveAudience(orgId, parseAudience(campaign.audience));
  if (audience.length === 0) return 0;

  const res = await db.campaignRecipient.createMany({
    data: audience.map((a) => ({
      orgId,
      campaignId,
      contactId: a.contactId,
      email: a.email,
      status: "PENDING" as const,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

/**
 * Execute a campaign send: loop its PENDING recipients, send each via
 * {@link sendEmail} (which records an EmailMessage even offline and skips
 * suppressed addresses), persist the recipient's resulting status +
 * emailMessageId, then mark the campaign SENT.
 *
 * Defensive and env-tolerant — a per-recipient failure records on that row and
 * never aborts the batch, mirroring the sequence runner. Safe to call directly
 * from tests (no Inngest runtime needed).
 */
export async function runCampaignSend(
  orgId: string,
  campaignId: string,
): Promise<{ sent: number; skipped: number; failed: number }> {
  const campaign = await db.campaign.findFirst({ where: { id: campaignId, orgId } });
  if (!campaign) return { sent: 0, skipped: 0, failed: 0 };

  // Recipients may already exist (materialized in the action); ensure they do.
  await materializeRecipients(orgId, campaignId);

  const recipients = await db.campaignRecipient.findMany({
    where: { orgId, campaignId, status: "PENDING" },
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of recipients) {
    try {
      const res = await sendEmail({
        orgId,
        to: r.email,
        subject: campaign.subject,
        html: campaign.bodyHtml,
        contactId: r.contactId,
        sentById: campaign.createdById,
      });
      const status = res.status === "sent" ? "SENT" : res.status === "failed" ? "FAILED" : "SKIPPED";
      await db.campaignRecipient.update({
        where: { id: r.id },
        data: {
          status,
          emailMessageId: res.id,
          error: res.status === "failed" ? (res.reason ?? "provider_error") : null,
        },
      });
      if (status === "SENT") sent += 1;
      else if (status === "SKIPPED") skipped += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await db.campaignRecipient.update({
        where: { id: r.id },
        data: { status: "FAILED", error: message.slice(0, 500) },
      });
    }
  }

  await db.campaign.update({
    where: { id: campaignId },
    data: { status: "SENT", sentAt: new Date() },
  });

  return { sent, skipped, failed };
}

export type CampaignStats = {
  total: number;
  pending: number;
  sent: number;
  skipped: number;
  failed: number;
  opens: number;
  clicks: number;
};

/**
 * Aggregate a campaign's recipient counts and join EmailEvent (by
 * emailMessageId) for opens/clicks. Org-scoped. Returns zeros for an unknown
 * campaign.
 */
export async function campaignStats(orgId: string, campaignId: string): Promise<CampaignStats> {
  const recipients = await db.campaignRecipient.findMany({
    where: { orgId, campaignId },
    select: { status: true, emailMessageId: true },
  });

  const stats: CampaignStats = {
    total: recipients.length,
    pending: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    opens: 0,
    clicks: 0,
  };
  const messageIds: string[] = [];
  for (const r of recipients) {
    if (r.status === "PENDING") stats.pending += 1;
    else if (r.status === "SENT") stats.sent += 1;
    else if (r.status === "SKIPPED") stats.skipped += 1;
    else if (r.status === "FAILED") stats.failed += 1;
    if (r.emailMessageId) messageIds.push(r.emailMessageId);
  }

  if (messageIds.length > 0) {
    // Open/click totals come from the same EmailMessage counters the Resend
    // webhook increments (M7), so they stay accurate without re-counting events.
    const agg = await db.emailMessage.aggregate({
      where: { orgId, id: { in: messageIds } },
      _sum: { openCount: true, clickCount: true },
    });
    stats.opens = agg._sum.openCount ?? 0;
    stats.clicks = agg._sum.clickCount ?? 0;
  }

  return stats;
}
