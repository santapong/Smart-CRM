import { z } from "zod";
import { db } from "@/lib/db";
import type { CustomFieldDefinition } from "@prisma/client";

export const ENTITIES = ["contact", "company", "deal"] as const;
export type CustomFieldEntity = (typeof ENTITIES)[number];

export const FIELD_TYPES = ["text", "number", "date", "boolean", "select"] as const;
export type CustomFieldType = (typeof FIELD_TYPES)[number];

/** Fetch the ordered custom-field definitions for an org + entity. */
export async function getDefinitions(
  orgId: string,
  entity: CustomFieldEntity,
): Promise<CustomFieldDefinition[]> {
  return db.customFieldDefinition.findMany({
    where: { orgId, entity },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
}

/** Pull the string[] of select options from a definition's config Json. */
export function selectOptions(def: CustomFieldDefinition): string[] {
  const config = def.config as { options?: unknown } | null;
  if (!config || !Array.isArray(config.options)) return [];
  return config.options.filter((o): o is string => typeof o === "string");
}

/** A loose ISO date string (date or date-time) that Date can parse. */
const isoDateSchema = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), "Must be an ISO date string");

function fieldSchema(def: CustomFieldDefinition): z.ZodTypeAny {
  switch (def.type as CustomFieldType) {
    case "number":
      return z.coerce.number();
    case "boolean":
      return z.coerce.boolean();
    case "date":
      return isoDateSchema;
    case "select": {
      const options = selectOptions(def);
      // An empty option list would make z.enum throw at build time; fall back
      // to a never-matching schema so any value is rejected for a broken def.
      if (options.length === 0) return z.never();
      return z.enum(options as [string, ...string[]]);
    }
    case "text":
    default:
      return z.string();
  }
}

/**
 * Build a Zod object that validates a `customFields` record against the given
 * definitions. Required fields must be present; optional fields may be omitted;
 * unknown keys are stripped.
 */
export function buildZodSchema(defs: CustomFieldDefinition[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const def of defs) {
    const base = fieldSchema(def);
    shape[def.key] = def.required ? base : base.optional();
  }
  // .strip() (the Zod default) drops unknown keys rather than erroring.
  return z.object(shape).strip();
}

export type ApplyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: Record<string, string[]> };

/**
 * Validate a plain key→value object against an org's custom-field definitions
 * for an entity. Returns a sanitized JSON object to store, or field errors.
 */
export async function applyCustomFields(
  orgId: string,
  entity: CustomFieldEntity,
  input: unknown,
): Promise<ApplyResult> {
  const defs = await getDefinitions(orgId, entity);
  const schema = buildZodSchema(defs);
  // Coerce a non-object (incl. null/undefined) to {} so "required" rules fire.
  const candidate = typeof input === "object" && input !== null ? input : {};
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>;
    const errors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(flat)) if (v) errors[k] = v;
    return { ok: false, errors };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
}
