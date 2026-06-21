/**
 * Pure prompt-building helpers for the AI assistant (M14). Kept in a plain
 * module (NOT a "use server" file) so they can be exported as ordinary
 * functions and unit-tested without a key, a database, or the network.
 *
 * Every function here is pure: it takes already-loaded plain records and returns
 * strings. No DB, no I/O, no `next/*` imports.
 */

/** System prompt shared by all sales-assistant calls. */
export const SYSTEM_SALES =
  "You are a concise, practical sales assistant inside a CRM. Be specific and " +
  "actionable. Never invent facts that are not in the provided context.";

export type DealContext = {
  title: string;
  value: number;
  currency: string;
  status: string;
  stageName: string | null;
  closeDate?: Date | string | null;
  contactName?: string | null;
  companyName?: string | null;
  notes?: string | null;
  recentActivities?: Array<{ type: string; title: string; completedAt?: Date | string | null }>;
  stageHistory?: Array<{ toStageName?: string | null; toStatus?: string | null; changedAt?: Date | string | null }>;
};

const fmtDate = (d?: Date | string | null): string | null => {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const money = (value: number, currency: string): string => `${currency} ${value.toLocaleString("en-US")}`;

/** Build a compact, deterministic context block describing a deal. PURE. */
export function buildDealContext(deal: DealContext): string {
  const lines: string[] = [];
  lines.push(`Deal: ${deal.title}`);
  lines.push(`Value: ${money(deal.value, deal.currency)}`);
  lines.push(`Status: ${deal.status}`);
  if (deal.stageName) lines.push(`Stage: ${deal.stageName}`);
  const close = fmtDate(deal.closeDate);
  if (close) lines.push(`Expected close: ${close}`);
  if (deal.contactName) lines.push(`Primary contact: ${deal.contactName}`);
  if (deal.companyName) lines.push(`Company: ${deal.companyName}`);
  if (deal.notes) lines.push(`Notes: ${deal.notes}`);

  const history = (deal.stageHistory ?? [])
    .map((h) => {
      const when = fmtDate(h.changedAt);
      const label = h.toStatus && h.toStatus !== "OPEN" ? h.toStatus : h.toStageName;
      return label ? `${when ? when + ": " : ""}${label}` : null;
    })
    .filter((x): x is string => !!x);
  if (history.length > 0) lines.push(`Stage history: ${history.join(" → ")}`);

  const acts = (deal.recentActivities ?? [])
    .map((a) => `${a.type}: ${a.title}${a.completedAt ? " (done)" : ""}`)
    .slice(0, 8);
  if (acts.length > 0) lines.push(`Recent activities:\n- ${acts.join("\n- ")}`);

  return lines.join("\n");
}

export type ContactContext = {
  name: string;
  email?: string | null;
  title?: string | null;
  companyName?: string | null;
  notes?: string | null;
  recentActivities?: Array<{ type: string; title: string; completedAt?: Date | string | null }>;
};

/** Build a compact context block describing a contact. PURE. */
export function buildContactContext(contact: ContactContext): string {
  const lines: string[] = [];
  lines.push(`Contact: ${contact.name}`);
  if (contact.title) lines.push(`Title: ${contact.title}`);
  if (contact.companyName) lines.push(`Company: ${contact.companyName}`);
  if (contact.email) lines.push(`Email: ${contact.email}`);
  if (contact.notes) lines.push(`Notes: ${contact.notes}`);
  const acts = (contact.recentActivities ?? [])
    .map((a) => `${a.type}: ${a.title}${a.completedAt ? " (done)" : ""}`)
    .slice(0, 8);
  if (acts.length > 0) lines.push(`Recent activities:\n- ${acts.join("\n- ")}`);
  return lines.join("\n");
}

export type LeadContext = {
  title: string;
  status: string;
  score: number;
  value?: number | null;
  currency?: string | null;
  source?: string | null;
  notes?: string | null;
};

/** Build a compact context block describing a lead. PURE. */
export function buildLeadContext(lead: LeadContext): string {
  const lines: string[] = [];
  lines.push(`Lead: ${lead.title}`);
  lines.push(`Status: ${lead.status}`);
  lines.push(`Score: ${lead.score}`);
  if (lead.value != null) lines.push(`Value: ${money(lead.value, lead.currency || "USD")}`);
  if (lead.source) lines.push(`Source: ${lead.source}`);
  if (lead.notes) lines.push(`Notes: ${lead.notes}`);
  return lines.join("\n");
}

/** Build the email-drafting prompt from a record context + user instructions. PURE. */
export function buildEmailPrompt(context: string, instructions: string): string {
  return [
    "Draft a short, friendly sales email based on the record below.",
    "",
    "RECORD CONTEXT:",
    context,
    "",
    `INSTRUCTIONS: ${instructions || "Write a helpful follow-up."}`,
    "",
    'Return ONLY a JSON object with exactly two string fields: "subject" and "body".',
    "Keep the body under 150 words. No markdown, no preamble, no code fences.",
  ].join("\n");
}

/** Build the deal-summary prompt from a deal context. PURE. */
export function buildDealSummaryPrompt(context: string): string {
  return [
    "Summarize this deal for a sales rep.",
    "",
    context,
    "",
    "Respond in three short labeled sections:",
    "Summary: <2-3 sentences>",
    "Risk: <one line on the biggest risk>",
    "Next step: <one concrete recommended action>",
  ].join("\n");
}

/** Build the lead-qualification prompt from a lead context. PURE. */
export function buildLeadQualifyPrompt(context: string): string {
  return [
    "Qualify this lead and suggest the next step.",
    "",
    context,
    "",
    "Respond in two short labeled lines:",
    "Assessment: <is this lead worth pursuing, and why — one or two sentences>",
    "Next step: <one concrete recommended action>",
  ].join("\n");
}

/** Build a pipeline Q&A prompt from a natural-language query + aggregate stats. PURE. */
export function buildPipelineAnswerPrompt(query: string, stats: string): string {
  return [
    "Answer the user's question about their sales pipeline using ONLY the stats below.",
    "If the stats do not contain the answer, say so briefly.",
    "",
    "PIPELINE STATS:",
    stats,
    "",
    `QUESTION: ${query}`,
    "",
    "Answer in 1-3 sentences.",
  ].join("\n");
}

/**
 * Parse a {subject, body} JSON object out of a model response, tolerating stray
 * prose or code fences. Falls back to using the whole text as the body. PURE.
 */
export function parseDraftedEmail(text: string): { subject: string; body: string } {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as { subject?: unknown; body?: unknown };
      const subject = typeof obj.subject === "string" ? obj.subject.trim() : "";
      const body = typeof obj.body === "string" ? obj.body.trim() : "";
      if (subject || body) return { subject: subject || "Following up", body: body || cleaned };
    } catch {
      // fall through to plain-text fallback
    }
  }
  return { subject: "Following up", body: cleaned };
}
