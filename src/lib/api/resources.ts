import type { Contact, Deal, Lead } from "@prisma/client";

/**
 * Public REST API resource serializers (M12).
 *
 * Convert internal Prisma rows (Decimal, Date, JSONB) into stable JSON shapes
 * for the v1 API. Keeping these here means the route handlers stay thin and the
 * external contract is defined in one place. Companies/activities would add a
 * serializer here following the same pattern.
 */

function decimalToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && typeof (v as { toNumber?: unknown }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: Date | null | undefined): string | null {
  return v ? v.toISOString() : null;
}

export function serializeContact(c: Contact) {
  return {
    id: c.id,
    org_id: c.orgId,
    company_id: c.companyId,
    first_name: c.firstName,
    last_name: c.lastName,
    email: c.email,
    phone: c.phone,
    title: c.title,
    notes: c.notes,
    custom_fields: c.customFields ?? null,
    version: c.version,
    created_at: iso(c.createdAt),
    updated_at: iso(c.updatedAt),
  };
}

export function serializeDeal(d: Deal) {
  return {
    id: d.id,
    org_id: d.orgId,
    title: d.title,
    value: decimalToNumber(d.value),
    currency: d.currency,
    status: d.status,
    stage_id: d.stageId,
    pipeline_id: d.pipelineId,
    company_id: d.companyId,
    contact_id: d.contactId,
    owner_id: d.ownerId,
    probability: d.probability,
    close_date: iso(d.closeDate),
    notes: d.notes,
    custom_fields: d.customFields ?? null,
    version: d.version,
    created_at: iso(d.createdAt),
    updated_at: iso(d.updatedAt),
  };
}

export function serializeLead(l: Lead) {
  return {
    id: l.id,
    org_id: l.orgId,
    title: l.title,
    value: decimalToNumber(l.value),
    currency: l.currency,
    status: l.status,
    owner_id: l.ownerId,
    contact_id: l.contactId,
    company_id: l.companyId,
    source: l.source,
    source_channel: l.sourceChannel,
    notes: l.notes,
    custom_fields: l.customFields ?? null,
    converted_deal_id: l.convertedDealId,
    version: l.version,
    created_at: iso(l.createdAt),
    updated_at: iso(l.updatedAt),
  };
}
