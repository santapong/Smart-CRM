import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { applyCustomFields } from "@/lib/custom-fields";
import { parseCsv } from "@/lib/import/parse";

/**
 * Guided CSV import runner (M13c).
 *
 * {@link processImportJob} parses an ImportJob's stored CSV, maps each row's
 * columns onto entity fields via the job's `mapping`, validates, dedupes by a
 * natural key (contact→email, company→domain||name) honoring `dupeMode`
 * (skip existing / update existing / always create), and creates/updates the
 * record org-scoped — incrementing counters as it goes.
 *
 * It is deliberately defensive: a row that fails validation or persistence
 * records an ImportRowError and is skipped, so one bad row never aborts the job.
 * Mapping targets may be a direct field (e.g. "firstName") or a custom field via
 * the "customFields.<key>" prefix, validated through {@link applyCustomFields}.
 */

export type ImportEntity = "contact" | "company";
export type DupeMode = "skip" | "update" | "create";

/** Direct (non-custom) target fields per entity. Order is the UI suggestion order. */
export const IMPORT_FIELDS: Record<ImportEntity, readonly string[]> = {
  contact: ["firstName", "lastName", "email", "phone", "title", "notes"],
  company: ["name", "domain", "industry", "size", "notes"],
} as const;

const CUSTOM_PREFIX = "customFields.";

/** A mapping is header → target field ("" / unmapped headers are ignored). */
export type ImportMapping = Record<string, string>;

