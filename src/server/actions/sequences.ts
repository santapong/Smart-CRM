"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { withinLimit } from "@/lib/entitlements";

/**
 * Sales sequence CRUD + step editing (M13b). All mutations are ADMIN-only and
 * org-scoped. Steps are ordered; the runner (src/lib/sequences/runner.ts) walks
 * them in `order`.
 */

const STEP_TYPES = ["email", "task", "wait"] as const;

const sequenceSchema = z.object({
  name: z.string().trim().min(1).max(160),
  enabled: z.coerce.boolean().default(true),
});

const stepBase = z.object({
  type: z.enum(STEP_TYPES),
  subject: z.string().max(200).optional().or(z.literal("")),
  body: z.string().max(20000).optional().or(z.literal("")),
  waitDays: z.coerce.number().int().min(0).max(365).default(0),
});

const stepSchema = stepBase
  .refine((d) => d.type !== "email" || !!(d.subject && d.subject.length > 0), {
    message: "Email steps need a subject",
    path: ["subject"],
  })
  .refine((d) => d.type !== "task" || !!(d.subject && d.subject.length > 0), {
    message: "Task steps need a title",
    path: ["subject"],
  });

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

async function ownSequence(orgId: string, sequenceId: string) {
  return db.sequence.findFirst({ where: { id: sequenceId, orgId } });
}

export async function createSequence(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = sequenceSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const count = await db.sequence.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "sequences", count))) {
    return fail("Plan limit reached: upgrade your plan to add more sequences");
  }
  const created = await db.sequence.create({
    data: { orgId, name: parsed.data.name, enabled: parsed.data.enabled },
  });
  revalidatePath("/sequences");
  return ok({ id: created.id });
}

export async function updateSequence(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = sequenceSchema.partial().safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const d = parsed.data;
  const res = await db.sequence.updateMany({
    where: { id, orgId },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
    },
  });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/sequences");
  revalidatePath(`/sequences/${id}`);
  return ok({ id });
}

export async function deleteSequence(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const res = await db.sequence.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/sequences");
  return ok({ id });
}

export async function addStep(sequenceId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = stepSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const seq = await ownSequence(orgId, sequenceId);
  if (!seq) return fail("Sequence not found");
  const d = parsed.data;
  const last = await db.sequenceStep.findFirst({
    where: { sequenceId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const created = await db.sequenceStep.create({
    data: {
      sequenceId,
      order: (last?.order ?? -1) + 1,
      type: d.type,
      subject: c(d.subject),
      body: c(d.body),
      waitDays: d.type === "wait" ? d.waitDays : 0,
    },
  });
  revalidatePath(`/sequences/${sequenceId}`);
  return ok({ id: created.id });
}

export async function updateStep(stepId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = stepBase.partial().safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const step = await db.sequenceStep.findFirst({
    where: { id: stepId, sequence: { orgId } },
    include: { sequence: { select: { id: true } } },
  });
  if (!step) return fail("Not found");
  const d = parsed.data;
  await db.sequenceStep.update({
    where: { id: stepId },
    data: {
      ...(d.type !== undefined ? { type: d.type } : {}),
      ...(d.subject !== undefined ? { subject: c(d.subject) } : {}),
      ...(d.body !== undefined ? { body: c(d.body) } : {}),
      ...(d.waitDays !== undefined ? { waitDays: d.waitDays } : {}),
    },
  });
  revalidatePath(`/sequences/${step.sequence.id}`);
  return ok({ id: stepId });
}

export async function removeStep(stepId: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const step = await db.sequenceStep.findFirst({
    where: { id: stepId, sequence: { orgId } },
    select: { id: true, sequenceId: true },
  });
  if (!step) return fail("Not found");
  await db.$transaction(async (tx) => {
    await tx.sequenceStep.delete({ where: { id: stepId } });
    // Re-pack orders so they stay contiguous (0..n).
    const remaining = await tx.sequenceStep.findMany({
      where: { sequenceId: step.sequenceId },
      orderBy: { order: "asc" },
      select: { id: true },
    });
    for (let i = 0; i < remaining.length; i++) {
      await tx.sequenceStep.update({ where: { id: remaining[i].id }, data: { order: i } });
    }
  });
  revalidatePath(`/sequences/${step.sequenceId}`);
  return ok({ id: stepId });
}

const reorderSchema = z.object({ stepIds: z.array(z.string().min(1)).min(1) });

/** Persist a new step ordering. `stepIds` is the full ordered list of ids. */
export async function reorderSteps(sequenceId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = reorderSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const seq = await ownSequence(orgId, sequenceId);
  if (!seq) return fail("Sequence not found");
  const steps = await db.sequenceStep.findMany({ where: { sequenceId }, select: { id: true } });
  const owned = new Set(steps.map((s) => s.id));
  if (parsed.data.stepIds.length !== steps.length || parsed.data.stepIds.some((id) => !owned.has(id))) {
    return fail("Step ids do not match this sequence");
  }
  await db.$transaction(
    parsed.data.stepIds.map((id, i) =>
      db.sequenceStep.update({ where: { id }, data: { order: i } }),
    ),
  );
  revalidatePath(`/sequences/${sequenceId}`);
  return ok({ id: sequenceId });
}
