"use server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { hasFeature } from "@/lib/entitlements";
import { complete, AI_NOT_CONFIGURED } from "@/lib/ai";
import {
  SYSTEM_SALES,
  buildDealContext,
  buildContactContext,
  buildLeadContext,
  buildEmailPrompt,
  buildDealSummaryPrompt,
  buildLeadQualifyPrompt,
  buildPipelineAnswerPrompt,
  parseDraftedEmail,
} from "@/lib/ai-prompts";
import { pipelineValue, winLoss } from "@/lib/reports/runners";

/**
 * AI assistant actions (M14), powered by Claude. Every action is:
 *   - org-scoped (requireOrg),
 *   - env-gated (when ANTHROPIC_API_KEY is unset, `complete` returns a graceful
 *     not-configured result and we surface it as a normal ActionResult — never
 *     throwing), and
 *   - entitlement-gated behind hasFeature(orgId, "ai") (pro/business).
 *
 * Prompt construction lives in pure helpers in src/lib/ai-prompts.ts so they're
 * unit-testable without a key or a database. (A "use server" file may only
 * export async functions, so the helpers cannot live here.)
 */

const num = (v: { toString(): string } | number | null | undefined): number =>
  v == null ? 0 : Number(typeof v === "number" ? v : v.toString());

const draftSchema = z
  .object({
    contactId: z.string().min(1).optional(),
    dealId: z.string().min(1).optional(),
    instructions: z.string().max(2000).optional().default(""),
  })
  .refine((d) => !!d.contactId || !!d.dealId, {
    message: "A contactId or dealId is required",
    path: ["contactId"],
  });

/**
 * Draft a short sales email from a contact or deal record. Returns
 * `{ subject, body }` — does NOT send (the user reviews/sends via the existing
 * send-email dialog). Env-gated and entitlement-gated.
 */
export async function aiDraftEmail(
  input: unknown,
): Promise<ActionResult<{ subject: string; body: string }>> {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  if (!(await hasFeature(orgId, "ai"))) return fail("AI features are not available on your plan");

  const { contactId, dealId, instructions } = parsed.data;

  let context: string;
  if (dealId) {
    const deal = await db.deal.findFirst({
      where: { id: dealId, orgId },
      include: {
        contact: { select: { firstName: true, lastName: true } },
        company: { select: { name: true } },
        stage: { select: { name: true } },
        activities: { orderBy: { createdAt: "desc" }, take: 8, select: { type: true, title: true, completedAt: true } },
      },
    });
    if (!deal) return fail("Deal not found");
    context = buildDealContext({
      title: deal.title,
      value: num(deal.value),
      currency: deal.currency,
      status: deal.status,
      stageName: deal.stage?.name ?? null,
      closeDate: deal.closeDate,
      contactName: deal.contact ? `${deal.contact.firstName} ${deal.contact.lastName}` : null,
      companyName: deal.company?.name ?? null,
      notes: deal.notes,
      recentActivities: deal.activities,
    });
  } else {
    const contact = await db.contact.findFirst({
      where: { id: contactId!, orgId },
      include: {
        company: { select: { name: true } },
        activities: { orderBy: { createdAt: "desc" }, take: 8, select: { type: true, title: true, completedAt: true } },
      },
    });
    if (!contact) return fail("Contact not found");
    context = buildContactContext({
      name: `${contact.firstName} ${contact.lastName}`,
      email: contact.email,
      title: contact.title,
      companyName: contact.company?.name ?? null,
      notes: contact.notes,
      recentActivities: contact.activities,
    });
  }

  const res = await complete({
    system: SYSTEM_SALES,
    prompt: buildEmailPrompt(context, instructions),
    maxTokens: 600,
  });
  if (!res.ok) return fail(res.error);
  return ok(parseDraftedEmail(res.text));
}

/**
 * Concise deal summary + risk assessment + suggested next step, built from the
 * deal, its DealStageEvent history, recent activities, and contact.
 */
