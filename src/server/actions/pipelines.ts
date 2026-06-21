"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { withinLimit } from "@/lib/entitlements";

const pipelineSchema = z.object({
  name: z.string().min(1).max(80),
  order: z.coerce.number().int().min(0).optional(),
  isDefault: z.boolean().optional(),
});

const stageSchema = z.object({
  pipelineId: z.string().min(1),
  name: z.string().min(1).max(80),
  order: z.coerce.number().int().min(0),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  rottenDays: z.coerce.number().int().min(0).max(3650).nullish(),
  probability: z.coerce.number().int().min(0).max(100).nullish(),
});

export async function createPipeline(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = pipelineSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const p = parsed.data;
  const count = await db.pipeline.count({ where: { orgId } });
  // M4: enforce plan limits. TODO: custom-fields / saved-views / seats follow
  // the same withinLimit(...) pattern in their respective create actions.
  if (!(await withinLimit(orgId, "pipelines", count))) {
    return fail("Plan limit reached: upgrade your plan to add more pipelines");
  }
  try {
    const created = await db.pipeline.create({
      data: { orgId, name: p.name, order: p.order ?? count, isDefault: p.isDefault ?? false },
    });
    revalidatePath("/deals");
    return ok({ id: created.id });
  } catch {
    return fail("A pipeline with that name already exists");
  }
}

export async function updatePipeline(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = pipelineSchema.partial().safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const existing = await db.pipeline.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  await db.pipeline.update({
    where: { id },
    data: { name: parsed.data.name, order: parsed.data.order, isDefault: parsed.data.isDefault },
  });
  revalidatePath("/deals");
  return ok({ id });
}

export async function deletePipeline(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const pipeline = await db.pipeline.findFirst({
    where: { id, orgId },
    include: { _count: { select: { deals: true } } },
  });
  if (!pipeline) return fail("Not found");
  if (pipeline.isDefault) return fail("Cannot delete the default pipeline");
  if (pipeline._count.deals > 0) return fail("Move or delete this pipeline's deals first");
  await db.pipeline.delete({ where: { id } }); // cascades stages
  revalidatePath("/deals");
  return ok({ id });
}

export async function createStage(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = stageSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const s = parsed.data;
  const pipeline = await db.pipeline.findFirst({ where: { id: s.pipelineId, orgId } });
  if (!pipeline) return fail("Pipeline not found");
  try {
    const created = await db.pipelineStage.create({
      data: {
        orgId,
        pipelineId: s.pipelineId,
        name: s.name,
        order: s.order,
        color: s.color ?? "#3b82f6",
        rottenDays: s.rottenDays ?? null,
        probability: s.probability ?? null,
      },
    });
    revalidatePath("/deals");
    return ok({ id: created.id });
  } catch {
    return fail("A stage with that name already exists in this pipeline");
  }
}

export async function updateStage(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = stageSchema.partial().safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const existing = await db.pipelineStage.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const s = parsed.data;
  await db.pipelineStage.update({
    where: { id },
    data: {
      name: s.name,
      order: s.order,
      color: s.color,
      rottenDays: s.rottenDays,
      probability: s.probability,
    },
  });
  revalidatePath("/deals");
  return ok({ id });
}

export async function deleteStage(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const stage = await db.pipelineStage.findFirst({
    where: { id, orgId },
    include: { _count: { select: { deals: true } } },
  });
  if (!stage) return fail("Not found");
  if (stage._count.deals > 0) return fail("Move or delete this stage's deals first");
  await db.pipelineStage.delete({ where: { id } });
  revalidatePath("/deals");
  return ok({ id });
}
