"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { withinLimit } from "@/lib/entitlements";
import { EVENTS } from "@/lib/events";
import { ACTION_TYPES } from "@/lib/workflows/types";
import { getRecipe } from "@/lib/workflows/recipes";

/**
 * No-code workflow CRUD (M9). ADMIN-gated, Zod-validated, and capped by the
 * org's `workflows` entitlement. The trigger must be a known domain event and
 * each action a known step type.
 */

const TRIGGERS = Object.values(EVENTS) as [string, ...string[]];

// A single action step. We validate the discriminator + common params loosely;
// the engine reads only the keys each type needs (see lib/workflows/engine.ts).
const actionSchema = z
  .object({
    type: z.enum(ACTION_TYPES),
    field: z.string().max(80).optional(),
    customField: z.string().max(80).optional(),
    value: z.unknown().optional(),
    title: z.string().max(160).optional(),
    body: z.string().max(8000).optional(),
    dueInDays: z.coerce.number().int().min(0).max(3650).optional(),
    subject: z.string().max(200).optional(),
    tag: z.string().max(40).optional(),
    url: z.string().url().max(2000).optional(),
    seconds: z.coerce.number().int().min(0).max(86400).optional(),
    condition: z.unknown().optional(),
    then: z.array(z.unknown()).max(20).optional(),
    else: z.array(z.unknown()).max(20).optional(),
  })
  .passthrough();

const workflowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  triggerEvent: z.enum(TRIGGERS),
  conditions: z.unknown().optional().nullable(),
  definition: z.array(actionSchema).max(50).default([]),
  enabled: z.boolean().default(true),
});

export async function listWorkflows() {
  const { orgId } = await requireOrg();
  return db.workflow.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
}

export async function createWorkflow(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const count = await db.workflow.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "workflows", count))) {
    return fail("Plan limit reached: upgrade your plan to add more workflows");
  }
  const w = parsed.data;
  const created = await db.workflow.create({
    data: {
      orgId,
      name: w.name,
      triggerEvent: w.triggerEvent,
      conditions: (w.conditions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      definition: w.definition as unknown as Prisma.InputJsonValue,
      enabled: w.enabled,
    },
  });
  revalidatePath("/automations");
  return ok({ id: created.id });
}

export async function updateWorkflow(
  id: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const existing = await db.workflow.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const w = parsed.data;
  await db.workflow.update({
    where: { id },
    data: {
      name: w.name,
      triggerEvent: w.triggerEvent,
      conditions: (w.conditions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      definition: w.definition as unknown as Prisma.InputJsonValue,
      enabled: w.enabled,
      version: { increment: 1 },
    },
  });
  revalidatePath("/automations");
  revalidatePath(`/automations/${id}`);
  return ok({ id });
}

export async function setWorkflowEnabled(
  id: string,
  enabled: boolean,
): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const res = await db.workflow.updateMany({ where: { id, orgId }, data: { enabled } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/automations");
  revalidatePath(`/automations/${id}`);
  return ok({ id, enabled });
}

export async function deleteWorkflow(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const res = await db.workflow.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/automations");
  return ok({ id });
}

/** Create a workflow from a built-in recipe template (ADMIN, limit-gated). */
export async function cloneRecipe(recipeKey: string): Promise<ActionResult<{ id: string }>> {
  const recipe = getRecipe(recipeKey);
  if (!recipe) return fail("Unknown recipe");
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const count = await db.workflow.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "workflows", count))) {
    return fail("Plan limit reached: upgrade your plan to add more workflows");
  }
  const created = await db.workflow.create({
    data: {
      orgId,
      name: recipe.name,
      triggerEvent: recipe.triggerEvent,
      conditions: (recipe.conditions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      definition: recipe.definition as unknown as Prisma.InputJsonValue,
      enabled: true,
    },
  });
  revalidatePath("/automations");
  return ok({ id: created.id });
}