export async function aiSummarizeDeal(dealId: string): Promise<ActionResult<{ summary: string }>> {
  if (!dealId) return fail("Deal id is required");
  const { orgId } = await requireOrg();
  if (!(await hasFeature(orgId, "ai"))) return fail("AI features are not available on your plan");

  const deal = await db.deal.findFirst({
    where: { id: dealId, orgId },
    include: {
      contact: { select: { firstName: true, lastName: true } },
      company: { select: { name: true } },
      stage: { select: { name: true } },
      activities: { orderBy: { createdAt: "desc" }, take: 8, select: { type: true, title: true, completedAt: true } },
    },
  });
  if (!deal) return fail("Deal not found");

  const events = await db.dealStageEvent.findMany({
    where: { orgId, dealId },
    orderBy: { changedAt: "asc" },
    take: 20,
    select: { toStageId: true, toStatus: true, changedAt: true },
  });
  const stageNames = new Map(
    (
      await db.pipelineStage.findMany({
        where: { orgId, id: { in: events.map((e) => e.toStageId).filter((x): x is string => !!x) } },
        select: { id: true, name: true },
      })
    ).map((s) => [s.id, s.name]),
  );

  const context = buildDealContext({
    title: deal.title,
    value: num(deal.value),
    currency: deal.currency,
    status: deal.status,
    stageName: deal.stage?.name ?? null,
    closeDate: deal.closeDate,
    contactName: deal.contact ? `${deal.contact.firstName} ${deal.contact.lastName}` : null,
    companyName: deal.company?.name ?? null,
    notes: deal.notes,
    recentActivities: deal.activities,
    stageHistory: events.map((e) => ({
      toStageName: e.toStageId ? stageNames.get(e.toStageId) ?? null : null,
      toStatus: e.toStatus,
      changedAt: e.changedAt,
    })),
  });

  const res = await complete({
    system: SYSTEM_SALES,
    prompt: buildDealSummaryPrompt(context),
    maxTokens: 500,
  });
  if (!res.ok) return fail(res.error);
  return ok({ summary: res.text });
}

/**
 * Short qualification + next-step suggestion for a lead.
 */
export async function aiQualifyLead(leadId: string): Promise<ActionResult<{ suggestion: string }>> {
  if (!leadId) return fail("Lead id is required");
  const { orgId } = await requireOrg();
  if (!(await hasFeature(orgId, "ai"))) return fail("AI features are not available on your plan");

  const lead = await db.lead.findFirst({ where: { id: leadId, orgId } });
  if (!lead) return fail("Lead not found");

  const context = buildLeadContext({
    title: lead.title,
    status: lead.status,
    score: lead.score,
    value: lead.value != null ? num(lead.value) : null,
    currency: lead.currency,
    source: lead.source,
    notes: lead.notes,
  });

  const res = await complete({
    system: SYSTEM_SALES,
    prompt: buildLeadQualifyPrompt(context),
    maxTokens: 350,
  });
  if (!res.ok) return fail(res.error);
  return ok({ suggestion: res.text });
}

const searchSchema = z.object({ query: z.string().trim().min(1).max(500) });

export type AiSearchResult = {
  query: string;
  /** A small set of matching contacts/deals from a bounded keyword search. */
  contacts: Array<{ id: string; name: string }>;
  deals: Array<{ id: string; title: string; value: number; stage: string | null }>;
  /** A natural-language answer grounded in aggregate pipeline stats. */
  answer: string;
};

/**
 * Translate a natural-language query into a bounded keyword search over
 * contacts/deals AND answer a pipeline question using aggregate report stats.
 * Bounded: caps result counts and only feeds compact aggregates to the model.
 */
export async function aiSearch(input: unknown): Promise<ActionResult<AiSearchResult>> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  if (!(await hasFeature(orgId, "ai"))) return fail("AI features are not available on your plan");

  const query = parsed.data.query;

  // Bounded keyword search across contacts + deals (case-insensitive, capped).
  const [contacts, deals] = await Promise.all([
    db.contact.findMany({
      where: {
        orgId,
        OR: [
          { firstName: { contains: query, mode: "insensitive" } },
          { lastName: { contains: query, mode: "insensitive" } },
          { email: { contains: query, mode: "insensitive" } },
        ],
      },
      orderBy: { lastName: "asc" },
      take: 5,
      select: { id: true, firstName: true, lastName: true },
    }),
    db.deal.findMany({
      where: { orgId, title: { contains: query, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, title: true, value: true, stage: { select: { name: true } } },
    }),
  ]);

  // Compact aggregate stats for the pipeline Q&A (reuses M11 report runners).
  const [pv, wl] = await Promise.all([pipelineValue(orgId), winLoss(orgId)]);
  const stats = [
    `Total open pipeline value: ${pv.totalValue.toLocaleString("en-US")}`,
    `Total weighted pipeline value: ${Math.round(pv.totalWeighted).toLocaleString("en-US")}`,
    `Open value by stage: ${pv.rows.map((r) => `${r.name}=${r.value.toLocaleString("en-US")} (${r.count} deals)`).join(", ") || "none"}`,
    `Won: ${wl.won} deals (${wl.wonValue.toLocaleString("en-US")}); Lost: ${wl.lost} deals (${wl.lostValue.toLocaleString("en-US")}); Win rate: ${wl.winRate}%`,
  ].join("\n");

  const res = await complete({
    system: SYSTEM_SALES,
    prompt: buildPipelineAnswerPrompt(query, stats),
    maxTokens: 300,
  });

  return ok({
    query,
    contacts: contacts.map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}` })),
    deals: deals.map((d) => ({ id: d.id, title: d.title, value: num(d.value), stage: d.stage?.name ?? null })),
    answer: res.ok ? res.text : res.error === AI_NOT_CONFIGURED ? AI_NOT_CONFIGURED : "Could not generate an answer.",
  });
}