function normalizeMapping(mapping: unknown): ImportMapping {
  if (!mapping || typeof mapping !== "object") return {};
  const out: ImportMapping = {};
  for (const [k, v] of Object.entries(mapping as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

type Mapped = {
  fields: Record<string, string>;
  customFields: Record<string, unknown>;
};

/** Apply the mapping to a parsed row, splitting direct vs custom-field targets. */
function mapRow(row: Record<string, string>, mapping: ImportMapping): Mapped {
  const fields: Record<string, string> = {};
  const customFields: Record<string, unknown> = {};
  for (const [header, target] of Object.entries(mapping)) {
    const value = (row[header] ?? "").trim();
    if (value.length === 0) continue;
    if (target.startsWith(CUSTOM_PREFIX)) {
      customFields[target.slice(CUSTOM_PREFIX.length)] = value;
    } else {
      fields[target] = value;
    }
  }
  return { fields, customFields };
}

const clean = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : null);

/** Validate the direct fields for an entity. Returns an error string or null. */
function validateFields(entity: ImportEntity, fields: Record<string, string>): string | null {
  if (entity === "contact") {
    if (!clean(fields.firstName) && !clean(fields.lastName)) {
      return "Contact needs a first or last name";
    }
    const email = clean(fields.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Invalid email";
  } else {
    if (!clean(fields.name)) return "Company needs a name";
  }
  return null;
}

/** Find an existing record matching the dedupe key (org-scoped). */
async function findExisting(orgId: string, entity: ImportEntity, fields: Record<string, string>) {
  if (entity === "contact") {
    const email = clean(fields.email);
    if (!email) return null;
    const matches = await db.contact.findMany({ where: { orgId, email: { not: null } } });
    return matches.find((c) => c.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }
  const domain = clean(fields.domain);
  if (domain) {
    const matches = await db.company.findMany({ where: { orgId, domain: { not: null } } });
    const hit = matches.find((c) => c.domain?.toLowerCase() === domain.toLowerCase());
    if (hit) return hit;
  }
  const name = clean(fields.name);
  if (!name) return null;
  const matches = await db.company.findMany({ where: { orgId } });
  return matches.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
}

function buildContactData(fields: Record<string, string>, cf: Record<string, unknown>) {
  return {
    firstName: clean(fields.firstName) ?? "",
    lastName: clean(fields.lastName) ?? "",
    email: clean(fields.email),
    phone: clean(fields.phone),
    title: clean(fields.title),
    notes: clean(fields.notes),
    customFields: cf as Prisma.InputJsonValue,
  };
}

function buildCompanyData(fields: Record<string, string>, cf: Record<string, unknown>) {
  return {
    name: clean(fields.name) ?? "",
    domain: clean(fields.domain),
    industry: clean(fields.industry),
    size: clean(fields.size),
    notes: clean(fields.notes),
    customFields: cf as Prisma.InputJsonValue,
  };
}

/** Merge update data: only overwrite a target field when the import supplies a value. */
function nonNull<T extends Record<string, unknown>>(data: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "customFields") continue;
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return out as Partial<T>;
}

export type ImportResult = {
  status: "done" | "failed";
  totalRows: number;
  processed: number;
  created: number;
  updated: number;
  failed: number;
};

/**
 * Process an ImportJob end-to-end. Idempotent-ish: re-running re-imports from
 * `raw` (existing-record dedupe applies). Returns final counters; also persisted
 * on the job row along with status + finishedAt.
 */
export async function processImportJob(jobId: string): Promise<ImportResult> {
  const job = await db.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Import job not found");

  const entity = job.entity as ImportEntity;
  const dupeMode = job.dupeMode as DupeMode;
  const mapping = normalizeMapping(job.mapping);
  const orgId = job.orgId;

  await db.importJob.update({ where: { id: jobId }, data: { status: "running" } });

  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(job.raw);
  } catch (err) {
    const finished = await db.importJob.update({
      where: { id: jobId },
      data: { status: "failed", finishedAt: new Date(), failed: 1, totalRows: 0 },
    });
    await db.importRowError.create({
      data: {
        importJobId: jobId,
        rowNumber: 0,
        message: err instanceof Error ? err.message : "Failed to parse CSV",
        raw: {} as Prisma.InputJsonValue,
      },
    });
    return {
      status: "failed",
      totalRows: 0,
      processed: finished.processed,
      created: 0,
      updated: 0,
      failed: 1,
    };
  }

  let processed = 0;
  let created = 0;
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNumber = i + 1;
    const sourceRow = parsed.rows[i];
    try {
      const { fields, customFields } = mapRow(sourceRow, mapping);

      const fieldError = validateFields(entity, fields);
      if (fieldError) throw new Error(fieldError);

      const cf = await applyCustomFields(orgId, entity, customFields);
      if (!cf.ok) {
        const first = Object.entries(cf.errors)[0];
        throw new Error(first ? `${first[0]}: ${first[1].join(", ")}` : "Invalid custom fields");
      }

      const existing = dupeMode === "create" ? null : await findExisting(orgId, entity, fields);

      if (existing && dupeMode === "skip") {
        processed += 1;
        continue;
      }

      if (existing && dupeMode === "update") {
        if (entity === "contact") {
          const data = buildContactData(fields, cf.value);
          await db.contact.update({
            where: { id: existing.id },
            data: { ...nonNull(data), customFields: cf.value as Prisma.InputJsonValue },
          });
        } else {
          const data = buildCompanyData(fields, cf.value);
          await db.company.update({
            where: { id: existing.id },
            data: { ...nonNull(data), customFields: cf.value as Prisma.InputJsonValue },
          });
        }
        updated += 1;
        processed += 1;
        continue;
      }

      // No existing match (or dupeMode === "create"): create a new record.
      if (entity === "contact") {
        await db.contact.create({ data: { orgId, ...buildContactData(fields, cf.value) } });
      } else {
        await db.company.create({ data: { orgId, ...buildCompanyData(fields, cf.value) } });
      }
      created += 1;
      processed += 1;
    } catch (err) {
      failed += 1;
      await db.importRowError.create({
        data: {
          importJobId: jobId,
          rowNumber,
          message: err instanceof Error ? err.message : "Row failed",
          raw: sourceRow as Prisma.InputJsonValue,
        },
      });
    }
  }

  await db.importJob.update({
    where: { id: jobId },
    data: {
      status: "done",
      totalRows: parsed.rows.length,
      processed,
      created,
      updated,
      failed,
      finishedAt: new Date(),
    },
  });

  return { status: "done", totalRows: parsed.rows.length, processed, created, updated, failed };
}

/** Header→field fuzzy suggestion: normalize and match against entity fields. */
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const FIELD_ALIASES: Record<ImportEntity, Record<string, string[]>> = {
  contact: {
    firstName: ["firstname", "first", "givenname", "fname"],
    lastName: ["lastname", "last", "surname", "familyname", "lname"],
    email: ["email", "emailaddress", "mail", "e-mail"],
    phone: ["phone", "phonenumber", "mobile", "tel", "telephone", "cell"],
    title: ["title", "jobtitle", "position", "role"],
    notes: ["notes", "note", "comment", "comments", "description"],
  },
  company: {
    name: ["name", "company", "companyname", "organization", "account"],
    domain: ["domain", "website", "url", "web", "site"],
    industry: ["industry", "sector", "vertical"],
    size: ["size", "employees", "headcount", "companysize"],
    notes: ["notes", "note", "comment", "comments", "description"],
  },
};

/**
 * Suggest a header→field mapping by fuzzy name match. Each header maps to the
 * first matching field by alias (or exact normalized field name); unmatched
 * headers are left unmapped (""). One field is suggested at most once.
 */
export function suggestMapping(entity: ImportEntity, headers: string[]): ImportMapping {
  const aliases = FIELD_ALIASES[entity];
  const used = new Set<string>();
  const mapping: ImportMapping = {};
  for (const header of headers) {
    const norm = normalizeHeader(header);
    let chosen = "";
    for (const field of IMPORT_FIELDS[entity]) {
      if (used.has(field)) continue;
      const fieldAliases = aliases[field] ?? [field.toLowerCase()];
      if (norm === normalizeHeader(field) || fieldAliases.some((a) => normalizeHeader(a) === norm)) {
        chosen = field;
        break;
      }
    }
    if (chosen) used.add(chosen);
    mapping[header] = chosen;
  }
  return mapping;
}
