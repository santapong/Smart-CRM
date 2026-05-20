"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import type { CustomFieldType } from "@prisma/client";

const entityEnum = z.enum(["COMPANY", "CONTACT", "DEAL"]);
const typeEnum = z.enum(["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT", "URL"]);

const defSchema = z.object({
  entity: entityEnum,
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/i, "Use letters, numbers, underscores; must start with a letter"),
  label: z.string().min(1).max(80),
  type: typeEnum,
  options: z.string().max(2000).optional().or(z.literal("")),
  required: z.union([z.literal("on"), z.boolean()]).optional(),
  order: z.coerce.number().int().min(0).max(1000).default(0),
});

const valueSchema = z.object({
  definitionId: z.string().min(1),
  entityId: z.string().min(1),
  raw: z.string().optional().or(z.literal("")),
});

const checkbox = (v: unknown) => v === true || v === "on";

function parseOptions(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const items = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

export async function createCustomFieldDefinition(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = defSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const d = parsed.data;

  const options = d.type === "SELECT" ? parseOptions(d.options ?? undefined) : null;
  if (d.type === "SELECT" && (!options || options.length === 0)) {
    return fail("SELECT fields need at least one option");
  }

  try {
    const created = await db.customFieldDefinition.create({
      data: {
        orgId,
        entity: d.entity,
        key: d.key.toLowerCase(),
        label: d.label,
        type: d.type,
        options: options ?? undefined,
        required: checkbox(d.required),
        order: d.order,
      },
    });
    revalidatePath("/settings");
    return ok({ id: created.id });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique")) {
      return fail("A field with that key already exists for this entity");
    }
    throw err;
  }
}

export async function deleteCustomFieldDefinition(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const res = await db.customFieldDefinition.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings");
  return ok({ id });
}

// setCustomFieldValue writes the value into the correct typed column based on
// the definition's `type`. The caller passes a raw string (from a form input)
// and we parse it here so the API surface is uniform.
export async function setCustomFieldValue(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = valueSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;

  const def = await db.customFieldDefinition.findFirst({ where: { id: d.definitionId, orgId } });
  if (!def) return fail("Custom field not found");

  const raw = d.raw && d.raw.length > 0 ? d.raw : null;
  if (def.required && raw == null) return fail(`${def.label} is required`);

  const value = decodeValue(def.type, raw);
  if (value === "INVALID") return fail(`Invalid value for ${def.label}`);

  // Validate the target row is in the same org and matches the entity kind.
  const where: { orgId: string; companyId?: string | null; contactId?: string | null; dealId?: string | null } = { orgId };
  if (def.entity === "COMPANY") {
    const exists = await db.company.findFirst({ where: { id: d.entityId, orgId }, select: { id: true } });
    if (!exists) return fail("Target account not found");
    where.companyId = d.entityId;
  } else if (def.entity === "CONTACT") {
    const exists = await db.contact.findFirst({ where: { id: d.entityId, orgId }, select: { id: true } });
    if (!exists) return fail("Target contact not found");
    where.contactId = d.entityId;
  } else {
    const exists = await db.deal.findFirst({ where: { id: d.entityId, orgId }, select: { id: true } });
    if (!exists) return fail("Target deal not found");
    where.dealId = d.entityId;
  }

  const existing = await db.customFieldValue.findFirst({
    where: { definitionId: d.definitionId, ...where },
  });

  const writePatch = {
    valueText: null as string | null,
    valueNumber: null as number | null,
    valueDate: null as Date | null,
    valueBoolean: null as boolean | null,
    ...value,
  };

  if (existing) {
    await db.customFieldValue.update({ where: { id: existing.id }, data: writePatch });
    return ok({ id: existing.id });
  }

  const created = await db.customFieldValue.create({
    data: {
      orgId,
      definitionId: d.definitionId,
      companyId: where.companyId ?? null,
      contactId: where.contactId ?? null,
      dealId: where.dealId ?? null,
      ...writePatch,
    },
  });

  if (where.companyId) revalidatePath(`/companies/${where.companyId}`);
  if (where.contactId) revalidatePath(`/contacts/${where.contactId}`);
  if (where.dealId) revalidatePath(`/deals/${where.dealId}`);

  return ok({ id: created.id });
}

type DecodedValue =
  | "INVALID"
  | { valueText?: string | null; valueNumber?: number | null; valueDate?: Date | null; valueBoolean?: boolean | null };

function decodeValue(type: CustomFieldType, raw: string | null): DecodedValue {
  if (raw == null) return {};
  switch (type) {
    case "TEXT":
    case "URL":
    case "SELECT":
      return { valueText: raw };
    case "NUMBER": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return "INVALID";
      return { valueNumber: n };
    }
    case "DATE": {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return "INVALID";
      return { valueDate: d };
    }
    case "BOOLEAN":
      return { valueBoolean: raw === "true" || raw === "on" };
  }
}
