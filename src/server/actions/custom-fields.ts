"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { ENTITIES, FIELD_TYPES } from "@/lib/custom-fields";
import { withinLimit } from "@/lib/entitlements";

const baseSchema = z.object({
  entity: z.enum(ENTITIES),
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/, "Key must be 1-40 chars: lowercase letter, then letters/digits/underscores"),
  label: z.string().trim().min(1).max(60),
  type: z.enum(FIELD_TYPES),
  config: z.record(z.unknown()).optional(),
  required: z.boolean().optional(),
  order: z.coerce.number().int().min(0).optional(),
});

const optionsSchema = z.array(z.string().trim().min(1)).min(1);

/** Validate that select-type fields carry a non-empty config.options string[]. */
function validateSelect(
  type: string,
  config: Record<string, unknown> | undefined,
): { ok: true; config: Record<string, unknown> | null } | { ok: false } {
  if (type !== "select") return { ok: true, config: config ?? null };
  const parsed = optionsSchema.safeParse(config?.options);
  if (!parsed.success) return { ok: false };
  return { ok: true, config: { ...(config ?? {}), options: parsed.data } };
}

export async function createFieldDefinition(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = baseSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const d = parsed.data;

  const select = validateSelect(d.type, d.config);
  if (!select.ok) return fail("A select field requires at least one option");

  // M4: enforce plan limits across all of the org's custom fields (every entity).
  const total = await db.customFieldDefinition.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "customFields", total))) {
    return fail("Plan limit reached: upgrade your plan to add more custom fields");
  }

  const count = await db.customFieldDefinition.count({ where: { orgId, entity: d.entity } });
  try {
    const created = await db.customFieldDefinition.create({
      data: {
        orgId,
        entity: d.entity,
        key: d.key,
        label: d.label,
        type: d.type,
        config: (select.config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        required: d.required ?? false,
        order: d.order ?? count,
      },
    });
    revalidatePath("/settings/custom-fields");
    return ok({ id: created.id });
  } catch {
    return fail("A field with that key already exists for this entity");
  }
}

const updateSchema = baseSchema.partial({
  label: true,
  type: true,
  config: true,
  required: true,
  order: true,
}).omit({ entity: true, key: true });

export async function updateFieldDefinition(
  id: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");

  const existing = await db.customFieldDefinition.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");

  const d = parsed.data;
  const effectiveType = d.type ?? (existing.type as string);
  // Re-validate select options whenever the type ends up "select" and config is
  // being changed (or the type is switching to select).
  let config: Record<string, unknown> | null | undefined;
  if (d.config !== undefined || d.type !== undefined) {
    const candidate =
      d.config ?? ((existing.config as Record<string, unknown> | null) ?? undefined);
    const select = validateSelect(effectiveType, candidate);
    if (!select.ok) return fail("A select field requires at least one option");
    config = select.config;
  }

  await db.customFieldDefinition.update({
    where: { id },
    data: {
      label: d.label,
      type: d.type,
      config:
        config === undefined
          ? undefined
          : ((config ?? Prisma.JsonNull) as Prisma.InputJsonValue),
      required: d.required,
      order: d.order,
    },
  });
  revalidatePath("/settings/custom-fields");
  return ok({ id });
}

export async function deleteFieldDefinition(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const res = await db.customFieldDefinition.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings/custom-fields");
  return ok({ id });
}
