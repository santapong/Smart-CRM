import type { Company, Contact, Deal, Organization, PipelineStage } from "@prisma/client";

/**
 * Smart-Docs merge engine (M18) — fully local, no external services.
 *
 * The renderer is PURE: {@link renderTemplate} takes a template body containing
 * `{{ path.to.value }}` tokens and a plain context object, and returns the
 * rendered string. Token resolution is a dot-path lookup over the context;
 * surrounding whitespace inside the braces is trimmed. UNKNOWN tokens (a path
 * that resolves to undefined/null, or anything not in the context) are replaced
 * with the empty string so generated documents never leak raw `{{…}}` markup.
 *
 * {@link buildMergeContext} assembles the context object from loaded Prisma
 * entities using their REAL field names, so it stays in lockstep with the schema.
 * {@link AVAILABLE_MERGE_FIELDS} documents every supported token for the UI hint.
 */

/** A token matches {{ anything-but-braces }}; we trim and dot-path it. */
const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Resolve a dot-path (e.g. "deal.stage") against a nested context object. */
export function lookupPath(context: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Render a template body, replacing every `{{ path }}` token with its resolved
 * value from `context`. Unknown / null / undefined tokens become "". Non-token
 * text is left untouched. Values are stringified (numbers, booleans, etc.).
 */
export function renderTemplate(body: string, context: Record<string, unknown>): string {
  return body.replace(TOKEN_RE, (_match, rawPath: string) => {
    const value = lookupPath(context, rawPath);
    if (value === null || value === undefined) return "";
    return String(value);
  });
}

/** A merge field descriptor for the UI hint (the literal token + a label). */
export type MergeField = { token: string; label: string };

/**
 * Every supported merge token. Mirrors what {@link buildMergeContext} produces;
 * keep the two in sync. Tokens render to "" when the underlying record is absent
 * (e.g. {{deal.title}} on a contact-only document).
 */
export const AVAILABLE_MERGE_FIELDS: MergeField[] = [
  { token: "{{deal.title}}", label: "Deal name" },
  { token: "{{deal.value}}", label: "Deal value" },
  { token: "{{deal.currency}}", label: "Deal currency" },
  { token: "{{deal.status}}", label: "Deal status" },
  { token: "{{deal.stage}}", label: "Deal stage" },
  { token: "{{deal.closeDate}}", label: "Deal close date" },
  { token: "{{contact.firstName}}", label: "Contact first name" },
  { token: "{{contact.lastName}}", label: "Contact last name" },
  { token: "{{contact.fullName}}", label: "Contact full name" },
  { token: "{{contact.email}}", label: "Contact email" },
  { token: "{{contact.phone}}", label: "Contact phone" },
  { token: "{{contact.title}}", label: "Contact job title" },
  { token: "{{company.name}}", label: "Company name" },
  { token: "{{company.domain}}", label: "Company domain" },
  { token: "{{company.industry}}", label: "Company industry" },
  { token: "{{org.name}}", label: "Your organization name" },
  { token: "{{today}}", label: "Today's date (YYYY-MM-DD)" },
];

/** Format a Date as YYYY-MM-DD (UTC), the stable form used by {{today}} / dates. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Entities loaded for a merge. Each is optional — a document can target any one. */
export type MergeEntities = {
  deal?: (Deal & { stage?: Pick<PipelineStage, "name"> | null }) | null;
  contact?: Contact | null;
  company?: Company | null;
  org?: Pick<Organization, "name" | "slug"> | null;
  /** Override "now" for deterministic tests; defaults to new Date(). */
  now?: Date;
};

/**
 * Build the merge context object from loaded entities, using their real Prisma
 * field names. Decimal values (deal.value) are coerced to a Number string via
 * String(); dates are emitted as YYYY-MM-DD. The shape matches the tokens in
 * {@link AVAILABLE_MERGE_FIELDS}.
 */
export function buildMergeContext(entities: MergeEntities): Record<string, unknown> {
  const now = entities.now ?? new Date();
  const ctx: Record<string, unknown> = { today: isoDate(now) };

  const { deal, contact, company, org } = entities;

  if (deal) {
    ctx.deal = {
      title: deal.title,
      value: deal.value != null ? String(deal.value) : "",
      currency: deal.currency,
      status: deal.status,
      stage: deal.stage?.name ?? "",
      closeDate: deal.closeDate ? isoDate(deal.closeDate) : "",
    };
  }

  if (contact) {
    ctx.contact = {
      firstName: contact.firstName,
      lastName: contact.lastName,
      fullName: `${contact.firstName} ${contact.lastName}`.trim(),
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      title: contact.title ?? "",
    };
  }

  if (company) {
    ctx.company = {
      name: company.name,
      domain: company.domain ?? "",
      industry: company.industry ?? "",
      size: company.size ?? "",
    };
  }

  if (org) {
    ctx.org = { name: org.name, slug: org.slug };
  }

  return ctx;
}
